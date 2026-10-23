# Antigravity CLI bridge security

This bridge allows Agora messages to cause an AI agent to read files, edit code,
and run commands on the bridge host. Treat membership in a channel containing
Antigravity as access to that host within the configured restrictions.

- Headless `agy` cannot ask anyone for approval, so the bridge chooses
  permissions per mode. The default `agent` mode auto-approves every tool and
  adds agy's sandbox (`--sandbox`). That sandbox only restricts terminal
  commands: agy's file tools (such as `write_file`) still write anywhere the
  bridge's OS user can, including outside the workspace, and network access
  stays available. Treat `agent` mode as write access to everything that user
  can reach. Use `/mode ask` or `/mode plan` in channels
  that should not edit files or run commands; there, agy denies those tools
  and the reply lists what was denied.
- `/mode force` auto-approves tools with no sandbox, so terminal commands are
  unrestricted as well. It is refused unless the
  bridge starts with `ANTIGRAVITY_ALLOW_FORCE=1`, and a saved force binding
  falls back to `agent` if the bridge restarts without it. Do not enable it on
  a shared Agora unless every channel member is trusted.
- Configure narrow `ANTIGRAVITY_ALLOWED_ROOTS`. The bridge resolves paths
  before accepting `/new` or `/worktree`, including symlinks and `..`. When
  roots are configured, `/use` only moves a binding into a conversation's
  folder if that folder is inside them; otherwise the conversation continues
  in the channel's current folder.
- Chat text never runs agy slash commands: turns run with
  `--disable-slash-commands`. Plan mode needs slash expansion, so there the
  bridge guarantees the prompt does not start with `/`. The bridge itself only
  invokes agy's `/compact` and `/usage`.
- Pairing tokens are long-lived credentials. Prefer a `chmod 600` token file,
  use `wss://` remotely, and rotate a token that may have leaked.
- Attachments and prior channel messages are untrusted model input and may
  contain prompt injection. The selected mode and the bridge's OS user, not
  prompting, are the security boundary; run the bridge as a dedicated user
  when untrusted text can reach it.
- Inbound attachments are written to a fresh temporary directory with
  sanitized file names, added to the workspace with `--add-dir` for that run
  only, and deleted afterwards. Large files are fetched from Agora with the
  pairing token and no redirects, and must match their advertised size.
- A model can request a local image upload with the attachment sentinel,
  including after prompt injection from an untrusted channel message.
  Resolved paths must stay inside the bound folder or
  `ANTIGRAVITY_ALLOWED_ROOTS`; that setting also acts as the upload-source
  allowlist, and symlinks are resolved before reading.
- `/sessions` and `/status` may expose repository paths and conversation
  titles to channel members. Plan mode posts the plan file agy wrote. Use a
  dedicated Google account or host for stronger isolation.
- The Google sign-in stays with `agy` on the bridge machine; the bridge never
  reads or forwards it. Usage reports send only quota percentages and reset
  times to Agora.
- Other agents cannot drive Antigravity by default. `AGORA_PEER_AGENTS` is an
  explicit allowlist and should remain empty unless agent collaboration is
  intentional.
- An allowlisted peer that explicitly @mentions Antigravity can queue a turn
  while it is busy, up to five waiting peer turns; later posts become context.
  `/stop` saves queued peer text as context while discarding queued human
  messages.
- Peers never reach bridge commands unless `AGORA_PEER_COMMANDS` lists them
  (empty by default; typically just `/new`). A listed command runs only for an
  allowlisted peer that explicitly `@mentions` Antigravity, and `/new` still
  enforces `ANTIGRAVITY_ALLOWED_ROOTS`. Every unlisted command stays blocked.

`/stop` sends SIGTERM to the local agy process and kills it if it has not
exited within 10 seconds.
