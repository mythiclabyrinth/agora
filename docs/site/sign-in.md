# Sign in

Let people join a hosted Agora with personal accounts instead of sharing the
operator admin key. Configure Google for browser, desktop, and mobile sign-in,
or Apple for the iPhone app.

## Before you begin

Agora admission is separate from provider authentication. Existing users and
invited emails can sign in; allowlists decide whether new, uninvited accounts
may join. Exact emails admit individuals, `*@example.com` admits a domain, and
a bare `*` enables open signup as a member.

Google and Apple allowlist entries feed the same admission check. A wildcard
in either list can therefore admit both providers when both are configured.

<!-- tabs:start -->
<!-- tab:google:Google -->
## Google

A personal Gmail account is enough to configure the Google Cloud project;
Google Workspace is optional. Agora uses one server-side OAuth client for web,
desktop, and mobile, so you do not need separate platform OAuth clients.

### Configure Google Cloud

1. Create or select a project in the
   [Google Cloud Console](https://console.cloud.google.com/).
2. Configure Google Auth Platform branding with the app name and support
   contact people should see during sign-in.
3. Configure the audience and test users.
4. Create an OAuth client of type **Web application**.
5. Add Agora's exact callback as an authorized redirect URI.

Agora requests only the basic OpenID Connect identity scopes: `openid`,
`email`, and `profile`.

#### Audience and test users

Use an **External** audience for personal Gmail accounts. A Google Workspace
organization may use an Internal audience when only people in that
organization should authorize the app.

While the OAuth app is in **Testing**, add every Google account that should
sign in as a test user. Google limits Testing projects to 100 test users. Move
the app to **In production** when it should serve accounts outside that list;
Google may require verification depending on the branding and scopes.

> Google's audience controls who may complete OAuth. Agora's account,
> invitation, and allowlist rules separately control who may join. Passing one
> gate does not bypass the other.

#### Authorized redirect URI

Register this URI on the Web application client, replacing the example host
with the public origin of your Agora deployment:

```text
https://agora.example.com/api/auth/google/callback
```

It must match exactly, including scheme, hostname, port, path, case, and
trailing slash. Do not add a trailing slash. Keep the generated client secret
in the hosted server's secret settings; never commit or expose it in a browser
build.

### Configure Agora for Google

Set all four variables on the hosted service:

```bash
AGORA_GOOGLE_CLIENT_ID=....apps.googleusercontent.com
AGORA_GOOGLE_CLIENT_SECRET=GOCSPX-...
AGORA_GOOGLE_ALLOWED_EMAILS=you@gmail.com
AGORA_PUBLIC_URL=https://agora.example.com
```

`AGORA_PUBLIC_URL` is the public HTTPS origin only, without a path or trailing
slash. Set it explicitly behind a reverse proxy, then restart or redeploy.
The equivalent `config.json` keys are `google_client_id`,
`google_client_secret`, `google_allowed_emails`, and `public_url`.

#### Google allowlist

The client ID and secret make the Google button appear. The allowlist controls
new, uninvited accounts:

| `AGORA_GOOGLE_ALLOWED_EMAILS` | Who can join |
| --- | --- |
| Empty | Existing users and invited emails only; Google sign-in remains visible. |
| `person@example.com` | That exact email, plus existing users and invitees. Separate entries with commas. |
| `*@example.com` | Any Google account in that domain. |
| `*` | Anyone who completes Google OAuth can create a member account. Use only for a public server. |

### Verify Google sign-in

1. Restart or redeploy Agora.
2. Open `https://agora.example.com/api/auth/config` and confirm it contains
   `"google":{"enabled":true}`.
3. In a private browser window, confirm **Continue with Google** appears.
4. Sign in with an account permitted by both Google and Agora.

### Google troubleshooting

#### `redirect_uri_mismatch`

Compare Google's complete error URI with the authorized redirect URI. The
most common hosted cause is an unset `AGORA_PUBLIC_URL` plus a proxy that omits
`X-Forwarded-Proto`; Agora then derives an `http://` callback. Set the public
HTTPS origin explicitly and redeploy.

#### Google blocks access or says the app is in Testing

Add the exact account under the OAuth app's test users. For broader access,
move the app to In production and complete any requested verification. An
Agora allowlist value of `*` does not bypass Google's test-user restriction.

#### Google account is not a member (`no_access`)

Google authenticated the account, but Agora found no existing user,
invitation, or matching allowlist entry. Invite the email or update
`AGORA_GOOGLE_ALLOWED_EMAILS`, then restart. A `disabled` error means an Agora
administrator disabled an existing account.

#### Google keeps selecting the wrong account

On the web, sign out of the unwanted Google account or open
`/api/auth/google/start?select_account=1` on the Agora host. The iPhone app
requests the chooser automatically when retrying a rejected account.

#### Too many Google sign-in attempts (`429`)

Wait for the short authentication rate-limit window before trying again.
<!-- /tab -->
<!-- tab:apple:Apple -->
## Apple

Sign in with Apple uses the iPhone's native system sheet. Agora verifies the
Apple identity token and creates the same kind of member account as Google.
There are no Apple client credentials to store on the Agora server.

### Before configuring Apple

The button appears only in an iOS build carrying the Sign in with Apple
entitlement, which requires a paid Apple Developer team. Free personal-team
development builds strip the entitlement and hide the button.

The stock Agora app expects bundle ID `app.agora.mobile`. If you ship a custom
build, configure its bundle ID explicitly.

### Configure Agora for Apple

Set the allowlist on the hosted service:

```bash
AGORA_APPLE_ALLOWED_EMAILS=you@icloud.com
# AGORA_APPLE_BUNDLE_ID=app.agora.mobile    # custom builds only
```

The equivalent `config.json` keys are `apple_allowed_emails` and
`apple_bundle_id`. Restart or redeploy after changing them.

#### Apple allowlist

| `AGORA_APPLE_ALLOWED_EMAILS` | Who can join |
| --- | --- |
| Empty | Apple stays off unless an explicit bundle ID is configured. |
| `person@icloud.com` | That exact Apple email. Separate entries with commas. |
| `*@example.com` | Any Apple account presenting an email in that domain. |
| `*` | Open signup: anyone who completes Apple sign-in can create a member account. |

If someone uses **Hide My Email**, allowlist the private relay address Apple
provides. It is stable for that Apple ID and app.

### Verify Apple sign-in

1. Restart or redeploy Agora.
2. Open `https://agora.example.com/api/auth/config` and confirm it contains
   `"apple":{"enabled":true}`.
3. Open the connect screen in an entitled iPhone build and confirm the native
   **Sign in with Apple** button appears.
4. Sign in with an account matching the invitation or allowlist rules.

### Apple troubleshooting

#### Continue with Apple does not appear

Confirm the mobile build carries the Sign in with Apple entitlement and the
server reports Apple as enabled. A non-empty allowlist enables the stock app;
a custom build also needs its matching `AGORA_APPLE_BUNDLE_ID`.

#### Apple account is not a member (`no_access`)

Agora did not find an existing user, invitation, or matching allowlist entry.
If Hide My Email was used, add the Apple relay address rather than the user's
personal address, then restart.

#### Apple audience or bundle ID error

For the stock app, leave `AGORA_APPLE_BUNDLE_ID` empty. For a custom build,
set it to the exact bundle ID used to sign the app, then redeploy.
<!-- /tab -->
<!-- tabs:end -->

## Authentication architecture

For token validation, session lifetime, per-client behavior, and account
deletion, read the repository's deeper
[accounts and sign-in reference](../AUTH.md).
