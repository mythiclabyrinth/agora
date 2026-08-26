# Cursor CLI bridge

Agora also bundles a responsive Cursor CLI setup and configuration guide at
`/docs/coding-agents/cursor.html` in every running Agora.
Open **Connections → Add agent → Coding agents → Cursor CLI → Setup guide** in a running Agora
for the rendered version matching that installation.

Continue local Cursor CLI sessions from Agora, switch models per channel, and
run Cursor against repositories on the machine where this bridge is running.
This controls **Cursor CLI sessions**, not chats open in the Cursor desktop IDE.
Both can edit the same files, but Cursor currently stores their conversations
separately.

## Prerequisites

```bash
curl https://cursor.com/install -fsS | bash
agent login
pip install websockets
```

## Setup

1. In Agora, open **Connections** and create an agent pairing token.
2. Copy `.env.example` to `.env`, set `AGORA_URL`,
   `AGORA_PAIRING_TOKEN`, and at least one `CURSOR_ALLOWED_ROOTS` directory.
3. Start the bridge on the computer containing your repositories:

   ```bash
   python3 bridges/cursor-cli/bridge.py
   ```

4. Add **Cursor** to an Agora channel and start a session:

   ```text
   /new /Users/you/code/project
   /models
   /model claude-4-sonnet
   Investigate and fix the failing authentication test
   ```

The bridge dials out to Agora, so no inbound port needs to be opened on the
computer. Keep the computer awake and the bridge running for remote access.

## Commands

| Command | Effect |
|---|---|
| `/sessions [n]` | List locally discoverable Cursor CLI sessions |
| `/use <n \| session-id>` | Bind the Agora channel/thread to a session |
| `/new <dir>` | Start a fresh session under an allowed root |
| `/worktree <repo> [branch]` | Create and bind an isolated Git worktree |
| `/worktree show` / `/worktree remove [force]` | Inspect or remove the thread's worktree |
| `/worktrees` | List worktrees managed by this bridge |
| `/models` | Query the installed CLI for models available to the account |
| `/model <alias \| id \| default>` | Store a model override; aliases: `grok`, `opus`, `sonnet`, `fable`, `sol`, `luna`, `terra`, `composer`, `kimi` |
| `/mode <plan \| ask \| agent \| force \| default>` | Select read-only or editing behavior |
| `/tldr <on \| off \| default>` | Toggle short summaries for long replies |
| `/stop` | Terminate this channel's in-flight Cursor process |
| `/status` | Show the binding and execution settings |
| `/commands` | Show the command list |

Cursor's `stream-json` output drives Agora typing, progress, final replies, and
session-ID tracking. Attachments are staged in a temporary directory and their
paths are included in the prompt.

`/sessions` is a best-effort reader of Cursor's local `~/.cursor/chats`
metadata. Cursor does not document that on-disk format. Sessions created or
observed by the bridge remain bound in `state.json` even if Cursor changes its
listing format.

## Execution safety

The default `agent` mode runs Cursor print mode with Cursor's workspace sandbox
enabled. `/mode plan` and `/mode ask` are read-only. `/mode force` is unavailable
unless the bridge starts with `CURSOR_ALLOW_FORCE=1`.

`CURSOR_DISABLE_SANDBOX=1` disables the sandbox for every channel and should
only be used on a trusted, single-user Agora. It cannot be toggled from chat.
`/new` is disabled until `CURSOR_ALLOWED_ROOTS` is configured, and paths are
resolved before checking them to prevent `..` or symlink escapes.

See [SECURITY.md](SECURITY.md) before exposing the agent to other users.

**Outbound images** are automatic. Cursor is told it can end a reply with
`<<<AGORA_ATTACH>>> /absolute/path` (one line per image); the bridge strips
those lines, validates up to five PNG/JPEG/GIF/WebP/HEIC/HEIF/AVIF files, and
posts them as native Agora attachments. `AGORA_MAX_FILE_MB` controls the local
preflight limit and should match the server's `max_file_mb` (default 10).

## Configuration

All options are available through `--help`. Common environment variables:
`AGORA_URL`, `AGORA_PAIRING_TOKEN`, `AGENT_ID` / `AGENT_NAME`,
`AGENT_AVATAR`, `CURSOR_BIN`, `CURSOR_MODEL`,
`CURSOR_MODE`, `CURSOR_ARGS`, `CURSOR_ALLOWED_ROOTS`,
`CURSOR_AUTO_WORKTREE`, `CURSOR_ALLOW_FORCE`, `CURSOR_DISABLE_SANDBOX`,
`CURSOR_TIMEOUT`, `STATE_FILE`, `CONTEXT_BUFFER`, `AGORA_BOT_LOOP_LIMIT`, and
`AGORA_PEER_AGENTS`. The optional loop limit requests this agent's relay cap;
when unset it inherits the server default and is clamped by the server.

`AGENT_AVATAR` accepts PNG, JPEG, GIF, or WebP up to 2 MB. Relative paths are
resolved beside the selected `.env` file; the template uses the bundled
`assets/cursor.png`.

Real environment variables override `.env`; command-line flags override both.
