# Bridge context budget

Status: approved by Tom 2026-10-02 for one PR covering A and B below.
Background: 30-day bridge usage analysis of Claude and Codex sessions.
Claude bridge sessions ≈ $2.3k API-equivalent/month; ≈ $575 of it is full cache
re-writes when a 300k–966k session is resumed after >1h idle (cache TTL).
Codex ≈ $132. Goal: cut waste with **zero regression in output quality**.

Out of scope (decided not to do): trimming Claude's append-system-prompt,
Cursor first-message-only notes, lowering Codex's compaction threshold,
Headroom/RTK, output caps. Cursor bridge is untouched.

## A. Codex: relay notes via `developer_instructions`

Today `run_codex` appends `_prompt_suffixes()` (TL;DR, etiquette, history,
attach notes, ≈ 2.6k chars) to **every** prompt, so it piles up in history
(68k chars in the heaviest session).

Verified on codex-cli 0.157.1 (throwaway sessions in /tmp, 2026-10-02):
- `codex exec -c 'developer_instructions="…"' -` → stored once in the session's
  first `developer` message; the model follows it.
- `codex exec -c developer_instructions=… resume <id> -` with the same text →
  followed, **not duplicated**.
- `resume` without the flag → still followed.
- `resume` with a **different** value → **ignored**; the first value sticks.
- `"type":"compacted"` rollout records keep developer messages in
  `replacement_history`.

Changes (`bridges/codex-cli/bridge.py`):
1. Build the standing text from the same pieces `_prompt_suffixes()` uses (reword
   the "(… note from the relay, not the user: …)" wrappers into plain developer
   instructions; keep every rule and sentinel format). Pass it on every run as
   `-c developer_instructions=<TOML string>` (new, resume and fork). Escape
   properly (use a TOML basic string with `\\`, `"`, newlines escaped — or
   `json.dumps`, which is a valid TOML basic string for this text; test it).
   Stop appending the suffixes to the prompt.
2. Record in the binding the instruction "fingerprint" the session started with
   (`tldr`, peer agents, history enabled). Because a changed value is ignored on
   resume, when the current settings differ from the session's starting ones,
   append a single short in-band relay note to the **next** prompt only (e.g.
   "Relay note: TL;DR summaries are now off for this conversation."), then
   update the stored fingerprint. Applies to `/tldr` and bridge restarts with
   different flags.
3. Sessions bound via `/use` that were started outside the bridge, or before this
   change, have no durable bridge developer instructions. Append the legacy
   suffix on every prompt in these sessions so compaction cannot remove the
   only copy. Record the developer-instruction marker only for new sessions
   actually started by this bridge. Forks inherit their source's marker.
4. Forks (`_fork_source`) inherit the source session's developer message —
   verify, and fall back to (3) if not.

Tests (`bridges/codex-cli/test_bridge.py`):
- new / resume / fork commands include `-c developer_instructions=…`; the prompt
  sent on stdin has no relay suffix.
- the TOML value round-trips (`tomllib.loads(f"x = {value}")["x"] == text`).
- `/tldr off` on a live session → exactly one in-band note on the next prompt,
  none after.
- `/use` of a foreign or pre-upgrade session → full suffix on every turn.
- Manual e2e (record result in the PR): new session, two follow-ups, `/tldr`
  toggle, and one session forced to compact with
  `-c model_auto_compact_token_limit=20000` → TL;DR/attach/history sentinels
  still honoured after compaction.

## B. Claude: automatic idle compaction

`CLAUDE_AUTO_COMPACT` enables both paths and is off by default. When enabled,
`CLAUDE_AUTO_COMPACT_TOKENS` sets their shared context threshold (default
300,000; must be positive). The token setting has no effect while automatic
compaction is off. No per-channel command is needed.

After a turn or command finishes, the bridge schedules a one-shot check after
15 minutes of quiet. New inbound activity cancels and resets the timer. At the
deadline, it compacts only if the same session is bound, the context meets the
threshold, and it has no active run, live child, queued turn, pending question,
or account authentication problem. Fork sources are skipped.

If the timer was missed, for example after a bridge restart, a human message
arriving after 60 minutes idle triggers compaction before that message runs.
The message proceeds in the same sequence without waiting for a choice. Peer
and scheduled messages never trigger the cold path.

Both paths send `/compact <FOCUS>` through the ordinary Claude turn path with
the binding's model, system prompt, and permissions. The focus keeps open
tasks, decisions, constraints, file paths, branch and PR numbers, commands that
worked, and exact unresolved errors. The bridge reads `postTokens` from the
compact boundary and posts `Auto-compacted this session: 412k → 38k tokens.`
A failed attempt posts nothing; the cold path still runs the human message.
The session must grow at least 50,000 tokens after a successful compaction
before another automatic compact. Timers are memory-only and disappear on
restart. Claude's native mid-turn auto-compact settings are unchanged.

Tests cover the warm and cold paths, skipped unsafe states, cancellation by new
activity, disabled and invalid settings, the regrowth guard, peer and scheduled messages, and
use of the normal model and system arguments.
