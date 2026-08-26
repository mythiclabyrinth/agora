import asyncio
import importlib.util
import json
import os
import sys
import types
import unittest
import tempfile
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from unittest.mock import patch


class Platform(str, Enum):
    AGORA = "agora"

    @classmethod
    def _missing_(cls, value):
        obj = str.__new__(cls, value)
        obj._name_ = value.upper()
        obj._value_ = value
        return obj


@dataclass
class PlatformConfig:
    extra: dict = field(default_factory=dict)


class BasePlatformAdapter:
    def __init__(self, config, platform):
        self.config = config
        self.platform = platform
        self.events = []
    def _mark_connected(self): pass
    def _mark_disconnected(self): pass
    async def handle_message(self, event): self.events.append(event)
    async def on_processing_complete(self, event, outcome):
        self.completed = (event, outcome)


class MessageType(Enum):
    TEXT = "text"


@dataclass
class SessionSource:
    platform: object
    chat_id: str
    chat_name: str
    chat_type: str
    user_id: str
    user_name: str
    thread_id: str | None = None
    message_id: str | None = None


class MessageEvent:
    def __init__(self, **kwargs): self.__dict__.update(kwargs)


@dataclass
class SendResult:
    success: bool
    message_id: str | None = None
    error: str | None = None
    retryable: bool = False


