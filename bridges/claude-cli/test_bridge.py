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
    instance.pending_turns = {}
    instance.pending_updates = {}
    instance.pending_deletes = {}
    instance.deleted_thread_roots = {}
    instance.active_message_ids = set()
    instance.stop_requested = set()
    instance.stopped_processes = set()
    instance.queue_full_notified = set()
    instance.procs = {}
    instance.live = {}
    instance._detached = set()
    instance.async_followups = True
    instance.followup_idle_timeout = bridge.FOLLOWUP_IDLE_TIMEOUT
    instance.followup_task_idle_timeout = bridge.FOLLOWUP_TASK_IDLE_TIMEOUT
    instance.followup_max_wait = bridge.FOLLOWUP_MAX_WAIT
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


class NotificationApprovalTests(unittest.TestCase):
    def test_tool_approval_keeps_detail_and_supplies_explicit_notification_label(self):
        async def run():
            b = make_bridge()
            b.session_allows = {}
            b.pending_perms = {}
            b.permission_timeout = 1
            b._send_to_claude = AsyncMock()

            def choose(post):
                self.assertEqual(post["options"][1]["label"], "Always allow Bash (this session)")
                self.assertEqual(post["options"][1]["notification"], {
                    "enabled": True, "label": "Always allow this tool",
                })
                fut = b.pending_perms[post["options_id"]][0]
                fut.set_result(("option", "allow_always", "ana"))

            b.send = Mock(side_effect=choose)
            await b._handle_control_request("c1", {"channel_id": "c1"}, Mock(), {
                "request_id": "ask-42", "request": {
                    "subtype": "can_use_tool", "tool_name": "Bash", "input": {"command": "pwd"},
                },
            }, [])
            self.assertIn("Bash", b.session_allows["c1"])
            b._send_to_claude.assert_awaited_once()

        asyncio.run(run())


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

    def test_busy_human_turn_is_queued(self):
        instance = make_bridge()
        del instance.forward_to_claude
        instance._answer_pending_question = Mock(return_value=False)
        instance.bindings = {"c1": {"cwd": "/tmp", "session_id": "s1"}}
        instance.busy = {"c1"}
        frame = {"channel_id": "c1", "author": {"type": "user", "id": "tom"}}
        handled = asyncio.run(instance.forward_to_claude("c1", frame, "hello"))
        self.assertFalse(handled)
        instance.post.assert_not_called()
        self.assertEqual(instance.pending_turns["c1"][0]["text"], "hello")
        self.assertTrue(instance.pending_turns["c1"][0]["queued"])
        instance.set_reaction.assert_called_with(frame, "⏳")

    def test_claim_emits_message_id(self):
        instance = make_bridge()
        instance.send = Mock()
        instance.claim({"channel_id": "c1", "message_id": 42})
        self.assertEqual(instance.send.call_args.args[0]["type"], "claim")
        self.assertEqual(instance.send.call_args.args[0]["message_id"], 42)

    def test_delete_thread_root_drops_queued_replies(self):
        instance = make_bridge()
        instance.pending_turns = {"c1:42": [
            {"frame": {"channel_id": "c1", "thread_id": 42, "message_id": 44}, "text": "reply"}
        ]}
        instance.active_message_ids.add(42)
        instance.handle_inbound_control({"type": "inbound_delete", "channel_id": "c1",
                                         "message_id": 42, "thread_id": None})
        self.assertNotIn("c1:42", instance.pending_turns)

    def test_control_before_enqueue_is_applied(self):
        instance = make_bridge()
        instance.handle_inbound_control({"type": "inbound_update", "channel_id": "c1",
                                         "message_id": 7, "text": "latest"})
        entry = instance._pending_entry({"channel_id": "c1", "message_id": 7}, "old")
        self.assertEqual(entry["text"], "latest")


class AppendSystemArgsTests(unittest.TestCase):
    def test_blocks_join_into_a_single_flag(self):
        instance = make_bridge(peer_agents="codex-cli")
        instance.async_followups = False
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
        instance.async_followups = False
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
        instance.async_followups = False
        instance.tldr_default = False
        self.assertEqual(instance._append_system_args({}), ["--append-system-prompt", bridge.ATTACH_SYSTEM_PROMPT])

    def test_background_block_rides_only_when_followups_are_on(self):
        instance = make_bridge()
        instance.tldr_default = False
        self.assertEqual(
            instance._append_system_args({}),
            ["--append-system-prompt",
             bridge.BACKGROUND_SYSTEM_PROMPT + "\n\n" + bridge.ATTACH_SYSTEM_PROMPT],
        )
        instance.async_followups = False
        self.assertNotIn(bridge.BACKGROUND_SYSTEM_PROMPT, instance._append_system_args({})[1])




def _fake_proc(lines, feed_delay=0.0, returncode=0):
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
    proc.returncode = returncode

    def killed():
        # A real kill ends the child, so its reader sees EOF rather than
        # blocking until whatever deadline it happened to be waiting on.
        proc.returncode = -9
        if not stdout.at_eof():
            stdout.feed_eof()

    proc.kill = Mock(side_effect=killed)
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
        b.spawn_calls = []

        async def fake_exec(*a, **kw):
            b.spawn_calls.append((a, kw))
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


def _tasks(*descriptions):
    return json.dumps({
        "type": "system", "subtype": "background_tasks_changed",
        "tasks": [{"task_id": f"t{i}", "task_type": "local_agent",
                   "description": d} for i, d in enumerate(descriptions)],
    })


def followup_bridge(idle=5.0):
    """A Bridge configured for the async-follow-up path, bound at key "k"."""
    b = make_bridge()
    b.claude_bin = "claude"
    b.base_claude_args = []
    b.default_model = None
    b.default_permission_mode = "acceptEdits"
    b.timeout = 10
    b.followup_idle_timeout = idle
    b.followup_task_idle_timeout = idle
    b.followup_max_wait = 60.0
    b.allowed_roots = []
    b.max_attachment_bytes = 1024
    b.tldr_default = False
    b.tldr_min_chars = 0
    b.bindings = {"k": {"cwd": "/tmp", "session_id": "sess-old"}}
    b.progress = Mock()
    b._append_system_args = Mock(return_value=[])
    b._stage_attachments = Mock(return_value=("hi", [], None))
    b._save_state = Mock()
    return b


async def hand_off(b, lines, feed_delay=0.0):
    """Drive one turn that ends holding a live child; return (reply, proc)."""
    proc = _fake_proc(lines, feed_delay, returncode=None)

    async def fake_exec(*_a, **_kw):
        return proc

    original = asyncio.create_subprocess_exec
    asyncio.create_subprocess_exec = fake_exec
    try:
        reply = await b.run_claude("k", {"channel_id": "c1"}, b.bindings["k"], "hi")
    finally:
        asyncio.create_subprocess_exec = original
    return reply, proc


