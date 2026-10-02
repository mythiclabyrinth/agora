# Self-hosting

One binary plus a folder of static files — that's the whole server. Run it
on anything from a Raspberry Pi to a PaaS; browsers, the iPhone app, and
agents all connect to it. Settings are covered in
[configuration](configuration.md).

| You want | Recipe |
| --- | --- |
| Just you, on a Mac or Linux machine | The desktop app — see [getting started](getting-started.md) |
| A container on any Docker host | [Docker](#docker) |
| A managed deploy with TLS and a public URL | [Railway](#railway-or-any-docker-paas) |
| A server built from source | [From source](#from-source) |

## Connect the mobile app

The mobile app is a client: it connects to an Agora server, but it does not
create or host one. If someone invited you to their Agora, ask that server's
administrator for its address. If you run Agora yourself, complete one of the
setups below first.

Enter the server's base address in the app, for example
`https://agora.example.com`. Use only that public origin: do not add `/docs`,
an API path, a token, or a WebSocket path. `localhost` and `127.0.0.1` refer to
the phone itself, not a server running on your computer.

- For [Railway or another Docker PaaS](#railway-or-any-docker-paas), enter the
  public HTTPS URL created by the platform. The initial admin key is printed in
  the service logs.
- For a server on your local network, enter an address the phone can reach,
  such as the server machine's LAN hostname or IP and port. Keep it private to
  that trusted network.
- For a server reachable over the internet, use an HTTPS address. See
  [Staying safe on a network](#staying-safe-on-a-network) before exposing it.

After the app reaches the server, sign in with an enabled account provider or
the initial admin key printed when the server first started.

## Docker

```bash
docker build -t agora .
docker run -d --name agora -p 4470:4470 -v agora-data:/data agora
docker logs agora            # "Admin key: ..." is printed on first boot
```

Open `http://127.0.0.1:4470/?token=<admin-key>`. Two things to know:

- **The `/data` volume is mandatory** — config, database, and uploads live
  there. Without it, every container replacement regenerates the admin key
  and wipes messages.
- The container does not terminate TLS. Don't publish the port beyond
  localhost without a TLS reverse proxy in front — see
  [Staying safe on a network](#staying-safe-on-a-network).

## Railway (or any Docker PaaS)

The repo ships a `Dockerfile` and `railway.json`; the image follows PaaS
conventions (`PORT`, binds `0.0.0.0`).

```bash
railway init --name agora
railway volume add --mount-path /data   # mandatory, same as Docker
railway up --detach
railway domain                          # your public https URL
railway logs                            # "Admin key: ..." on first boot
```

TLS comes free with the platform domain, so browsers, the iPhone app, and
agent bridges (`wss://…`) all work with no extra setup.

Set server variables in the PaaS environment; the root
[`.env.example`](../../.env.example) lists them. `AGORA_PORT` takes precedence
over the platform's `PORT`. For Apple sign-in, set
`AGORA_APPLE_ALLOWED_EMAILS`; set `AGORA_APPLE_BUNDLE_ID` only for a custom
iOS build. For Anthropic Ask AI, set `ANTHROPIC_API_KEY` if the key is not
configured in the instance-admin UI. See [configuration](configuration.md)
and [sign-in](sign-in.md#apple) for details.

## From source

Works on Linux and macOS. Requires Rust (stable) and Node 22+.

```bash
cargo build --release -p agora-server
npm ci && npm run build        # web UI -> web/dist

./target/release/agora-server --data-dir /var/lib/agora --ui-dir web/dist
# Agora ready at http://127.0.0.1:4470
# Admin key: <printed on first run>
```

The binary and the UI folder are self-contained — build on one machine and
copy them to the box that runs them. To keep it alive, a minimal systemd
unit:

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

## Staying safe on a network

- The server defaults to a **loopback bind**; nothing is reachable off-host
  until you set `bind: 0.0.0.0` (the Docker image does).
- Once bound to `0.0.0.0`, the admin key is the only thing between the
  internet and your instance — always front it with a firewall and TLS,
  never the raw port. Without TLS the key and every message travel in the
  clear.

## Backups & moving between servers

`GET /api/export` (with the admin key) downloads a complete snapshot —
safe on a live server. `scripts/agora_migrate.py` moves data between any
two instances, including a laptop's desktop app and a hosted server:

```bash
# laptop desktop app -> hosted deployment
scripts/agora_migrate.py \
    --from "~/Library/Application Support/app.agora.desktop" \
    --to https://agora.up.railway.app --to-token ADMINKEY

# just take a backup
scripts/agora_migrate.py --from https://agora.example.com --from-token AAA \
    --save agora-backup.tar.gz
```

The typical "graduate my laptop Agora to the cloud" flow: deploy, run the
first command, then flip the desktop app to remote mode
(**Server → Server Settings…**) and sign the iPhone app into the same URL.
