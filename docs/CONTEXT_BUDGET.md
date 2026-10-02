# Bridge context budget

Status: approved by Tom 2026-10-02 for one PR covering A and B below.
Background: 30-day bridge usage analysis (`/tmp/headroom-analysis/report.md`).
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
   change, have no developer_instructions of ours: treat their fingerprint as
   unknown and append the full suffix once on the first bridge prompt, then
   record it. (Pre-existing bridge sessions already have the notes in history.)
4. Forks (`_fork_source`) inherit the source session's developer message —
   verify, and fall back to (3) if not.

Tests (`bridges/codex-cli/test_bridge.py`):
- new / resume / fork commands include `-c developer_instructions=…`; the prompt
  sent on stdin has no relay suffix.
- the TOML value round-trips (`tomllib.loads(f"x = {value}")["x"] == text`).
- `/tldr off` on a live session → exactly one in-band note on the next prompt,
  none after.
- `/use` of a foreign session → full suffix once, then none.
- Manual e2e (record result in the PR): new session, two follow-ups, `/tldr`
  toggle, and one session forced to compact with
  `-c model_auto_compact_token_limit=20000` → TL;DR/attach/history sentinels
  still honoured after compaction.

## B. Claude: cold-resume notice (no automatic action)

When a **human** message arrives for a bound Claude session that is both
- idle ≥ 60 min since its last assistant entry (transcript mtime / last
  timestamp), and
- large: last assistant `usage` in the transcript has
  `input_tokens + cache_creation_input_tokens + cache_read_input_tokens`
  ≥ 300,000 (`--cold-resume-tokens`, env `CLAUDE_COLD_RESUME_TOKENS`;
  `0` disables the feature),

the bridge **holds** the message and posts:

> This session is ~412k tokens and has been idle 2h, so its cache has expired
> and the next turn re-reads all of it. Reply **/compact** to summarise first,
> **/fresh** to start a new session in the same folder, or **/continue** to
> carry on as is. (Held message will run after your choice.)

Choices (only meaningful while a message is held for that binding):
- `/compact` → run `claude -p --resume <id> "/compact <FOCUS>"` with the same
  model / system args as normal runs, then run the held message on the same
  session. Post "Compacted: 412k → 38k tokens." (read from the transcript after).
  Read the post-compaction size before running the held prompt.
- `/fresh` → new session in the same cwd (same as `/new <current cwd>`; keep
  worktree/model/permissions overrides), then run the held message there.
  Remember the old session id in the binding and mention it in the reply
  ("previous session abc123… — `/use` to go back").
- `/continue` → run the held message unchanged.
- Any other new human chat message → treat as `/continue`: run the held message,
  then the new one, in order. Other slash commands run as bridge commands and
  leave the message held; `/stop` discards it.
- `/fresh` and `/continue` without a held message reply locally that nothing
  is waiting.
- `/compact` with no held message keeps today's behaviour (forwarded to Claude).

Rules:
- Never hold messages from peer agents or injected background follow-ups —
  they run as today.
- Prompt at most once per idle period per binding.
- The hold lives in memory; a bridge restart drops it and the next message
  behaves as today (it'll get the notice again if still cold).
- Use the existing per-binding lock/queue so nothing runs concurrently.

FOCUS text:
"Summarise for continuing this work. Keep verbatim: open tasks and next steps,
decisions and why, user preferences/constraints, file paths, branch and PR
numbers, commands that worked, exact unresolved error messages. Drop resolved
dead ends and tool output already acted on."

Tests (`bridges/claude-cli/test_bridge.py`):
- threshold/idle detection from a fixture transcript (below/above, idle/fresh,
  disabled with 0).
- hold → `/compact` runs compact then held prompt with identical model and
  `--append-system-prompt`; `/fresh` creates a new session in the same cwd and
  records the previous id; `/continue` and any-other-message paths.
- peer-agent and background follow-up messages are never held.
- only one notice per idle period.

## Later: opt-in trial of warm compaction (not in this PR)

Per-channel `/autocompact on` (default off). When on, the bridge runs `/compact
<FOCUS>` on a Claude session that is ≥ 400k tokens after 15 min of quiet (inside
the 1h cache TTL), and the channel's Claude runs use auto-compact at ≈ 500k.
Enable on 1–2 heavy channels for a week, compare ccusage numbers and output
quality against untouched channels, then decide.
