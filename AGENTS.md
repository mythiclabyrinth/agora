# AGENTS.md

Working guide for AI agents and contributors in this repo. This file covers
how to work on the code; for what Agora *does* as a product, read
[README.md](README.md). Deep design lives in
[ARCHITECTURE.md](docs/ARCHITECTURE.md), the agent protocol in
[PROTOCOL.md](docs/PROTOCOL.md), operations in [DEPLOYMENT.md](docs/DEPLOYMENT.md), and
accounts/sign-in in [AUTH.md](docs/AUTH.md).

## What this is

Agora is a Slack-like chat app where **people and AI agents share rooms**.
One Rust core, three clients:

| Path | What it is |
| --- | --- |
| `crates/agora-core` | The embeddable heart: SQLite store, message hub, HTTP+WS API (axum), auth, outbound connections. |
| `crates/agora-desktop` | Tauri v2 macOS/Linux shell. **Embedded mode** runs `agora-core` in-process and serves the *bundled* web UI build; **remote mode** is a thin webview onto a hosted `agora-server`. |
| `crates/agora-server` | The same core, headless, for a VPS / Railway. |
| `packages/core` | `@agora/core` — shared TypeScript client core: API client + types, TanStack Query hooks, the WS event reducer, zustand stores, mdlite/format/unread/emoji helpers. Consumed by `web/` and `mobile/`. |
| `web/` | The web UI: React (Vite + TS), incl. voice notes, speak-aloud, and live voice. `npm run build` emits `web/dist/` (gitignored — never committed), which the server serves (`--ui-dir`), the Docker image bakes in, and the desktop bundle copies. `web/public/` carries the root assets incl. `connect.html` (the desktop server picker) and the vendored `mermaid.min.js`. |
| `mobile/` | React Native (Expo) iOS/Android app — a pure client of a hosted `agora-server`. Consumes `@agora/core` via a `file:../packages/core` dependency but is NOT an npm-workspace member (its `npm ci` stays standalone; `metro.config.js` pins React/query/zustand to mobile's copies to avoid the dual-instance hazard). |
| `bridges/` | Dial-in CLI bridge clients for the agent WebSocket protocol. |
| `plugins/` | Native plugins installed into another agent host, speaking the same protocol: `hermes` (Python, copied into `~/.hermes/plugins/agora/`) and `openclaw` (a TypeScript OpenClaw channel plugin with its own `package.json` — not an npm-workspace member). |

Agora is **multi-user**: real accounts (`users` table) with instance roles
(admin/member), per-group roles, email/link invites, and Google/Apple
sign-in. The `admin_key` in `config.json` is the *operator* credential, not
a user account.

## Worktrees

All feature and bug-fix changes happen in a dedicated worktree so concurrent
sessions do not disturb the main checkout. Create one from the main checkout
with `scripts/worktree.sh new <branch>`; worktrees live under
`.worktrees/<branch-slug>`. The main checkout stays on `main` and is reserved
for fetching, pulling, worktree creation, and cleanup.

Before the first edit in a session, run both of these commands:

```bash
git rev-parse --show-toplevel
git branch --show-current
```

Confirm that both identify the assigned worktree and branch. If either is
wrong, stop and ask; never silently relocate or switch the checkout. One
branch belongs to a worktree for its whole lifetime. In a shared worktree,
never run `git switch`, `git checkout <branch>`, `git stash`, or
`git reset --hard`; create another worktree when another branch is needed.

Each generated `.worktree-env` assigns isolated server, Vite, Storybook, and
Metro ports, a data directory, and a per-worktree Cargo target. Shell state
does not carry between agent commands, so prefix commands explicitly:

```bash
source .worktree-env && cargo run -p agora-server -- --data-dir "$AGORA_DATA_DIR" --ui-dir web/dist
source .worktree-env && npm run dev -w web -- --port "$AGORA_WEB_PORT"
source .worktree-env && npm run storybook -w web -- -p "$AGORA_STORYBOOK_PORT"
source .worktree-env && npx expo start --port "$AGORA_METRO_PORT"
source .worktree-env && node web/e2e/parity.mjs /
```

`AGORA_BASE` makes both `web/e2e/parity.mjs` and `web/e2e/artifacts.mjs`
target the worktree's server port.

Only one collaborator should own port-bound processes in a shared worktree;
others reuse those processes. Gitignored per-tool skill directories that do
not travel with a new checkout are linked back to the main checkout, without
sharing broader per-session state. Root dependencies are installed only when
requested with `--install-deps`; mobile dependencies and generated native
projects remain opt-in. Without `--install-deps`, Node resolution falls back
to the main checkout's hoisted `node_modules`; use `--install-deps` whenever a
branch changes `package.json` or `package-lock.json`.

Use `scripts/worktree.sh list` to inspect worktrees and
`scripts/worktree.sh rm <branch-or-path>` after the work is merged. Removal
refuses dirty/unregistered worktrees and the main checkout; optional branch
deletion uses merged-only `git branch -d`. Never run `git clean -xdf` at the
repository root while worktrees exist: it deletes the nested directories and
leaves stale Git metadata (recover with `git worktree prune`). Only remove a
worktree you created or were explicitly asked to clean up.

## Setup, run, test

```bash
# Rust (whole workspace: core + server + desktop shell)
cargo test --workspace          # all tests, offline, no keys needed
cargo check --workspace

# headless server
# build the web UI first (npm ci && npm run build); --ui-dir defaults to web/dist
cargo run -p agora-server -- --data-dir /tmp/agora-dev --ui-dir web/dist

# mobile (from mobile/) — run the ROOT `npm ci` first: mobile consumes
# @agora/core as raw TS source, whose react types + babel helpers resolve
# from the repo root's node_modules
npm ci
npx tsc --noEmit                # typecheck
npx jest                        # unit tests
npx expo start                  # dev client
npm run storybook               # native component catalog (simulator/device, NOT a browser)
npm run storybook:ios           # open native Storybook on iOS
npm run storybook:android       # open native Storybook on Android
npm run storybook-generate      # refresh .rnstorybook/storybook.requires.ts after adding stories
# Before the first native Storybook run (and after native dependency changes),
# compile its dev client with the same flag so Storybook-only modules are linked:
EXPO_PUBLIC_STORYBOOK_ENABLED=true npx expo run:ios
EXPO_PUBLIC_STORYBOOK_ENABLED=true npx expo run:android

# desktop dev build
cd crates/agora-desktop && npx @tauri-apps/cli@2 dev

# web UI + shared core (root npm workspaces: packages/core + web)
npm ci
npm test                    # @agora/core vitest
npm run typecheck
npm run build               # web/ -> web/dist (gitignored; the served dir)
npm run storybook -w web    # web/desktop component catalog on :6006
npm run build-storybook -w web
npx playwright install chromium # once per machine, for Storybook browser tests
npm run test-storybook -w web  # browser smoke + story play tests
node web/e2e/parity.mjs /   # Playwright regression flows (AGORA_TOKEN=<key>)
```

`web/dist/` is a build output — it is gitignored and never committed; the
Docker image and the desktop bundle build it themselves.
`packages/core/src/lib/emoji.ts` is generated by `scripts/gen-emoji.js` —
edit the DATA there and re-run the generator.

## Versioning and releases (read before bumping anything)

Releases are **triggered by version bumps merged to `main`** — the bump in
a PR *is* the publish intent. CI never bumps versions itself, and merges
that change app code *without* a bump deliberately publish nothing.

**Desktop (macOS and Linux)** — version lives in **two files that must stay in sync**:

- `Cargo.toml` → `[workspace.package] version`
- `crates/agora-desktop/tauri.conf.json` → `version`

Bump both (semver patch unless told otherwise), run `cargo check` so
`Cargo.lock` follows, and commit all three. When the bump lands on `main`,
[.github/workflows/release-desktop.yml](.github/workflows/release-desktop.yml)
builds, signs and notarizes the macOS app, builds Linux Debian/AppImage
packages, and **publishes** a GitHub
release named `vX.Y.Z` (publishing creates the tag; the in-app updater
only sees published releases, so users start updating as soon as the
workflow finishes). Re-runs are idempotent: if the release already
exists the workflow no-ops.

**Mobile** — version lives in **one file**:

- `mobile/app.json` → `expo.version`

Never touch build numbers: `eas.json` uses `appVersionSource: remote` +
`autoIncrement`, so EAS mints them server-side. When the bump lands on
`main`, [.github/workflows/publish-mobile.yml](.github/workflows/publish-mobile.yml)
starts an EAS production iOS build with TestFlight auto-submit (needs the
`EXPO_TOKEN` repo secret).

**When to bump what** — the desktop binary bundles `agora-core` *and* the
web UI build, so:

- Changes under `crates/**`, `web/**`, `packages/**`, or
  `Cargo.toml`/`Cargo.lock` → bump **desktop** (embedded-mode installs only
  get the change via a new binary; hosted servers additionally need a
  redeploy).
- Changes under `mobile/**` that should reach TestFlight → bump **mobile**.
- A PR touching both (e.g. a feature with server + mobile halves) bumps
  both; each workflow fires independently on merge.
- Docs, `bridges/`, `scripts/`, CI-only changes → no bump.

Separate from releases,
[.github/workflows/web-ci.yml](.github/workflows/web-ci.yml) runs on every
PR touching the JS stack: typecheck + `@agora/core` tests, a web build, the
emoji-dataset drift check, mobile's standalone tsc + jest, and the
Playwright regression suite against a freshly built `web/dist`.

Convention: keep the bump in its own `chore(release): bump desktop to X.Y.Z
and mobile to A.B.C` commit at the tip of the feature PR.

## Architecture orientation

[ARCHITECTURE.md](docs/ARCHITECTURE.md) has the system model. At the keyboard, the
files that matter:

- **Store** ([store.rs](crates/agora-core/src/store.rs)): all persistence.
  Synchronous rusqlite behind a `Mutex`, JSON `Value` payloads whose shapes
  the UI depends on — don't rename fields casually. Schema changes go in
  `SCHEMA` (new tables) or `migrate()` (new columns on existing tables);
  both run on every open, so they must be idempotent.
- **Hub** ([hub.rs](crates/agora-core/src/hub.rs)): in-memory fan-out —
  agent sockets, UI websockets, notifications, push. Visibility filtering
  for UI broadcasts lives here.
- **Server** ([server.rs](crates/agora-core/src/server.rs)): axum routes.
  Blocking store/LLM work is wrapped in `spawn_blocking` where it matters.
- **Auth** ([auth.rs](crates/agora-core/src/auth.rs)): HMAC session tokens
  (embed the user's `session_version`; bumping it revokes their sessions),
  Google OAuth state encoding, Apple JWT verification.
- **Mobile state**: react-query for server data (`src/api/queries.ts`),
  zustand for the session (`src/state/session.ts`), keychain for creds.

## Authorization model (enforce on every new endpoint)

The full model — helpers, roles, and the per-user presentation-state invariant
— is in [ARCHITECTURE.md](docs/ARCHITECTURE.md#authorization-model). The rules a new
endpoint must not break:

- Resolve the caller with `require_user` → `AuthedUser`, then gate with
  `require_instance_admin` / `require_group_admin` / `require_member` /
  `require_channel_member` / `require_message_visible` (all in `server.rs`).
  The admin key resolves to an instance admin and must keep working everywhere
  a user session does.
- Search results must stay scoped to the caller (`visible_to`/`user` params on
  the store's search functions).
- **Presentation state is per-user, never shared** — hiding/reordering live in
  `user_prefs` (overlaid via `overlay_prefs`); **never write** the legacy
  global `hidden`/`position` columns on `groups`/`channels` again. Thread
  hides/reads/stars are per-user tables keyed by `username`.

## Conventions

- **Rust**: comments explain *why*, not what. JSON payloads via
  `serde_json::json!`. Errors on API paths are `ApiError` with a helpful
  message — handlers degrade gracefully, they don't panic.
- **Tests are offline.** Store tests use `Store::open_in_memory()`; server
  tests use the `test_state()` helper and call handlers directly (mint
  sessions with `session_headers`). Never hit a real network/API in tests.
  Mirror new behavior in the matching `#[cfg(test)]` module, and in
  `mobile/tests/` for mobile logic.
- **Web UI (`web/`)**: React + TS on `@agora/core` (react-query hooks + the
  WS reducer); UI state in small zustand stores persisted to localStorage;
  styling in `web/src/styles.css` (one flat stylesheet, class-based). Keep
  `web/e2e/parity.mjs` green — it's the regression contract CI runs.
- **Shared UI fixtures**: framework-free Storybook/test fixtures intentionally
  use the `@agora/core/testing/fixtures` testing-only subpath; production code
  continues to import from the package barrel.
- **Mobile**: follow the existing screen patterns — react-query hooks and
  the WS reducer come from `@agora/core` (the client is provided by
  `ApiProvider` in `app/(app)/_layout.tsx`); mobile-only pieces (voice
  upload, notifications, session/secure-store) stay under `mobile/src`.
  Admin-only UI gates on `instanceAdmin` from the session store, `toastErr`
  for mutation failures. The app entry is `mobile/index.js`, not
  `expo-router/entry` directly: it picks the router or the on-device Storybook
  root off `EXPO_PUBLIC_STORYBOOK_ENABLED` (the prefix matters — only
  `EXPO_PUBLIC_*` is inlined into the bundle, and the literal is what lets
  Metro drop Storybook from production builds). `metro.config.js` reads the
  same variable.
- **No new heavy deps** without good reason, in any of the three stacks.
- **Secrets** (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, OAuth client secret)
  live in the process env or `config.json` — never hardcode, never log.

## Gotchas / invariants

- **Every request is authenticated.** New routes take
  `Query<HashMap<String,String>>` + `HeaderMap` and start with a
  `require_*` call; the token arrives as `Authorization: Bearer` or
  `?token=`.
  `/agent/files/{file_id}` is deliberately narrower: pairing credentials are
  accepted through `Authorization: Bearer` only, never the query string.
- **The store's JSON shapes are the API contract** for web + mobile; add
  fields freely, rename/remove only with all three clients updated.
- **Sessions**: disabling a user must `bump_session_version`; deleting an
  account deletes the row (which kills its sessions). Sign-in admission is
  exactly: existing user → email invite → valid invite link → config
  allowlist; everything else is `no_access`.
- **Invite links are single-use**: consume via `use_invite_link` (atomic
  UPDATE guard) *before* creating the account.
- **Desktop embedded vs remote**: don't assume the webview talks to
  localhost — remote mode points at any hosted server, so shell features
  (notifications, updater) must work against both.
- **Updater discipline**: never ship two releases with the same version —
  the release workflow's gate assumes version == release identity.
- **Keep the assigned worktree clean**; it may be shared by more than one
  session. Check `git status` before staging and stage specific files, never
  `-A`.

## Git / PR conventions

- Conventional Commits with a scope: `feat(multi-user): …`, `fix(ui): …`,
  `chore(release): …`, `ci: …`.
- **Only commit when asked.** Don't commit or push proactively.
- Do not change branches in an existing feature worktree; create a new
  worktree for a different branch.
- `main` is protected — land changes via PR. Remember the release
  implication: merging a PR that bumps a version *publishes* (ships the
  desktop release / starts the TestFlight build), so leave bumps out of
  PRs that aren't meant to ship.
