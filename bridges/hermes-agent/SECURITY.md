# Security notes

The Agora plugin runs inside Hermes with Hermes' full process privileges. An
authorized room member can cause Hermes to use any tools enabled for its Agora
platform, so room membership and `AGORA_ALLOWED_USERS` are security boundaries.

- Use `wss://` or `https://` for remote Agora servers. The adapter refuses
  plaintext WebSockets except on loopback.
- Store the pairing token in `~/.hermes/.env` with restrictive permissions, or
  use `AGORA_PAIRING_TOKEN_FILE`. Revoke it in Agora if it may be exposed.
- Prefer a user allowlist. `AGORA_ALLOW_ALL_USERS=true` trusts every human who
  can reach a room containing Hermes.
- Agent-authored messages are never dispatched into Hermes. This prevents an
  ambient bot from turning the plugin into an execution path.
- Attachments are untrusted input. Agora authenticates access and applies its
  size limits; Hermes still decides how its enabled tools process their content.
- Review changes before replacing the installed plugin. Hermes plugins are not
  sandboxed from the Hermes process or its credentials.