def run_bridge_with_followups(lines, inject=None, feed_delay=0.0, idle=5.0,
                              pre_inject=None):
    """Drive run_claude() and then let the follow-up loop drain the stream.

    Returns ``(first_reply, bridge, injected_reply)``. Unlike run_bridge this
    keeps the loop alive until the held child is released, so spontaneous
    follow-up posts actually happen before the assertions run.
    """
    b = make_bridge()
    b.claude_bin = "claude"
    b.base_claude_args = []
    b.default_model = None
    b.default_permission_mode = "acceptEdits"
    b.timeout = 10
    b.followup_idle_timeout = idle
    b.followup_task_idle_timeout = idle
    b.followup_max_wait = 60.0
    b.allowed_roots = []
    b.max_attachment_bytes = 1024
    b.tldr_default = False
    b.tldr_min_chars = 0
    b.bindings = {"k": {"cwd": "/tmp"}}
    b.progress = Mock()
    b._append_system_args = Mock(return_value=[])
    b._stage_attachments = Mock(return_value=("hi", [], None))
    b._save_state = Mock()

    async def main():
        # returncode None: a child held past its reply is still running, which
        # is what LiveRun.alive gates on.
        proc = _fake_proc(lines, feed_delay, returncode=None)

        async def fake_exec(*a, **kw):
            return proc

        original_exec = asyncio.create_subprocess_exec
        asyncio.create_subprocess_exec = fake_exec
        try:
            first = await b.run_claude("k", {"channel_id": "c1"}, b.bindings["k"], "hi")
        finally:
            asyncio.create_subprocess_exec = original_exec
        injected = None
        live = b.live.get("k")
        if pre_inject and live is not None:
            # Events the held child emits *before* the next message arrives —
            # e.g. its task inventory emptying, which owes a report.
            for line in pre_inject:
                proc.stdout.feed_data(line.encode() + b"\n")
            await asyncio.sleep(0.05)
        if inject is not None and live is not None:
            # Answer the injected turn only once it is actually waiting, so the
            # test exercises the waiter path rather than racing it.
            async def feed_injected():
                await asyncio.sleep(0.05)
                for line in inject:
                    proc.stdout.feed_data(line.encode() + b"\n")
            b._send_to_claude = AsyncMock()
            asyncio.get_running_loop().create_task(feed_injected())
            injected = await b.run_claude("k", {"channel_id": "c1"},
                                          b.bindings["k"], "follow up")
        if live is not None and live.reader is not None:
            proc.stdout.feed_eof()
            await asyncio.wait_for(live.reader, 10)
        return first, injected

    first, injected = asyncio.run(main())
    return first, b, injected


