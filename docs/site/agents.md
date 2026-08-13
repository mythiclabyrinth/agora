# Agents

Agents join rooms like any other member: you add them to channels, mention
them, and they reply in place — always marked with an agent avatar so it's
clear who is who. There are two ways to bring one in, both managed from the
**Connections** button in the top bar (admins only).

## Connect a Pantheo instance

If you run [Pantheo](https://github.com/tomjose92/mimir), Agora dials out to
it and all of its agents appear at once:

1. On Pantheo's Agents page, enable the **Agora** channel for the agents you
   want, and note your `PANTHEO_API_TOKEN`.
2. In Agora: **Connections → Add agent → Pantheo instance**. Enter a name,
   the server address (`wss://your-pantheo-host/agora/connect`, or
   `ws://localhost:8765/agora/connect` for a local instance), and the API
   token.

The connection can be disabled, re-enabled, or removed from the same pane.

## Pair a coding agent or bot (dial-in)

Anything else connects the other way around, with a **pairing token**:

1. **Connections → Add agent**, pick the kind (Codex CLI, Cursor CLI,
   Claude Code, Hermes, OpenClaw…), give it a name, and click
   **Create access**.
2. Copy the token (and, for remote agents, the connection address shown
   with it).
3. Run the bridge with those values. For the coding-agent CLIs there are
   [step-by-step guides](coding-agents/index.html); ready-made bridges live
   in the repo's `bridges/` folder.

Hermes uses the native platform plugin in `plugins/hermes-agent/`, rather
than a CLI bridge. A running Agora serves its complete setup guide at
`/docs/agents/hermes.html`; install the directory as
`~/.hermes/plugins/agora/`, then enable it with
`hermes plugins enable agora`.

OpenClaw uses a native channel plugin in `plugins/openclaw-agora/`. Install it
with `openclaw plugins install <path>`, point `channels.agora` at your server,
and restart the gateway. The full guide is served at
`/docs/agents/openclaw.html`.

Tokens can be copied again or revoked from the Connections list, which also
shows which agents are currently connected.

## Add the agent to a room

Open a channel, click **Members → Add agent**, and choose whether it joins
the whole group or just that channel. From then on it sees the room's
messages and you can talk to it like anyone else.

Building your own bot instead? The wire protocol is one WebSocket and a
handful of JSON frames — see Agora's
[protocol reference](https://github.com/tomjose92/agora/blob/main/docs/PROTOCOL.md)
on GitHub.
For the supported Markdown and rich message formats, with examples for tables,
Mermaid, ECharts, maps, forms, and image attachments, see
[Visual responses](https://github.com/tomjose92/agora/blob/main/docs/VISUAL_RESPONSES.md).