def load_adapter():
    websockets = types.ModuleType("websockets")
    websockets.connect = None
    config = types.ModuleType("gateway.config")
    config.Platform, config.PlatformConfig = Platform, PlatformConfig
    base = types.ModuleType("gateway.platforms.base")
    for name, value in {"BasePlatformAdapter": BasePlatformAdapter,
                        "MessageEvent": MessageEvent, "MessageType": MessageType,
                        "SendResult": SendResult}.items(): setattr(base, name, value)
    session = types.ModuleType("gateway.session")
    session.SessionSource = SessionSource
    modules = {"websockets": websockets, "gateway": types.ModuleType("gateway"),
               "gateway.config": config, "gateway.platforms": types.ModuleType("gateway.platforms"),
               "gateway.platforms.base": base, "gateway.session": session}
    with patch.dict(sys.modules, modules):
        path = Path(__file__).with_name("adapter.py")
        spec = importlib.util.spec_from_file_location("agora_test_adapter", path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module


class AdapterTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.module = load_adapter()

    def adapter(self):
        with patch.dict(os.environ, {"AGORA_URL": "http://127.0.0.1:4470",
                                     "AGORA_PAIRING_TOKEN": "secret"}, clear=True):
            return self.module.AgoraAdapter(PlatformConfig())

    def test_reads_optional_per_agent_bot_loop_limit(self):
        with patch.dict(os.environ, {"AGORA_URL": "http://127.0.0.1:4470",
                                     "AGORA_PAIRING_TOKEN": "secret",
                                     "AGORA_BOT_LOOP_LIMIT": "21"}, clear=True):
            adapter = self.module.AgoraAdapter(PlatformConfig())
        self.assertEqual(adapter.bot_loop_limit, "21")

    def test_remote_plaintext_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "loopback"):
            self.module._socket_url("ws://example.com", "secret")

    def test_channel_and_thread_are_preserved_for_session_keying(self):
        adapter = self.adapter()
        frame = {"type": "inbound", "channel_id": "room-1", "thread_id": "thread-2",
                 "chat_name": "Main", "message_id": 42, "text": "hello", "any_mention": False,
                 "author": {"id": "alice", "name": "Alice", "type": "user"},
                 "attachments": []}
        asyncio.run(adapter._handle_inbound(frame))
        source = adapter.events[0].source
        self.assertEqual((source.chat_id, source.thread_id, source.chat_type),
                         ("room-1", "thread-2", "thread"))
        self.assertEqual(source.chat_name, "Main")

    def test_agent_authors_and_other_mentions_are_ignored(self):
        adapter = self.adapter()
        base = {"channel_id": "room", "thread_id": None, "message_id": 1,
                "text": "run this", "attachments": []}
        asyncio.run(adapter._handle_inbound({**base, "any_mention": False,
                    "author": {"id": "bot", "type": "agent"}}))
        asyncio.run(adapter._handle_inbound({**base, "any_mention": True, "mentioned": False,
                    "author": {"id": "alice", "type": "user"}}))
        self.assertEqual(adapter.events, [])

    def test_mention_only_mode_is_enforced_by_adapter(self):
        adapter = self.adapter()
        adapter.require_mention = True
        frame = {"channel_id": "room", "thread_id": None, "message_id": 1,
                 "text": "hello", "attachments": [], "any_mention": False,
                 "mentioned": False,
                 "author": {"id": "alice", "type": "user"}}
        asyncio.run(adapter._handle_inbound(frame))
        self.assertEqual(adapter.events, [])

    def test_registration_uses_hermes_platform_contract(self):
        calls = []
        self.module.register(types.SimpleNamespace(register_platform=lambda **kw: calls.append(kw)))
        entry = calls[0]
        self.assertEqual(entry["name"], "agora")
        self.assertEqual(entry["allowed_users_env"], "AGORA_ALLOWED_USERS")
        with patch.dict(os.environ, {}, clear=True):
            self.assertFalse(entry["env_enablement_fn"]())

    def test_disconnected_send_is_retryable(self):
        result = asyncio.run(self.adapter().send("room", "hello"))
        self.assertFalse(result.success)
        self.assertTrue(result.retryable)

    def test_oversized_image_is_rejected_before_socket_write(self):
        adapter = self.adapter()
        adapter.max_file_bytes = 2
        path = Path(__file__).with_name("plugin.yaml")
        result = asyncio.run(adapter.send_image_file("room", str(path)))
        self.assertFalse(result.success)
        self.assertIn("file limit", result.error)

    def test_error_frame_is_logged(self):
        class Frames:
            def __aiter__(self):
                self.frames = iter([json.dumps({"type": "error", "frame_type": "post",
                    "request_id": "post-1", "error": "not a member"})])
                return self
            async def __anext__(self):
                try: return next(self.frames)
                except StopIteration: raise StopAsyncIteration
        adapter = self.adapter()
        adapter._socket = Frames()
        with self.assertLogs("agora_test_adapter", level="WARNING") as logs:
            asyncio.run(adapter._read_loop())
        self.assertIn("post request post-1", logs.output[0])

    def test_invalid_outbound_reaction_id_is_ignored(self):
        adapter = self.adapter()
        self.assertFalse(asyncio.run(adapter._add_reaction("room", "uuid", "👀")))
        self.assertFalse(asyncio.run(adapter._remove_reaction("room", "uuid")))

    def test_attachment_failure_does_not_discard_valid_sibling(self):
        adapter = self.adapter()
        with tempfile.TemporaryDirectory() as directory:
            adapter._temp_dir = types.SimpleNamespace(name=directory)
            frame = {"attachments": [
                {"filename": "bad.png", "mime": "image/png", "data_b64": "%%%"},
                {"filename": "good.txt", "mime": "text/plain", "data_b64": "aGk="},
            ]}
            with self.assertLogs("agora_test_adapter", level="WARNING"):
                paths, media_types = asyncio.run(adapter._localize_attachments(frame))
            self.assertEqual(len(paths), 1)
            self.assertEqual(Path(paths[0]).read_text(), "hi")
            self.assertEqual(media_types, ["text/plain"])

    def test_thread_ids_are_numeric_in_posts_and_typing_lifecycle(self):
        class Socket:
            def __init__(self): self.frames = []
            async def send(self, raw): self.frames.append(json.loads(raw))
            async def close(self): pass
        adapter = self.adapter()
        socket = Socket()
        adapter._socket = socket
        result = asyncio.run(adapter.send("room", "reply", metadata={"thread_id": "42"}))
        self.assertTrue(result.success)
        asyncio.run(adapter.send_typing("room", metadata={"thread_id": "42"}))
        source = SessionSource(Platform.AGORA, "room", "Main", "thread",
                               "alice", "Alice", thread_id="42", message_id="7")
        event = MessageEvent(source=source)
        asyncio.run(adapter.on_processing_complete(event, "success"))
        self.assertEqual(socket.frames[0]["thread_id"], 42)
        self.assertEqual(socket.frames[1]["thread_id"], 42)
        self.assertTrue(socket.frames[1]["active"])
        self.assertEqual(socket.frames[2]["thread_id"], 42)
        self.assertFalse(socket.frames[2]["active"])
        self.assertEqual(adapter.completed, (event, "success"))

    def test_invalid_thread_id_falls_back_to_channel_root(self):
        self.assertIsNone(self.module._thread_id({"thread_id": "not-a-number"}))


if __name__ == "__main__":
    unittest.main()