class AsyncFollowupTests(unittest.TestCase):
    def test_child_is_held_when_the_reply_leaves_background_work_running(self):
        first, b, _ = run_bridge_with_followups(
            [_tasks("deep research"), _result("kicked off the research"),
             _tasks(), _result("here is what I found")])
        self.assertEqual(first, "kicked off the research")
        posted = [c.args[1] for c in b.post.call_args_list]
        self.assertEqual(posted, ["here is what I found"])
        self.assertEqual(b.post.call_args_list[0].args[0]["channel_id"], "c1")

    def test_held_child_is_released_once_its_task_list_empties(self):
        _, b, _ = run_bridge_with_followups(
            [_tasks("deep research"), _result("started"),
             _tasks(), _result("done")])
        self.assertEqual(b.live, {})
        self.assertEqual(b.procs, {})

    def test_reply_with_no_background_work_closes_the_child_as_before(self):
        reply, b = run_bridge([_result("just an answer")])
        self.assertEqual(reply, "just an answer")
        self.assertEqual(b.live, {})

    def test_followups_disabled_closes_the_child_even_with_tasks_pending(self):
        b = make_bridge()
        b.async_followups = False
        b.claude_bin, b.base_claude_args = "claude", []
        b.default_model, b.default_permission_mode = None, "acceptEdits"
        b.timeout = 10
        b.progress = Mock()
        b._append_system_args = Mock(return_value=[])
        b._stage_attachments = Mock(return_value=("hi", [], None))
        b._save_state = Mock()

        async def main():
            proc = _fake_proc([_tasks("research"), _result("started")])

            async def fake_exec(*a, **kw):
                return proc
            original = asyncio.create_subprocess_exec
            asyncio.create_subprocess_exec = fake_exec
            try:
                return await b.run_claude("k", {"channel_id": "c1"}, {"cwd": "/tmp"}, "hi")
            finally:
                asyncio.create_subprocess_exec = original

        self.assertEqual(asyncio.run(main()), "started")
        self.assertEqual(b.live, {})

    def test_a_new_turn_is_injected_into_the_held_child(self):
        """No second `claude --resume` against a session the held child owns."""
        first, b, injected = run_bridge_with_followups(
            [_tasks("research"), _result("started")],
            inject=[_result("answer to the follow-up")])
        self.assertEqual(first, "started")
        self.assertEqual(injected, "answer to the follow-up")
        # Claimed by the waiting turn, so the answer is not also posted on its
        # own. The teardown notice is separate: the harness ends the child while
        # "research" is still listed, which is exactly when it should speak up.
        answers = [c.args[1] for c in b.post.call_args_list
                   if "Stopped watching" not in c.args[1]]
        self.assertEqual(answers, [])

    def test_background_result_posts_while_a_turn_is_still_waiting(self):
        """A waiter takes the first real result; later ones post themselves.

        This is the ordering where the user's message arrives *before* the task
        completes, so the CLI answers the injected prompt first.
        """
        first, b, injected = run_bridge_with_followups(
            [_tasks("research"), _result("started")],
            inject=[_result("your answer"), _tasks(), _result("research landed")])
        self.assertEqual((first, injected), ("started", "your answer"))
        self.assertEqual([c.args[1] for c in b.post.call_args_list],
                         ["research landed"])

    def test_a_report_already_owed_is_not_handed_to_a_later_message(self):
        """The CLI clears a task *before* re-invoking the model to report it —
        the ordering this feature is built around. A message injected during
        that report turn must not be answered with the report, and the child
        must not be released before the message itself is answered."""
        first, b, injected = run_bridge_with_followups(
            [_tasks("research"), _result("started")],
            # Inventory empties before the user's message exists, so the report
            # is already owed when the turn is injected.
            pre_inject=[_tasks()],
            inject=[_result("research landed"), _result("your answer")])
        self.assertEqual(first, "started")
        self.assertEqual(injected, "your answer",
                         "the injected turn was answered with the background report")
        posted = [c.args[1] for c in b.post.call_args_list]
        self.assertIn("research landed", posted,
                      "the background report was consumed instead of posted")
        self.assertNotIn("your answer", posted)

    def test_rebinding_retires_the_held_child_instead_of_injecting(self):
        """/new, /use, /worktree, /model must not be swallowed by a held child."""
        async def main():
            b = followup_bridge()
            await hand_off(b, [_tasks("research"), _result("started")])
            self.assertIn("k", b.live)
            held = b.live["k"]
            # What /new does: a brand-new binding object for the same key.
            b.bindings["k"] = {"cwd": "/elsewhere", "session_id": None}
            spawned = []

            async def fake_exec(*a, **_kw):
                spawned.append(a)
                return _fake_proc([_result("fresh session answer")])

            original = asyncio.create_subprocess_exec
            asyncio.create_subprocess_exec = fake_exec
            try:
                reply = await b.run_claude("k", {"channel_id": "c1"},
                                           b.bindings["k"], "next message")
            finally:
                asyncio.create_subprocess_exec = original
            return b, held, reply, spawned

        b, held, reply, spawned = asyncio.run(main())
        self.assertEqual(reply, "fresh session answer")
        self.assertEqual(len(spawned), 1, "the new binding must spawn its own child")
        self.assertNotIn("--resume", spawned[0])
        self.assertFalse(held.alive)
        self.assertEqual(b.live, {})

    def test_a_late_result_never_overwrites_a_binding_that_was_replaced(self):
        """The held child's session id belongs to the old conversation."""
        async def main():
            b = followup_bridge()
            _, proc = await hand_off(b, [_tasks("research"), _result("started")])
            fresh = {"cwd": "/elsewhere", "session_id": None}
            b.bindings["k"] = fresh
            b._save_state.reset_mock()  # the first turn's own write is legitimate
            # The held child reports in after the rebind, carrying its own id.
            proc.stdout.feed_data((_result("late", session_id="sess-held")
                                   + "\n").encode())
            proc.stdout.feed_data((_tasks() + "\n").encode())
            proc.stdout.feed_eof()
            await asyncio.wait_for(b.live["k"].reader, 5)
            return b, fresh

        b, fresh = asyncio.run(main())
        self.assertIsNone(fresh["session_id"], "fresh binding must stay fresh")
        b._save_state.assert_not_called()

    def test_stop_during_an_injected_turn_says_stopped_and_leaves_no_residue(self):
        """The busy path would kill the held child but skip run_claude's cleanup,
        poisoning the next two messages."""
        async def main():
            b = followup_bridge()
            await hand_off(b, [_tasks("research"), _result("started")])

            async def stop_once_waiting():
                await asyncio.sleep(0.05)
                b.busy.add("k")  # forward_to_claude marks the key busy
                return b._cmd_stop("k")

            stopper = asyncio.create_task(stop_once_waiting())
            with self.assertRaises(bridge.RunStopped):
                await b.run_claude("k", {"channel_id": "c1"},
                                   b.bindings["k"], "follow up")
            return b, await stopper

        b, message = asyncio.run(main())
        self.assertIn("Stopping", message)
        self.assertEqual(b.stop_requested, set())
        self.assertEqual(b.stopped_processes, set())
        self.assertEqual(b.live, {})

    def test_stop_with_no_turn_waiting_reports_the_dropped_tasks(self):
        async def main():
            b = followup_bridge()
            await hand_off(b, [_tasks("deep research"), _result("started")])
            message = b._cmd_stop("k")
            await asyncio.sleep(0.05)
            return b, message

        b, message = asyncio.run(main())
        self.assertIn("Dropped 1 background task", message)
        self.assertEqual(b.stop_requested, set())

    def test_a_blank_result_with_an_empty_inventory_releases_immediately(self):
        """Re-invoked and said nothing: no reason to hold for the idle window."""
        async def main():
            b = followup_bridge(idle=30.0)  # long enough that idling would hang
            started = asyncio.get_running_loop().time()
            await hand_off(b, [_tasks("research"), _result("started"),
                               _tasks(), _result("")])
            await asyncio.wait_for(b.live["k"].reader, 5)
            return b, asyncio.get_running_loop().time() - started

        b, elapsed = asyncio.run(main())
        self.assertLess(elapsed, 5, "released on the blank, not after the idle window")
        self.assertEqual(b.live, {})
        b.post.assert_not_called()

    def test_a_held_child_is_released_when_it_simply_goes_quiet(self):
        """Deadline-driven exit: no EOF, no further events, inventory empty."""
        async def main():
            b = followup_bridge(idle=0.2)
            await hand_off(b, [_tasks("research"), _result("started"), _tasks()])
            await asyncio.wait_for(b.live["k"].reader, 5)
            return b

        b = asyncio.run(main())
        self.assertEqual(b.live, {})
        self.assertEqual(b.procs, {})

    def test_permissions_and_model_retire_the_held_child_despite_in_place_edits(self):
        """/permissions and /model mutate the binding dict rather than replacing
        it, so an identity check alone leaves the held child running under the
        old permission mode while the channel was told otherwise."""
        for command, arg, field, expected in (
            ("_cmd_permissions", "plan", "permission_mode", "plan"),
            ("_cmd_model", "haiku", "model", "haiku"),
        ):
            with self.subTest(command=command):
                async def main():
                    b = followup_bridge()
                    b.allow_escalation = True
                    b.default_permission_mode = "acceptEdits"
                    await hand_off(b, [_tasks("research"), _result("started")])
                    held = b.live["k"]
                    before = b.bindings["k"]
                    getattr(b, command)("k", arg)
                    # The very hazard: same object, changed contents.
                    self.assertIs(b.bindings["k"], before)
                    self.assertEqual(b.bindings["k"][field], expected)
                    spawned = []

                    async def fake_exec(*a, **_kw):
                        spawned.append(a)
                        return _fake_proc([_result("answered afresh")])

                    original = asyncio.create_subprocess_exec
                    asyncio.create_subprocess_exec = fake_exec
                    try:
                        reply = await b.run_claude("k", {"channel_id": "c1"},
                                                   b.bindings["k"], "next")
                    finally:
                        asyncio.create_subprocess_exec = original
                    return b, held, reply, spawned

                b, held, reply, spawned = asyncio.run(main())
                self.assertEqual(reply, "answered afresh")
                self.assertEqual(len(spawned), 1,
                                 "the new setting must reach a fresh child")
                self.assertIn(expected, spawned[0])
                self.assertFalse(held.alive)

    def test_retiring_mid_turn_says_why_and_reports_the_dropped_work(self):
        """A command that retires the child cancels any turn injected into it.
        That must read as "stopped, here is why", not as a crash — and the
        background work it was holding must not vanish unmentioned."""
        async def main():
            b = followup_bridge()
            await hand_off(b, [_tasks("deep research"), _result("started")])
            b._send_to_claude = AsyncMock()
            turn = asyncio.create_task(
                b.run_claude("k", {"channel_id": "c1"}, b.bindings["k"], "what about X?"))
            await asyncio.sleep(0.05)  # let it become a waiter
            b.bindings["k"] = {"cwd": "/elsewhere", "session_id": None}
            await b._retire_if_stale("k")
            try:
                await turn
                return b, None
            except bridge.RunStopped as stopped:
                return b, str(stopped)

        b, stopped = asyncio.run(main())
        self.assertIsNotNone(stopped, "the injected turn must end as RunStopped")
        self.assertIn("Stopped", stopped)
        self.assertIn("binding changed", stopped)
        posted = [c.args[1] for c in b.post.call_args_list]
        self.assertTrue(any("deep research" in p for p in posted),
                        f"dropped background work went unmentioned: {posted}")

    def test_stop_during_a_retire_window_cancels_the_replacement_turn(self):
        """live.closing is also true while run_claude retires a child before
        spawning its replacement — a /stop there was acknowledged and ignored."""
        async def main():
            b = followup_bridge()
            await hand_off(b, [_tasks("research"), _result("started")])
            # The state run_claude is in while retiring a child before spawning
            # its replacement: child closing, key busy, nothing spawned yet.
            b.live["k"].closing = True
            b.busy.add("k")
            message = b._cmd_stop("k")
            spawned = []

            async def fake_exec(*a, **_kw):
                spawned.append(a)
                return _fake_proc([_result("this turn should never run")])

            original = asyncio.create_subprocess_exec
            asyncio.create_subprocess_exec = fake_exec
            try:
                await b.run_claude("k", {"channel_id": "c1"}, b.bindings["k"], "hi")
                stopped = False
            except bridge.RunStopped:
                stopped = True
            finally:
                asyncio.create_subprocess_exec = original
            return message, stopped, spawned

        message, stopped, spawned = asyncio.run(main())
        self.assertIn("Already stopping", message)
        self.assertTrue(stopped, "the replacement turn ran despite /stop")
        self.assertEqual(spawned, [], "no child should have been spawned")

    def test_tldr_does_not_kill_a_held_child(self):
        """It only shapes formatting; the next spawn picks it up."""
        self.assertNotIn("/tldr", bridge.REBINDING_COMMANDS)
        self.assertIn("/permissions", bridge.REBINDING_COMMANDS)

    def test_permissions_changed_before_handoff_still_retires_the_child(self):
        """The window before "started" is posted: the process is in self.procs
        but not self.live, so nothing retires it — and the hand-off used to
        fingerprint the binding *as it is then*, recording the new mode while
        the process kept running the old one."""
        async def main():
            b = followup_bridge()
            b.allow_escalation = False
            b.default_permission_mode = "acceptEdits"
            proc = _fake_proc([], returncode=None)

            async def fake_exec(*a, **_kw):
                # The child is spawned at acceptEdits; the user de-escalates
                # while the first turn is still running, then it hands off.
                b._cmd_permissions("k", "plan")
                for line in (_tasks("long refactor"), _result("started")):
                    proc.stdout.feed_data(line.encode() + b"\n")
                return proc

            original = asyncio.create_subprocess_exec
            asyncio.create_subprocess_exec = fake_exec
            try:
                first = await b.run_claude("k", {"channel_id": "c1"},
                                           b.bindings["k"], "big refactor")
            finally:
                asyncio.create_subprocess_exec = original
            held = b.live.get("k")
            spawned = []

            async def fake_exec2(*a, **_kw):
                spawned.append(a)
                return _fake_proc([_result("answered under plan")])

            asyncio.create_subprocess_exec = fake_exec2
            try:
                await b.run_claude("k", {"channel_id": "c1"},
                                   b.bindings["k"], "next message")
            finally:
                asyncio.create_subprocess_exec = original
            return first, held, spawned

        first, held, spawned = asyncio.run(main())
        self.assertEqual(first, "started")
        self.assertIsNotNone(held)
        self.assertEqual(held.spawned_with[1], "acceptEdits",
                         "the hold must record what the process actually ran as")
        self.assertEqual(len(spawned), 1,
                         "the acceptEdits child must not have been injected into")
        self.assertIn("plan", spawned[0])

    def test_permissions_retires_the_held_child_with_no_next_message(self):
        """A de-escalation has to reach the process that is actually running —
        checking on the next inbound is too late when there isn't one."""
        async def main():
            b = followup_bridge()
            b.allow_escalation = False
            b.default_permission_mode = "acceptEdits"
            b.sessions_limit = 5
            await hand_off(b, [_tasks("long refactor"), _result("started")])
            held = b.live["k"]
            # binding_key() derives the key from channel_id, and hand_off binds "k".
            await b.handle_inbound({
                "channel_id": "k", "message_id": 2, "text": "/permissions plan",
                "author": {"id": "u1", "name": "tom", "type": "user"},
                "mentioned": True, "any_mention": True,
            })
            return b, held, dict(b.live)

        b, held, live_after = asyncio.run(main())
        self.assertEqual(b.bindings["k"]["permission_mode"], "plan")
        self.assertFalse(held.alive, "the acceptEdits child must not outlive the change")
        self.assertEqual(live_after, {})

    def test_worktree_removal_refuses_while_a_child_is_still_held(self):
        """`busy` no longer implies "a child is running" — the worktree is that
        child's cwd and deleting it would pull the ground out from under it."""
        async def main():
            b = followup_bridge()
            b.bindings["k"]["worktree"] = {
                "base": "/repo", "path": "/repo/.worktrees/x", "branch": "x"}
            await hand_off(b, [_tasks("running the suite"), _result("started")])
            # Captured inside the loop: teardown retires held children.
            return b._remove_worktree("k", force=True), b.live.get("k") is not None

        message, still_held = asyncio.run(main())
        self.assertIn("run is in flight", message)
        self.assertTrue(still_held)

    def test_a_follow_up_is_formatted_against_the_binding_its_child_ran_under(self):
        """A relative attachment path resolves against the old cwd, not whatever
        the channel points at by the time the report lands."""
        async def main():
            b = followup_bridge()
            b.bindings["k"]["cwd"] = "/old/repo"
            _, proc = await hand_off(b, [_tasks("render a chart"), _result("started")])
            b.bindings["k"] = {"cwd": "/somewhere/else", "session_id": None}
            seen = {}
            b._split_outbound_attachments = Mock(
                side_effect=lambda reply, cwd, *a: seen.setdefault("cwd", cwd) and None
                or (reply, [], []))
            proc.stdout.feed_data((_result("here is the chart") + "\n").encode())
            proc.stdout.feed_data((_tasks() + "\n").encode())
            proc.stdout.feed_eof()
            await asyncio.wait_for(b.live["k"].reader, 5)
            return seen

        self.assertEqual(asyncio.run(main())["cwd"], "/old/repo")

    def test_stop_during_retirement_still_reports_stopped(self):
        """Not "Claude run failed" — the user asked for this."""
        async def main():
            b = followup_bridge()
            await hand_off(b, [_tasks("research"), _result("started")])
            live = b.live["k"]
            live.closing = True  # reader already retiring
            message = b._cmd_stop("k")
            self.assertTrue(live.stopping)
            fut = asyncio.get_running_loop().create_future()
            live.waiters.append({"fut": fut, "frame": {"channel_id": "c1"},
                                 "ahead": 0})
            await b._retire_live_run(live, [])
            return message, fut

        message, fut = asyncio.run(main())
        self.assertIn("Already stopping", message)
        self.assertIsInstance(fut.exception(), bridge.RunStopped)

    def test_attachments_retire_the_held_child_and_spawn_fresh(self):
        """--add-dir can only be widened by a new process."""
        async def main():
            b = followup_bridge()
            await hand_off(b, [_tasks("research"), _result("started")])
            held = b.live["k"]
            b._stage_attachments = Mock(
                return_value=("look at this", ["--add-dir", "/tmp/att"], None))
            spawned = []

            async def fake_exec(*a, **_kw):
                spawned.append(a)
                return _fake_proc([_result("I see the image")])

            original = asyncio.create_subprocess_exec
            asyncio.create_subprocess_exec = fake_exec
            try:
                reply = await b.run_claude("k", {"channel_id": "c1"},
                                           b.bindings["k"], "look")
            finally:
                asyncio.create_subprocess_exec = original
            return b, held, reply, spawned

        b, held, reply, spawned = asyncio.run(main())
        self.assertEqual(reply, "I see the image")
        self.assertEqual(len(spawned), 1)
        self.assertIn("--add-dir", spawned[0])
        self.assertFalse(held.alive)
        self.assertEqual(b.live, {})

    def test_a_timeout_with_work_still_listed_tells_the_channel(self):
        """Otherwise a dropped follow-up is indistinguishable from a slow one."""
        async def main():
            b = followup_bridge(idle=0.2)
            # Inventory never empties, so the task-idle deadline is what fires.
            await hand_off(b, [_tasks("a long silent build"), _result("started")])
            await asyncio.wait_for(b.live["k"].reader, 5)
            return b

        b = asyncio.run(main())
        self.assertEqual(b.live, {})
        notice = b.post.call_args_list[-1].args[1]
        self.assertIn("nothing further will be reported", notice)
        self.assertIn("a long silent build", notice)
        # Stating what happened, not claiming a promise: plenty of backgrounded
        # work (a dev server) never had a follow-up to deliver.
        self.assertNotIn("promised", notice)

    def test_stop_stays_silent_about_tasks_it_deliberately_dropped(self):
        """/stop already reported the drop; no second notice on the way out."""
        async def main():
            b = followup_bridge(idle=0.2)
            await hand_off(b, [_tasks("research"), _result("started")])
            b._cmd_stop("k")
            await asyncio.sleep(0.1)
            return b

        b = asyncio.run(main())
        b.post.assert_not_called()

    def test_end_live_run_never_evicts_a_newer_held_child(self):
        """A slow retirement must not orphan the run that replaced it."""
        async def main():
            b = followup_bridge()
            _, old_proc = await hand_off(b, [_tasks("research"), _result("started")])
            old = b.live["k"]

            async def slow_retirement():
                await asyncio.sleep(0.1)
            old.reader = asyncio.create_task(slow_retirement())

            # _end_live_run captures `old`, then waits on its reader…
            ending = asyncio.create_task(b._end_live_run("k", "/stop"))
            await asyncio.sleep(0.02)
            # …and in that window a new turn hands off its own child.
            newer = bridge.LiveRun(_fake_proc([], returncode=None), "k",
                                   {"channel_id": "c1"}, b.bindings["k"],
                                   (None, "acceptEdits"), [])
            b.live["k"] = newer
            await ending
            return b, newer, old_proc

        b, newer, old_proc = asyncio.run(main())
        self.assertIs(b.live.get("k"), newer,
                      "the newer run must stay reachable by /stop and shutdown")
        old_proc.kill.assert_called()

    def test_shutdown_kills_children_that_outlived_their_turn(self):
        async def main():
            b = followup_bridge()
            _, proc = await hand_off(b, [_tasks("research"), _result("started")])
            return b, proc

        b, proc = asyncio.run(main())
        b.kill_children()
        proc.kill.assert_called()
        self.assertEqual(b.live, {})
        self.assertEqual(b.procs, {})


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


