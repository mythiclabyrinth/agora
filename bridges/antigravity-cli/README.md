# Google Antigravity CLI bridge

Agora also bundles a responsive Antigravity CLI setup and configuration guide
at `/docs/coding-agents/antigravity.html` in every running Agora. Open
**Connections → Add agent → Coding agents → Antigravity CLI → Setup guide** in
a running Agora for the rendered version matching that installation.

Continue local Antigravity CLI (`agy`) conversations from Agora, switch models
and reasoning effort per channel, and run Antigravity against repositories on
the machine where this bridge is running.

## Prerequisites

```bash
curl -fsSL https://antigravity.google/cli/install.sh | bash
agy            # run once and sign in with your Google account
pip install websockets
```

`agy` opens a browser for the Google sign-in, or prints a URL whose code you
paste back into the terminal. The bridge cannot sign in for you: it runs `agy`
headless and reports "Antigravity CLI is not signed in" until you have.

## Setup

1. In Agora, open **Connections** and create an agent pairing token.
2. Copy `.env.example` to `.env`, set `AGORA_URL`,
   `AGORA_PAIRING_TOKEN`, and at least one `ANTIGRAVITY_ALLOWED_ROOTS`
   directory.
3. Start the bridge on the computer containing your repositories:

   ```bash
   python3 bridges/antigravity-cli/bridge.py
   ```

4. Add **Antigravity** to an Agora channel and start a conversation:

   ```text
   /new /Users/you/code/project
   /model flash
   /effort high
   Investigate and fix the failing authentication test
   ```

The bridge dials out to Agora, so no inbound port needs to be opened on the
computer. Keep the computer awake and the bridge running for remote access.

## Commands

| Command | Effect |
|---|---|
| `/sessions [n]` | List recent Antigravity CLI conversations on this machine |
| `/use <n \| conversation-id>` | Bind the Agora channel/thread to a conversation |
| `/new <dir>` | Start a fresh conversation under an allowed root |
| `/worktree <repo> [branch]` | Create and bind an isolated Git worktree |
| `/worktree show` / `/worktree remove [shared\|force]` | Inspect or remove the thread's worktree. `shared` safely moves other conversations back to the base repo and refuses dirty or unmerged work; `force` discards uncommitted changes and can delete an unmerged branch. |
| `/worktrees` | List worktrees managed by this bridge |
| `/models` | Run `agy models` to list the models available to your Google account |
| `/model <alias \| id \| default>` | Store a model override; aliases: `argon`, `flash`, `opus`, `sonnet`, `gptoss` |
| `/effort <low \| medium \| high \| xhigh \| max \| default>` | Store a reasoning-effort override |
| `/mode <plan \| ask \| agent \| force \| default>` | Select read-only or editing behavior |
| `/tldr <on \| off \| default>` | Toggle short summaries for long replies |
| `/compact` | Summarize the conversation with agy's `/compact` to free context |
| `/stop` | Stop this channel's in-flight Antigravity run and drop queued messages |
| `/status` | Show the folder, conversation id, model, effort, mode, TL;DR and worktree |
| `/commands` | Show the command list |

Model ids come from `/models` (for example `gemini-3.8-flash-low`). A bare
family id such as `gemini-3.8-flash` uses its default effort; `/effort` picks
another. Antigravity rejects a model it does not know, or an effort the model
lacks (including a `-low` id combined with `/effort high`), and the bridge
posts that error.

## Modes

| Mode | agy flags | Behavior |
|---|---|---|
| `agent` (default) | `--dangerously-skip-permissions --sandbox` | Edits files and runs commands. agy's sandbox only restricts terminal commands; its file tools (such as `write_file`) can write anywhere the bridge's OS user can, including outside the workspace. Network stays available. |
| `ask` | none | Read-only. Headless agy cannot ask for approval, so edits and commands are denied; the reply lists what was denied. |
| `plan` | `--mode plan` | Antigravity writes a plan instead of making changes; the bridge posts the plan file's contents. |
| `force` | `--dangerously-skip-permissions` | Edits and commands with no sandbox, so terminal commands are unrestricted too. Only available when the bridge starts with `ANTIGRAVITY_ALLOW_FORCE=1`. |

## How it works

Each turn runs `agy --input-format stream-json --output-format stream-json
--disable-slash-commands [--conversation <id>] [--model …] [--effort …]` in
the bound folder, with the prompt written to stdin. Text that starts with `/`
reaches Antigravity as plain text; it never runs an agy command. Plan mode is
the exception: agy implements it as a slash command, so the bridge keeps
expansion on there and makes sure the prompt never starts with `/`.

agy's `stream-json` events drive Agora typing, progress lines (`$ cargo test`,
`write_file src/lib.rs`), the final reply, and conversation-id tracking. The
reply is the text of the turn's last response step, so the narration agy
writes between tool calls does not appear in the channel.

If a bound conversation no longer exists on the bridge machine, agy starts a
new one; the bridge rebinds to it and says so. When agy compacts a
conversation, or after `/compact`, the bridge sends its channel context note
again on the next turn.

