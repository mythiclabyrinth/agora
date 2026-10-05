"""Offline Jev transport, failure isolation and approval lifecycle tests."""
import asyncio
import importlib.util
import io
import json
import math
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, Mock, patch


SPEC = importlib.util.spec_from_file_location("jev_bridge", Path(__file__).with_name("bridge.py"))
bridge = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(bridge)


def advisor(**env):
    with patch.dict(bridge.os.environ, {
        "JEV_MODE": "advise", "JEV_OPENROUTER_API_KEY": "test-dedicated-key", **env,
    }, clear=True):
        return bridge.JevAdvisor()


def answer(destructive=0.01, secrets=0.02, external=0.03):
    return {"answers": {name: {"type": "noul", "noul": value} for name, value in
                        zip(("destructive", "secrets", "external"), (destructive, secrets, external))}}


class Response(io.BytesIO):
    def __init__(self, body, code=200, headers=None):
        super().__init__(body)
        self.code = code
        self.headers = headers or {}


class JevClientTests(unittest.IsolatedAsyncioTestCase):
    async def evaluate(self, client, payload=None, status=200, headers=None):
        with patch.object(client, "_request", return_value=(status, payload or answer(), headers or {})):
            return await client.assess("Bash", {"command": "pwd"}, "/tmp/repo")

    async def test_default_off_missing_key_and_invalid_configuration_skip_network(self):
        cases = [{"JEV_MODE": "off"}, {"JEV_OPENROUTER_API_KEY": ""},
                 {"JEV_MODE": "auto"}, {"JEV_TIMEOUT_SECONDS": "nan"},
                 {"JEV_TIMEOUT_SECONDS": "11"}, {"JEV_TIMEOUT_SECONDS": "garbage"},
                 {"JEV_SAFE_THRESHOLD": "0.9"}, {"JEV_RISK_THRESHOLD": "nan"}]
        for settings in cases:
            with self.subTest(settings=settings):
                client = advisor(**settings)
                with patch.object(client, "_request") as request:
                    self.assertEqual(await client.assess("Bash", {"command": "pwd"}, "/tmp"), "")
                    request.assert_not_called()
                self.assertIn("off" if settings.get("JEV_MODE") == "off" else "unavailable", client.status())
        with patch.dict(bridge.os.environ, {}, clear=True):
            self.assertEqual(bridge.JevAdvisor().mode, "off")

    async def test_inclusive_bands_and_custom_cutoffs(self):
        for risk, expected in [(0, "looks safe"), (0.05, "looks safe"),
                               (0.051, "unsure"), (0.799, "unsure"),
                               (0.8, "likely destructive"), (1, "likely destructive")]:
            with self.subTest(risk=risk):
                self.assertIn(expected, await self.evaluate(advisor(), answer(0, risk)))
        client = advisor(JEV_SAFE_THRESHOLD="0.1", JEV_RISK_THRESHOLD="0.6")
        self.assertIn("looks safe", await self.evaluate(client, answer(0.1, 0)))
        self.assertIn("likely destructive", await self.evaluate(client, answer(0.6, 0)))

    async def test_external_score_is_visible_but_not_claimed_as_authorization(self):
        text = await self.evaluate(advisor(), answer(0.01, 0.02, 0.99))
        self.assertIn("external 0.99", text)
        self.assertIn("advice only", text)

    async def test_null_error_with_valid_answers_is_success(self):
        client = advisor()
        client.note_failure()
        for _ in range(3):
            self.assertIn("looks safe", await self.evaluate(client, {**answer(), "error": None}))
            self.assertEqual(client.consecutive_failures, 0)
            self.assertEqual(client.reason, "")

    async def test_string_error_codes_in_success_http_response_keep_failure_policy(self):
        for code, reason, delay in [("401", "API key rejected", math.inf),
                                    ("402", "out of credits", 1800)]:
            with self.subTest(code=code):
                client = advisor()
                before = time.monotonic()
                self.assertEqual(await self.evaluate(client, {"error": {"code": code}}), "")
                self.assertEqual(client.reason, reason)
                self.assertAlmostEqual(client.until - before, delay, delta=1)
                with patch.object(client, "_request") as request:
                    self.assertEqual(await client.assess("Bash", {"command": "pwd"}, ""), "")
                    request.assert_not_called()

    async def test_failed_credit_recovery_preserves_reason_backoff_and_notice(self):
        for failure in (TimeoutError(), ValueError("malformed response")):
            with self.subTest(failure=type(failure).__name__):
                client = advisor()
                await self.evaluate(client, status=402)
                self.assertIn("out of credits", client.notice("c1"))
                client.until = 0  # The original 30-minute wait has elapsed.
                before = time.monotonic()
                with patch.object(client, "_request", side_effect=failure):
                    self.assertEqual(await client.assess("Bash", {"command": "pwd"}, ""), "")
                self.assertEqual(client.reason, "out of credits")
                self.assertAlmostEqual(client.until - before, 1800, delta=1)
                self.assertEqual(client.notice("c1"), "")
                client.until = 0
                self.assertIn("looks safe", await self.evaluate(client))
                self.assertEqual(client.pause_seconds, 0)

    async def test_transient_failure_never_shortens_active_pause_or_relabels_it(self):
        for code, reason in [(401, "API key rejected"), (402, "out of credits")]:
            with self.subTest(code=code):
                client = advisor()
                await self.evaluate(client, status=code)
                deadline = client.until
                client.note_failure()
                self.assertGreaterEqual(client.until, deadline)
                self.assertEqual(client.reason, reason)
        client = advisor()
        client._pause("in-flight budget limit", 8)
        client.until = 0
        client.note_failure()
        self.assertAlmostEqual(client.until - time.monotonic(), 60, delta=1)
        self.assertEqual(client.reason, "in-flight budget limit")

    async def test_invalid_scores_and_response_shapes_disable_only_advice(self):
        payloads = [answer(value) for value in [True, False, None, "0.01", -1, 1.1, math.nan, math.inf]]
        payloads += [{"answers": []}, {"answers": {"destructive": {"noul": 0}}},
                     {"answers": {"destructive": {"type": "choice", "noul": 0}}},
                     {"error": {"code": 500}}]
        for payload in payloads:
            with self.subTest(payload=payload):
                client = advisor()
                self.assertEqual(await self.evaluate(client, payload), "")
                self.assertEqual(client.reason, "")
                self.assertEqual(client.consecutive_failures, 1)

    async def test_credit_exhaustion_pauses_30_minutes_and_deduplicates_per_channel(self):
        client = advisor()
        before = time.monotonic()
        self.assertEqual(await self.evaluate(client, {"error": {"code": 402}}, 402), "")
        self.assertAlmostEqual(client.until - before, 1800, delta=1)
        self.assertIn("out of credits", client.notice("c1"))
        self.assertEqual(client.notice("c1"), "")
        self.assertIn("out of credits", client.notice("c2"))
        with patch.object(client, "_request") as request:
            self.assertEqual(await client.assess("Bash", {"command": "pwd"}, ""), "")
            request.assert_not_called()
        client.until = 0
        self.assertIn("looks safe", await self.evaluate(client))
        self.assertIn("resumed", client.status())
        await self.evaluate(client, {"error": {"code": 402}}, 402)
        self.assertIn("out of credits", client.notice("c1"))

    async def test_402_inflight_budget_requires_retry_header_and_metadata(self):
        body = {"error": {"metadata": {"limit_source": "openrouter_in_flight_budget"}}}
        for payload, headers, expected in [(body, {"Retry-After": "8"}, 8),
                                           (body, {}, 1800),
                                           ({"error": {}}, {"Retry-After": "8"}, 1800)]:
            client = advisor()
            before = time.monotonic()
            await self.evaluate(client, payload, 402, headers)
            self.assertAlmostEqual(client.until - before, expected, delta=1)

    async def test_auth_rate_limits_and_server_failures(self):
        for code, headers, delay in [(401, {}, math.inf), (403, {}, 60), (429, {"Retry-After": "9000"}, 300),
                                     (503, {"Retry-After": "2"}, 2), (302, {}, 60)]:
            client = advisor()
            before = time.monotonic()
            await self.evaluate(client, {"error": {"code": code}}, code, headers)
            if math.isinf(delay):
                self.assertTrue(math.isinf(client.until))
                self.assertIn("restart", client.status())
            else:
                self.assertAlmostEqual(client.until - before, delay, delta=1)

    async def test_transient_http_and_malformed_failures_pause_only_after_three(self):
        for code, body in [(500, {"error": {"code": 500}}), (503, {"error": {"code": 503}}),
                           (429, {"error": {"code": 429}}), (200, {"answers": []}),
                           (200, {"error": {}})]:
            with self.subTest(code=code, body=body):
                client = advisor()
                for attempt in range(1, 4):
                    self.assertEqual(await self.evaluate(client, body, code), "")
                    self.assertEqual(client.consecutive_failures, attempt)
                    self.assertEqual(bool(client.reason), attempt == 3)
                    self.assertEqual(bool(client.notice("c1")), attempt == 3)
                self.assertAlmostEqual(client.until - time.monotonic(), 60, delta=1)

    async def test_success_resets_failures_and_failed_recovery_reopens_breaker(self):
        client = advisor()
        for _ in range(2):
            await self.evaluate(client, {"answers": []})
        self.assertEqual(client.consecutive_failures, 2)
        self.assertIn("looks safe", await self.evaluate(client))
        self.assertEqual(client.consecutive_failures, 0)
        for _ in range(3):
            await self.evaluate(client, {"answers": []})
        self.assertIn("unavailable", client.notice("c1"))
        client.until = 0
        await self.evaluate(client, {"answers": []})
        self.assertAlmostEqual(client.until - time.monotonic(), 60, delta=1)
        self.assertEqual(client.notice("c1"), "")
        client.until = 0
        self.assertIn("looks safe", await self.evaluate(client))
        self.assertEqual(client.consecutive_failures, 0)
        self.assertEqual(client.reason, "")

    async def test_retry_after_rejects_invalid_and_accepts_http_date(self):
        for raw in ("garbage", "nan", "inf", "-10", "0", None):
            self.assertEqual(bridge.JevAdvisor._retry_after({"Retry-After": raw}), 0)
        with patch.object(bridge.time, "time", return_value=0):
            self.assertEqual(bridge.JevAdvisor._retry_after({"Retry-After": "Thu, 01 Jan 1970 00:01:00 GMT"}), 60)

    async def test_exception_text_and_inputs_never_reach_log_or_notice(self):
        client = advisor()
        with patch.object(client, "_request", side_effect=RuntimeError("credential-secret")), patch.object(bridge, "log") as log:
            await client.assess("Bash", {"command": "echo command-secret"}, "")
        recorded = str(log.call_args_list) + client.notice("c1")
        for secret in ("credential-secret", "command-secret", client.key):
            self.assertNotIn(secret, recorded)
        self.assertIn("elapsed=", recorded)
        self.assertIn("band=unavailable", recorded)

    async def test_timeout_retains_worker_slot_and_discards_late_success(self):
        client = advisor(JEV_TIMEOUT_SECONDS="0.1")
        release = threading.Event()
        exited = threading.Event()
        def slow(_):
            try:
                release.wait(3)
                return 200, answer(), {}
            finally:
                exited.set()
        try:
            with patch.object(client, "_request", side_effect=slow):
                started = time.monotonic()
                self.assertEqual(await client.assess("Bash", {"command": "pwd"}, ""), "")
                self.assertLess(time.monotonic() - started, 0.7)
                self.assertTrue(client.slots.acquire(False))
                self.assertTrue(client.slots.acquire(False))
                self.assertFalse(client.slots.acquire(False))
                client.slots.release()
                client.slots.release()
                release.set()
                await asyncio.to_thread(exited.wait, 1)
                await asyncio.sleep(0.01)
                self.assertEqual(client.reason, "")
                self.assertEqual(client.consecutive_failures, 1)
        finally:
            release.set()

    async def test_busy_workers_skip_without_queue(self):
        client = advisor()
        for _ in range(client.MAX_INFLIGHT):
            self.assertTrue(client.slots.acquire(False))
        with patch.object(client, "_request") as request, patch.object(bridge, "log") as log:
            for attempt in range(1, 4):
                self.assertEqual(await client.assess("Bash", {"command": "pwd"}, ""), "")
                self.assertEqual("workers busy" in client.status(), attempt == 3)
            request.assert_not_called()
            self.assertEqual(log.call_count, 3)
            self.assertTrue(all("reason=workers_busy" in call.args[0] for call in log.call_args_list))
        self.assertEqual(client.reason, "")
        client.slots.release()
        self.assertNotIn("workers busy", client.status())
        self.assertIn("looks safe", await self.evaluate(client))
        self.assertEqual(client.busy_skips, 0)

    async def test_state_preparation_runs_in_worker_with_shared_timeout(self):
        client = advisor(JEV_TIMEOUT_SECONDS="0.1")
        release = threading.Event()
        preparing_threads = []

        def slow_state(*_):
            preparing_threads.append(threading.current_thread())
            release.wait(1)
            return "prepared state"

        try:
            with patch.object(client, "_state", side_effect=slow_state), patch.object(client, "_request") as request:
                started = time.monotonic()
                self.assertEqual(await client.assess("Bash", {"command": "pwd"}, ""), "")
                self.assertLess(time.monotonic() - started, 0.5)
                self.assertEqual([thread.name for thread in preparing_threads], ["jev-advice"])
                self.assertTrue(client.slots.acquire(False))
                self.assertTrue(client.slots.acquire(False))
                self.assertFalse(client.slots.acquire(False))
                release.set()
                await asyncio.to_thread(preparing_threads[0].join, 1)
                self.assertFalse(preparing_threads[0].is_alive())
                request.assert_not_called()  # No late paid call after preparation times out.
        finally:
            release.set()

    async def test_unsupported_and_oversized_state_never_calls_provider(self):
        client = advisor()
        with patch.object(client, "_request") as request:
            for tool, data in [("WebSearch", {"query": "private"}),
                               ("Bash", {"command": "A" * 16001}), ("Bash", {})]:
                self.assertEqual(await client.assess(tool, data, ""), "")
            request.assert_not_called()
        self.assertEqual(client.consecutive_failures, 0)
        for _ in range(client.MAX_INFLIGHT):
            self.assertTrue(client.slots.acquire(False))

    async def test_one_recovery_probe_and_older_success_cannot_clear_auth_failure(self):
        client = advisor()
        entered = asyncio.Event()
        release = asyncio.Event()
        async def fetch(*_):
            try:
                entered.set()
                await release.wait()
                return 200, answer(), {}
            finally:
                client.slots.release()
        with patch.object(client, "_fetch", side_effect=fetch):
            running = asyncio.create_task(client.assess("Bash", {"command": "pwd"}, ""))
            await entered.wait()
            client._pause("API key rejected", math.inf)
            release.set()
            self.assertEqual(await running, "")
            self.assertEqual(client.reason, "API key rejected")
            entered.clear()
            release.clear()
            client.until = 0
            running = asyncio.create_task(client.assess("Bash", {"command": "pwd"}, ""))
            await entered.wait()
            self.assertTrue(client.probing)
            self.assertEqual(await client.assess("Bash", {"command": "pwd"}, ""), "")
            release.set()
            self.assertIn("looks safe", await running)