class QueueLifecycleTests(unittest.TestCase):
    def test_slash_turn_is_claimed_as_its_own_batch(self):
        instance = make_bridge()
        instance.pending_turns = {"c1": [
            {"frame": {}, "text": "one"}, {"frame": {}, "text": "/compact"},
            {"frame": {}, "text": "two"},
        ]}
        self.assertEqual([e["text"] for e in instance._claim_pending_turns("c1")], ["one"])
        self.assertEqual([e["text"] for e in instance._claim_pending_turns("c1")], ["/compact"])
        self.assertEqual([e["text"] for e in instance._claim_pending_turns("c1")], ["two"])

    def test_tombstones_evict_oldest_and_claimed_controls_are_ignored(self):
        instance = make_bridge()
        for message_id in range(101):
            instance.handle_inbound_control({"type": "inbound_delete", "channel_id": "c1",
                                             "message_id": message_id, "thread_id": 1})
        self.assertNotIn(0, instance.pending_deletes)
        self.assertIn(100, instance.pending_deletes)
        instance.active_message_ids.add(200)
        instance.handle_inbound_control({"type": "inbound_update", "channel_id": "c1",
                                         "message_id": 200, "text": "changed"})
        self.assertNotIn(200, instance.pending_updates)

    def test_active_turn_drains_one_coalesced_followup_batch(self):
        instance = make_bridge()
        del instance.forward_to_claude
        instance.bindings = {"c1": {"cwd": "/tmp", "session_id": "s1"}}
        instance.typing = Mock()
        instance.tldr_default = False
        instance.tldr_min_chars = 1500
        instance.allowed_roots = []
        instance.max_attachment_bytes = 1024
        calls = 0
        async def run(_key, _frame, _binding, prompt):
            nonlocal calls
            calls += 1
            if calls == 1:
                instance.pending_turns["c1"] = [
                    {"frame": {"channel_id": "c1", "message_id": 2, "author": {"name": "Tom"}}, "text": "second"},
                    {"frame": {"channel_id": "c1", "message_id": 3, "author": {"name": "Tom"}}, "text": "third"},
                ]
                instance.bindings["c1"] = {"cwd": "/new", "session_id": "s2"}
            else:
                self.assertEqual(_binding["cwd"], "/new")
                self.assertIn("second", prompt)
                self.assertIn("third", prompt)
            return f"reply {calls}"
        instance.run_claude = run
        asyncio.run(instance.forward_to_claude("c1", {"channel_id": "c1", "message_id": 1}, "first"))
        self.assertEqual(calls, 2)
        self.assertEqual(instance.post.call_count, 2)

    def test_stop_drops_queued_turns_and_reactions(self):
        instance = make_bridge()
        instance.busy = {"c1"}
        proc = Mock(returncode=None)
        instance.procs = {"c1": proc}
        frame = {"channel_id": "c1", "message_id": 2}
        instance.pending_turns = {"c1": [{"frame": frame, "text": "later"}]}
        reply = instance._cmd_stop("c1")
        proc.kill.assert_called_once()
        self.assertNotIn("c1", instance.pending_turns)
        instance.clear_reaction.assert_called_with(frame)
        self.assertIn("removed 1", reply)

    def test_stop_before_child_registration_cancels_busy_run(self):
        instance = make_bridge()
        instance.busy = {"c1"}
        reply = instance._cmd_stop("c1")
        self.assertIn("Stopping", reply)
        self.assertIn("c1", instance.stop_requested)
        with patch.object(bridge.asyncio, "to_thread", AsyncMock(return_value=("prompt", [], None))):
            with self.assertRaises(bridge.RunStopped):
                asyncio.run(instance.run_claude("c1", {"channel_id": "c1"}, {}, "text"))
        self.assertNotIn("c1", instance.stop_requested)

    def test_queued_turn_can_be_edited_deleted_and_coalesced(self):
        instance = make_bridge()
        first = {"channel_id": "c1", "message_id": 10, "author": {"name": "Tom"}, "attachments": [{"id": "a"}]}
        second = {"channel_id": "c1", "message_id": 11, "author": {"name": "Tom"}, "attachments": [{"id": "b"}]}
        instance.pending_turns = {"c1": [{"frame": first, "text": "old"}, {"frame": second, "text": "second"}]}
        instance.handle_inbound_control({"type": "inbound_update", "channel_id": "c1", "message_id": 10, "text": "@claude-cli new"})
        frame, prompt = instance._coalesce_turns(instance.pending_turns["c1"])
        self.assertIn("new", prompt)
        self.assertEqual(frame["attachments"], [{"id": "a"}, {"id": "b"}])
        instance.handle_inbound_control({"type": "inbound_delete", "channel_id": "c1", "message_id": 10, "thread_id": None})
        self.assertEqual([e["frame"]["message_id"] for e in instance.pending_turns["c1"]], [11])

    def test_queue_cap_posts_one_notice_and_rejects_each_message(self):
        instance = make_bridge()
        del instance.forward_to_claude
        instance.bindings = {"c1": {"cwd": "/tmp", "session_id": "s1"}}
        instance.busy = {"c1"}
        instance.pending_turns = {"c1": [{"frame": {"message_id": i}, "text": str(i)} for i in range(bridge.MAX_QUEUED_TURNS)]}
        frame = {"channel_id": "c1", "message_id": 99, "author": {"type": "user"}}
        self.assertFalse(asyncio.run(instance.forward_to_claude("c1", frame, "overflow")))
        self.assertFalse(asyncio.run(instance.forward_to_claude("c1", frame, "overflow again")))
        instance.post.assert_called_once()
        self.assertIn("not accepted", instance.post.call_args.args[1])
        self.assertEqual(instance.set_reaction.call_count, 2)
        instance.set_reaction.assert_called_with(frame, "🚫", remember=False)

    def test_coalescing_caps_attachments_and_names_omissions(self):
        instance = make_bridge()
        entries = [{"frame": {"message_id": i, "attachments": [{"id": f"file-{i}"}]},
                    "text": str(i)} for i in range(bridge.MAX_ATTACHMENTS + 2)]
        instance.pending_turns = {"c1": entries}
        first = instance._claim_pending_turns("c1")
        self.assertEqual(len(first), bridge.MAX_ATTACHMENTS)
        self.assertEqual(len(instance.pending_turns["c1"]), 2)
        frame, prompt = instance._coalesce_turns(first)
        self.assertEqual(len(frame["attachments"]), bridge.MAX_ATTACHMENTS)
        self.assertNotIn("omitted", prompt)
        oversized = [{"frame": {"message_id": 9, "attachments": [
            {"id": f"single-{i}"} for i in range(bridge.MAX_ATTACHMENTS + 1)]}, "text": "one"}]
        _, prompt = instance._coalesce_turns(oversized)
        self.assertIn("single-5", prompt)

    def test_idle_fast_path_keeps_existing_backlog_fifo(self):
        instance = make_bridge()
        del instance.forward_to_claude
        instance._answer_pending_question = Mock(return_value=False)
        instance.bindings = {"c1": {"cwd": "/tmp", "session_id": "s1"}}
        instance.pending_turns = {"c1": [{"frame": {"channel_id": "c1", "message_id": 1,
                                                       "author": {"name": "Tom"}}, "text": "older", "queued": True}]}
        events = []
        instance.send = Mock(side_effect=lambda f: events.append(("send", f)))
        instance.set_reaction = Mock(side_effect=lambda f, emoji, **kw: events.append(("reaction", emoji)))
        instance.typing = Mock()
        instance.tldr_default = False
        instance.tldr_min_chars = 1500
        instance.allowed_roots = []
        instance.max_attachment_bytes = 1024
        prompts = []
        async def run(_key, _frame, _binding, prompt):
            prompts.append(prompt)
            return "done"
        instance.run_claude = run
        frame = {"channel_id": "c1", "message_id": 2, "author": {"name": "Tom"}}
        asyncio.run(instance.forward_to_claude("c1", frame, "newer"))
        self.assertLess(prompts[0].index("older"), prompts[0].index("newer"))
        self.assertEqual([e[1]["message_id"] for e in events if e[0] == "send" and e[1]["type"] == "claim"], [1])
        self.assertLess(next(i for i, e in enumerate(events) if e[0] == "send" and e[1]["type"] == "claim"), next(i for i, e in enumerate(events) if e == ("reaction", "👀")))

    def test_edit_preserves_thread_context_prefix(self):
        instance = make_bridge()
        original = '[thread on: "root" — by Tom]\nold'
        instance.pending_turns = {"c1:1": [{"frame": {"channel_id": "c1", "message_id": 2},
                                               "text": original}]}
        instance.handle_inbound_control({"type": "inbound_update", "channel_id": "c1",
                                         "message_id": 2, "text": "@claude-cli new"})
        self.assertEqual(instance.pending_turns["c1:1"][0]["text"],
                         '[thread on: "root" — by Tom]\nnew')


