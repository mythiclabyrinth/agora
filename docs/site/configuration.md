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
| `google_client_id` | `""` | Google OAuth client id — see [Sign in with Google](sign-in.md#google). |
| `google_client_secret` | `""` | Google OAuth client secret — see [Sign in with Google](sign-in.md#google). |
| `google_allowed_emails` | `[]` | Google admission list — see [Google allowlist](sign-in.md#google-allowlist). |
| `apple_allowed_emails` | `[]` | Apple admission list — see [Apple allowlist](sign-in.md#apple-allowlist). |
| `apple_bundle_id` | `""` | iOS bundle id — see [Sign in with Apple](sign-in.md#apple). |
| `public_url` | `""` | Public https origin, used to build the OAuth redirect URI. |
| `map_style_url` | `""` | MapLibre style URL for map artifacts; empty uses the built-in default, `"none"` disables external tiles. |
| `ai.voice` / `ai.search` | defaults | Instance-admin AI settings (keys, models, enable flags). Set from the **AI & voice** panel in the clients, or leave empty and supply process-env fallbacks. |

### Voice and Ask AI

Instance admins configure these in the product (**Settings** on web/desktop,
**Settings → AI & voice** on mobile): **Features** for providers/models and
Enabled toggles, **Credentials** for API keys and Codex OAuth. Values persist
under `ai` in `config.json`. Process-env fallbacks are resolved at *read* time
only — they are **never** folded into `config.json` on boot (so a Railway
restart cannot overwrite a UI-set key). Clients advertise voice / Ask AI from
the Enabled flags alone; missing credentials fail with a clear error when used.

| Env (fallback) | Feature |
| --- | --- |
| `OPENAI_API_KEY` | Voice TTS and OpenAI STT; also Ask AI when provider is `openai` |
| `GROQ_API_KEY` | Voice STT and TTS when that half is set to `groq` |
| `ANTHROPIC_API_KEY` | Ask AI when provider is `anthropic` |

Voice **STT / TTS providers** (Features tab): `openai` or `groq`. Groq TTS uses Orpheus (`canopylabs/orpheus-v1-english` or `canopylabs/orpheus-arabic-saudi`; wav only; 200-character chunks). **Accent** (`american` / `british` / `arabic`) is stored once and applied on every provider: OpenAI `gpt-4o-mini-tts` follows it via speech instructions; Groq maps Arabic onto the Arabic Orpheus model and English accents onto English voices. Models and voices stay per provider so switching does not leak a foreign id.

Ask AI **providers** (set in the UI Features tab):

| Provider | Auth (Credentials tab) |
| --- | --- |
| `anthropic` | Anthropic API key (config or `ANTHROPIC_API_KEY`) |
| `openai` | OpenAI API key shared with voice (config or `OPENAI_API_KEY`) |
| `codex` | **Codex OAuth** via PKCE — **Authorize Codex** in Credentials (loopback on desktop/localhost; paste the redirected URL when hosted). Model list is fetched live from the Codex catalog when linked. |

Models are chosen per provider in the Features tab. If a call fails (bad key, expired OAuth, unknown model), Ask AI / voice returns an explicit error naming the provider and model.
