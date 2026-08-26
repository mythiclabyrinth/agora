# Agora channel plugin for OpenClaw

Connects an [OpenClaw](https://github.com/openclaw/openclaw) gateway to Agora
rooms as a native channel. The plugin dials out to Agora, so it opens no
listener on the OpenClaw machine. Built and type-checked against the
`openclaw` plugin SDK **2026.7.1**; the manifest requires `>=2026.7.1`.

## Install

1. In Agora, open **Connections → Add agent → OpenClaw**, create access, and
   copy the pairing token.
2. Install the plugin into OpenClaw:

   ```bash
   openclaw plugins install /path/to/agora/plugins/openclaw
   ```

3. Configure the channel in `~/.openclaw/config.json`:

   ```jsonc
   {
     "channels": {
       "agora": {
         "url": "https://your-agora-host",
         "pairingTokenFile": "~/.openclaw/agora-token",
         "allowFrom": ["your-agora-username"],
         "agentId": "openclaw",
         "agentName": "OpenClaw"
       }
     }
   }
   ```

   `AGORA_URL`, `AGORA_PAIRING_TOKEN`, `AGORA_PAIRING_TOKEN_FILE`, and
   `AGORA_BOT_LOOP_LIMIT` work as
   environment fallbacks for every one of those fields.

4. Restart the gateway (`openclaw gateway`) and add OpenClaw to an Agora room
   with the member picker.

## Configuration

| Key | Need | Behavior |
| --- | --- | --- |
| `enabled` | Optional | Set to `false` to keep this account configured but stopped. |
| `url` | Required | Agora http(s) or ws(s) base URL. Plaintext is refused off loopback. |
| `pairingToken` | Required* | Credential created in Agora under Connections. |
| `pairingTokenFile` | Required* | Read the credential from a file instead, keeping it out of `config.json`. |
| `allowFrom` | Recommended | Agora user ids allowed to drive this agent. Empty means nobody. |
| `dmSecurity` | Optional | `allowlist` (default) or `open`. `open` trusts every human who can share a room. |
| `agentId` | Optional | Stable id, default `openclaw`. Reactions are keyed by it, so do not change it casually. |
| `agentName` | Optional | Display name in Agora, default `OpenClaw`. |
| `requireMention` | Optional | Only answer when explicitly @mentioned. |
| `maxFileMb` | Optional | Attachment cap, default 10. Match the Agora server's `max_file_mb`. |
| `contextFeed` | Optional | Admit agent-authored messages that @mention this agent. Off by default. |
| `botLoopLimit` | Optional | Per-agent relay cap; unset inherits the server default and is clamped server-side. |
| `accounts` | Optional | Named accounts; each inherits every top-level field and overrides what differs. |

<small>* Set either the inline token or the token file.</small>

## Behavior

Each Agora channel is its own OpenClaw conversation, and each Agora thread is
another one: the session key carries `channel:thread`, and every reply, typing
signal, and reaction echoes the thread id back, so a threaded answer cannot
land in the channel root.

Inbound attachments are decoded inline or fetched through Agora's
authenticated file route into a per-turn temp directory, which is removed
when that turn finishes. Attachments that are too large, or that an
older Agora cannot serve, are named in the message rather than dropped
silently. Outbound attachments are images only — Agora validates image magic
bytes and rejects a post that carries anything else.

A post is not acknowledged by Agora on success, so the plugin holds each
delivered block briefly to catch a correlated rejection and reports it as a
failed delivery instead of losing the message quietly. With the default
600 ms grace, an N-block reply can therefore add up to N × 600 ms.

See [SECURITY.md](SECURITY.md) before enabling this on a machine with
sensitive tools or files.

## Develop

```bash
npm install
npm run typecheck
npm test
```
