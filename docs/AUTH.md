<!-- ‹ back to [README](../README.md) -->

# Accounts & sign-in

Agora is multi-user: real accounts (a `users` table) with instance roles
(admin/member), per-group roles, and email/invite-link admission. The
`admin_key` in `config.json` is the *operator* credential — it resolves to an
instance admin — not a personal account. On top of pasted-token access, a
deployed server can offer Google and Apple sign-in.

Set `AGORA_ADMIN_LOGIN_ENABLED=false` (or `0`, `no`, or `off`) to hide the
admin-key login controls without invalidating the operator key; see
[Deployment](DEPLOYMENT.md#deploying-on-railway-or-any-docker-paas).

## Google sign-in

Instead of pasting the admin key, a deployed server can offer **Sign in with
Google** — the same OIDC code flow Pantheo's dashboard uses. The web UI's auth
gate, the desktop app's server picker, and the mobile connect screen all grow a
Google button once the server is configured. A successful sign-in mints a
30-day session token (HMAC-signed with `session_secret`) that is accepted
everywhere the admin key is; Google credentials are never stored.

### Set up Google Cloud

A personal Gmail account is enough to own the Google Cloud project; Google
Workspace is not required. If you do use a Workspace organization, you may
choose an Internal audience to restrict consent to that organization. For a
personal account, use an External audience.

1. Create or select a project in the
   [Google Cloud Console](https://console.cloud.google.com/).
2. Configure the Google Auth Platform branding and audience. Choose
   **External** when using personal Gmail accounts. While the app is in
   **Testing**, add every Google account that should sign in as a test user.
   Google limits Testing projects to 100 test users. Move the app to **In
   production** when it should serve users outside the test list; Google may
   require verification depending on the branding and scopes you configure.
   Agora requests only the basic OpenID Connect identity scopes (`openid`,
   `email`, `profile`).
3. Create an OAuth client of type **Web application** and add this authorized
   redirect URI, substituting the public origin of your Agora deployment:

   ```text
   https://<your-agora-host>/api/auth/google/callback
   ```

   Google matches redirect URIs exactly, including the `http`/`https` scheme,
   hostname, port, path, case, and trailing slash. Do not add a trailing slash.
   Agora's browser, desktop, and mobile clients all use this one server-side
   web client; do not create separate Android, iOS, or desktop OAuth clients.

Keep the generated client secret private. Do not commit it to the repository,
put it in a client-side environment variable, or expose it in a browser build.

### Configure Agora

Set these variables on the hosted Agora server (for example, in Railway's
service variables):

```bash
AGORA_GOOGLE_CLIENT_ID=....apps.googleusercontent.com
AGORA_GOOGLE_CLIENT_SECRET=GOCSPX-...
AGORA_GOOGLE_ALLOWED_EMAILS=you@gmail.com          # comma-separated
AGORA_PUBLIC_URL=https://agora.up.railway.app      # must match the redirect URI
```

The same values can be set as `google_client_id`, `google_client_secret`,
`google_allowed_emails`, and `public_url` in `config.json`. Environment values
are persisted into that file at boot, so removing an environment variable
later does not erase its last value. Restart or redeploy Agora after changing
them.

`AGORA_PUBLIC_URL` should be the public HTTPS origin only, with no path or
trailing slash. Setting it explicitly is strongly recommended behind a reverse
proxy. Without it, Agora derives the callback origin from the request's `Host`
and `X-Forwarded-Proto` headers and defaults to `http` when the forwarded
protocol is absent.

The client ID and secret control whether Google sign-in is offered. When both
are non-empty, `GET /api/auth/config` reports `{"google":{"enabled":true}}`
and the sign-in buttons appear, even if the allowlist is empty.

### Decide who can join

Admission is decided by the sign-in rules (existing user → email invite →
valid invite link → config allowlist); the `google_allowed_emails` list is the
fallback that lets a fresh email create a member account. An invite can assign
a different instance role. With an empty allowlist, Google sign-in stays
visible but the instance is invite-only: existing users and invited emails can
sign in, while other accounts finish Google's flow and are refused by Agora.

Allowlist entries may be wildcards: `*@example.com` admits everyone at that
domain, and a bare `*` is **open sign-up** — anyone with a Google (or Apple)
account gets a member account on your instance, so only use it on servers
meant to be public. Both allowlists feed the same admission check, so a
wildcard on either admits sign-ins from both providers.

Google's audience and test-user settings and Agora's admission rules are two
separate gates. Being a Google OAuth test user permits the Google consent flow;
it does not grant access to the Agora instance. Conversely, an Agora allowlist
entry cannot bypass Google's test-user restriction while the OAuth app is in
Testing.

### Verify and troubleshoot

After restarting or redeploying:

1. Open `https://<your-agora-host>/api/auth/config` and confirm it contains
   `"google":{"enabled":true}`.
2. Open Agora in a private browser window and confirm **Continue with Google**
   appears.
3. Sign in with an account admitted by an existing account, email invite,
   invite link, or allowlist entry.

Common failures:

- **`redirect_uri_mismatch` from Google** — compare the complete URI shown in
  the error with the authorized redirect URI. The most common hosted cause is
  an unset `AGORA_PUBLIC_URL` combined with a proxy that does not send
  `X-Forwarded-Proto`, causing Agora to generate an `http://` callback. Set
  `AGORA_PUBLIC_URL` to the public HTTPS origin and redeploy.
- **Google blocks access or says the app is being tested** — for an External
  app in Testing, add that exact Google account under test users. For broader
  access, move the OAuth app to In production and complete any verification
  Google requests.
- **The account is not a member (`no_access`)** — Google authenticated the
  account, but Agora did not find an existing user, applicable invitation, or
  matching allowlist entry. Invite the email or update the allowlist and
  restart. This is distinct from `disabled`, which means an Agora administrator
  disabled an existing account.
- **Google silently reuses the wrong account** — iPhone retries request
  Google's account chooser automatically. On the web, sign out of the wrong
  Google account or open `/api/auth/google/start?select_account=1` directly.
- **`429 Too many sign-in attempts`** — wait for the short authentication rate
  limit window before retrying.
- **Old settings remain after changing deployment variables** — Agora writes
  these environment overrides into `config.json` at boot. Unsetting a variable
  does not clear the persisted value; replace it explicitly or edit the
  deployment's `config.json`, then restart.

> **Token trust:** the `id_token` is validated by its claims (`iss`, `aud`,
> `exp`, `email_verified`, allowlist) but **not** by an RS256/JWKS signature
> check. This is safe because the token is fetched directly from Google's token
> endpoint over the server's TLS back-channel (authorization-code flow), so its
> authenticity is already established by transport — a JWKS verification would
> be redundant and add a network dependency. Do **not** repurpose
> `decode_id_token` for tokens received from an untrusted source (e.g. an
> implicit-flow token straight from a browser); those must have their signature
> verified. See `crates/agora-core/src/auth.rs`.

Per client:

- **Browser** — the auth gate shows *Continue with Google*; the callback lands
  the session in the URL fragment and the UI stores it like a pasted token.
- **Desktop** — *Server → Server Settings… → Sign in with Google instead*
  opens your default browser (Google refuses embedded webviews) and catches
  the token on a loopback listener; the app then behaves exactly like remote
  mode with a pasted token. Embedded mode needs no sign-in at all.
- **iPhone** — the connect screen's Google button opens a system auth sheet
  and returns via the `agora://auth` deep link; the session token goes into
  the keychain in the admin key's place.

Sessions expire after 30 days (or all at once if `session_secret` is rotated);
clients drop back to their sign-in screen and one Google tap renews them. The
admin key keeps working unchanged — Google sign-in is additive.

## Sign in with Apple

The iOS app can also sign in with Apple (an App Store requirement once any
third-party login is offered). It takes the native path, not a browser
round-trip: the app presents Apple's system sheet, gets back an **identity
token** (an RS256 JWT audienced to the app's bundle id), and posts it to
`POST /api/auth/apple`. The server verifies the token's signature against
Apple's published JWKS — unlike the Google flow there is no trusted TLS
back-channel, the token arrives from the client — plus issuer, audience,
expiry and the email allowlist, then mints the same 30-day session a Google
sign-in would.

Setup needs no Apple-side credentials on the server, just the allowlist:

```bash
AGORA_APPLE_ALLOWED_EMAILS=you@icloud.com   # comma-separated
# AGORA_APPLE_BUNDLE_ID=app.agora.mobile    # only if you ship a custom build
```

(or `apple_allowed_emails` / `apple_bundle_id` in `config.json`). Restart and
`GET /api/auth/config` reports `{"apple":{"enabled":true}}`; the mobile connect
screen shows the Apple button. The same wildcard entries work here —
`*@example.com` for a domain, `*` for open sign-up (which also counts as a
non-empty allowlist, so it enables the Apple button on its own). If you use
Apple's **Hide My Email**, allowlist
the relay address — it is stable per Apple ID and app. Note the button only
renders in builds carrying the Sign in with Apple entitlement (a paid Apple
Developer team); free-personal-team dev builds strip it and hide the button.

## Account deletion

`DELETE /api/me` (Settings → **Delete account** in the iOS app) erases
everything keyed to the owner — authored messages and their attachments,
threads they started, stars, read markers, pins, mentions, memberships — and
rotates `session_secret`, signing out every device at once. The admin key
survives: it's the instance's admin credential, not a user account. This is
what satisfies App Store guideline 5.1.1(v) for the published app.
