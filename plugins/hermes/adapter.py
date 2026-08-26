"""Hermes platform adapter for Agora's authenticated dial-in protocol."""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import mimetypes
import os
import tempfile
import uuid
from pathlib import Path
from typing import Any, Dict, Optional
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

import websockets

from gateway.config import Platform, PlatformConfig
from gateway.platforms.base import (
    BasePlatformAdapter,
    MessageEvent,
    MessageType,
    SendResult,
)
from gateway.session import SessionSource

_LOOPBACK = {"127.0.0.1", "localhost", "::1"}
_MAX_ATTACHMENTS = 5
_DEFAULT_MAX_FILE_MB = 10
logger = logging.getLogger(__name__)


class _NoRedirectHandler(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


_NO_REDIRECT_OPENER = build_opener(_NoRedirectHandler())


def _truthy(value: Any) -> bool:
    return str(value or "").strip().lower() in {"1", "true", "yes", "on"}


def _thread_id(metadata: Optional[Dict[str, Any]]) -> Optional[int]:
    value = (metadata or {}).get("thread_id")
    if value is None:
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _max_file_bytes(extra: dict) -> int:
    raw = os.getenv("AGORA_MAX_FILE_MB") or extra.get("max_file_mb", _DEFAULT_MAX_FILE_MB)
    try:
        megabytes = max(1, int(raw))
    except (TypeError, ValueError):
        megabytes = _DEFAULT_MAX_FILE_MB
    return megabytes * 1024 * 1024


def _token(extra: dict) -> str:
    direct = os.getenv("AGORA_PAIRING_TOKEN") or extra.get("pairing_token", "")
    if direct:
        return str(direct).strip()
    token_file = os.getenv("AGORA_PAIRING_TOKEN_FILE") or extra.get("pairing_token_file", "")
    return Path(str(token_file)).expanduser().read_text().strip() if token_file else ""


def _socket_url(base: str, token: str) -> str:
    parsed = urlsplit(base.strip())
    scheme = {"http": "ws", "https": "wss"}.get(parsed.scheme, parsed.scheme)
    if scheme not in {"ws", "wss"} or not parsed.hostname:
        raise ValueError("AGORA_URL must be an http(s) or ws(s) URL")
    if scheme == "ws" and parsed.hostname.lower() not in _LOOPBACK:
        raise ValueError("plaintext ws:// is allowed only for loopback Agora servers")
    path = parsed.path.rstrip("/")
    if not path.endswith("/agent/ws"):
        path = f"{path}/agent/ws" if path else "/agent/ws"
    query = dict(parse_qsl(parsed.query, keep_blank_values=True))
    query["token"] = token
    return urlunsplit((scheme, parsed.netloc, path, urlencode(query), ""))


def _http_file_url(socket_url: str, file_id: str, agent_id: str) -> str:
    parsed = urlsplit(socket_url)
    scheme = "https" if parsed.scheme == "wss" else "http"
    query = urlencode({"agent_id": agent_id})
    return urlunsplit((scheme, parsed.netloc, f"/agent/files/{file_id}", query, ""))


class AgoraAdapter(BasePlatformAdapter):
    supports_code_blocks = True
    _ACK_EMOJI = "👀"
    _OK_EMOJI = "✅"
    _FAIL_EMOJI = "❌"

    def __init__(self, config: PlatformConfig):
        super().__init__(config, Platform("agora"))
        extra = config.extra or {}
        self.base_url = str(os.getenv("AGORA_URL") or extra.get("url", "")).strip()
        self.token = _token(extra)
        self.agent_id = str(os.getenv("AGORA_AGENT_ID") or extra.get("agent_id", "hermes-agent")).strip()
        self.agent_name = str(os.getenv("AGORA_AGENT_NAME") or extra.get("agent_name", "Hermes")).strip()
        self.require_mention = _truthy(os.getenv("AGORA_REQUIRE_MENTION", extra.get("require_mention", "false")))
        self.bot_loop_limit = os.getenv("AGORA_BOT_LOOP_LIMIT", extra.get("bot_loop_limit"))
        self.max_file_bytes = _max_file_bytes(extra)
        self.socket_url = _socket_url(self.base_url, self.token)
        self._socket = None
        self._reader_task: Optional[asyncio.Task] = None
        self._send_lock = asyncio.Lock()
        self._temp_dir: Optional[tempfile.TemporaryDirectory] = None
        self._typing: set[tuple[str, Optional[int]]] = set()

    async def connect(self, *, is_reconnect: bool = False) -> bool:
        await self.disconnect()
        try:
            self._socket = await websockets.connect(
                self.socket_url,
                open_timeout=20,
                ping_interval=20,
                ping_timeout=20,
                max_size=64 * 1024 * 1024,
            )
            agent = {
                "id": self.agent_id,
                "name": self.agent_name,
                "requires_mention": self.require_mention,
                "wants_context_feed": False,
            }
            if self.bot_loop_limit is not None:
                agent["bot_loop_limit"] = self.bot_loop_limit
            await self._write({
                "type": "hello",
                "agents": [agent],
            })
            self._temp_dir = tempfile.TemporaryDirectory(prefix="hermes-agora-")
            self._reader_task = asyncio.create_task(self._read_loop(), name="agora-platform-reader")
            self._mark_connected()
            return True
        except Exception as error:
            parsed = urlsplit(self.socket_url)
            logger.warning("Could not connect to Agora at %s://%s: %s",
                           parsed.scheme, parsed.netloc, error)
            await self.disconnect()
            return False

    async def disconnect(self) -> None:
        if self._socket is not None:
            for chat_id, thread_id in tuple(self._typing):
                try:
                    await self._send_typing(chat_id, thread_id, False)
                except Exception as error:
                    logger.warning("Could not clear Agora typing state during disconnect: %s", error)
        self._typing.clear()
        task, self._reader_task = self._reader_task, None
        if task and task is not asyncio.current_task():
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
        socket, self._socket = self._socket, None
        if socket:
            await socket.close()
        if self._temp_dir:
            self._temp_dir.cleanup()
            self._temp_dir = None
        self._mark_disconnected()

    async def _write(self, frame: dict) -> None:
        async with self._send_lock:
            socket = self._socket
            if socket is None:
                raise RuntimeError("Agora is not connected")
            await socket.send(json.dumps(frame))

    async def _read_loop(self) -> None:
        try:
            async for raw in self._socket:
                try:
                    frame = json.loads(raw)
                    if frame.get("type") == "inbound":
                        await self._handle_inbound(frame)
                    elif frame.get("type") == "error":
                        logger.warning(
                            "Agora rejected %s request %s: %s",
                            frame.get("frame_type", "unknown"),
                            frame.get("request_id", "unknown"),
                            frame.get("error", "unknown error"),
                        )
                except Exception as error:
                    logger.warning("Could not process Agora frame: %s", error)
                    continue
        finally:
            self._mark_disconnected()

    async def _handle_inbound(self, frame: dict) -> None:
        author = frame.get("author") or {}
        # The platform registry applies AGORA_ALLOWED_USERS to human IDs. Agent
        # turns are intentionally ignored; Agora does not become an ambient
        # agent-to-agent execution channel.
        if author.get("type") != "user":
            return
        if self.require_mention and not frame.get("mentioned"):
            return
        if frame.get("any_mention") and not frame.get("mentioned"):
            return
        channel_id = str(frame["channel_id"])
        thread_id = frame.get("thread_id")
        paths, types = await self._localize_attachments(frame)
        text = str(frame.get("text") or "")
        if not text and paths:
            text = "Please review the attached file."
        source = SessionSource(
            platform=Platform("agora"),
            chat_id=channel_id,
            chat_name=str(frame.get("chat_name") or channel_id),
            chat_type="thread" if thread_id else "channel",
            user_id=str(author.get("id") or ""),
            user_name=str(author.get("name") or author.get("id") or "Agora user"),
            thread_id=str(thread_id) if thread_id is not None else None,
            message_id=str(frame.get("message_id") or "") or None,
        )
        await self.handle_message(MessageEvent(
            text=text,
            message_type=MessageType.TEXT,
            user_id=source.user_id,
            user_name=source.user_name,
            source=source,
            raw_message=frame,
            message_id=source.message_id,
            media_urls=paths,
            media_types=types,
        ))

    async def _localize_attachments(self, frame: dict) -> tuple[list[str], list[str]]:
        paths: list[str] = []
        types: list[str] = []
        if not self._temp_dir:
            return paths, types
        for index, attachment in enumerate((frame.get("attachments") or [])[:_MAX_ATTACHMENTS]):
            try:
                size = int(attachment.get("size") or 0)
                if size > self.max_file_bytes:
                    continue
                name = Path(str(attachment.get("filename") or f"attachment-{index}")).name
                destination = Path(self._temp_dir.name) / f"{uuid.uuid4().hex}-{name}"
                encoded = attachment.get("data_b64")
                if encoded:
                    data = base64.b64decode(encoded, validate=True)
                elif attachment.get("id"):
                    url = _http_file_url(self.socket_url, str(attachment["id"]), self.agent_id)
                    data = await asyncio.to_thread(self._download, url)
                else:
                    continue
                if len(data) > self.max_file_bytes:
                    continue
                destination.write_bytes(data)
                paths.append(str(destination))
                types.append(str(attachment.get("mime") or mimetypes.guess_type(name)[0] or "application/octet-stream"))
            except Exception as error:
                logger.warning("Could not localize Agora attachment %s: %s", index, error)
        return paths, types

    def _download(self, url: str) -> bytes:
        request = Request(url, headers={"Authorization": f"Bearer {self.token}"})
        with _NO_REDIRECT_OPENER.open(request, timeout=30) as response:
            return response.read(self.max_file_bytes + 1)

    async def send(self, chat_id: str, content: str, reply_to: Optional[str] = None,
                   metadata: Optional[Dict[str, Any]] = None) -> SendResult:
        request_id = uuid.uuid4().hex
        try:
            await self._write({
                "type": "post",
                "request_id": request_id,
                "agent_id": self.agent_id,
                "channel_id": chat_id,
                "thread_id": _thread_id(metadata),
                "text": content,
            })
        except Exception as error:
            return SendResult(success=False, error=str(error), retryable=True)
        return SendResult(success=True, message_id=request_id)

    async def send_image_file(self, chat_id: str, image_path: str,
                              caption: Optional[str] = None,
                              reply_to: Optional[str] = None,
                              metadata: Optional[Dict[str, Any]] = None,
                              **kwargs) -> SendResult:
        path = Path(image_path)
        try:
            size = path.stat().st_size
        except OSError as error:
            return SendResult(success=False, error=f"Could not read image: {error}")
        if size > self.max_file_bytes:
            limit_mb = self.max_file_bytes // (1024 * 1024)
            return SendResult(
                success=False,
                error=f"Image exceeds Agora's configured {limit_mb} MB file limit",
            )
        data = await asyncio.to_thread(path.read_bytes)
        request_id = uuid.uuid4().hex
        try:
            await self._write({
                "type": "post", "request_id": request_id, "agent_id": self.agent_id,
                "channel_id": chat_id, "thread_id": _thread_id(metadata),
                "text": caption or "", "attachments": [{
                    "filename": path.name,
                    "mime": mimetypes.guess_type(path.name)[0] or "application/octet-stream",
                    "data_b64": base64.b64encode(data).decode("ascii"),
                }],
            })
        except Exception as error:
            return SendResult(success=False, error=str(error), retryable=True)
        return SendResult(success=True, message_id=request_id)

    async def send_typing(self, chat_id: str, metadata=None) -> None:
        thread_id = _thread_id(metadata)
        try:
            await self._send_typing(chat_id, thread_id, True)
            self._typing.add((chat_id, thread_id))
        except Exception as error:
            logger.warning("Could not update Agora typing state: %s", error)

    async def _send_typing(self, chat_id: str, thread_id: Optional[int], active: bool) -> None:
        await self._write({"type": "typing", "agent_id": self.agent_id,
                           "channel_id": chat_id, "thread_id": thread_id,
                           "active": active})

    async def on_processing_start(self, event: MessageEvent) -> None:
        if event.source.chat_id and event.message_id:
            await self._add_reaction(event.source.chat_id, event.message_id, self._ACK_EMOJI)

    async def on_processing_complete(self, event: MessageEvent, outcome) -> None:
        thread_id = _thread_id({"thread_id": event.source.thread_id})
        try:
            await self._send_typing(event.source.chat_id, thread_id, False)
        except Exception as error:
            logger.warning("Could not clear Agora typing state: %s", error)
        finally:
            self._typing.discard((event.source.chat_id, thread_id))
        await super().on_processing_complete(event, outcome)

    async def _add_reaction(self, chat_id: str, message_id: str, emoji: str) -> bool:
        try:
            numeric_message_id = int(message_id)
        except (TypeError, ValueError):
            return False
        await self._write({"type": "reaction", "agent_id": self.agent_id,
                           "channel_id": chat_id, "message_id": numeric_message_id,
                           "emoji": emoji, "action": "add"})
        return True

    async def _remove_reaction(self, chat_id: str, message_id: str) -> bool:
        try:
            numeric_message_id = int(message_id)
        except (TypeError, ValueError):
            return False
        await self._write({"type": "reaction", "agent_id": self.agent_id,
                           "channel_id": chat_id, "message_id": numeric_message_id,
                           "emoji": self._ACK_EMOJI, "action": "remove"})
        return True

    async def get_chat_info(self, chat_id: str) -> dict:
        return {"name": chat_id, "type": "channel"}


def check_requirements() -> bool:
    try:
        return bool(os.getenv("AGORA_URL") and _token({}))
    except OSError:
        return False


def validate_config(config) -> bool:
    extra = getattr(config, "extra", {}) or {}
    try:
        return bool((os.getenv("AGORA_URL") or extra.get("url")) and _token(extra))
    except OSError:
        return False


def _env_enablement() -> Optional[dict]:
    if not check_requirements():
        return None
    return {
        "url": os.environ["AGORA_URL"],
        "pairing_token": _token({}),
        "agent_id": os.getenv("AGORA_AGENT_ID", "hermes-agent"),
        "agent_name": os.getenv("AGORA_AGENT_NAME", "Hermes"),
        "require_mention": _truthy(os.getenv("AGORA_REQUIRE_MENTION")),
    }


def register(ctx) -> None:
    ctx.register_platform(
        name="agora",
        label="Agora",
        adapter_factory=lambda config: AgoraAdapter(config),
        check_fn=check_requirements,
        validate_config=validate_config,
        required_env=["AGORA_URL"],
        env_enablement_fn=_env_enablement,
        allowed_users_env="AGORA_ALLOWED_USERS",
        allow_all_env="AGORA_ALLOW_ALL_USERS",
        max_message_length=8000,
        platform_hint="You are chatting in an Agora room. Markdown is supported.",
        emoji="🏛️",
    )
