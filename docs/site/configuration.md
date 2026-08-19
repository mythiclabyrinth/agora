# Configuration

Everything lives in one file: `config.json` in the server's data dir,
created on first boot. Any key can also be set as an `AGORA_*` environment
variable (Railway-friendly); env values are written into `config.json` at
boot, so unsetting one later keeps the last value.

## `config.json` reference

| Key | Default | Meaning |
| --- | --- | --- |
| `admin_key` | generated | Operator credential (`?token=` or `Authorization: Bearer`). Printed on first boot. |
| `admin_login_enabled` | `true` | `false` hides admin-key login controls in the clients (env: `AGORA_ADMIN_LOGIN_ENABLED`). |
| `session_secret` | generated | Signs session tokens; rotate it to sign everyone out. |
| `username` | `me` | Display name of the bootstrap local user. |
| `bind` | `127.0.0.1` | `0.0.0.0` accepts LAN/remote connections — read [Staying safe on a network](self-hosting.md#staying-safe-on-a-network) first. |
| `port` | `4470` | Falls back to an ephemeral port if taken (env: `PORT`). |
| `require_tls` | `false` | Refuse plaintext outbound connections to non-loopback hosts. |
| `connections` | `[]` | Outbound Pantheo endpoints — managed from the [Connections pane](agents.md), not by hand. |
| `pairing_tokens` | `[]` | Dial-in agent credentials — likewise managed from the UI. |
| `max_file_mb` | `10` | Per-attachment upload cap. |
| `max_video_mb` | `100` | Cap for video attachments (MP4, MOV, M4V, WebM). |
| `google_client_id` | `""` | Google OAuth client id — see below. |
| `google_client_secret` | `""` | Google OAuth client secret. |
| `google_allowed_emails` | `[]` | Google accounts allowed to sign in; empty keeps Google sign-in off. |
| `apple_allowed_emails` | `[]` | Apple emails allowed to sign in; empty keeps Apple sign-in off. |
| `apple_bundle_id` | `""` | iOS bundle id for Apple sign-in; empty means the App Store app. |
| `public_url` | `""` | Public https origin, used to build the OAuth redirect URI. |
| `map_style_url` | `""` | MapLibre style URL for map artifacts; empty uses the built-in default, `"none"` disables external tiles. |
| `ai.voice` / `ai.search` | defaults | Instance-admin AI settings (keys, models, enable flags). Set from the **AI & voice** panel in the clients, or leave empty and supply process-env fallbacks. |

### Voice and Ask AI

Instance admins configure these in the product (**AI & voice** on web/desktop,
**Settings → AI & voice** on mobile). Values persist under `ai` in
`config.json`. Process-env fallbacks are resolved at *read* time only — they
are **never** folded into `config.json` on boot (so a Railway restart cannot
overwrite a UI-set key):

| Env (fallback) | Feature |
| --- | --- |
| `OPENAI_API_KEY` | Voice (OpenAI STT/TTS); also Ask AI when provider is `openai` |
| `ANTHROPIC_API_KEY` | Ask AI when provider is `anthropic` |
| `AGORA_AI_MODEL` | Ask AI model override when none is saved in settings |

Ask AI **providers** (set in the UI):

| Provider | Auth |
| --- | --- |
| `anthropic` | Anthropic API key (config or `ANTHROPIC_API_KEY`) |
| `openai` | OpenAI API key (config or `OPENAI_API_KEY`) |
| `codex` | ChatGPT OAuth — import `~/.codex/auth.json` after `codex login`, paste that JSON, or paste a refresh token. Tokens refresh against the fixed OpenAI auth host; Ask AI calls the fixed Codex responses URL. |

Default models when unset: Anthropic `claude-sonnet-5`, OpenAI `gpt-4.1-mini`,
Codex `gpt-5.1`.

`enabled: false` in settings turns a feature off even when an env key is still
present. Clearing a saved key removes only the config value and falls back to
env. Provider base URLs are not configurable (SSRF risk). Codex OAuth tokens
are never folded from the environment.

## Sign in with Google and Apple

A deployed server can offer real sign-in instead of the pasted admin key.
Who gets in: existing users first, then email invites, then invite links,
then these allowlists (wildcards work — `*@example.com` for a domain, `*`
for open sign-up).

**Google** — create an OAuth client (type *Web application*) in the
[Google Cloud Console](https://console.cloud.google.com/apis/credentials)
with the redirect URI `https://<your-host>/api/auth/google/callback`, then:

```bash
AGORA_GOOGLE_CLIENT_ID=....apps.googleusercontent.com
AGORA_GOOGLE_CLIENT_SECRET=GOCSPX-...
AGORA_GOOGLE_ALLOWED_EMAILS=you@gmail.com          # comma-separated
AGORA_PUBLIC_URL=https://agora.up.railway.app      # must match the redirect URI
```

**Apple** (iPhone app) — no Apple-side credentials needed, just the
allowlist:

```bash
AGORA_APPLE_ALLOWED_EMAILS=you@icloud.com   # comma-separated
```

Restart, and the sign-in buttons appear in the browser, the desktop server
picker, and the iPhone connect screen. Using Apple's **Hide My Email**?
Allowlist the relay address — it's stable per Apple ID.
