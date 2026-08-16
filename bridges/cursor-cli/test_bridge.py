import asyncio
import importlib.util
import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, Mock, patch


SPEC = importlib.util.spec_from_file_location(
    "cursor_bridge", Path(__file__).with_name("bridge.py")
)
bridge = importlib.util.module_from_spec(SPEC)
assert SPEC.loader
SPEC.loader.exec_module(bridge)


class FakeResponse(io.BytesIO):
    def __enter__(self): return self
    def __exit__(self, *_args): self.close()


class AdvancingClock:
    def __init__(self, step=31):
        self.now = -step
        self.step = step

    def __call__(self):
        self.now += self.step
        return self.now


class AttachmentFetchTests(unittest.TestCase):
    def test_http_base_preserves_server_prefix(self):
        self.assertEqual(bridge.Bridge._http_base("ws://host/p/agent/ws?token=x"), "http://host/p")

    def test_fetches_missing_inline_bytes_and_cleans_truncation(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(bridge._NO_REDIRECT_OPENER, "open", return_value=FakeResponse(b"image")):
            saved, images, _notes = bridge.materialize_attachments(
                [{"id": "f/1", "filename": "x.png", "mime": "image/png", "size": 5}],
                Path(tmp), "http://host", "token", "cursor-cli")
            self.assertEqual(saved, images)
            self.assertEqual(saved[0].read_bytes(), b"image")
            request = bridge._NO_REDIRECT_OPENER.open.call_args.args[0]
            self.assertEqual(request.full_url, "http://host/agent/files/f%2F1?agent_id=cursor-cli")
            self.assertEqual(request.headers["Authorization"], "Bearer token")
        with tempfile.TemporaryDirectory() as tmp, patch.object(bridge._NO_REDIRECT_OPENER, "open", return_value=FakeResponse(b"short")):
            saved, images, notes = bridge.materialize_attachments(
                [{"id": "f1", "filename": "x.png", "mime": "image/png", "size": 6}],
                Path(tmp), "http://host", "token", "cursor-cli")
            self.assertEqual((saved, images, list(Path(tmp).iterdir())), ([], [], []))
            self.assertIn("downloaded size mismatch", notes[0])

    def test_refuses_redirects_and_enforces_total_deadline(self):
        self.assertEqual(bridge.ATTACHMENT_FETCH_TIMEOUT + (100 * 1024 * 1024) / bridge.MIN_DOWNLOAD_RATE_BYTES_PER_SECOND, 130)
        self.assertIsNone(bridge._NoRedirectHandler().redirect_request(Mock(), None, 302, "Found", {}, "https://elsewhere/file"))
        with tempfile.TemporaryDirectory() as tmp, patch.object(bridge.time, "monotonic", new=AdvancingClock()), patch.object(bridge._NO_REDIRECT_OPENER, "open") as fetch:
            fetch.return_value.__enter__.return_value.read1.return_value = b"image"
            saved, images, notes = bridge.materialize_attachments(
                [{"id": "f1", "filename": "x.png", "mime": "image/png", "size": 5}], Path(tmp),
                "http://host", "token", "cursor-cli")
            self.assertEqual((saved, images, list(Path(tmp).iterdir())), ([], [], []))
            self.assertIn("total-transfer deadline", notes[0])

    def test_rejects_oversize_and_overread_with_cleanup(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(bridge._NO_REDIRECT_OPENER, "open") as fetch:
            saved, images, notes = bridge.materialize_attachments(
                [{"id": "f1", "filename": "huge", "size": bridge.MAX_INBOUND_ATTACHMENT_BYTES + 1}],
                Path(tmp), "http://host", "token", "cursor-cli")
            fetch.assert_not_called()
            self.assertEqual((saved, images), ([], []))
            self.assertIn("safety limit", notes[0])
        with tempfile.TemporaryDirectory() as tmp, patch.object(bridge._NO_REDIRECT_OPENER, "open", return_value=FakeResponse(b"toolong")):
            saved, images, notes = bridge.materialize_attachments(
                [{"id": "f1", "filename": "x", "size": 5}], Path(tmp),
                "http://host", "token", "cursor-cli")
            self.assertEqual((saved, images, list(Path(tmp).iterdir())), ([], [], []))
            self.assertIn("downloaded size mismatch", notes[0])

    def test_legacy_metadata_falls_back_and_inline_bytes_win_over_id(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(bridge._NO_REDIRECT_OPENER, "open") as fetch:
            saved, images, notes = bridge.materialize_attachments(
                [{"filename": "legacy.mov", "mime": "video/quicktime", "size": 99}],
                Path(tmp), "http://host", "token", "cursor-cli")
            self.assertEqual((saved, images), ([], []))
            self.assertIn("too large to inline; not available locally", notes[0])
            saved, images, _notes = bridge.materialize_attachments(
                [{"id": "f1", "filename": "inline.png", "mime": "image/png",
                  "size": 5, "data_b64": "aW1hZ2U="}],
                Path(tmp), "http://host", "token", "cursor-cli")
            self.assertEqual(saved, images)
            self.assertEqual(saved[0].read_bytes(), b"image")
            fetch.assert_not_called()


class ModelSelectionTests(unittest.TestCase):
    def test_cursor_model_ids_and_parameters_are_accepted(self):
        self.assertEqual(bridge.normalize_model("gpt-5"), "gpt-5")
        self.assertEqual(
            bridge.normalize_model("claude-opus-4-8[effort=high,fast=false]"),
            "claude-opus-4-8[effort=high,fast=false]",
        )

    def test_shell_metacharacters_are_rejected(self):
        self.assertIsNone(bridge.normalize_model("gpt-5; touch /tmp/no"))

    def test_aliases_resolve_to_full_ids(self):
        self.assertEqual(bridge.resolve_model("grok"), "cursor-grok-4.5-high-fast")
        self.assertEqual(bridge.resolve_model("OPUS"), "claude-opus-5-thinking-high-fast")
        # Non-alias ids pass through validation unchanged.
        self.assertEqual(bridge.resolve_model("gpt-5.5-high-fast"), "gpt-5.5-high-fast")
        self.assertIsNone(bridge.resolve_model("grok; rm -rf /"))

    def test_model_command_accepts_alias(self):
        instance = bridge.Bridge.__new__(bridge.Bridge)
        instance.bindings = {"channel": {"cwd": "/tmp"}}
        instance.default_model = None
        instance._save_state = Mock()

        reply = instance._cmd_model("channel", "sonnet")

        self.assertEqual(
            instance.bindings["channel"]["model"], "claude-sonnet-5-thinking-high"
        )
        self.assertIn("claude-sonnet-5-thinking-high", reply)

    def test_model_command_persists_canonical_id(self):
        instance = bridge.Bridge.__new__(bridge.Bridge)
        instance.bindings = {"channel": {"cwd": "/tmp"}}
        instance.default_model = None
        instance._save_state = Mock()

        reply = instance._cmd_model("channel", "gpt-5")

        self.assertEqual(instance.bindings["channel"]["model"], "gpt-5")
        self.assertIn("gpt-5", reply)
        instance._save_state.assert_called_once()

    def test_default_clears_override_and_falls_back_to_sol(self):
        instance = bridge.Bridge.__new__(bridge.Bridge)
        instance.bindings = {
            "channel": {"cwd": "/tmp", "model": "gpt-5"}
        }
        instance.default_model = None
        instance._save_state = Mock()

        reply = instance._cmd_model("channel", "default")

        self.assertNotIn("model", instance.bindings["channel"])
        self.assertIn("Cursor Auto", reply)


class CursorBinaryTests(unittest.TestCase):
    def test_explicit_executable_path_is_resolved(self):
        with tempfile.TemporaryDirectory() as directory:
            executable = Path(directory) / "agent"
            executable.write_text("#!/bin/sh\n")
            executable.chmod(0o700)
            self.assertEqual(
                bridge.resolve_agent_bin(str(executable)), str(executable.resolve())
            )

    def test_missing_explicit_path_returns_none(self):
        self.assertIsNone(bridge.resolve_agent_bin("/definitely/missing/agent"))


class ProgressSnippetTests(unittest.TestCase):
    def test_formats_tool_path_and_phase(self):
        event = {
            "type": "tool_call",
            "subtype": "started",
            "tool_call": {"readToolCall": {"args": {"path": "src/auth.rs"}}},
        }
        self.assertEqual(
            bridge.Bridge._progress_snippet(event),
            "readToolCall started: src/auth.rs",
        )

    def test_formats_terminal_command(self):
        event = {
            "type": "tool_call",
            "subtype": "completed",
            "tool_call": {"terminalToolCall": {"args": {"command": "cargo test"}}},
        }
        self.assertEqual(
            bridge.Bridge._progress_snippet(event),
            "terminalToolCall completed: cargo test",
        )

    def test_falls_back_for_unknown_or_empty_tool_shape(self):
        self.assertEqual(
            bridge.Bridge._progress_snippet(
                {"subtype": "started", "tool_call": {"customToolCall": {}}}
            ),
            "customToolCall started",
        )
        self.assertEqual(
            bridge.Bridge._progress_snippet({"subtype": "started"}),
            "tool started",
        )


class ModeSelectionTests(unittest.TestCase):
    def test_force_requires_bridge_opt_in(self):
        instance = bridge.Bridge.__new__(bridge.Bridge)
        instance.bindings = {"channel": {"cwd": "/tmp"}}
        instance.default_mode = "agent"
        instance.allow_force = False
        instance.disable_sandbox = False
        instance._save_state = Mock()
        self.assertIn("disabled", instance._cmd_mode("channel", "force"))
        self.assertNotIn("mode", instance.bindings["channel"])


def make_bridge(peer_agents=""):
    """A Bridge with just enough state to drive handle_inbound."""
    instance = bridge.Bridge.__new__(bridge.Bridge)
    instance.agent_id = "cursor-cli"
    instance.agent_name = "Cursor"
    instance.peer_agents = bridge.parse_peer_agents(peer_agents)
    instance.context_buffer = {}
    instance.context_buffer_limit = 50
    instance.busy = set()
    instance.bindings = {}
    instance.set_reaction = Mock()
    instance.clear_reaction = Mock()
    instance.post = Mock()
    instance.forward_to_agent = AsyncMock()
    return instance


def peer_frame(**overrides):
    frame = {
        "channel_id": "c1",
        "author": {"type": "agent", "id": "claude-cli", "name": "Claude"},
        "mentioned": True,
        "any_mention": True,
        "text": "@agent please review the diff",
        "bot_turns_left": 3,
    }
    frame.update(overrides)
    return frame


class PeerConfigTests(unittest.TestCase):
    def test_parse_normalizes_case_whitespace_and_empties(self):
        self.assertEqual(
            bridge.parse_peer_agents(" Claude-CLI ,, other-bot "),
            frozenset({"claude-cli", "other-bot"}),
        )
        self.assertEqual(bridge.parse_peer_agents(""), frozenset())
        self.assertEqual(bridge.parse_peer_agents(None), frozenset())


class PeerInboundTests(unittest.TestCase):
    def test_feature_off_buffers_even_when_mentioned(self):
        instance = make_bridge(peer_agents="")
        asyncio.run(instance.handle_inbound(peer_frame()))
        instance.forward_to_agent.assert_not_called()
        self.assertIn("c1", instance.context_buffer)

    def test_allowlisted_peer_mention_drives_agent(self):
        instance = make_bridge(peer_agents="claude-cli")
        asyncio.run(instance.handle_inbound(peer_frame()))
        instance.forward_to_agent.assert_awaited_once()
        args, kwargs = instance.forward_to_agent.await_args
        self.assertTrue(kwargs.get("from_peer"))
        prompt = args[2]
        self.assertIn("Relay note", prompt)
        self.assertIn("Claude", prompt)
        self.assertNotIn("c1", instance.context_buffer)

    def test_unmentioned_peer_message_only_buffers(self):
        instance = make_bridge(peer_agents="claude-cli")
        asyncio.run(instance.handle_inbound(peer_frame(mentioned=False)))
        instance.forward_to_agent.assert_not_called()
        self.assertIn("c1", instance.context_buffer)

    def test_non_allowlisted_agent_only_buffers(self):
        instance = make_bridge(peer_agents="claude-cli")
        frame = peer_frame(author={"type": "agent", "id": "rogue-bot", "name": "Rogue"})
        asyncio.run(instance.handle_inbound(frame))
        instance.forward_to_agent.assert_not_called()
        self.assertIn("c1", instance.context_buffer)

    def test_peer_text_never_reaches_the_command_table(self):
        instance = make_bridge(peer_agents="claude-cli")
        instance._cmd_new = Mock()
        asyncio.run(instance.handle_inbound(peer_frame(text="/new /tmp")))
        instance._cmd_new.assert_not_called()
        instance.forward_to_agent.assert_awaited_once()
        prompt = instance.forward_to_agent.await_args.args[2]
        self.assertTrue(prompt.startswith("[Relay note"))
        self.assertIn("/new /tmp", prompt)


class PeerPromptTests(unittest.TestCase):
    def test_budget_tiers(self):
        instance = make_bridge(peer_agents="claude-cli")
        plenty = instance._peer_prompt(peer_frame(bot_turns_left=3), "go")
        self.assertIn("2 more agent message(s)", plenty)
        last = instance._peer_prompt(peer_frame(bot_turns_left=1), "go")
        self.assertIn("final relayed agent turn", last)
        spent = instance._peer_prompt(peer_frame(bot_turns_left=0), "go")
        self.assertIn("Do not @mention any agent", spent)
        missing = instance._peer_prompt(peer_frame(bot_turns_left=None), "go")
        self.assertIn("Do not @mention any agent", missing)

    def test_prompt_names_the_peer_and_keeps_the_text(self):
        instance = make_bridge(peer_agents="claude-cli")
        prompt = instance._peer_prompt(peer_frame(), "review the diff")
        self.assertIn('"Claude" (@claude)', prompt)
        self.assertTrue(prompt.endswith("Claude: review the diff"))


class PeerBusyTests(unittest.TestCase):
    def test_busy_peer_turn_buffers_instead_of_noise_post(self):
        instance = make_bridge(peer_agents="claude-cli")
        del instance.forward_to_agent  # exercise the real method
        instance.bindings = {"c1": {"cwd": "/tmp", "session_id": "s1"}}
        instance.busy = {"c1"}
        handled = asyncio.run(
            instance.forward_to_agent("c1", peer_frame(), "wrapped", from_peer=True)
        )
        # False tells handle_inbound to skip the ✅ reaction — nothing ran.
        self.assertFalse(handled)
        instance.post.assert_not_called()
        self.assertIn("c1", instance.context_buffer)
        instance.clear_reaction.assert_called_once()

    def test_busy_human_turn_still_gets_the_notice(self):
        instance = make_bridge()
        del instance.forward_to_agent
        instance.bindings = {"c1": {"cwd": "/tmp", "session_id": "s1"}}
        instance.busy = {"c1"}
        frame = {"channel_id": "c1", "author": {"type": "user", "id": "tom"}}
        handled = asyncio.run(instance.forward_to_agent("c1", frame, "hello"))
        self.assertTrue(handled)
        instance.post.assert_called_once()
        self.assertIn("Still working", instance.post.call_args.args[1])


class PromptSuffixTests(unittest.TestCase):
    def test_collab_suffix_rides_only_with_peer_agents(self):
        instance = make_bridge(peer_agents="claude-cli")
        instance.tldr_default = False
        self.assertEqual(
            instance._prompt_suffixes({}), bridge.COLLAB_PROMPT_SUFFIX + bridge.ATTACH_PROMPT_SUFFIX)
        instance.peer_agents = frozenset()
        self.assertEqual(instance._prompt_suffixes({}), bridge.ATTACH_PROMPT_SUFFIX)
        instance.tldr_default = True
        self.assertEqual(
            instance._prompt_suffixes({}), bridge.TLDR_PROMPT_SUFFIX + bridge.ATTACH_PROMPT_SUFFIX)


class OutboundAttachmentTests(unittest.TestCase):
    def test_malformed_attachment_limit_env_falls_back(self):
        with patch.dict("os.environ", {"AGORA_MAX_FILE_MB": "bad"}):
            self.assertEqual(bridge.parse_positive_int("bad", 10), 10)

    def test_empty_run_posts_original_fallback(self):
        instance = make_bridge()
        del instance.forward_to_agent
        instance.bindings = {"c1": {"cwd": "/tmp", "session_id": "s1"}}
        instance.run_agent = AsyncMock(return_value="")
        instance.typing = Mock()
        instance.tldr_default = False
        instance.tldr_min_chars = 1500
        instance.allowed_roots = []
        instance.max_attachment_bytes = 10 * 1024 * 1024
        asyncio.run(instance.forward_to_agent("c1", {"channel_id": "c1"}, "hello"))
        self.assertEqual(instance.post.call_args.args[1], "(empty response)")

    def test_extracts_image_and_reports_missing_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "screen shot.png"
            path.write_bytes(b"\x89PNG\r\n\x1a\nimage")
            body, attachments, notices = bridge.Bridge._split_outbound_attachments(
                f"Here it is.\n{bridge.ATTACH_SENTINEL} {path}", tmp, [], 10 * 1024 * 1024)
        self.assertEqual((body, notices), ("Here it is.", []))
        self.assertEqual(attachments[0]["filename"], "screen shot.png")
        self.assertEqual(attachments[0]["mime"], "image/png")
        body, attachments, notices = bridge.Bridge._split_outbound_attachments(
            f"Done\n{bridge.ATTACH_SENTINEL} /missing/nope.png", "/", [], 10 * 1024 * 1024)
        self.assertEqual((body, attachments, len(notices)), ("Done", [], 1))

    def test_attachments_ride_only_the_first_text_chunk(self):
        instance = bridge.Bridge.__new__(bridge.Bridge)
        instance.agent_id = "cursor-cli"
        instance.send = Mock()
        attachment = {"filename": "x.png", "mime": "image/png", "data_b64": "eA=="}
        instance.post({"channel_id": "c1"}, "x" * (bridge.MAX_POST_CHARS + 1), attachments=[attachment])
        self.assertEqual(instance.send.call_count, 2)
        self.assertEqual(instance.send.call_args_list[0].args[0]["attachments"], [attachment])
        self.assertNotIn("attachments", instance.send.call_args_list[1].args[0])

    def test_attachment_limits_and_path_containment(self):
        too_many = "\n".join(f"{bridge.ATTACH_SENTINEL} image-{i}.png" for i in range(6))
        _, attachments, notices = bridge.Bridge._split_outbound_attachments(too_many, "/tmp", [], 10)
        self.assertEqual((attachments, len(notices)), ([], 1))
        with tempfile.TemporaryDirectory() as tmp, tempfile.TemporaryDirectory() as outside:
            large = Path(tmp) / "large.png"
            large.write_bytes(b"\x89PNG\r\n\x1a\n" + b"x" * 16)
            with patch.object(Path, "read_bytes", side_effect=AssertionError("oversize file read")):
                _, attachments, notices = bridge.Bridge._split_outbound_attachments(
                    f"{bridge.ATTACH_SENTINEL} {large}", tmp, [], 8)
            self.assertEqual((attachments, len(notices)), ([], 1))
            secret = Path(outside) / "secret.png"
            secret.write_bytes(b"\x89PNG\r\n\x1a\nimage")
            _, attachments, notices = bridge.Bridge._split_outbound_attachments(
                f"{bridge.ATTACH_SENTINEL} {secret}", tmp, [], 1024)
            self.assertEqual((attachments, len(notices)), ([], 1))
            link = Path(tmp) / "link.png"
            link.symlink_to(secret)
            _, attachments, notices = bridge.Bridge._split_outbound_attachments(
                f"{bridge.ATTACH_SENTINEL} {link}", tmp, [], 1024)
            self.assertEqual((attachments, len(notices)), ([], 1))

    def test_duplicate_attachment_paths_upload_once(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "same.png"
            path.write_bytes(b"\x89PNG\r\n\x1a\nimage")
            line = f"{bridge.ATTACH_SENTINEL} {path}"
            _, attachments, notices = bridge.Bridge._split_outbound_attachments(
                f"{line}\n{line}", tmp, [], 1024)
            self.assertEqual((len(attachments), notices), (1, []))


def _fake_proc(lines):
    """A stand-in for the CLI child process that replays `lines` on stdout."""
    stdout = asyncio.StreamReader()
    for line in lines:
        stdout.feed_data(line.encode() + b"\n")
    stdout.feed_eof()
    stderr = asyncio.StreamReader()
    stderr.feed_eof()

    proc = Mock()
    proc.stdout = stdout
    proc.stderr = stderr
    proc.stdin = Mock()
    proc.stdin.write = Mock()
    proc.stdin.close = Mock()
    proc.wait = AsyncMock(return_value=0)
    proc.kill = Mock()
    proc.returncode = 0
    return proc


def _assistant(text):
    return json.dumps({"type": "assistant",
                       "message": {"content": [{"type": "text", "text": text}]}})


def _cursor_result(text, **extra):
    frame = {"type": "result", "subtype": "success", "result": text,
             "session_id": "sess-1"}
    frame.update(extra)
    return json.dumps(frame)


def run_cursor_stream(lines):
    """Drive the real run_agent() against a scripted stdout stream."""
    b = make_bridge()
    b.agent_bin = "agent"
    b.base_agent_args = []
    b.default_model = None
    b.default_mode = "agent"
    b.disable_sandbox = False
    b.timeout = 10
    b.procs = {}
    b.stop_requested = set()
    b.progress = Mock()
    b._stage_attachments = Mock(return_value=("hi", [], None))
    b._prompt_suffixes = Mock(return_value="")
    b._save_state = Mock()

    async def main():
        proc = _fake_proc(lines)  # StreamReader needs a running loop

        async def fake_exec(*a, **kw):
            return proc

        original_exec = asyncio.create_subprocess_exec
        asyncio.create_subprocess_exec = fake_exec
        try:
            return await b.run_agent(
                "k", {"channel_id": "c1"}, {"cwd": "/tmp"}, "hi")
        finally:
            asyncio.create_subprocess_exec = original_exec

    return asyncio.run(main()), b


class PartialStreamTests(unittest.TestCase):
    """`--stream-partial-output` sends each message as deltas *and* again as a
    consolidated copy. Only `result` may build the reply, or it doubles."""

    def test_deltas_and_consolidated_copy_are_not_doubled(self):
        reply, _ = run_cursor_stream([
            _assistant("hello"), _assistant(" world"),
            _assistant("hello world"),          # consolidated repeat
            _cursor_result("hello world"),
        ])
        self.assertEqual(reply, "hello world")

    def test_multi_message_turn_keeps_result_ordering(self):
        reply, _ = run_cursor_stream([
            _assistant("**Step 1**"), _assistant("**Step 1**"),
            _assistant("did a thing."), _assistant("**Step 1**did a thing."),
            _cursor_result("**Step 1**did a thing."),
        ])
        self.assertEqual(reply, "**Step 1**did a thing.")

    def test_assistant_text_still_drives_progress(self):
        _, b = run_cursor_stream([_assistant("working on it"),
                                  _cursor_result("done")])
        self.assertTrue(b.progress.called)

    def test_missing_result_falls_back_to_last_chunk(self):
        """A turn that ends without a result must not raise 'no result'."""
        reply, _ = run_cursor_stream([_assistant("partial answer"),
                                      _cursor_result("")])
        self.assertEqual(reply, "partial answer")


if __name__ == "__main__":
    unittest.main()
