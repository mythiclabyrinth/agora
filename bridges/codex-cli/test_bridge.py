import asyncio
import json
import importlib.util
import io
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, Mock, patch


SPEC = importlib.util.spec_from_file_location(
    "codex_bridge", Path(__file__).with_name("bridge.py")
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
        self.assertEqual(bridge.Bridge._http_base("wss://host/p/agent/ws?token=x"), "https://host/p")

    def test_fetches_missing_inline_bytes_and_cleans_truncation(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(bridge._NO_REDIRECT_OPENER, "open", return_value=FakeResponse(b"image")):
            saved, images, _notes = bridge.materialize_attachments(
                [{"id": "f/1", "filename": "x.png", "mime": "image/png", "size": 5}],
                Path(tmp), "https://host", "token", "codex-cli")
            self.assertEqual(saved, images)
            self.assertEqual(saved[0].read_bytes(), b"image")
            request = bridge._NO_REDIRECT_OPENER.open.call_args.args[0]
            self.assertEqual(request.full_url, "https://host/agent/files/f%2F1?agent_id=codex-cli")
            self.assertEqual(request.headers["Authorization"], "Bearer token")
        with tempfile.TemporaryDirectory() as tmp, patch.object(bridge._NO_REDIRECT_OPENER, "open", return_value=FakeResponse(b"short")):
            saved, images, notes = bridge.materialize_attachments(
                [{"id": "f1", "filename": "x.png", "mime": "image/png", "size": 6}],
                Path(tmp), "https://host", "token", "codex-cli")
            self.assertEqual((saved, images, list(Path(tmp).iterdir())), ([], [], []))
            self.assertIn("downloaded size mismatch", notes[0])

    def test_refuses_redirects_and_enforces_total_deadline(self):
        self.assertEqual(bridge.ATTACHMENT_FETCH_TIMEOUT + (100 * 1024 * 1024) / bridge.MIN_DOWNLOAD_RATE_BYTES_PER_SECOND, 130)
        self.assertIsNone(bridge._NoRedirectHandler().redirect_request(Mock(), None, 302, "Found", {}, "https://elsewhere/file"))
        with tempfile.TemporaryDirectory() as tmp, patch.object(bridge.time, "monotonic", new=AdvancingClock()), patch.object(bridge._NO_REDIRECT_OPENER, "open") as fetch:
            fetch.return_value.__enter__.return_value.read1.return_value = b"image"
            saved, images, notes = bridge.materialize_attachments(
                [{"id": "f1", "filename": "x.png", "mime": "image/png", "size": 5}], Path(tmp),
                "https://host", "token", "codex-cli")
            self.assertEqual((saved, images, list(Path(tmp).iterdir())), ([], [], []))
            self.assertIn("total-transfer deadline", notes[0])

    def test_rejects_oversize_and_overread_with_cleanup(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(bridge._NO_REDIRECT_OPENER, "open") as fetch:
            saved, images, notes = bridge.materialize_attachments(
                [{"id": "f1", "filename": "huge", "size": bridge.MAX_INBOUND_ATTACHMENT_BYTES + 1}],
                Path(tmp), "https://host", "token", "codex-cli")
            fetch.assert_not_called()
            self.assertEqual((saved, images), ([], []))
            self.assertIn("safety limit", notes[0])
        with tempfile.TemporaryDirectory() as tmp, patch.object(bridge._NO_REDIRECT_OPENER, "open", return_value=FakeResponse(b"toolong")):
            saved, images, notes = bridge.materialize_attachments(
                [{"id": "f1", "filename": "x", "size": 5}], Path(tmp),
                "https://host", "token", "codex-cli")
            self.assertEqual((saved, images, list(Path(tmp).iterdir())), ([], [], []))
            self.assertIn("downloaded size mismatch", notes[0])

    def test_legacy_metadata_falls_back_and_inline_bytes_win_over_id(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(bridge._NO_REDIRECT_OPENER, "open") as fetch:
            saved, images, notes = bridge.materialize_attachments(
                [{"filename": "legacy.mov", "mime": "video/quicktime", "size": 99}],
                Path(tmp), "https://host", "token", "codex-cli")
            self.assertEqual((saved, images), ([], []))
            self.assertIn("too large to inline; not available locally", notes[0])
            saved, images, _notes = bridge.materialize_attachments(
                [{"id": "f1", "filename": "inline.png", "mime": "image/png",
                  "size": 5, "data_b64": "aW1hZ2U="}],
                Path(tmp), "https://host", "token", "codex-cli")
            self.assertEqual(saved, images)
            self.assertEqual(saved[0].read_bytes(), b"image")
            fetch.assert_not_called()


class ModelSelectionTests(unittest.TestCase):
    def test_friendly_names_are_case_insensitive(self):
        self.assertEqual(bridge.normalize_model("astra"), "gpt-6-astra")
        self.assertEqual(bridge.normalize_model("sol"), "gpt-5.6-sol")
        self.assertEqual(bridge.normalize_model("TERRA"), "gpt-5.6-terra")
        self.assertEqual(bridge.normalize_model(" luna "), "gpt-5.6-luna")

    def test_unknown_models_are_rejected(self):
        self.assertIsNone(bridge.normalize_model("gpt-unlisted"))

    def test_model_command_persists_canonical_id(self):
        instance = bridge.Bridge.__new__(bridge.Bridge)
        instance.bindings = {"channel": {"cwd": "/tmp"}}
        instance.default_model = bridge.DEFAULT_MODEL
        instance._save_state = Mock()

        reply = instance._cmd_model("channel", "luna")

        self.assertEqual(instance.bindings["channel"]["model"], "gpt-5.6-luna")
        self.assertIn("gpt-5.6-luna", reply)
        instance._save_state.assert_called_once()

    def test_default_clears_override_and_falls_back_to_sol(self):
        instance = bridge.Bridge.__new__(bridge.Bridge)
        instance.bindings = {
            "channel": {"cwd": "/tmp", "model": "gpt-5.6-terra"}
        }
        instance.default_model = bridge.DEFAULT_MODEL
        instance._save_state = Mock()

        reply = instance._cmd_model("channel", "default")

        self.assertNotIn("model", instance.bindings["channel"])
        self.assertIn("gpt-5.6-sol", reply)


class SandboxSelectionTests(unittest.TestCase):
    def test_workspace_git_selects_permission_profile(self):
        instance = bridge.Bridge.__new__(bridge.Bridge)

        self.assertEqual(
            instance._sandbox_args("workspace-git"),
            ["-c", "default_permissions=workspace-git"],
        )


def make_bridge(peer_agents=""):
    """A Bridge with just enough state to drive handle_inbound."""
    instance = bridge.Bridge.__new__(bridge.Bridge)
    instance.agent_id = "codex-cli"
    instance.agent_name = "Codex"
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
    instance.bindings = {}
    instance.set_reaction = Mock()
    instance.clear_reaction = Mock()
    instance.post = Mock()
    instance.forward_to_codex = AsyncMock()
    return instance


def peer_frame(**overrides):
    frame = {
        "channel_id": "c1",
        "author": {"type": "agent", "id": "claude-cli", "name": "Claude"},
        "mentioned": True,
        "any_mention": True,
        "text": "@codex please review the diff",
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
        instance.forward_to_codex.assert_not_called()
        self.assertIn("c1", instance.context_buffer)

    def test_allowlisted_peer_mention_drives_codex(self):
        instance = make_bridge(peer_agents="claude-cli")
        asyncio.run(instance.handle_inbound(peer_frame()))
        instance.forward_to_codex.assert_awaited_once()
        args, kwargs = instance.forward_to_codex.await_args
        self.assertTrue(kwargs.get("from_peer"))
        prompt = args[2]
        self.assertIn("Relay note", prompt)
        self.assertIn("Claude", prompt)
        self.assertNotIn("c1", instance.context_buffer)

    def test_unmentioned_peer_message_only_buffers(self):
        instance = make_bridge(peer_agents="claude-cli")
        asyncio.run(instance.handle_inbound(peer_frame(mentioned=False)))
        instance.forward_to_codex.assert_not_called()
        self.assertIn("c1", instance.context_buffer)

    def test_non_allowlisted_agent_only_buffers(self):
        instance = make_bridge(peer_agents="claude-cli")
        frame = peer_frame(author={"type": "agent", "id": "rogue-bot", "name": "Rogue"})
        asyncio.run(instance.handle_inbound(frame))
        instance.forward_to_codex.assert_not_called()
        self.assertIn("c1", instance.context_buffer)

    def test_peer_text_never_reaches_the_command_table(self):
        instance = make_bridge(peer_agents="claude-cli")
        instance._cmd_new = Mock()
        asyncio.run(instance.handle_inbound(peer_frame(text="/new /tmp")))
        instance._cmd_new.assert_not_called()
        instance.forward_to_codex.assert_awaited_once()
        prompt = instance.forward_to_codex.await_args.args[2]
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
                asyncio.run(instance.run_codex("c1", {"channel_id": "c1"}, {}, "text"))
        self.assertNotIn("c1", instance.stop_requested)

    def test_delete_thread_root_and_control_before_enqueue(self):
        instance = make_bridge()
        instance.pending_turns = {"c1:42": [
            {"frame": {"channel_id": "c1", "thread_id": 42, "message_id": 44}, "text": "reply"}
        ]}
        instance.active_message_ids.add(42)
        instance.handle_inbound_control({"type": "inbound_delete", "channel_id": "c1",
                                         "message_id": 42, "thread_id": None})
        self.assertNotIn("c1:42", instance.pending_turns)
        instance.handle_inbound_control({"type": "inbound_update", "channel_id": "c1",
                                         "message_id": 7, "text": "@codex-cli latest"})
        entry = instance._pending_entry({"channel_id": "c1", "message_id": 7}, "old")
        self.assertEqual(entry["text"], "latest")

    def test_queue_cap_posts_notice_without_reaction(self):
        instance = make_bridge()
        del instance.forward_to_codex
        instance.bindings = {"c1": {"cwd": "/tmp", "session_id": "s1"}}
        instance.busy = {"c1"}
        instance.pending_turns = {"c1": [
            {"frame": {"message_id": i}, "text": str(i)} for i in range(bridge.MAX_QUEUED_TURNS)
        ]}
        frame = {"channel_id": "c1", "message_id": 99, "author": {"type": "user"}}
        self.assertFalse(asyncio.run(instance.forward_to_codex("c1", frame, "overflow")))
        self.assertFalse(asyncio.run(instance.forward_to_codex("c1", frame, "overflow again")))
        instance.post.assert_called_once()
        self.assertIn("not accepted", instance.post.call_args.args[1])
        instance.set_reaction.assert_not_called()

    def test_coalescing_caps_attachments_and_names_omissions(self):
        instance = make_bridge()
        entries = [{"frame": {"message_id": i, "attachments": [{"id": f"file-{i}"}]},
                    "text": str(i)} for i in range(bridge.MAX_ATTACHMENTS + 2)]
        frame, prompt = instance._coalesce_turns(entries)
        self.assertEqual(len(frame["attachments"]), bridge.MAX_ATTACHMENTS)
        self.assertIn("file-5", prompt)
        self.assertIn("file-6", prompt)

    def test_edit_preserves_thread_context_prefix(self):
        instance = make_bridge()
        original = '[thread on: "root" — by Tom]\nold'
        instance.pending_turns = {"c1:1": [{"frame": {"channel_id": "c1", "message_id": 2},
                                               "text": original}]}
        instance.handle_inbound_control({"type": "inbound_update", "channel_id": "c1",
                                         "message_id": 2, "text": "@codex-cli new"})
        self.assertEqual(instance.pending_turns["c1:1"][0]["text"],
                         '[thread on: "root" — by Tom]\nnew')

    def test_busy_peer_turn_buffers_instead_of_noise_post(self):
        instance = make_bridge(peer_agents="claude-cli")
        del instance.forward_to_codex  # exercise the real method
        instance.bindings = {"c1": {"cwd": "/tmp", "session_id": "s1"}}
        instance.busy = {"c1"}
        handled = asyncio.run(
            instance.forward_to_codex("c1", peer_frame(), "wrapped", from_peer=True)
        )
        # False tells handle_inbound to skip the ✅ reaction — nothing ran.
        self.assertFalse(handled)
        instance.post.assert_not_called()
        self.assertIn("c1", instance.context_buffer)
        instance.clear_reaction.assert_called_once()

    def test_busy_human_turn_is_queued(self):
        instance = make_bridge()
        del instance.forward_to_codex
        instance.bindings = {"c1": {"cwd": "/tmp", "session_id": "s1"}}
        instance.busy = {"c1"}
        frame = {"channel_id": "c1", "author": {"type": "user", "id": "tom"}}
        handled = asyncio.run(instance.forward_to_codex("c1", frame, "hello"))
        self.assertFalse(handled)
        instance.post.assert_not_called()
        self.assertEqual(instance.pending_turns["c1"][0]["text"], "hello")
        instance.set_reaction.assert_called_with(frame, "⏳")

    def test_queued_turn_can_be_edited_deleted_and_coalesced(self):
        instance = make_bridge()
        first = {"channel_id": "c1", "message_id": 10, "author": {"name": "Tom"},
                 "attachments": [{"id": "a"}]}
        second = {"channel_id": "c1", "message_id": 11, "author": {"name": "Tom"},
                  "attachments": [{"id": "b"}]}
        instance.pending_turns = {"c1": [
            {"frame": first, "text": "old"}, {"frame": second, "text": "second"},
        ]}
        instance.handle_inbound_control({"type": "inbound_update", "channel_id": "c1",
                                         "message_id": 10, "text": "new"})
        frame, prompt = instance._coalesce_turns(instance.pending_turns["c1"])
        self.assertIn("new", prompt)
        self.assertIn("second", prompt)
        self.assertEqual(frame["attachments"], [{"id": "a"}, {"id": "b"}])
        instance.handle_inbound_control({"type": "inbound_delete", "channel_id": "c1",
                                         "message_id": 10, "thread_id": None})
        self.assertEqual([e["frame"]["message_id"] for e in instance.pending_turns["c1"]], [11])


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
        del instance.forward_to_codex
        instance.bindings = {"c1": {"cwd": "/tmp", "session_id": "s1"}}
        instance.run_codex = AsyncMock(return_value="")
        instance.typing = Mock()
        instance.tldr_default = False
        instance.tldr_min_chars = 1500
        instance.allowed_roots = []
        instance.max_attachment_bytes = 10 * 1024 * 1024
        asyncio.run(instance.forward_to_codex("c1", {"channel_id": "c1"}, "hello"))
        self.assertEqual(instance.post.call_args.args[1], "(empty response)")

    def test_active_turn_drains_one_coalesced_followup_batch(self):
        instance = make_bridge()
        del instance.forward_to_codex
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
                    {"frame": {"channel_id": "c1", "message_id": 2,
                               "author": {"name": "Tom"}}, "text": "second"},
                    {"frame": {"channel_id": "c1", "message_id": 3,
                               "author": {"name": "Tom"}}, "text": "third"},
                ]
                instance.bindings["c1"] = {"cwd": "/new", "session_id": "s2"}
            else:
                self.assertEqual(_binding["cwd"], "/new")
                self.assertIn("Message 2", prompt)
                self.assertIn("second", prompt)
                self.assertIn("Message 3", prompt)
                self.assertIn("third", prompt)
            return f"reply {calls}"

        instance.run_codex = run
        frame = {"channel_id": "c1", "message_id": 1, "author": {"name": "Tom"}}
        asyncio.run(instance.forward_to_codex("c1", frame, "first"))
        self.assertEqual(calls, 2)
        self.assertEqual(instance.post.call_count, 2)
        self.assertNotIn("c1", instance.busy)

    def test_provider_error_and_stop_do_not_mark_message_complete(self):
        for reply in ["(codex error) denied", bridge.RunStopped()]:
            instance = make_bridge()
            del instance.forward_to_codex
            instance.bindings = {"c1": {"cwd": "/tmp", "session_id": "s1"}}
            instance.typing = Mock()
            instance.run_codex = (AsyncMock(side_effect=reply) if isinstance(reply, Exception)
                                  else AsyncMock(return_value=reply))
            frame = {"channel_id": "c1", "message_id": 1}
            asyncio.run(instance.forward_to_codex("c1", frame, "first"))
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
        instance.agent_id = "codex-cli"
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
    def test_refresh_reads_rollouts_off_the_event_loop(self):
        instance = bridge.Bridge.__new__(bridge.Bridge)
        instance.agent_id = "codex-cli"
        instance.send = Mock()
        usage = {
            "provider": "codex", "availability": "available", "captured_at": 10,
            "windows": [{"key": "primary", "label": "Weekly", "used_percent": 4}],
        }
        with patch.object(bridge.asyncio, "to_thread", new=AsyncMock(return_value=usage)) as to_thread:
            asyncio.run(instance.refresh_usage("thread-1"))
        to_thread.assert_awaited_once_with(bridge.read_codex_usage, "thread-1")
        instance.send.assert_called_once_with(instance.last_usage_frame)

    def test_rollout_rate_limits_keep_percentage_units_and_duration_labels(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            path = root / "2026" / "08" / "31" / "rollout-test-thread-1.jsonl"
            path.parent.mkdir(parents=True)
            path.write_text(json.dumps({"timestamp": "2026-08-31T01:23:45Z", "payload": {"type": "token_count", "rate_limits": {
                "primary": {"used_percent": 4.0, "window_minutes": 10080, "resets_at": 3000},
                "secondary": {"used_percent": 22.0, "window_minutes": 300, "resets_at": 2000},
                "plan_type": "pro", "credits": {"has_credits": True, "balance": "5"},
            }}}) + "\n")
            with patch.object(bridge, "CODEX_SESSIONS", root):
                usage = bridge.read_codex_usage("thread-1")
        self.assertEqual(usage["windows"][0]["used_percent"], 4.0)
        self.assertEqual(usage["windows"][0]["label"], "Weekly")
        self.assertEqual(usage["windows"][1]["label"], "5-hour")
        self.assertEqual(usage["credits"]["balance"], "5")
        self.assertEqual(usage["captured_at"], 1788139425)

    def test_rollout_without_rate_limits_is_ignored(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(bridge, "CODEX_SESSIONS", Path(tmp)):
            self.assertIsNone(bridge.read_codex_usage())


if __name__ == "__main__":
    unittest.main()
