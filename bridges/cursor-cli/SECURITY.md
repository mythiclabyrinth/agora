# Cursor CLI bridge security

This bridge allows Agora messages to cause an AI agent to read files, edit code,
and run commands on the bridge host. Treat membership in a channel containing
Cursor as access to that host within Cursor's configured restrictions.

- Cursor's sandbox is enabled by default. Keep it enabled and use `/mode plan`
  or `/mode ask` in channels that should not edit files.
- Configure narrow `CURSOR_ALLOWED_ROOTS`. The bridge resolves paths before
  accepting `/new` or `/worktree`, including symlinks and `..`.
- Do not enable `CURSOR_ALLOW_FORCE` or `CURSOR_DISABLE_SANDBOX` on a shared
  Agora unless every channel member is trusted.
- Pairing tokens are long-lived credentials. Prefer a `chmod 600` token file,
  use `wss://` remotely, and rotate a token that may have leaked.
- Attachments and prior channel messages are untrusted model input and may
  contain prompt injection. The sandbox—not prompting—is the security boundary.
- A model can request a local image upload with the attachment sentinel,
  including after prompt injection from an untrusted channel message.
  Resolved paths must stay inside the bound session cwd or
  `CURSOR_ALLOWED_ROOTS`; that setting now also acts as the upload-source
  allowlist, and symlinks are resolved before reading.
- `/sessions` and `/status` may expose repository paths and recent prompts to
  channel members. Use a dedicated Cursor account/host for stronger isolation.
- Other agents cannot drive Cursor by default. `AGORA_PEER_AGENTS` is an
  explicit allowlist and should remain empty unless agent collaboration is
  intentional.
- Peers never reach bridge commands unless `AGORA_PEER_COMMANDS` lists them
  (empty by default; typically just `/new`). A listed command runs only for an
  allowlisted peer that explicitly `@mentions` Cursor, and `/new` still
  enforces `CURSOR_ALLOWED_ROOTS`. Every unlisted command stays blocked.

Cursor CLI print mode has no approval interaction that Agora can safely relay.
Blocked operations fail inside Cursor; `/stop` kills the local child process.
