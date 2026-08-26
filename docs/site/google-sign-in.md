# Google sign-in

Let people join a hosted Agora with their Google account instead of sharing
the operator admin key. A personal Gmail account is enough to configure the
Google Cloud project; Google Workspace is optional.

## Before you begin

You need:

- an Agora deployment with a public HTTPS origin, such as
  `https://agora.example.com`;
- access to set environment variables and restart that deployment; and
- a Google account that can create or manage a Google Cloud project.

Agora uses one server-side OAuth client for its web, desktop, and mobile
clients. You do not need separate Android, iOS, or desktop OAuth clients.

## Configure Google Cloud

1. Create or select a project in the
   [Google Cloud Console](https://console.cloud.google.com/).
2. Configure the Google Auth Platform branding. Supply the app name and
   support contact that people should see during sign-in.
3. Configure the audience and test users.
4. Create an OAuth client of type **Web application**.
5. Add Agora's exact callback as an authorized redirect URI.

Agora requests only the basic OpenID Connect identity scopes: `openid`,
`email`, and `profile`.

### Audience and test users

Use an **External** audience for personal Gmail accounts. A Google Workspace
organization may instead use an Internal audience when only people in that
organization should authorize the app.

While the OAuth app is in **Testing**, add every Google account that should
sign in as a test user. Google limits Testing projects to 100 test users. Move
the app to **In production** when it should serve accounts outside that list;
Google may require verification depending on the branding and scopes.

> Google's audience controls who may complete OAuth. Agora separately decides
> who may join the instance using existing accounts, invitations, and the
> allowlist configured below. Passing one gate does not bypass the other.

### Authorized redirect URI

Register this URI on the Web application OAuth client, replacing the example
host with the public origin of your Agora deployment:

```text
https://agora.example.com/api/auth/google/callback
```

The URI must match exactly, including the `https` scheme, hostname, port,
path, case, and trailing slash. Do not add a trailing slash to the callback.

Keep the generated client secret private. Store it only in the hosted server's
secret or environment-variable settings; never commit it or expose it in a
browser build.

## Configure Agora

### Environment variables

Set all four variables on the hosted Agora service:

```bash
AGORA_GOOGLE_CLIENT_ID=....apps.googleusercontent.com
AGORA_GOOGLE_CLIENT_SECRET=GOCSPX-...
AGORA_GOOGLE_ALLOWED_EMAILS=you@gmail.com
AGORA_PUBLIC_URL=https://agora.example.com
```

`AGORA_PUBLIC_URL` is the public HTTPS origin only: do not include a path or
trailing slash. Setting it explicitly is strongly recommended behind a reverse
proxy. Restart or redeploy Agora after changing these values.

The same values can be stored in `config.json` as `google_client_id`,
`google_client_secret`, `google_allowed_emails`, and `public_url`. Environment
values are written into `config.json` at boot, so unsetting one later does not
erase its last persisted value.

### Allowlist: invite-only, domains, or open signup

The client ID and secret make the Google button appear. The allowlist controls
whether a new, uninvited Google account may create an Agora member account.

| `AGORA_GOOGLE_ALLOWED_EMAILS` | Who can join |
| --- | --- |
| Empty | Existing Agora users and invited emails only. Google sign-in remains visible. |
| `person@example.com` | That exact email, plus existing users and invitees. Separate multiple emails with commas. |
| `*@example.com` | Any Google account in that domain. |
| `*` | Open signup: anyone who completes Google OAuth can create a member account. Use only for a public server. |

An email invitation can assign a different instance role. Accounts admitted
only through the allowlist are created as members, not administrators.

Google and Apple allowlist entries feed the same admission check. A wildcard
in either provider's list can therefore admit sign-ins from both providers
when both are configured.

## Verify Google sign-in

1. Restart or redeploy Agora.
2. Open `https://agora.example.com/api/auth/config` and confirm the response
   contains `"google":{"enabled":true}`.
3. Open Agora in a private browser window and confirm **Continue with Google**
   appears.
4. Sign in with an account permitted by both the Google audience and Agora's
   account, invitation, or allowlist rules.

## Troubleshooting

### `redirect_uri_mismatch`

Compare the complete URI in Google's error with the authorized redirect URI.
The most common hosted cause is an unset `AGORA_PUBLIC_URL` combined with a
proxy that does not send `X-Forwarded-Proto`; Agora then derives an `http://`
callback that Google rejects. Set `AGORA_PUBLIC_URL` to the public HTTPS origin
and redeploy.

### Google blocks access or says the app is in Testing

Add the exact Google account under the OAuth app's test users. For broader
access, move the app to In production and complete any verification Google
requests. Setting Agora's allowlist to `*` does not bypass Google's test-user
restriction.

### Account is not a member (`no_access`)

Google authenticated the account, but Agora found no existing user,
applicable invitation, or matching allowlist entry. Invite the email or update
`AGORA_GOOGLE_ALLOWED_EMAILS`, then restart. A `disabled` error instead means
an Agora administrator disabled an existing account.

### Google keeps selecting the wrong account

On the web, sign out of the unwanted Google account or open
`/api/auth/google/start?select_account=1` on your Agora host. The iPhone app
automatically requests the account chooser when retrying a rejected account.

### Too many sign-in attempts (`429`)

Wait for the short authentication rate-limit window before trying again.

### Old settings remain after a deployment change

Agora persists these environment overrides into `config.json` at boot.
Unsetting a deployment variable does not clear the stored value; replace it
explicitly or edit the deployment's `config.json`, then restart.

## Authentication architecture

For token validation, session lifetime, per-client behavior, Apple sign-in,
and account deletion, read the repository's deeper
[accounts and sign-in reference](../AUTH.md#google-sign-in).
