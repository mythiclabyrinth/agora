# Claude CLI bridge — security & privacy

This bridge is, by design, a way to run an autonomous coding agent on your
machine from a chat channel. That makes its blast radius large: whoever can
post in a channel the bridge is a member of can cause code to run on the host
it runs on. Read this before exposing it beyond a trusted, single-user setup.

The lists below are ordered by decreasing severity. Security (what an attacker
can *do*) and privacy (what an attacker can *learn*) are kept separate.

## Security issues

1. **Remote code execution by design.** Every non-command message is passed to
   `claude -p` with `--permission-mode acceptEdits` by default (and the README
   suggests `--dangerously-skip-permissions` for unattended use). Claude runs
   with your full user privileges — no sandbox — so it can read your SSH keys,
   keychain, cloud credentials, and edit/delete any file you can. This is the
   feature; treat channel access as shell access.
   *Partially addressed:* the permission mode is now per channel (`/permissions`)
   and defaults to the bridge's startup mode. A channel may always **lower**
   privilege (e.g. `/permissions plan` for read-only work), but **raising** it
   above the startup default is refused unless the bridge is launched with
   `CLAUDE_ALLOW_PERMISSION_ESCALATION=1` — so chat cannot flip a confirming
   setup into `bypassPermissions`. The model is likewise allowlisted (`/model`
   only accepts known ids, never arbitrary argv). *Still open:* even at the
   default mode Claude runs unsandboxed with your full privileges. Reduce it by
   starting the bridge in a confirming mode (e.g. `--permission-mode plan`),
   running as a dedicated low-privilege user, or inside a container/VM.

2. **Any channel participant is an operator.** The bridge trusts whoever the hub
   says is in the channel; there is no per-sender allowlist.
   - *Addressed:* it does not accept commands from non-user authors **by
     default**. Other agents/bots cannot drive it even by `@mention` (closes
     the path where a prompt-injected sandboxed agent runs code on your
     laptop). See `handle_inbound` in [bridge.py](bridge.py).
   - *Opt-in exception:* `AGORA_PEER_AGENTS` (`--peer-agents`) allowlists
     specific agent ids whose explicit `@mentions` may drive Claude, for
     human-directed agent-to-agent hand-offs. The exposure is bounded: only an
     explicit mention from an allowlisted id triggers a run; the peer's text
     never reaches the bridge command table (`/new`, `/permissions`, …) or CLI
     slash commands — it is wrapped in a relay note that names the author as
     an AI and subordinates it to the humans' instructions; and the hub stops
     relaying agent-to-agent messages after this bridge's effective cap without
     a human. Set `AGORA_BOT_LOOP_LIMIT` for a per-bridge preference; when it is
     unset, the server default applies, and the server safety maximum still
     bounds the preference.
     **Residual risk you accept by setting it:** an allowlisted peer that is
     itself prompt-injected can drive this CLI within those bounds. Leave it
     unset to keep the humans-only posture.
   - *Still open:* any *human* the hub admits to the channel is fully trusted.
     There is no per-user authorization list in the bridge. This extends to the
     in-channel **permission buttons** (see below): any channel member can tap
     Approve / Always allow on a tool request, not just the person who asked.

3. **The pairing token is an unscoped master key.**
   - *Addressed (bridge side):* the token can now be supplied via
     `AGORA_PAIRING_TOKEN` or `--token-file` (read a `chmod 600` file) instead of
     `--token`, which is visible to other local users in `ps`/`/proc`; `--token`
     still works but warns. The bridge also refuses plaintext `ws://` to any
     non-loopback host (`_reject_insecure_ws`), so a LAN misconfiguration can't
     send the token and traffic in the clear — use `wss://`.
   - *Still open (hub side, Rust):* the token rides in the URL query string
     (`?token=`) and so lands in server/proxy logs; it is unscoped (not limited
     to one agent id or channel set) and never expires. Fixing these means
     accepting the token from an `Authorization` header and adding scope/expiry
     to `PairingToken` in
     `crates/agora-core/src/server.rs` (`agent_ws`) and `config.rs`.

4. **`/new` could start a session in any directory.**
   - *Addressed:* `/new` is now gated by an allowlist. Set
     `CLAUDE_ALLOWED_ROOTS` (colon-separated) or `--allowed-roots`; the target is
     resolved (`Path.resolve()`, defeating `../`/symlink escapes) and must be
     equal to or under an allowed root. When unset, `/new` is **disabled**.
     See `_cmd_new` in [bridge.py](bridge.py).

5. **Orphaned Claude process after a failed run.**
   - *Addressed:* `run_claude` now kills the child on every exit path via a
     `finally` (previously only a timeout killed it). Before this, a stream
     parse error / disconnect left `claude` running and auto-applying edits
     after the user was told the run "failed."