class OutboundAttachmentTests(unittest.TestCase):
    def test_stop_flags_clear_when_run_raises(self):
        instance = make_bridge()
        instance.claude_bin = "claude"
        instance.default_permission_mode = "acceptEdits"
        instance.default_model = None
        instance.base_claude_args = []
        instance._stage_attachments = Mock(return_value=("prompt", [], None))
        instance._append_system_args = Mock(return_value=[])
        instance.stopped_processes = {"c1"}
        instance.stop_requested = set()
        with patch.object(bridge.asyncio, "create_subprocess_exec",
                          AsyncMock(side_effect=RuntimeError("spawn failed"))):
            with self.assertRaises(bridge.RunStopped):
                asyncio.run(instance.run_claude("c1", {"channel_id": "c1"}, {"cwd": "/tmp"}, "x"))
            with self.assertRaisesRegex(RuntimeError, "spawn failed"):
                asyncio.run(instance.run_claude("c1", {"channel_id": "c1"}, {"cwd": "/tmp"}, "x"))
        self.assertFalse(instance.stop_requested)
        self.assertFalse(instance.stopped_processes)

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

    def test_provider_error_and_stop_do_not_mark_message_complete(self):
        for reply in ["(claude error) denied", bridge.RunStopped()]:
            instance = make_bridge()
            del instance.forward_to_claude
            instance.bindings = {"c1": {"cwd": "/tmp", "session_id": "s1"}}
            instance.typing = Mock()
            instance.run_claude = (AsyncMock(side_effect=reply) if isinstance(reply, Exception)
                                   else AsyncMock(return_value=reply))
            frame = {"channel_id": "c1", "message_id": 1}
            asyncio.run(instance.forward_to_claude("c1", frame, "first"))
            self.assertFalse(any(c.args[1] == "✅" for c in instance.set_reaction.call_args_list))
            instance.clear_reaction.assert_called_with(frame)

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
            env=instance.child_env(),
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


