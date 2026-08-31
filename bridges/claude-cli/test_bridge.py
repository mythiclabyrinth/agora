import asyncio
import json
import importlib.util
import io
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, Mock, patch


SPEC = importlib.util.spec_from_file_location(
    "claude_bridge", Path(__file__).with_name("bridge.py")
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
        self.assertEqual(
            bridge.Bridge._http_base("wss://example.test/agora/agent/ws?token=secret"),
            "https://example.test/agora",
        )

    def test_fetches_missing_inline_bytes_and_rejects_truncation(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(
            bridge._NO_REDIRECT_OPENER, "open", return_value=FakeResponse(b"video")
        ) as fetch:
            saved, notes = bridge.materialize_attachments(
                [{"id": "f/1", "filename": "clip.mov", "mime": "video/quicktime", "size": 5}],
                Path(tmp), "https://example.test", "secret", "claude-cli",
            )
            self.assertEqual(saved[0].read_bytes(), b"video")
            self.assertIn("Authorization", fetch.call_args.args[0].headers)
            self.assertEqual(
                fetch.call_args.args[0].full_url,
                "https://example.test/agent/files/f%2F1?agent_id=claude-cli",
            )
            self.assertIn("5 bytes", notes[0])
        with tempfile.TemporaryDirectory() as tmp, patch.object(
            bridge._NO_REDIRECT_OPENER, "open", return_value=FakeResponse(b"short")
        ):
            saved, notes = bridge.materialize_attachments(
                [{"id": "f1", "filename": "clip.mov", "mime": "video/quicktime", "size": 6}],
                Path(tmp), "https://example.test", "secret", "claude-cli",
            )
            self.assertEqual(saved, [])
            self.assertEqual(list(Path(tmp).iterdir()), [])
            self.assertIn("downloaded size mismatch", notes[0])

    def test_refuses_redirects_and_enforces_total_transfer_deadline(self):
        self.assertEqual(
            bridge.ATTACHMENT_FETCH_TIMEOUT
            + (100 * 1024 * 1024) / bridge.MIN_DOWNLOAD_RATE_BYTES_PER_SECOND,
            130,
        )
        self.assertIsNone(bridge._NoRedirectHandler().redirect_request(
            Mock(), None, 302, "Found", {}, "https://elsewhere.test/file"
        ))
        with tempfile.TemporaryDirectory() as tmp, patch.object(
            bridge.time, "monotonic", new=AdvancingClock()
        ), patch.object(bridge._NO_REDIRECT_OPENER, "open") as fetch:
            fetch.return_value.__enter__.return_value.read1.return_value = b"video"
            saved, notes = bridge.materialize_attachments(
                [{"id": "f1", "filename": "clip.mov", "mime": "video/quicktime", "size": 5}],
                Path(tmp), "https://example.test", "secret", "claude-cli",
            )
            self.assertEqual(saved, [])
            self.assertEqual(list(Path(tmp).iterdir()), [])
            self.assertIn("total-transfer deadline", notes[0])

    def test_rejects_oversize_advertisement_and_midstream_overread(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(
            bridge._NO_REDIRECT_OPENER, "open"
        ) as fetch:
            saved, notes = bridge.materialize_attachments(
                [{"id": "f1", "filename": "huge", "size": bridge.MAX_INBOUND_ATTACHMENT_BYTES + 1}],
                Path(tmp), "https://example.test", "secret", "claude-cli",
            )
            fetch.assert_not_called()
            self.assertEqual(saved, [])
            self.assertIn("safety limit", notes[0])
        with tempfile.TemporaryDirectory() as tmp, patch.object(
            bridge._NO_REDIRECT_OPENER, "open", return_value=FakeResponse(b"toolong")
        ):
            saved, notes = bridge.materialize_attachments(
                [{"id": "f1", "filename": "clip", "size": 5}], Path(tmp),
                "https://example.test", "secret", "claude-cli",
            )
            self.assertEqual(saved, [])
            self.assertEqual(list(Path(tmp).iterdir()), [])
            self.assertIn("downloaded size mismatch", notes[0])

    def test_legacy_metadata_falls_back_and_inline_bytes_win_over_id(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(
            bridge._NO_REDIRECT_OPENER, "open"
        ) as fetch:
            saved, notes = bridge.materialize_attachments(
                [{"filename": "legacy.mov", "mime": "video/quicktime", "size": 99}],
                Path(tmp), "https://example.test", "secret", "claude-cli",
            )
            self.assertEqual(saved, [])
            self.assertIn("too large to inline; not available locally", notes[0])
            saved, _notes = bridge.materialize_attachments(
                [{"id": "f1", "filename": "inline.bin", "mime": "application/octet-stream",
                  "size": 5, "data_b64": "aW1hZ2U="}],
                Path(tmp), "https://example.test", "secret", "claude-cli",
            )
            self.assertEqual(saved[0].read_bytes(), b"image")
            fetch.assert_not_called()


def make_bridge(peer_agents=""):
    """A Bridge with just enough state to drive handle_inbound."""
    instance = bridge.Bridge.__new__(bridge.Bridge)
    instance.agent_id = "claude-cli"
    instance.agent_name = "Claude"
    instance.peer_agents = bridge.parse_peer_agents(peer_agents)
    instance.context_buffer = {}
    instance.context_buffer_limit = 50
    instance.busy = set()
    instance.bindings = {}
    instance.pending_questions = {}
    instance.set_reaction = Mock()
    instance.clear_reaction = Mock()
    instance.post = Mock()
    instance.forward_to_claude = AsyncMock()
    return instance


def peer_frame(**overrides):
    frame = {
        "channel_id": "c1",
        "author": {"type": "agent", "id": "codex-cli", "name": "Codex"},
        "mentioned": True,
        "any_mention": True,
        "text": "@claude please review the diff",
        "bot_turns_left": 3,
    }
    frame.update(overrides)
    return frame


class PeerConfigTests(unittest.TestCase):
    def test_parse_normalizes_case_whitespace_and_empties(self):
        self.assertEqual(
            bridge.parse_peer_agents(" Codex-CLI ,, other-bot "),
            frozenset({"codex-cli", "other-bot"}),
        )
        self.assertEqual(bridge.parse_peer_agents(""), frozenset())
        self.assertEqual(bridge.parse_peer_agents(None), frozenset())


class PeerInboundTests(unittest.TestCase):
    def test_feature_off_buffers_even_when_mentioned(self):
        instance = make_bridge(peer_agents="")
        asyncio.run(instance.handle_inbound(peer_frame()))
        instance.forward_to_claude.assert_not_called()
        self.assertIn("c1", instance.context_buffer)

    def test_allowlisted_peer_mention_drives_claude(self):
        instance = make_bridge(peer_agents="codex-cli")
        asyncio.run(instance.handle_inbound(peer_frame()))
        instance.forward_to_claude.assert_awaited_once()
        args, kwargs = instance.forward_to_claude.await_args
        self.assertTrue(kwargs.get("from_peer"))
        prompt = args[2]
        self.assertIn("Relay note", prompt)
        self.assertIn("Codex", prompt)
        self.assertNotIn("c1", instance.context_buffer)

    def test_unmentioned_peer_message_only_buffers(self):
        instance = make_bridge(peer_agents="codex-cli")
        asyncio.run(instance.handle_inbound(peer_frame(mentioned=False)))
        instance.forward_to_claude.assert_not_called()
        self.assertIn("c1", instance.context_buffer)

    def test_non_allowlisted_agent_only_buffers(self):
        instance = make_bridge(peer_agents="codex-cli")
        frame = peer_frame(author={"type": "agent", "id": "rogue-bot", "name": "Rogue"})
        asyncio.run(instance.handle_inbound(frame))
        instance.forward_to_claude.assert_not_called()
        self.assertIn("c1", instance.context_buffer)

    def test_peer_text_never_reaches_the_command_table(self):
        instance = make_bridge(peer_agents="codex-cli")
        instance._cmd_new = Mock()
        asyncio.run(instance.handle_inbound(peer_frame(text="/new /tmp")))
        instance._cmd_new.assert_not_called()
        instance.forward_to_claude.assert_awaited_once()
        prompt = instance.forward_to_claude.await_args.args[2]
        self.assertTrue(prompt.startswith("[Relay note"))
        self.assertIn("/new /tmp", prompt)


class PeerPromptTests(unittest.TestCase):
    def test_budget_tiers(self):
        instance = make_bridge(peer_agents="codex-cli")
        plenty = instance._peer_prompt(peer_frame(bot_turns_left=3), "go")
        self.assertIn("2 more agent message(s)", plenty)
        last = instance._peer_prompt(peer_frame(bot_turns_left=1), "go")
        self.assertIn("final relayed agent turn", last)
        spent = instance._peer_prompt(peer_frame(bot_turns_left=0), "go")
        self.assertIn("Do not @mention any agent", spent)
        missing = instance._peer_prompt(peer_frame(bot_turns_left=None), "go")
        self.assertIn("Do not @mention any agent", missing)

    def test_prompt_names_the_peer_and_keeps_the_text(self):
        instance = make_bridge(peer_agents="codex-cli")
        prompt = instance._peer_prompt(peer_frame(), "review the diff")
        self.assertIn('"Codex" (@codex)', prompt)
        self.assertTrue(prompt.endswith("Codex: review the diff"))


class PeerForwardTests(unittest.TestCase):
    def test_peer_turn_never_answers_a_pending_question(self):
        instance = make_bridge(peer_agents="codex-cli")
        del instance.forward_to_claude  # exercise the real method
        instance._answer_pending_question = Mock(return_value=True)
        asyncio.run(
            instance.forward_to_claude("c1", peer_frame(), "wrapped", from_peer=True)
        )
        instance._answer_pending_question.assert_not_called()
        # No binding: the run stops with the usual notice.
        instance.post.assert_called_once()
        self.assertIn("No session bound", instance.post.call_args.args[1])

    def test_human_turn_still_answers_a_pending_question(self):
        instance = make_bridge()
        del instance.forward_to_claude
        instance._answer_pending_question = Mock(return_value=True)
        frame = {"channel_id": "c1", "author": {"type": "user", "id": "tom"}}
        asyncio.run(instance.forward_to_claude("c1", frame, "option 2"))
        instance._answer_pending_question.assert_called_once()
        instance.post.assert_not_called()

    def test_busy_peer_turn_buffers_instead_of_noise_post(self):
        instance = make_bridge(peer_agents="codex-cli")
        del instance.forward_to_claude
        instance.bindings = {"c1": {"cwd": "/tmp", "session_id": "s1"}}
        instance.busy = {"c1"}
        handled = asyncio.run(
            instance.forward_to_claude("c1", peer_frame(), "wrapped", from_peer=True)
        )
        # False tells handle_inbound to skip the ✅ reaction — nothing ran.
        self.assertFalse(handled)
        instance.post.assert_not_called()
        self.assertIn("c1", instance.context_buffer)
        instance.clear_reaction.assert_called_once()

    def test_busy_human_turn_still_gets_the_notice(self):
        instance = make_bridge()
        del instance.forward_to_claude
        instance._answer_pending_question = Mock(return_value=False)
        instance.bindings = {"c1": {"cwd": "/tmp", "session_id": "s1"}}
        instance.busy = {"c1"}
        frame = {"channel_id": "c1", "author": {"type": "user", "id": "tom"}}
        handled = asyncio.run(instance.forward_to_claude("c1", frame, "hello"))
        self.assertTrue(handled)
        instance.post.assert_called_once()
        self.assertIn("Still working", instance.post.call_args.args[1])


class AppendSystemArgsTests(unittest.TestCase):
    def test_blocks_join_into_a_single_flag(self):
        instance = make_bridge(peer_agents="codex-cli")
        instance.tldr_default = True
        args = instance._append_system_args({})
        self.assertEqual(args[0], "--append-system-prompt")
        self.assertEqual(
            args[1],
            bridge.COLLAB_SYSTEM_PROMPT + "\n\n" + bridge.TLDR_SYSTEM_PROMPT + "\n\n" + bridge.ATTACH_SYSTEM_PROMPT,
        )
        self.assertEqual(len(args), 2)

    def test_each_block_rides_alone(self):
        instance = make_bridge(peer_agents="codex-cli")
        instance.tldr_default = False
        self.assertEqual(
            instance._append_system_args({}),
            ["--append-system-prompt", bridge.COLLAB_SYSTEM_PROMPT + "\n\n" + bridge.ATTACH_SYSTEM_PROMPT],
        )
        instance.peer_agents = frozenset()
        instance.tldr_default = True
        self.assertEqual(
            instance._append_system_args({}),
            ["--append-system-prompt", bridge.TLDR_SYSTEM_PROMPT + "\n\n" + bridge.ATTACH_SYSTEM_PROMPT],
        )

    def test_neither_block_means_no_flag(self):
        instance = make_bridge()
        instance.tldr_default = False
        self.assertEqual(instance._append_system_args({}), ["--append-system-prompt", bridge.ATTACH_SYSTEM_PROMPT])




def _fake_proc(lines, feed_delay=0.0):
    """A stand-in for the CLI child process that replays `lines` on stdout.

    With ``feed_delay`` the lines trickle out from a background task, so a test
    can exercise the idle window instead of draining a pre-filled buffer.
    """
    stdout = asyncio.StreamReader()
    if feed_delay:
        async def feed():
            for line in lines:
                await asyncio.sleep(feed_delay)
                stdout.feed_data(line.encode() + b"\n")
        asyncio.get_running_loop().create_task(feed())
    else:
        for line in lines:
            stdout.feed_data(line.encode() + b"\n")
    stderr = asyncio.StreamReader()
    stderr.feed_eof()

    proc = Mock()
    proc.stdout = stdout
    proc.stderr = stderr
    proc.stdin = Mock()
    proc.stdin.drain = AsyncMock()
    proc.stdin.close = Mock()
    proc.wait = AsyncMock(return_value=0)
    proc.kill = Mock()
    proc.returncode = 0
    return proc


def _result(text, **extra):
    frame = {"type": "result", "subtype": "success", "result": text,
             "session_id": "sess-1", "num_turns": 1}
    frame.update(extra)
    return json.dumps(frame)


def run_bridge(lines, grace=None, timeout=10, feed_delay=0.0):
    """Drive the real run_claude() against a scripted stdout stream."""
    b = make_bridge()
    b.claude_bin = "claude"
    b.base_claude_args = []
    b.default_model = None
    b.default_permission_mode = "acceptEdits"
    b.timeout = timeout
    b.procs = {}
    b.stop_requested = set()
    b.progress = Mock()
    b._append_system_args = Mock(return_value=[])
    b._stage_attachments = Mock(return_value=("hi", [], None))
    b._save_state = Mock()

    original_grace = bridge.BLANK_RESULT_IDLE_GRACE
    if grace is not None:
        bridge.BLANK_RESULT_IDLE_GRACE = grace

    async def main():
        proc = _fake_proc(lines, feed_delay)  # StreamReader needs a running loop

        async def fake_exec(*a, **kw):
            return proc

        original_exec = asyncio.create_subprocess_exec
        asyncio.create_subprocess_exec = fake_exec
        try:
            return await b.run_claude(
                "k", {"channel_id": "c1"}, {"cwd": "/tmp"}, "hi")
        finally:
            asyncio.create_subprocess_exec = original_exec

    try:
        return asyncio.run(main()), b
    finally:
        bridge.BLANK_RESULT_IDLE_GRACE = original_grace


class BlankResultTests(unittest.TestCase):
    def test_normal_result_is_returned(self):
        reply, _ = run_bridge([_result("the answer")])
        self.assertEqual(reply, "the answer")

    def test_blank_result_from_injected_turn_is_skipped(self):
        """A CLI-injected turn ends with a blank result; ours follows."""
        reply, _ = run_bridge([_result(""), _result("the real answer")])
        self.assertEqual(reply, "the real answer")

    def test_repeated_blanks_still_yield_the_real_answer(self):
        reply, _ = run_bridge([_result(""), _result("   "), _result("finally")])
        self.assertEqual(reply, "finally")

    def test_genuinely_blank_run_falls_back_once_the_stream_goes_quiet(self):
        """No further output: accept the blank rather than hanging to --timeout."""
        reply, _ = run_bridge([_result("")], grace=0.2)
        self.assertEqual(reply, "")

    def test_idle_window_is_refreshed_by_ongoing_work(self):
        """Our answer can be far past the window; frames in between must extend it."""
        chatter = [json.dumps(
            {"type": "assistant",
             "message": {"content": [{"type": "tool_use", "name": "Bash"}]}})] * 8
        # 8 frames x 40ms = 320ms of work, well past the 100ms idle window.
        # Only refreshing the deadline per frame reaches the real answer.
        reply, _ = run_bridge([_result("")] + chatter + [_result("late answer")],
                              grace=0.1, feed_delay=0.04)
        self.assertEqual(reply, "late answer")

    def test_outer_run_timeout_still_fires_while_holding_a_blank(self):
        """The inner grace read must not swallow the run-level timeout."""
        with self.assertRaises(RuntimeError) as cm:
            run_bridge([_result("")], grace=60, timeout=0.3)
        self.assertIn("timed out", str(cm.exception))

    def test_no_result_at_all_raises(self):
        with self.assertRaises(RuntimeError):
            run_bridge([], timeout=0.3)

    def test_error_result_is_not_held(self):
        reply, _ = run_bridge([_result("", is_error=True)])
        self.assertTrue(reply.startswith("(claude error)"))

    def test_session_id_is_tracked_even_from_a_blank_result(self):
        """A held blank still carries the forked session id we must resume from."""
        _, b = run_bridge([_result("", session_id="forked")], grace=0.2)
        self.assertEqual(b.bindings["k"]["session_id"], "forked")


class OutboundAttachmentTests(unittest.TestCase):
    def test_malformed_attachment_limit_env_falls_back(self):
        with patch.dict("os.environ", {"AGORA_MAX_FILE_MB": "bad"}):
            self.assertEqual(bridge.parse_positive_int("bad", 10), 10)

    def test_empty_run_posts_original_fallback(self):
        instance = make_bridge()
        del instance.forward_to_claude
        instance.bindings = {"c1": {"cwd": "/tmp", "session_id": "s1"}}
        instance.run_claude = AsyncMock(return_value="")
        instance.typing = Mock()
        instance.tldr_default = False
        instance.tldr_min_chars = 1500
        instance.allowed_roots = []
        instance.max_attachment_bytes = 10 * 1024 * 1024
        asyncio.run(instance.forward_to_claude("c1", {"channel_id": "c1"}, "hello"))
        self.assertEqual(instance.post.call_args.args[1], "(no reply — the run ended without any text)")

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
        instance.agent_id = "claude-cli"
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


class UsageTests(unittest.TestCase):
    def test_subscription_usage_text_maps_to_existing_windows(self):
        now = 1788160000
        raw = json.dumps({"result": (
            "Current session: 16% used · resets Aug 31 at 3:09pm (Asia/Calcutta)\n"
            "Current week (all models): 9% used · resets Sep 3 at 1:29pm (Asia/Calcutta)\n"
            "Total cost: $0.0000"
        )})
        windows = bridge.parse_subscription_usage(raw, now=now)
        self.assertEqual([window["key"] for window in windows], ["five_hour", "seven_day"])
        self.assertEqual([window["used_percent"] for window in windows], [16, 9])
        self.assertTrue(all(now < window["resets_at"] <= now + 8 * 86400 for window in windows))

    def test_subscription_usage_parser_fails_closed_on_format_drift(self):
        raw = json.dumps({"result": (
            "Current session: 16% used · sometime Aug 31\n"
            "Current week (all models): 9% used · resets Sep 3 at 1:29pm (Asia/Calcutta)"
        )})
        self.assertIsNone(bridge.parse_subscription_usage(raw, now=1788160000))
        self.assertIsNone(bridge.parse_subscription_usage('{"result":"Current week (mystery): 9% used · resets Sep 3 at 1:29pm (Asia/Calcutta)"}', now=1788160000))

    def test_subscription_usage_parser_skips_unknown_additive_scopes(self):
        raw = json.dumps({"result": (
            "Current session: 12% used · resets Aug 31 at 3:09pm (Asia/Calcutta)\n"
            "Current week (all models): 9% used · resets Sep 3 at 1:29pm (Asia/Calcutta)\n"
            "Current week (Haiku only): 4% used · resets Sep 3 at 1:29pm (Asia/Calcutta)"
        )})
        windows = bridge.parse_subscription_usage(raw, now=1788160000)
        self.assertEqual([window["key"] for window in windows], ["five_hour", "seven_day"])

    def test_subscription_usage_rejects_billed_envelope(self):
        raw = json.dumps({
            "result": (
                "Current session: 16% used · resets Aug 31 at 3:09pm (Asia/Calcutta)\n"
                "Current week (all models): 9% used · resets Sep 3 at 1:29pm (Asia/Calcutta)"
            ),
            "num_turns": 1,
            "total_cost_usd": 0.012,
            "duration_api_ms": 420,
        })
        self.assertIsNone(bridge.parse_subscription_usage(raw, now=1788160000))

    def test_subscription_usage_parser_is_locale_independent(self):
        import locale
        raw = json.dumps({"result": (
            "Current session: 16% used · resets Aug 31 at 3:09pm (Asia/Calcutta)\n"
            "Current week (all models): 9% used · resets Sep 3 at 1:29pm (Asia/Calcutta)"
        )})
        previous = locale.setlocale(locale.LC_TIME)
        try:
            try:
                locale.setlocale(locale.LC_TIME, "fr_FR.UTF-8")
            except locale.Error:
                self.skipTest("fr_FR.UTF-8 locale unavailable")
            windows = bridge.parse_subscription_usage(raw, now=1788160000)
            self.assertEqual(
                [window["key"] for window in windows],
                ["five_hour", "seven_day"],
            )
            self.assertEqual([window["used_percent"] for window in windows], [16, 9])
        finally:
            locale.setlocale(locale.LC_TIME, previous)

    def test_subscription_usage_refresh_is_zero_turn_subprocess_and_updates_cache(self):
        instance = bridge.Bridge.__new__(bridge.Bridge)
        instance.claude_bin = "claude-test"
        instance.agent_id = "claude-cli"
        instance.last_usage_frame = None
        instance.send = Mock()
        proc = Mock(returncode=0)
        proc.communicate = AsyncMock(return_value=(json.dumps({"result": (
            "Current session: 16% used · resets Aug 31 at 3:09pm (Asia/Calcutta)\n"
            "Current week (all models): 9% used · resets Sep 3 at 1:29pm (Asia/Calcutta)"
        )}).encode(), b""))
        with patch.object(bridge.asyncio, "create_subprocess_exec", new=AsyncMock(return_value=proc)) as spawn, \
             patch.object(bridge.time, "time", return_value=1788160000):
            asyncio.run(instance.refresh_usage())
        spawn.assert_awaited_once_with(
            "claude-test", "-p", "/usage", "--output-format", "json",
            stdout=bridge.asyncio.subprocess.PIPE,
            stderr=bridge.asyncio.subprocess.PIPE,
        )
        self.assertEqual(instance.last_usage_frame["windows"][0]["used_percent"], 16)
        instance.send.assert_called_once_with(instance.last_usage_frame)

    def test_failed_subscription_refresh_keeps_last_good_snapshot(self):
        instance = bridge.Bridge.__new__(bridge.Bridge)
        instance.claude_bin = "claude-test"
        instance.agent_id = "claude-cli"
        instance.last_usage_frame = {"type": "usage_update", "windows": [{"key": "five_hour"}]}
        instance.send = Mock()
        proc = Mock(returncode=0)
        proc.communicate = AsyncMock(return_value=(b'{"result":"unexpected"}', b""))
        with patch.object(bridge.asyncio, "create_subprocess_exec", new=AsyncMock(return_value=proc)):
            asyncio.run(instance.refresh_usage())
        instance.send.assert_called_once_with(instance.last_usage_frame)

    def test_subscription_usage_refresh_timeout_preserves_snapshot_and_kills_process(self):
        instance = bridge.Bridge.__new__(bridge.Bridge)
        instance.claude_bin = "claude-test"
        instance.agent_id = "claude-cli"
        good = {"type": "usage_update", "windows": [{"key": "five_hour", "used_percent": 12}]}
        instance.last_usage_frame = good
        instance.send = Mock()
        proc = Mock(returncode=None)
        proc.communicate = AsyncMock(side_effect=TimeoutError())
        proc.kill = Mock()
        proc.wait = AsyncMock(return_value=0)
        with patch.object(bridge.asyncio, "create_subprocess_exec", new=AsyncMock(return_value=proc)):
            asyncio.run(instance.refresh_usage())
        proc.kill.assert_called_once()
        proc.wait.assert_awaited()
        self.assertIs(instance.last_usage_frame, good)
        instance.send.assert_called_once_with(good)

    def test_rate_limit_event_normalizes_fractional_windows(self):
        instance = bridge.Bridge.__new__(bridge.Bridge)
        instance.agent_id = "claude-cli"
        instance.send = Mock()
        instance.capture_usage({"rate_limit_info": {"unifiedWindows": {
            "five_hour": {"utilization": 0.34, "resetsAt": 2000},
            "seven_day_sonnet": {"utilization": 0.5, "resetsAt": 3000},
            "seven_day_opus": None,
        }}})
        frame = instance.send.call_args.args[0]
        self.assertEqual(frame["windows"][0]["used_percent"], 34)
        self.assertEqual(frame["windows"][1]["used_percent"], 50)
        self.assertEqual(frame["windows"][1]["window_minutes"], 10080)

    def test_malformed_rate_limit_event_is_ignored(self):
        instance = bridge.Bridge.__new__(bridge.Bridge)
        instance.agent_id = "claude-cli"
        instance.send = Mock()
        instance.capture_usage({"rate_limit_info": {"unifiedWindows": {"five_hour": {"utilization": "nope"}}}})
        instance.send.assert_not_called()


if __name__ == "__main__":
    unittest.main()