class JevPrivacyTransportTests(unittest.TestCase):
    def test_long_single_tokens_redact_in_under_100ms(self):
        client = advisor()
        for length in (4000, 15000, 15950, 16000):
            command = "A" * length
            started = time.perf_counter()
            state = client._state("Bash", {"command": command}, "")
            elapsed = time.perf_counter() - started
            self.assertLess(elapsed, 0.1, f"{length}-character token took {elapsed:.3f}s")
            if length < 16000:
                self.assertIn(command, state)  # Exercise redaction, not just the size guard.

    def test_short_environment_settings_are_not_redacted(self):
        client = advisor(TOKENIZERS_PARALLELISM="false", SOME_SECRET="long-private-secret")
        state = client._state("Bash", {"command": "echo false long-private-secret"}, "")
        self.assertIn("false", state)
        self.assertNotIn("long-private-secret", state)

    def test_non_http_urls_drop_passwords_paths_queries_and_fragments(self):
        client = advisor()
        for scheme in ("postgresql", "mongodb+srv", "amqp", "HTTPS", "custom.v1"):
            state = client._state("Bash", {"command":
                f"client {scheme}://admin:s3cr3tpw@db.example.test:1234/prod?auth=opaque#fragment"}, "")
            self.assertIn(f"{scheme.lower()}://db.example.test:1234", state)
            for secret in ("admin", "s3cr3tpw", "/prod", "opaque", "fragment"):
                self.assertNotIn(secret, state)

    def test_dedicated_key_precedes_fallback(self):
        self.assertEqual(advisor(OPENROUTER_API_KEY="fallback").key, "test-dedicated-key")
        self.assertEqual(advisor(JEV_OPENROUTER_API_KEY="", OPENROUTER_API_KEY="fallback").key, "fallback")

    def test_payload_selection_redaction_and_path_normalization(self):
        client = advisor(SOME_TOKEN="known-env-secret")
        command = ('TOKEN="a secret value" PASSWORD=plain-value '
                   "SECRET='other secret' "
                   '--password "flag secret" -u user:basic-secret '
                   'curl https://alice:pw@example.test/api?q=private-query#private-fragment '
                   '-H "Authorization: Bearer opaque-value" '
                   'sk-unknown-key ghp_unknown-token test-dedicated-key '
                   'known-env-secret /Users/alice/project/file /home/bob/file')
        with patch.dict(bridge.os.environ, {"SOME_TOKEN": "known-env-secret"}):
            state = client._state("Bash", {"command": command, "description": "private description",
                                          "content": "private content"}, "/Users/alice/project")
        for secret in ["a secret value", "plain-value", "other secret", "alice:pw", "private-query",
                       "private-fragment", "opaque-value", "sk-unknown-key", "ghp_unknown-token",
                       "test-dedicated-key", "known-env-secret", "private description", "private content",
                       "flag secret", "basic-secret",
                       "/Users/alice", "/home/bob"]:
            self.assertNotIn(secret, state)
        self.assertIn("<project>/file", state)
        self.assertIn("https://example.test", state)
        self.assertNotIn("/api", state)

    def test_webhook_and_signed_url_paths_are_not_transmitted(self):
        client = advisor()
        state = client._state("Bash", {"command":
            "curl https://hooks.slack.com/services/T000/B000/webhook-secret "
            "https://storage.test/presigned-secret/object?sig=query-secret#fragment-secret"}, "")
        self.assertIn("https://hooks.slack.com", state)
        self.assertIn("https://storage.test", state)
        for secret in ("services", "T000", "B000", "webhook-secret", "presigned-secret",
                       "object", "query-secret", "fragment-secret"):
            self.assertNotIn(secret, state)

    def test_private_key_and_unknown_or_oversize_inputs(self):
        client = advisor()
        self.assertNotIn("private-key-material", client._state("Bash", {"command":
            "echo '-----BEGIN RSA PRIVATE KEY-----\nprivate-key-material\n-----END RSA PRIVATE KEY-----'"}, ""))
        for tool, data in [("Write", {"file_path": "/a", "content": "private"}),
                           ("Edit", {"new_string": "private"}), ("mcp__secret", {"command": "private"}),
                           ("Bash", {"command": "x" * 16001}), ("Bash", {"command": "☃" * 6000}),
                           ("Bash", {"command": []}), ("Bash", [])]:
            self.assertIsNone(client._state(tool, data, ""))

    def test_exact_http_contract_and_no_redirects(self):
        client = advisor()
        with patch.object(bridge._NO_REDIRECT_OPENER, "open", return_value=Response(json.dumps(answer()).encode())) as open_request:
            status, body, _ = client._request("test state")
        request = open_request.call_args.args[0]
        self.assertEqual(request.full_url, "https://openrouter.ai/api/v1/systemone")
        self.assertEqual(request.headers["Authorization"], "Bearer test-dedicated-key")
        self.assertEqual(request.get_method(), "POST")
        self.assertEqual(json.loads(request.data), {
            "model": "typesafe/jev-1.13", "state": "test state", "questions": client.QUESTIONS})
        self.assertEqual(status, 200)
        self.assertEqual(body, answer())
        self.assertEqual(open_request.call_args.kwargs["timeout"], 3)
        self.assertIsNone(bridge._NoRedirectHandler().redirect_request(
            request, None, 302, "redirect", {}, "https://example.test"))

    def test_http_error_body_is_bounded_and_malformed_json_is_safe(self):
        client = advisor()
        error = bridge.HTTPError(client.ENDPOINT, 402, "payment", {"Retry-After": "8"},
                                 io.BytesIO(b'{"error":{"code":402}}'))
        with patch.object(bridge._NO_REDIRECT_OPENER, "open", side_effect=error):
            self.assertEqual(client._request("state")[0], 402)
        for body in (b'not json', b'[]', b'\xff'):
            with patch.object(bridge._NO_REDIRECT_OPENER, "open", return_value=Response(body)):
                self.assertEqual(client._request("state")[1], {})
        with patch.object(bridge._NO_REDIRECT_OPENER, "open", return_value=Response(b'x' * 32769)):
            with self.assertRaises(ValueError):
                client._request("state")

    def test_child_env_only_preserves_general_key_for_exact_openrouter_host(self):
        b = bridge.Bridge.__new__(bridge.Bridge)
        for url, keep in [("", False), ("https://api.anthropic.com", False),
                          ("https://openrouter.ai/api", True), ("https://OPENROUTER.AI/api", True),
                          ("https://openrouter.ai.evil.test", False),
                          ("https://openrouter.ai@evil.test", False), ("https://[bad", False)]:
            with patch.dict(bridge.os.environ, {"JEV_OPENROUTER_API_KEY": "dedicated",
                    "OPENROUTER_API_KEY": "fallback", "ANTHROPIC_BASE_URL": url}, clear=True):
                env = b.child_env()
                self.assertNotIn("JEV_OPENROUTER_API_KEY", env)
                self.assertEqual("OPENROUTER_API_KEY" in env, keep)


class JevPermissionTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.b = bridge.Bridge.__new__(bridge.Bridge)
        self.b.agent_id = "claude-test"
        self.b.bindings = {"c1": {"cwd": "/tmp/repo"}}
        self.b.run_generation = {}
        self.b.pending_perms = {}
        self.b._control_tasks = {}
        self.b.pending_questions = {}
        self.b.session_allows = {}
        self.b.permission_timeout = 0.1
        self.b.jev = advisor()
        self.b.send = Mock()
        self.b.post = Mock()
        self.b._send_to_claude = AsyncMock()
        self.frame = {"channel_id": "c1", "thread_id": 12, "text": "private task context"}
        self.proc = Mock(returncode=None)
        self.event = {"request_id": "r1", "request": {"subtype": "can_use_tool", "tool_name": "Bash",
                      "input": {"command": "pwd"}}}
        self.ids = []

    def choose(self, choice):
        def on_send(post):
            if post.get("options"):
                self.b.handle_option_select({"options_id": post["options_id"], "option_id": choice,
                                             "user": {"name": "Tom"}})
        self.b.send.side_effect = on_send

    async def run_request(self):
        await self.b._handle_control_request("c1", self.frame, self.proc, self.event, self.ids)

    async def test_advice_preserves_buttons_and_human_choice_even_when_risky(self):
        for choice in ("allow", "deny", "allow_always"):
            self.setUp()
            self.choose(choice)
            with patch.object(self.b.jev, "_request", return_value=(200, answer(0.95), {})):
                await self.run_request()
            post = self.b.send.call_args.args[0]
            self.assertTrue(post["text"].startswith("Claude wants to use **Bash**:"))
            self.assertIn("\n\nJev: ⚠ likely destructive", post["text"])
            self.assertEqual(post["options"], [
                {"id": "allow", "label": "Approve", "style": "primary"},
                {"id": "allow_always", "label": "Always allow Bash (this session)",
                 "notification": {"enabled": True, "label": "Always allow this tool"}},
                {"id": "deny", "label": "Reject"},
            ])
            result = self.b._send_to_claude.call_args.args[1]["response"]["response"]
            self.assertEqual(result["behavior"], "deny" if choice == "deny" else "allow")
            self.assertFalse(self.b.pending_perms)

    async def test_complete_notification_options_identical_with_advice_and_off(self):
        # Watch/long-press actions match exact labels, order and notification
        # overrides. Comparing IDs alone would miss a broken push category.
        for tool in ("Bash", "Read", "ExitPlanMode"):
            baseline = None
            for mode in ("off", "advise"):
                self.setUp()
                self.b.jev = advisor(JEV_MODE=mode)
                self.event["request"]["tool_name"] = tool
                self.event["request"]["input"] = {"command": "pwd", "file_path": "/tmp/file"}
                self.choose("allow")
                with patch.object(self.b.jev, "_request", return_value=(200, answer(0.95), {})):
                    await self.run_request()
                options = self.b.send.call_args.args[0]["options"]
                if baseline is None:
                    baseline = options
                else:
                    self.assertEqual(options, baseline)

    async def test_one_or_two_timeouts_post_no_notice_third_does(self):
        self.choose("allow")
        with patch.object(self.b.jev, "_request", side_effect=TimeoutError):
            for attempt in range(1, 4):
                self.event["request_id"] = f"timeout-{attempt}"
                await self.run_request()
                self.assertEqual(self.b._send_to_claude.await_count, attempt)
                self.assertEqual(self.b.post.call_count, 1 if attempt == 3 else 0)
                self.assertEqual(self.b.jev.consecutive_failures, attempt)
                self.assertNotIn("Jev:", self.b.send.call_args.args[0]["text"])
        self.assertIn("service unavailable", self.b.post.call_args.args[1])
        self.event["request_id"] = "while-paused"
        await self.run_request()
        self.assertEqual(self.b.post.call_count, 1)
        self.assertEqual(self.b._send_to_claude.await_count, 4)

    async def test_failure_still_posts_ordinary_buttons_and_one_notice(self):
        self.choose("allow")
        posts = Mock()
        posts.attach_mock(self.b.send, "approval")
        posts.attach_mock(self.b.post, "notice")
        with patch.object(self.b.jev, "_request", return_value=(402, {}, {})):
            await self.run_request()
            self.event["request_id"] = "r2"
            await self.run_request()
        self.assertEqual(self.b.post.call_count, 1)
        self.assertIn("out of credits", self.b.post.call_args.args[1])
        self.assertEqual(self.b._send_to_claude.await_count, 2)
        self.assertEqual([call[0] for call in posts.mock_calls], ["approval", "notice", "approval"])

    async def test_empty_request_id_is_not_registered_for_cancellation(self):
        self.event["request_id"] = ""
        entered, release = asyncio.Event(), asyncio.Event()

        async def slow(*_):
            entered.set()
            await release.wait()
            return ""

        self.choose("allow")
        with patch.object(self.b.jev, "assess", side_effect=slow):
            task = self.b._start_control_request("c1", self.frame, self.proc, self.event, self.ids)
            await entered.wait()
            self.assertFalse(self.b._control_tasks)
            self.b._cancel_request("c1", "", "invalid cancellation")
            self.assertFalse(task.done())
            release.set()
            await task
        self.b._send_to_claude.assert_awaited_once()

    async def test_unexpected_advisor_exception_cannot_strand_request(self):
        self.choose("deny")
        with patch.object(self.b.jev, "assess", side_effect=RuntimeError("private failure")):
            await self.run_request()
        self.b._send_to_claude.assert_awaited_once()
        self.assertNotIn("private failure", str(self.b.post.call_args_list))

    async def test_default_off_posts_exact_original_prompt_without_network(self):
        self.b.jev = advisor(JEV_MODE="off")
        self.choose("allow")
        with patch.object(self.b.jev, "_request") as request:
            await self.run_request()
            request.assert_not_called()
        self.assertEqual(self.b.send.call_args.args[0]["text"], self.b._perm_prompt_text("Bash", {"command": "pwd"}, None))
        self.b.post.assert_not_called()

    async def test_skip_plan_questions_compaction_and_session_grants(self):
        for kind in ("plan", "question", "compaction", "grant"):
            self.setUp()
            self.choose("allow")
            if kind == "plan":
                self.event["request"]["tool_name"] = "ExitPlanMode"
            elif kind == "question":
                self.event["request"]["tool_name"] = "AskUserQuestion"
                self.b._ask_user_question = AsyncMock()
            elif kind == "compaction":
                self.frame["_auto_compact"] = True
            else:
                self.b.session_allows = {"c1": {"Bash"}}
            with patch.object(self.b.jev, "assess") as assess:
                await self.run_request()
                assess.assert_not_called()
            if kind == "plan":
                self.assertEqual(len(self.b.send.call_args.args[0]["options"]), 2)

    async def test_permission_timeout_still_denies(self):
        with patch.object(self.b.jev, "_request", return_value=(200, answer(), {})):
            await self.run_request()
        self.assertEqual(self.b._send_to_claude.call_args.args[1]["response"]["response"]["behavior"], "deny")
        self.assertFalse(self.b.pending_perms)

    async def test_withdrawal_before_coroutine_start_posts_nothing(self):
        task = self.b._start_control_request("c1", self.frame, self.proc, self.event, self.ids)
        self.b._cancel_request("c1", "r1", "withdrawn")
        await asyncio.gather(task, return_exceptions=True)
        self.b.send.assert_not_called()
        self.b._send_to_claude.assert_not_awaited()

    async def test_withdrawal_or_stop_while_advisor_waits_discards_result(self):
        for cancel in ("withdraw", "stop"):
            self.setUp()
            entered = asyncio.Event()
            async def slow(*_):
                entered.set()
                await asyncio.Event().wait()
            with patch.object(self.b.jev, "assess", side_effect=slow):
                task = self.b._start_control_request("c1", self.frame, self.proc, self.event, self.ids)
                await entered.wait()
                if cancel == "withdraw":
                    self.b._cancel_request("c1", "r1", "withdrawn")
                else:
                    task.cancel()  # The run's cleanup cancels its permission tasks.
                await asyncio.wait_for(asyncio.gather(task, return_exceptions=True), 0.5)
            self.b.send.assert_not_called()  # No resolution of unposted buttons either.
            self.b._send_to_claude.assert_not_awaited()
            self.assertFalse(self.b.pending_perms)

    async def test_rebinding_answers_live_process_but_dead_process_discards_advice(self):
        for mutation in ("binding", "generation", "process"):
            self.setUp()
            self.choose("allow")
            async def change(*_):
                if mutation == "binding":
                    self.b.bindings["c1"] = {"cwd": "/other"}
                elif mutation == "generation":
                    self.b.run_generation["c1"] = 1
                else:
                    self.proc.returncode = 0
                return "Jev: looks safe"
            with patch.object(self.b.jev, "assess", side_effect=change):
                await self.run_request()
            if mutation == "process":
                self.b.send.assert_not_called()
                self.b._send_to_claude.assert_not_awaited()
            else:
                self.assertIn("Jev: looks safe", self.b.send.call_args.args[0]["text"])
                self.b._send_to_claude.assert_awaited_once()
                proc, response = self.b._send_to_claude.call_args.args
                self.assertIs(proc, self.proc)
                self.assertEqual(response["response"]["request_id"], "r1")
                self.assertEqual(response["response"]["response"]["behavior"], "allow")
            self.assertFalse(self.b.pending_perms)

    async def test_old_tap_is_ignored_during_advice_and_after_new_prompt(self):
        self.choose("allow")
        with patch.object(self.b.jev, "assess", return_value=""):
            await self.run_request()
        old_id = self.b.send.call_args.args[0]["options_id"]
        self.b.send.reset_mock(side_effect=True)
        self.b._send_to_claude.reset_mock()
        entered, release, posted = asyncio.Event(), asyncio.Event(), asyncio.Event()

        async def slow(*_):
            entered.set()
            await release.wait()
            return "Jev: looks safe"

        self.b.send.side_effect = lambda _: posted.set()
        stale_tap = {"options_id": old_id, "option_id": "allow", "user": {"name": "Tom"}}
        with patch.object(self.b.jev, "assess", side_effect=slow):
            task = self.b._start_control_request("c1", self.frame, self.proc, self.event, self.ids)
            await entered.wait()
            self.assertFalse(self.b.pending_perms)
            self.b.handle_option_select(stale_tap)
            release.set()
            await posted.wait()
            new_id = self.b.send.call_args.args[0]["options_id"]
            self.assertNotEqual(old_id, new_id)
            self.b.handle_option_select(stale_tap)
            self.b._send_to_claude.assert_not_awaited()
            self.assertFalse(self.b.pending_perms[new_id][0].done())
            self.b.handle_option_select({**stale_tap, "options_id": new_id, "option_id": "deny"})
            await task
        self.assertEqual(self.b._send_to_claude.call_args.args[1]["response"]["response"]["behavior"], "deny")
        self.assertEqual(self.b.jev.consecutive_failures, 0)

    async def test_same_request_id_in_two_sessions_cancels_only_owner_during_advice(self):
        entered = {"/tmp/repo": asyncio.Event(), "/tmp/other": asyncio.Event()}
        release = asyncio.Event()
        other_proc, other_ids = Mock(returncode=None), []
        self.b.bindings["c2"] = {"cwd": "/tmp/other"}

        async def slow(_tool, _input, cwd):
            entered[cwd].set()
            await release.wait()
            return "Jev: looks safe"

        self.choose("allow")
        with patch.object(self.b.jev, "assess", side_effect=slow):
            first = self.b._start_control_request("c1", self.frame, self.proc, self.event, self.ids)
            second = self.b._start_control_request("c2", {"channel_id": "c2"}, other_proc, self.event, other_ids)
            await asyncio.gather(*(event.wait() for event in entered.values()))
            self.b._cancel_request("c1", "r1", "withdrawn")
            await first
            self.assertFalse(second.done())
            self.b.send.assert_not_called()
            release.set()
            await second
        self.b._send_to_claude.assert_awaited_once()
        self.assertIs(self.b._send_to_claude.call_args.args[0], other_proc)
        self.assertFalse(self.b._control_tasks)

    async def test_same_request_id_posted_buttons_and_questions_stay_isolated(self):
        for tool in ("Bash", "AskUserQuestion"):
            self.setUp()
            self.b.permission_timeout = 1
            self.event["request"]["tool_name"] = tool
            if tool == "AskUserQuestion":
                self.event["request"]["input"] = {"questions": [
                    {"question": "Which?", "options": [{"label": "One"}, {"label": "Two"}]}]}
            both_posted = asyncio.Event()
            posts = {}

            def record(post):
                if post.get("options"):
                    posts[post["channel_id"]] = post
                    if len(posts) == 2:
                        both_posted.set()

            self.b.send.side_effect = record
            other_proc = Mock(returncode=None)
            with patch.object(self.b.jev, "assess", return_value=""):
                first = self.b._start_control_request("c1", self.frame, self.proc, self.event, self.ids)
                second = self.b._start_control_request("c2", {"channel_id": "c2"}, other_proc, self.event, [])
                await both_posted.wait()
                self.assertNotEqual(posts["c1"]["options_id"], posts["c2"]["options_id"])
                self.b._cancel_request("c1", "r1", "withdrawn")
                await first
                self.assertFalse(second.done())
                resolutions = [call.args[0] for call in self.b.send.call_args_list
                               if call.args[0]["type"] == "options_resolve"]
                self.assertEqual([post["options_id"] for post in resolutions], [posts["c1"]["options_id"]])
                self.b.handle_option_select({"options_id": posts["c2"]["options_id"],
                    "option_id": "allow" if tool == "Bash" else "opt-1", "user": {"name": "Tom"}})
                await second
            self.b._send_to_claude.assert_awaited_once()
            self.assertIs(self.b._send_to_claude.call_args.args[0], other_proc)
            self.assertFalse(self.b.pending_perms)
            self.assertFalse(self.b.pending_questions)

    async def test_never_sends_user_context_to_advisor(self):
        self.choose("allow")
        with patch.object(self.b.jev, "assess", return_value="") as assess:
            await self.run_request()
        self.assertEqual(assess.call_args.args, ("Bash", {"command": "pwd"}, "/tmp/repo"))


if __name__ == "__main__":
    unittest.main()