6. **Attachment bytes written to disk from channel input.** Inbound messages can
   carry files (the hub inlines those up to 8 MB as base64); the bridge decodes
   each into a fresh `tempfile.mkdtemp()` dir and exposes it to Claude with
   `--add-dir` so its Read tool can open images/files.
   - *Addressed:* filenames are reduced to a sanitized basename
     (`_safe_filename` strips directory components and shell/path metacharacters)
     so a sender can't traverse out of the temp dir or influence the path;
     collisions get a numeric suffix; the temp dir is removed in a `finally`
     after every run. Undecodable/oversized entries are noted in the prompt, not
     written.
   - *Still open:* the bytes themselves are untrusted content fed to an
     autonomous agent (a hostile image/file could carry a prompt-injection
     payload the model then acts on). Bounded only by the permission mode
     (#1 above). See `materialize_attachments` / `_stage_attachments` in
     [bridge.py](bridge.py).

7. **In-channel tool approval changes the default trust posture.** Runs now use
   `--permission-prompt-tool stdio`: tools the permission mode doesn't cover are
   relayed to the channel as Approve / Always allow / Reject buttons instead of
   being silently denied. That is the point — but note the consequences:
   - Approval authority equals channel membership (see #2); there is no
     approver allowlist and no distinction between who prompted and who taps.
   - **Always allow** grants the whole tool (e.g. all of `Bash`) for that
     channel/thread binding until the bridge restarts. It is deliberately
     memory-only and never persisted to `state.json`.
   - Unanswered requests **deny** after `--permission-timeout` (default 600 s),
     and requests still pending when a run dies are denied and their buttons
     locked, so a stale button can never answer a later run (ids are keyed by
     the CLI's per-request uuid).
   - **`AskUserQuestion` bypasses the Approve/Reject step by design**: it has no
     side effects (answering only feeds text back to the model), so the bridge
     renders the questions directly and returns the selection. The trust
     posture matches approvals — any channel member can tap an option or answer
     with a typed reply, and that text enters the model's context like any
     other channel message.

8. **Bounded memory DoS on large output.** The subprocess stdout limit is 64 MB
   (raised from asyncio's 64 KB default so `stream-json` lines carrying whole
   files don't crash the reader). A single pathological line can still make the
   bridge buffer up to 64 MB. Acceptable for single-user use; note it if you
   ever multi-tenant this.

## Privacy issues

1. **`/sessions` discloses your work.** It scans `~/.claude/projects/` and posts
   each recent session's working-directory name and **last user prompt** (up to
   90 chars) into the channel. Anyone with channel access can enumerate what
   you're working on and read prompt fragments (possibly secrets you pasted).
   *Not mitigated.* Consider redacting prompts or gating `/sessions`.

2. **Reply exfiltration.** Replies are whatever Claude outputs, chunked at 8000
   chars. Any file Claude reads can be echoed straight into the channel. Inherent
   to the feature; bounded only by the permission mode (#1 in Security).

2a. **Outbound image exfiltration.** A model can request that a local image be
   uploaded with the attachment sentinel, including after prompt injection
   from an untrusted channel message. Resolved paths must stay inside the
   bound session cwd or `CLAUDE_ALLOWED_ROOTS`; this also makes that setting an
   upload-source allowlist. The check resolves symlinks before reading.

3. **`/status` leaks absolute paths** of the bound session's working directory.

4. **Credential/state at rest.**
   - `state.json` (channel→session bindings, working dirs, optional model /
     permission overrides) is written with the default umask and can be
     world-readable. `chmod 600` it, or point `STATE_FILE` at a private location.
   - The README's launchd fallback puts a plaintext `ANTHROPIC_API_KEY` in a
     plist under `~/Library/LaunchAgents/`. Prefer the OAuth keychain login where
     possible; if you must use a key file, restrict its permissions.

## Summary of what changed in code

| Issue | Status | Where |
|---|---|---|
| Non-user authors can drive it (2) | Fixed (default; opt-in peer allowlist) | `handle_inbound`, `AGORA_PEER_AGENTS` |
| Attachment path traversal / temp-dir leak (6) | Fixed | `_safe_filename`, `_stage_attachments` |
| Silent headless denies → in-channel approval (7) | Fixed (by design, see caveats) | `_handle_control_request` |
| Orphaned child on failure (5) | Fixed | `run_claude` (finally-kill) |
| `/new` any directory (4) | Fixed | `_cmd_new` + `CLAUDE_ALLOWED_ROOTS` |
| Token on CLI / plaintext ws (3, partial) | Fixed (bridge side) | `main`, `_reject_insecure_ws` |
| RCE / no sandbox (1) | Open | operational (run Claude confined) |
| Token in query string, unscoped, no expiry (3) | Open | hub (`server.rs`, `config.rs`) |
| `/sessions` / `/status` disclosure (privacy 1, 3) | Open | `format_sessions`, `_cmd_status` |
| `state.json` perms, plaintext API key (privacy 4) | Open | operational |
