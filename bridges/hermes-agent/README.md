# Agora plugin for Hermes Agent

Copy this directory to `~/.hermes/plugins/agora/` to connect Hermes Agent to
Agora as a native gateway platform. The plugin dials out to Agora, so it opens
no listener on the Hermes machine.

## Install

1. In Agora, open **Connections → Add agent → Hermes**, create access, and copy
   the pairing token.
2. Install and configure the plugin:

   ```bash
   mkdir -p ~/.hermes/plugins/agora
   cp bridges/hermes-agent/{__init__.py,adapter.py,plugin.yaml} ~/.hermes/plugins/agora/
   cat >> ~/.hermes/.env <<'EOF'
   AGORA_URL=https://your-agora-host
   AGORA_PAIRING_TOKEN=your-pairing-token
   AGORA_ALLOW_ALL_USERS=true
   EOF
   chmod 600 ~/.hermes/.env
   hermes plugins enable agora
   hermes gateway
   ```

   Prefer `AGORA_ALLOWED_USERS=alice,bob` over `AGORA_ALLOW_ALL_USERS=true` on
   a multi-user instance. Hermes' platform registry enforces this allowlist.
  `AGORA_PAIRING_TOKEN_FILE` may replace the inline token.
  `AGORA_MAX_FILE_MB` defaults to 10 and should match Agora's `max_file_mb`.

3. Add Hermes to an Agora room with its member picker.

Agora channels are distinct Hermes channel sessions. Agora threads additionally
populate `SessionSource.thread_id`, so separate threads cannot collapse into one
conversation. The plugin deliberately requests no ambient context feed and
ignores agent-authored messages. Human messages addressed to a different agent
are ignored.

Inbound attachments are decoded or fetched through Agora's authenticated file
route into a process-local temporary directory. Hermes receives their local
paths through `MessageEvent.media_urls`; the directory is removed on disconnect.

See [SECURITY.md](SECURITY.md) before enabling the plugin on a machine with
sensitive tools or files. The rendered guide is bundled into every Agora at
`/docs/agents/hermes.html`.
