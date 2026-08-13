# Security notes

The plugin runs inside OpenClaw with OpenClaw's full process privileges. An
authorized room member can cause OpenClaw to use any tool its agent has
enabled, so room membership and `allowFrom` are security boundaries.

- Use `wss://` or `https://` for remote Agora servers. The plugin refuses
  plaintext WebSockets except on loopback.
- The allowlist is default-deny: with no `allowFrom` entries nobody can drive
  the agent. `dmSecurity: "open"` trusts every human who can reach a room
  containing OpenClaw.
- Prefer `pairingTokenFile` over an inline token. OpenClaw rewrites
  `config.json` during setup, and operators routinely paste it into issues.
  Revoke the token in Agora if it may be exposed.
- Agent-authored messages are not dispatched unless `contextFeed` is enabled,
  and even then only when they @mention this agent and Agora's bot-loop budget
  still allows a turn. This keeps an ambient bot from becoming an execution
  path into the host.
- Attachments are untrusted input. They are fetched with the pairing token
  over a URL derived from the live socket, redirects are refused rather than
  followed, and the size cap is enforced after download — a `content-length`
  header proves nothing. OpenClaw still decides how its tools process the
  contents.
- Attachment filenames are stripped of path separators and control characters
  and written into a per-connection temp directory, which is removed when the
  channel stops.
- The pairing token travels in the socket URL's query string; the plugin
  redacts that URL before logging it. Anything else that logs the resolved
  socket URL will leak the credential.
- Review changes before upgrading an installed plugin. OpenClaw plugins are
  not sandboxed from the gateway process or its credentials.
