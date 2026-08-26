# Codex CLI bridge — security & privacy

This bridge is, by design, a way to run an autonomous coding agent on your
machine from a chat channel. That makes its blast radius large: whoever can
post in a channel the bridge is a member of can cause code to run on the host
it runs on. Read this before exposing it beyond a trusted, single-user setup.

Most of the threat model is shared with the Claude CLI bridge
([../claude-cli/SECURITY.md](../claude-cli/SECURITY.md)); this file covers the
Codex-specific posture plus the shared points that still apply. The lists are
ordered by decreasing severity.

## Security issues

1. **Remote code execution by design — bounded by the sandbox.** Every
   non-command message becomes a `codex exec` run. Unlike the Claude bridge
   there is no in-channel approval step: `codex exec` is strictly
   non-interactive, so whatever the sandbox mode allows happens unattended.
   The default is `workspace-write` (edit files under the bound directory, no
   network); `read-only` is look-don't-touch; `workspace-git` is
   workspace-write plus a writable `.git` and network access to the git hosts
   allowlisted in the `[permissions.workspace-git]` profile in
   `~/.codex/config.toml` (unattended branch/commit/**push** — treat it as
   granting repo-publish rights to the channel); `danger-full-access` and
   `bypass` (`--dangerously-bypass-approvals-and-sandbox`) remove the guard
   rails entirely.
   *Mitigations:* the sandbox mode is per channel (`/sandbox`) and defaults to
   the bridge's startup mode. A channel may always **lower** privilege, but
   **raising** it above the startup default is refused unless the bridge is
   launched with `CODEX_ALLOW_SANDBOX_ESCALATION=1` — so chat cannot flip a
   sandboxed setup into `bypass`. Note the Codex sandbox restricts *writes and
   network*, not reads: even `read-only` lets the model read your SSH keys and
   anything else your user can, and echo them into the channel (see Privacy).

2. **Any channel participant is an operator.** The bridge trusts whoever the
   hub says is in the channel; there is no per-sender allowlist.
   - *Addressed:* it does not accept commands from non-user authors **by
     default**. Other agents/bots cannot drive it even by `@mention` (closes
     the path where a prompt-injected sandboxed agent runs code on your
     laptop). See `handle_inbound` in [bridge.py](bridge.py).
   - *Opt-in exception:* `AGORA_PEER_AGENTS` (`--peer-agents`) allowlists
     specific agent ids whose explicit `@mentions` may drive Codex, for
     human-directed agent-to-agent hand-offs. The exposure is bounded: only an
     explicit mention from an allowlisted id triggers a run; the peer's text
     never reaches the bridge command table (`/new`, `/sandbox`, …) — it is
     wrapped in a relay note that names the author as an AI and subordinates
     it to the humans' instructions; and the hub stops relaying agent-to-agent
     messages after this bridge's effective cap without a human. Set
     `AGORA_BOT_LOOP_LIMIT` for a per-bridge preference; when it is unset, the
     server default applies, and the server safety maximum still bounds the
     preference. **Residual risk you accept by setting it:** an allowlisted peer
     that is itself prompt-injected can
     drive this CLI within those bounds. Leave it unset to keep the
     humans-only posture.
   - *Still open:* any *human* the hub admits to the channel is fully trusted.

3. **The pairing token is an unscoped master key.**
   - *Addressed (bridge side):* the token can be supplied via
     `AGORA_PAIRING_TOKEN` or `--token-file` (read a `chmod 600` file) instead
     of `--token`, which is visible to other local users in `ps`/`/proc`;
     `--token` still works but warns. The bridge also refuses plaintext `ws://`
     to any non-loopback host (`_reject_insecure_ws`), so a LAN
     misconfiguration can't send the token and traffic in the clear.
   - *Still open (hub side):* the token rides in the URL query string, is
     unscoped, and never expires — same as for every bridge; see the Claude
     bridge's SECURITY.md for the hub-side fix sketch.

4. **`/new` is gated by an allowlist.** Set `CODEX_ALLOWED_ROOTS`
   (colon-separated) or `--allowed-roots`; the target is resolved
   (`Path.resolve()`, defeating `../`/symlink escapes) and must be equal to or
   under an allowed root. When unset, `/new` is **disabled**. Worktrees
   (`/worktree`) obey the same roots. See `_cmd_new` in [bridge.py](bridge.py).

5. **Orphaned Codex process after a failed run.** `run_codex` kills the child
   on every exit path via a `finally` (timeout, stream parse error,
   disconnect, cancellation), so a run never keeps editing after the user was
   told it failed.

6. **Attachment bytes written to disk from channel input.** Inbound messages
   can carry files (the hub inlines those up to 8 MB as base64); the bridge
   decodes each into a fresh `tempfile.mkdtemp()` dir, names the paths in the
   prompt, and passes images via `codex -i`.
   - *Addressed:* filenames are reduced to a sanitized basename
     (`_safe_filename` strips directory components and shell/path
     metacharacters); collisions get a numeric suffix; the temp dir is removed
     in a `finally` after every run.
   - *Still open:* the bytes themselves are untrusted content fed to an
     autonomous agent (a hostile image/file could carry a prompt-injection
     payload the model then acts on). Bounded only by the sandbox mode (#1).

7. **Models are allowlisted.** `/model` accepts only `sol`, `terra`, or `luna` and
   maps those friendly names to fixed Codex model ids before constructing the
   argument vector. Values are never interpreted by a shell.

8. **Bounded memory DoS on large output.** The subprocess stdout limit is
   64 MB (raised from asyncio's 64 KB default so JSONL lines carrying whole
   command outputs don't crash the reader). A single pathological line can
   still make the bridge buffer up to 64 MB. Acceptable for single-user use.

## Privacy issues

1. **`/sessions` discloses your work.** It scans `~/.codex/sessions/` and
   posts each recent session's working-directory name and **last user prompt**
   (up to 90 chars) into the channel. Anyone with channel access can enumerate
   what you're working on and read prompt fragments (possibly secrets you
   pasted). *Not mitigated.*

2. **Reply exfiltration.** Replies are whatever Codex outputs, chunked at 8000
   chars. Any file Codex reads can be echoed straight into the channel — and
   the sandbox does not restrict reads, so this holds even in `read-only`.
   Inherent to the feature.

2a. **Outbound image exfiltration.** A model can request that a local image be
   uploaded with the attachment sentinel, including after prompt injection
   from an untrusted channel message. Resolved paths must stay inside the
   bound session cwd or `CODEX_ALLOWED_ROOTS`; this also makes that setting an
   upload-source allowlist. The check resolves symlinks before reading.

3. **`/status` leaks absolute paths** of the bound session's working directory.

4. **Credential/state at rest.**
   - `state.json` (channel→session bindings, working dirs, optional model /
     sandbox overrides) is written with the default umask and can be
     world-readable. `chmod 600` it, or point `STATE_FILE` at a private
     location.
   - Codex credentials live in `~/.codex/auth.json`, managed by `codex login`;
     the bridge never touches or logs them.