class ClaudeAccountTests(unittest.TestCase):
    def _bridge(self, tmp):
        b = bridge.Bridge.__new__(bridge.Bridge)
        b.accounts = bridge.parse_accounts(
            f"work:{tmp}/work,personal:{tmp}/personal")
        b.account = "work"
        b.account_epoch = 0
        b.state_file = Path(tmp) / "state.json"
        b.bindings = {"c1": {"session_id": "old", "cwd": "/repo",
                              "model": "sonnet", "permission_mode": "plan"}}
        b.listings = {"c1": [{"session_id": "old"}]}
        b.busy = set()
        b.live = {}
        b.claude_bin = "claude-test"
        b.agent_id = "claude-cli"
        b.last_usage_frame = {"windows": [{"key": "five_hour"}]}
        b.send = Mock()
        b._saved_account = "work"
        b._previous_config_dir = b.config_dir
        b._account_state_valid = True
        b.account_auth_problem = None
        b._spawn = lambda coro: coro.close()
        return b

    def test_parse_accounts_and_single_account_compatibility(self):
        with tempfile.TemporaryDirectory() as tmp:
            accounts = bridge.parse_accounts(f"Work:{tmp}/w,personal:{tmp}/p")
            self.assertEqual(list(accounts), ["work", "personal"])
            self.assertTrue(accounts["work"].is_absolute())
        with patch.dict(bridge.os.environ, {"CLAUDE_CONFIG_DIR": "/tmp/claude-one"}):
            self.assertEqual(
                bridge.parse_accounts(""),
                {bridge.DEFAULT_ACCOUNT: Path("/tmp/claude-one").resolve()},
            )

    def test_parse_accounts_rejects_bad_and_duplicate_names(self):
        for raw in ("missing-path", "bad name:/tmp/x", "work:/a,work:/b"):
            with self.subTest(raw=raw), self.assertRaises(ValueError):
                bridge.parse_accounts(raw)

    def test_child_env_pins_selected_config_directory(self):
        with tempfile.TemporaryDirectory() as tmp:
            b = self._bridge(tmp)
            self.assertEqual(b.child_env()["CLAUDE_CONFIG_DIR"], str(b.accounts["work"]))
            self.assertEqual(
                b.child_env("personal")["CLAUDE_CONFIG_DIR"],
                str(b.accounts["personal"]),
            )

    def test_main_run_spawn_pins_active_account_environment(self):
        async def exercise():
            b = followup_bridge()
            b.async_followups = False
            b.accounts = {"work": Path("/tmp/claude-work").resolve()}
            b.account = "work"
            proc = _fake_proc([_result("done")])
            with patch.object(bridge.asyncio, "create_subprocess_exec",
                              new=AsyncMock(return_value=proc)) as spawn:
                reply = await b.run_claude(
                    "k", {"channel_id": "c1"}, b.bindings["k"], "hi")
            return b, reply, spawn

        b, reply, spawn = asyncio.run(exercise())
        self.assertEqual(reply, "done")
        self.assertEqual(
            spawn.await_args.kwargs["env"]["CLAUDE_CONFIG_DIR"],
            str(b.accounts["work"]),
        )

    def test_auth_status_uses_target_env_and_parses_cli_json(self):
        with tempfile.TemporaryDirectory() as tmp:
            b = self._bridge(tmp)
            proc = Mock(returncode=0)
            proc.communicate = AsyncMock(return_value=(json.dumps({
                "loggedIn": True, "authMethod": "claude.ai",
                "projectsDirectory": str(b.accounts["personal"] / "projects"),
            }).encode(), b""))
            with patch.object(bridge.asyncio, "create_subprocess_exec",
                              new=AsyncMock(return_value=proc)) as spawn:
                status = asyncio.run(b.account_status("personal"))
            self.assertTrue(status["ok"])
            self.assertEqual(
                spawn.await_args.kwargs["env"]["CLAUDE_CONFIG_DIR"],
                str(b.accounts["personal"]),
            )

    def test_auth_status_timeout_kills_probe_and_reports_failure(self):
        with tempfile.TemporaryDirectory() as tmp:
            b = self._bridge(tmp)
            proc = Mock(returncode=None)
            proc.communicate = AsyncMock(side_effect=TimeoutError())
            proc.kill = Mock()
            proc.wait = AsyncMock(return_value=1)
            with patch.object(bridge.asyncio, "create_subprocess_exec",
                              new=AsyncMock(return_value=proc)):
                status = asyncio.run(b.account_status("personal"))
            self.assertFalse(status["ok"])
            proc.kill.assert_called_once()
            proc.wait.assert_awaited_once()

    def test_switch_rejects_unusable_target_without_mutating_bindings(self):
        with tempfile.TemporaryDirectory() as tmp:
            b = self._bridge(tmp)
            b.account_status = AsyncMock(return_value={"ok": False})
            reply = asyncio.run(b._cmd_switch("personal"))
            self.assertIn("claude auth login", reply)
            self.assertEqual(b.account, "work")
            self.assertEqual(b.bindings["c1"]["session_id"], "old")

    def test_switch_rejects_busy_and_live_children(self):
        with tempfile.TemporaryDirectory() as tmp:
            b = self._bridge(tmp)
            b.busy.add("c1")
            self.assertIn("still active", asyncio.run(b._cmd_switch("personal")))
            b.busy.clear()
            b.live["c1"] = Mock(alive=True)
            self.assertIn("background", asyncio.run(b._cmd_switch("personal")))

    def test_switch_rejects_credential_override(self):
        with tempfile.TemporaryDirectory() as tmp, patch.dict(
            bridge.os.environ, {"ANTHROPIC_API_KEY": "test-only"}, clear=False
        ):
            b = self._bridge(tmp)
            reply = asyncio.run(b._cmd_switch("personal"))
            self.assertIn("ANTHROPIC_API_KEY", reply)
            self.assertEqual(b.account, "work")

    def test_successful_switch_releases_only_account_local_state(self):
        with tempfile.TemporaryDirectory() as tmp, patch.dict(
            bridge.os.environ,
            {name: "" for name in bridge.CLAUDE_CREDENTIAL_OVERRIDES}, clear=False,
        ):
            b = self._bridge(tmp)
            b.account_status = AsyncMock(return_value={
                "ok": True,
                "projectsDirectory": str(b.accounts["personal"] / "projects"),
            })
            reply = asyncio.run(b._cmd_switch("personal"))
            self.assertIn("Switched from work to personal", reply)
            self.assertIsNone(b.bindings["c1"]["session_id"])
            self.assertEqual(b.bindings["c1"]["cwd"], "/repo")
            self.assertEqual(b.bindings["c1"]["model"], "sonnet")
            self.assertEqual(b.account_epoch, 1)
            saved = json.loads(b.state_file.read_text())
            self.assertEqual(saved["config_dir"], str(b.accounts["personal"]))
            self.assertEqual(b.last_usage_frame["availability"], "unavailable")

    def test_v2_state_matches_renamed_account_by_persisted_directory(self):
        with tempfile.TemporaryDirectory() as tmp:
            b = bridge.Bridge.__new__(bridge.Bridge)
            b.accounts = bridge.parse_accounts(f"renamed:{tmp}/same,other:{tmp}/other")
            b.account = "renamed"
            b.state_file = Path(tmp) / "state.json"
            b.state_file.write_text(json.dumps({
                "_v": 2, "account": "old-name",
                "config_dir": str(Path(tmp) / "same"),
                "bindings": {"c1": {"session_id": "keep", "cwd": "/repo"}},
            }))
            bindings = b._load_state()
            self.assertEqual(b.account, "renamed")
            self.assertEqual(bindings["c1"]["session_id"], "keep")

    def test_flat_state_migrates_without_losing_bindings(self):
        with tempfile.TemporaryDirectory() as tmp, patch.dict(
            bridge.os.environ, {"CLAUDE_CONFIG_DIR": str(Path(tmp) / "config")}
        ):
            b = bridge.Bridge.__new__(bridge.Bridge)
            b.accounts = bridge.parse_accounts("")
            b.account = bridge.DEFAULT_ACCOUNT
            b.state_file = Path(tmp) / "state.json"
            b.state_file.write_text(json.dumps({
                "c1": {"session_id": "keep", "cwd": "/repo"},
            }))
            b.bindings = b._load_state()
            b._account_state_valid = True
            b._save_state()
            saved = json.loads(b.state_file.read_text())
            self.assertEqual(saved["_v"], 2)
            self.assertEqual(saved["bindings"]["c1"]["session_id"], "keep")

    def test_unusable_changed_startup_preserves_previous_state(self):
        with tempfile.TemporaryDirectory() as tmp:
            b = self._bridge(tmp)
            b._previous_config_dir = Path(tmp) / "old"
            b._saved_account = "old"
            b.account_status = AsyncMock(return_value={"ok": False})
            asyncio.run(b._reconcile_startup_account())
            self.assertEqual(b.bindings["c1"]["session_id"], "old")
            self.assertFalse(b._account_state_valid)
            b._save_state()
            saved = json.loads(b.state_file.read_text())
            self.assertEqual(saved["account"], "old")
            self.assertEqual(saved["config_dir"], str(Path(tmp) / "old"))

    def test_startup_projects_mismatch_preserves_sessions(self):
        with tempfile.TemporaryDirectory() as tmp:
            b = self._bridge(tmp)
            b._previous_config_dir = Path(tmp) / "old"
            b.account_status = AsyncMock(return_value={
                "ok": True, "projectsDirectory": str(Path(tmp) / "unexpected"),
            })
            asyncio.run(b._reconcile_startup_account())
            self.assertEqual(b.bindings["c1"]["session_id"], "old")
            self.assertIn("projectsDirectory", b.account_auth_problem)

    def test_status_names_account_even_without_a_binding(self):
        with tempfile.TemporaryDirectory() as tmp:
            b = self._bridge(tmp)
            b.bindings = {}
            b.account_auth_problem = "login required"
            reply = b._cmd_status("missing")
            self.assertIn("Account: work", reply)
            self.assertIn("login required", reply)

    def test_usage_result_from_previous_epoch_is_discarded(self):
        with tempfile.TemporaryDirectory() as tmp:
            b = self._bridge(tmp)
            proc = Mock(returncode=0)

            async def communicate():
                b.account_epoch += 1
                return (json.dumps({"result": (
                    "Current session: 16% used · resets Aug 31 at 3:09pm (Asia/Calcutta)\n"
                    "Current week (all models): 9% used · resets Sep 3 at 1:29pm (Asia/Calcutta)"
                )}).encode(), b"")

            proc.communicate = communicate
            b.last_usage_frame = None
            with patch.object(bridge.asyncio, "create_subprocess_exec",
                              new=AsyncMock(return_value=proc)):
                asyncio.run(b.refresh_usage())
            b.send.assert_not_called()

    def test_sessions_result_from_previous_epoch_is_discarded(self):
        b = make_bridge()
        b.accounts = {"work": Path("/tmp/claude-work")}
        b.account = "work"
        b.account_epoch = 0
        b.sessions_limit = 10
        b.listings = {}

        async def stale_scan(*_args):
            b.account_epoch += 1
            return [{"session_id": "stale", "cwd": "/old", "last_prompt": "old"}]

        frame = {
            "channel_id": "c1", "text": "/sessions", "mentioned": True,
            "author": {"type": "user", "id": "u1"},
        }
        with patch.object(bridge.asyncio, "to_thread", side_effect=stale_scan):
            asyncio.run(b.handle_inbound(frame))
        self.assertNotIn("c1", b.listings)
        self.assertIn("run /sessions again", b.post.call_args.args[1])

    def test_use_result_from_previous_epoch_is_not_bound(self):
        with tempfile.TemporaryDirectory() as tmp:
            b = self._bridge(tmp)
            b.listings = {}
            b._set_binding = Mock()

            def stale_lookup(_session_id, _projects_dir):
                b.account_epoch += 1
                return {"session_id": "stale", "cwd": "/old", "last_prompt": "old"}

            with patch.object(bridge, "find_session", side_effect=stale_lookup):
                reply = b._cmd_use("c1", "stale", epoch=0)
            self.assertIn("previous account", reply)
            b._set_binding.assert_not_called()


if __name__ == "__main__":
    unittest.main()