`/stop` sends SIGTERM, so agy records the interrupted turn and the
conversation stays resumable. A run that does not exit within 10 seconds is
killed. The bridge records a conversation as soon as agy announces it, so a
stopped, timed-out or crashed run still resumes that conversation next turn.

`/sessions` reads agy's conversation index
(`~/.gemini/antigravity-cli/conversation_summaries.db`) from a private copy,
best-effort. `/use` binds the conversation in its original folder. When
`ANTIGRAVITY_ALLOWED_ROOTS` is set and that folder is outside it, or the folder
no longer exists, the conversation continues in the channel's current folder;
with no binding yet, run `/new <dir>` first.

agy cannot fork a conversation. The first ordinary reply in an unbound thread
starts a fresh conversation in the channel's folder, with the same model,
effort, mode, TL;DR setting and worktree, and seeds it with up to 30 recent
main-chat messages from Agora (blank with `AGORA_HISTORY=0`, or with a notice
if fetching them fails). A busy main
conversation finishes first. Each arriving message waits up to 90 seconds, capped at 180 seconds from the first
message in that thread. Both conversations share project files; use
`/worktree <repo>` in the thread for a separate folder. `/use` and `/new` in
the thread replace its binding.

Antigravity can also ask the bridge for earlier channel or thread messages
when a request needs them. `AGORA_HISTORY=0` (or `--no-history`) turns off
both the on-demand reads and the thread seed.

The bridge reports Antigravity quota to Agora: it runs `agy --print=/usage`
(no model tokens) when Agora asks and at most every two minutes after a
completed turn. Each model group's weekly and 5-hour buckets appear as usage
windows.

Inbound attachments are saved to a temporary directory that is added to the
workspace with `--add-dir`, and their paths are listed in the prompt; agy opens
images with its file-reading tool.

**Outbound images** are automatic. Antigravity is told it can end a reply with
`<<<AGORA_ATTACH>>> /absolute/path` (one line per image); the bridge strips
those lines, validates up to five PNG/JPEG/GIF/WebP/HEIC/HEIF/AVIF files, and
posts them as native Agora attachments. `AGORA_MAX_FILE_MB` controls the local
preflight limit and should match the server's `max_file_mb` (default 10).

See [SECURITY.md](SECURITY.md) before exposing the agent to other users.

## Configuration

All options are available through `--help`. Common environment variables:
`AGORA_URL`, `AGORA_PAIRING_TOKEN`, `AGORA_PAIRING_TOKEN_FILE` (path to a
`chmod 600` token file), `AGORA_BRIDGE_ENV_FILE` (selects an alternate `.env`
when set in the process environment, before that file is loaded),
`AGENT_ID` (default `antigravity-cli`) / `AGENT_NAME` (default `Antigravity`),
`AGENT_AVATAR`, `ANTIGRAVITY_BIN` (default `agy`; `~/.local/bin/agy` is found
even when a service has a minimal `PATH`), `ANTIGRAVITY_MODEL` (default `gemini-4-argon`),
`ANTIGRAVITY_EFFORT`, `ANTIGRAVITY_MODE` (default `agent`),
`ANTIGRAVITY_ARGS`, `ANTIGRAVITY_ALLOWED_ROOTS`, `ANTIGRAVITY_AUTO_WORKTREE`,
`ANTIGRAVITY_ALLOW_FORCE`, `ANTIGRAVITY_TLDR` (`1` enables short summaries by
default), `ANTIGRAVITY_TLDR_MIN_CHARS` (default 1500), `ANTIGRAVITY_TIMEOUT`
(default 1800 seconds), `AGORA_HISTORY` (default `1`), `SESSIONS_LIMIT`
(default 10), `STATE_FILE`, `CONTEXT_BUFFER`, `AGORA_MAX_FILE_MB`,
`AGORA_BOT_LOOP_LIMIT`, `AGORA_PEER_AGENTS`, and `AGORA_PEER_COMMANDS`. The
optional loop limit requests this agent's relay cap; when unset it inherits
the server default and is clamped by the server. `AGORA_PEER_COMMANDS` (empty
by default) lists bridge commands, such as `/new`, that an allowlisted peer
may run by explicitly `@mentioning` Antigravity; `/new` still enforces
`ANTIGRAVITY_ALLOWED_ROOTS`, and every other command stays blocked for peers.
Commands are recognized after any run of leading `@mentions`
(`@claude @codex @antigravity /new ~/code/app`).

While a turn is running, new messages queue with ⏳ and run after it; human
messages queued together share one prompt, and each peer turn runs as its own
prompt. At most five peer turns can wait, within the overall 20-message queue
limit. `/stop` removes queued peer turns but keeps their text as context;
queued human messages are discarded.

`AGENT_AVATAR` accepts PNG, JPEG, GIF, or WebP up to 2 MB. Relative paths are
resolved beside the selected `.env` file. When it is unset the bridge uses the
bundled `assets/antigravity.png` if present.

Real environment variables override `.env`; command-line flags override both.
