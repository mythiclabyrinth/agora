<!-- ‹ back to [README](../README.md) -->

# Deployment & operations

How to get an Agora server running and configured: three recipes (source,
Docker, Railway), the config reference, and the operational essentials.
For how the system works, see [ARCHITECTURE.md](ARCHITECTURE.md); for
accounts and sign-in, [AUTH.md](AUTH.md).

Pick the recipe that matches your setup:

| You want | Recipe |
| --- | --- |
| The macOS desktop app for yourself | Quick start in the [README](../README.md) |
| A headless server on your own machine or VPS | [Run the server from source](#run-the-server-from-source) |
| A container on any Docker host | [Run the server with Docker](#run-the-server-with-docker) |
| A managed deploy with TLS and a public URL | [Deploying on Railway (or any Docker PaaS)](#deploying-on-railway-or-any-docker-paas) |

The user-facing version of this material lives in the hosted docs at
<https://tomjose92.github.io/agora/> (also served by every running server at
`/docs/`); this file keeps the full operator detail.

## Run the server from source

Works on Linux and macOS. **Prerequisites:** Rust (stable) and Node 22+.

```bash
cargo build --release -p agora-server
npm ci && npm run build        # web UI -> web/dist

./target/release/agora-server --data-dir /var/lib/agora --ui-dir web/dist
# Agora ready at http://127.0.0.1:4470
# Admin key: <printed on first run>
```

Open `http://127.0.0.1:4470/?token=<admin-key>`. The admin key is printed on
first boot and stored in `<data-dir>/config.json`.

The binary and the UI directory are self-contained — build on one machine,
copy `target/release/agora-server` plus `web/dist` to the box that runs them.
A systemd unit to keep it alive:

```ini
[Unit]
Description=Agora
After=network.target

[Service]
ExecStart=/usr/local/bin/agora-server --data-dir /var/lib/agora --ui-dir /var/lib/agora/ui
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

Keep the bind loopback and put a TLS reverse proxy in front (WebSockets need
upgrade headers):

```nginx
server {
    server_name agora.example.com;
    listen 443 ssl;
    location / {
        proxy_pass http://127.0.0.1:4470;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
```

Then share `https://agora.example.com/?token=<admin-key>`, or invite users so
they sign in with their own accounts — see [AUTH.md](AUTH.md).

## Run the server with Docker

The repo's [`Dockerfile`](../Dockerfile) bakes the web UI into the image —
the host needs nothing but Docker.

```bash
docker build -t agora .
docker run -d --name agora -p 4470:4470 -v agora-data:/data agora
docker logs agora            # "Admin key: ..." is printed on first boot
```

Open `http://127.0.0.1:4470/?token=<admin-key>`. Two things to know:

- **The `/data` volume is mandatory.** Config, database, and uploads live
  there; without it every container replacement regenerates the admin key
  and wipes messages.
- The container does not terminate TLS. Publishing the port beyond localhost
  needs a TLS reverse proxy in front, exactly as in the source recipe — see
  [Network exposure](#network-exposure). The image sets `AGORA_BIND=0.0.0.0`
  and honors `PORT`.

## Deploying on Railway (or any Docker PaaS)

The repo ships the [`Dockerfile`](../Dockerfile) and
[`railway.json`](../railway.json); the image follows PaaS conventions
(`PORT` injected by the platform, `AGORA_BIND=0.0.0.0`).

```bash
railway init --name agora
railway volume add --mount-path /data   # config.json + agora.db + uploads live here
railway up --detach
railway domain                          # get the public https URL
railway logs                            # "Admin key: ..." is printed on first boot
```

- **The `/data` volume is mandatory** — same reason as Docker above.
- **TLS comes free** with the platform domain, so browsers, the mobile app,
  and dial-in bridges (`wss://.../agent/ws?token=...`) work with no reverse
  proxy.
- Optional: `AGORA_ADMIN_LOGIN_ENABLED=false` hides admin-key login controls
  in the clients without invalidating the key.

## Sharing the desktop app

**Linux** — releases include an x86-64 Debian package and AppImage: install
with `sudo apt install ./Agora_*.deb`, or mark the AppImage executable and
launch it directly. WSL2 with WSLg works for development and internal use
(WSL1 and headless WSL are unsupported).

**macOS** — the locally built `.app` is ad-hoc signed, so another Mac's
Gatekeeper refuses it. Options, in increasing order of effort:

1. **They build it themselves** (Quick start in the README) — Gatekeeper
   trusts locally built apps.
2. **Send the `.app`** and have them clear quarantine once:
   `xattr -dr com.apple.quarantine /Applications/Agora.app`.
3. **Sign and notarize** with an Apple Developer account — see
   [Tauri's macOS signing guide](https://v2.tauri.app/distribute/sign/macos/).

Note each installed app is its **own Agora** (own database, own groups); a
shared room for multiple people is what a server deployment is for.

## Releases and auto-update

Merging a version bump to `main` publishes a desktop release via
[release-desktop.yml](../.github/workflows/release-desktop.yml): a universal
macOS DMG plus Linux Debian and AppImage packages, published together with
one signed updater feed once every artifact is ready. The macOS app and the
Linux AppImage self-update from that feed (checked on launch and via
**Agora → Check for Updates…**); Debian installs update through the package
itself. Local dev builds compile the updater out, so they are never silently
replaced. If a draft release gets stuck, delete the draft and re-run the
workflow.

## Moving between Agoras

An Agora's data can be exported as one archive and imported into any other
instance (`GET /api/export` / `POST /api/import`, admin key; tokens and bind
settings never migrate). [`scripts/agora_migrate.py`](../scripts/agora_migrate.py)
composes those for every combination of local data dir and live server:

```bash
# laptop desktop app -> hosted Railway deployment
scripts/agora_migrate.py \
    --from "~/Library/Application Support/app.agora.desktop" \
    --to https://agora.up.railway.app --to-token ADMINKEY

# hosted -> hosted, overwriting the target (old data kept in pre-import-<ts>/)
scripts/agora_migrate.py --from https://old.example --from-token AAA \
                         --to https://new.example --to-token BBB --replace

# just take a backup
scripts/agora_migrate.py --from https://agora.up.railway.app --from-token AAA \
    --save agora-backup.tar.gz
```

The typical "graduate my laptop Agora to the cloud" flow: deploy on Railway,
run the first command, then flip the desktop app to remote mode
(Server → Server Settings…) and sign the mobile app into the same URL.

## Network exposure

- The server defaults to a **loopback bind**; nothing is reachable off-host
  until you set `bind: 0.0.0.0` (the Docker image does).
- On `0.0.0.0` the admin key is the only thing between the internet and full
  control — always front it with a firewall and a **TLS reverse proxy**,
  never expose the raw port. Without TLS the key and every message travel in
  the clear.
- The built-in rate limiting is an in-process backstop; keep a real limiter
  at the edge for internet-facing deployments.

## Configuration (`config.json` in the data dir)

| Key | Default | Meaning |
| --- | --- | --- |
| `admin_key` | generated | Operator credential for the UI/REST API (`?token=` or `Authorization: Bearer`). |
| `admin_login_enabled` | `true` | `false` hides admin-key login controls in the clients (env: `AGORA_ADMIN_LOGIN_ENABLED`). |
| `session_secret` | generated | Signs session tokens; rotate it to sign everyone out. |
| `username` | `me` | Display name of the bootstrap local user. |
| `bind` | `127.0.0.1` | `0.0.0.0` accepts LAN/remote connections — see [Network exposure](#network-exposure). |
| `port` | `4470` | Falls back to an ephemeral port if taken (env: `PORT`). |
| `require_tls` | `false` | Refuse plaintext outbound connections to non-loopback hosts. |
| `connections` | `[]` | Outbound Pantheo endpoints (managed from the UI). |
| `pairing_tokens` | `[]` | Dial-in bridge credentials (managed from the UI). |
| `max_file_mb` | `10` | Per-attachment upload cap. |
| `max_video_mb` | `100` | Cap for recognized video containers (MP4, MOV, M4V, WebM). |
| `google_client_id` | `""` | Google OAuth client id — see [AUTH.md](AUTH.md#google-sign-in). |
| `google_client_secret` | `""` | Google OAuth client secret. |
| `google_allowed_emails` | `[]` | Google accounts allowed to sign in; empty keeps Google sign-in off. |
| `apple_allowed_emails` | `[]` | Apple emails allowed to sign in — see [AUTH.md](AUTH.md#sign-in-with-apple). |
| `apple_bundle_id` | `""` | iOS bundle id for Apple sign-in; empty means the stock app. |
| `public_url` | `""` | Public https origin used to build the OAuth redirect URI. |
| `map_style_url` | `""` | MapLibre style URL for map artifacts; empty uses the built-in default, `"none"` disables external tiles. |

Voice / Ask AI keys may be set by instance admins in the **Settings** UI
(`ai` in `config.json`) or supplied as process-env fallbacks
(`OPENAI_API_KEY`, `GROQ_API_KEY`, `ANTHROPIC_API_KEY`). Ask AI also supports provider
`codex` (**Codex OAuth** via PKCE in Settings → Credentials). Voice STT can use
`openai` or `groq`; TTS remains OpenAI for now. Models and Enabled toggles are set
per feature in Settings → Features; for Codex OAuth the dropdown prefers the
live Codex catalog when linked (else a hard-coded fallback).
Env key fallbacks are **not** folded into `config.json` at boot — see
[configuration.md](site/configuration.md#voice-and-ask-ai).

`AGORA_*` environment overrides are written into `config.json` at boot, so
unsetting one later keeps the last value rather than reverting.

## Notifications

Agent replies that land while nobody is looking pop native banners: the
desktop app notifies while unfocused, and the mobile app gets instant remote
push (Expo → APNs/FCM) when backgrounded, with tap-to-open and unread
badges. Two requirements:

- **iOS push** needs a paid Apple Developer membership (APNs entitlement)
  and a native rebuild with the `expo-notifications` plugin enabled.
- **macOS banners** need a stable code signature — an ad-hoc build gets
  "notifications are not allowed". For local dev:
  `codesign --force --deep --sign "Agora Dev" /Applications/Agora.app`
  (self-signed cert created in Keychain Access); a Developer ID signature
  covers distribution.
