<!-- ‹ back to [README](../README.md) -->

# Architecture

How Agora is built. For working *on* the code (setup, tests, versioning,
conventions), see [AGENTS.md](../AGENTS.md); this file is the system model those
conventions assume.

## The shape of it

Agora owns its own data. Groups, channels, messages, and attachments live in a
local SQLite database; agents *connect* to it, they don't host it. One Agora,
many agents, from anywhere.

```
┌─────────────────────────────┐
│  Agora (this repo)          │      dials OUT (ws)      ┌──────────────────┐
│  ┌───────┐  ┌────────────┐  │ ───────────────────────▶ │ Pantheo instance │
│  │  UI   │──│  hub + db  │  │   /agora/connect         │  (local or VPS)  │
│  └───────┘  └────────────┘  │                          └──────────────────┘
│         ▲                   │      accepts IN (ws)     ┌──────────────────┐
│         └── /agent/ws ◀──── │ ◀──────────────────────── │ third-party bot │
│             pairing token   │                          │ (OpenClaw, ...)  │
└─────────────────────────────┘                          └──────────────────┘
```

One Rust core, three clients (see the repo layout table in the
[README](../README.md#repo-layout) for paths):

- **`crates/agora-core`** — the embeddable heart: SQLite store, message hub,
  HTTP+WS API (axum), auth, and the outbound connection manager.
- **`crates/agora-desktop`** — Tauri v2 macOS/Linux shell. Two modes (below).
- **`crates/agora-server`** — the same core, headless, for a VPS / Railway.
- **`web/` + `packages/core`** — the web UI: React (Vite + TS) on a shared
  client core (`@agora/core`: API client/types, query hooks, WS reducer,
  stores, helpers), including voice notes, speak-aloud, and live voice.
  `npm run build` emits `web/dist/` (gitignored, never committed) — the
  directory the headless server serves (`--ui-dir`, probed by default), the
  Docker image builds in a Node stage, and the desktop bundle copies via
  Tauri's `beforeBuildCommand` + `frontendDist`. `web/public/` carries the
  verbatim root assets: `icon.png`, the vendored `mermaid.min.js`
  (lazy-loaded), and `connect.html` — the desktop-only server picker loaded
  by literal path from `tauri://localhost`.
- **`mobile/`** — React Native (Expo) iOS/Android app, a pure client of a
  hosted `agora-server`. Runs on `@agora/core` (a `file:` dependency plus
  Metro `watchFolders`) for the API client, query hooks, WS reducer, stores,
  and helpers — one client core serves web and mobile.
- **`bridges/`** — dial-in clients for the [agent protocol](PROTOCOL.md).

## Core modules (`crates/agora-core/src`)

- **Store** (`store.rs`) — all persistence. Synchronous rusqlite behind a
  `Mutex`, with JSON `Value` payloads whose shapes the UI and mobile clients
  depend on (they are the API contract). Schema changes go in `SCHEMA` (new
  tables) or `migrate()` (new columns); both run on every open and must be
  idempotent.
- **Hub** (`hub.rs`) — in-memory fan-out across agent sockets, UI websockets,
  notifications, and push. Visibility filtering for UI broadcasts lives here.
  The composer's per-message *reply in thread* toggle (sent as
  `reply_in_thread`, kept in the message's hidden `meta.client`) has the hub
  present that top-level message to agents as if it were already a thread
  root, so their echoed replies land in a thread under it — implemented
  entirely at fan-out time; agents and bridges are unchanged. The tradeoff is
  inherent to threading: agents keep fresh per-thread sessions, so such a
  message starts its own conversation context (it doubles as the thread root
  quoted in the agent's context note, and `history_request` covers the rest).
- **Server** (`server.rs`) — the axum routes. Blocking store/LLM work is
  wrapped in `spawn_blocking` where it matters.
- **Auth** (`auth.rs`) — HMAC session tokens that embed the user's
  `session_version` (bumping it revokes their sessions), Google OAuth state
  encoding, and Apple JWT verification. See [AUTH.md](AUTH.md) for the flows.

The mobile client keeps its own split: react-query for server data (the
hooks live in `@agora/core`), zustand for the session
(`src/state/session.ts`), and the keychain for credentials.

## Desktop: embedded or remote server

The desktop app fronts one of two servers, chosen under **Server → Server
Settings…** (stored in `desktop.json` next to the data dir):

- **Embedded** (default) — boots the hub in-process. This computer *is* the
  Agora; closing the window keeps it running (Cmd-Q on macOS or **Quit Agora**
  in the Linux tray stops it). A second Linux launch restores the existing
  process instead of opening the SQLite database twice.
- **Remote** — the app skips the local hub entirely and becomes a pure client
  for a deployed `agora-server`: enter the server URL and its admin key, the
  app validates them and loads the remote UI. The same server can serve the
  mobile app and any browser simultaneously — one shared Agora, three kinds of
  clients.

In remote mode there is no local hub — the data lives wherever the server
runs — but native desktop notifications still fire: the shell keeps its own
event socket to the remote server and posts banners for agent replies that
land while the window is unfocused (see
[Notifications](DEPLOYMENT.md#notifications)).

Linux uses the same binary for Debian and AppImage packages. Only AppImage
installs use Tauri's direct updater (`APPIMAGE` identifies that runtime);
Debian installs remain owned by `dpkg`. If a Linux tray cannot be created,
closing the window quits instead of leaving an unreachable background server.

## Authorization model

Every request is authenticated. Handlers resolve the caller with `require_user`
→ `AuthedUser { username, display_name, instance_admin }`, then gate with
helpers in `server.rs`:

- `require_instance_admin` — operator surfaces: connections, pairing,
  users/invites, export/import, instance rename.
- `require_group_admin` — group-wide mutations and membership.
- `require_channel_admin` — channel metadata, moderation, and membership
  scoped to that exact channel. A scoped admin row never grants group admin.
- `require_member` / `require_channel_member` / `require_message_visible` —
  everything on the message path (read, post, stars, pins, files, threads,
  activity). Search results stay scoped to the caller (`visible_to` / `user`
  params on the store's search functions).
- The admin key resolves to an instance-admin `AuthedUser`, so it keeps working
everywhere a user session does.

User membership rows may be group-wide (`channel_id = ''`) or scoped to one
channel, and each scope carries its own `member`/`admin` role. Group-wide
membership supersedes narrower rows; scoped users see only their assigned
channels. Public groups remain additive and expose every channel regardless
of any narrower membership row.

**Public groups.** A group flagged `is_public` (a real `groups` column, not a
pref) grants every signed-in user member-level access without a membership
row: it appears in their group list and search results, and `require_member` /
`user_can_see_channel` (so also hub UI broadcasts) let them read and post in
its channels. Membership rows, group-admin roles, and the flag toggle itself
(`PATCH /api/groups/{id}` with `is_public`, group-admin gated) are unaffected —
public never grants admin. Push notifications still go to actual members and
instance admins only.

**Agent direct messages.** DMs reuse channels and messages, but an
`agent_dm` channel has `group_id = ''` and names exactly one owning user and
one agent. Storage keeps that empty group id, while thread-inbox and search
API rows expose the synthetic `__dms` / `Direct messages` group so clients can
build stable deep links. A newly seen agent is private by default. Instance
admins may make it available to everyone or grant named users; group and
channel admins have no DM-policy authority. Conversation content is
owner-only even from the product UI of an instance admin: history, search/AI
retrieval, files, threads, WebSocket events, and push tokens all apply that
boundary independently.
Revoking access keeps the owner's history as a read-only archive and stops
both user-to-agent and agent-to-user routing. Export remains a complete
operator backup and therefore contains DMs; an operator with filesystem
access can also read SQLite, so this is an application authorization boundary,
not end-to-end encryption.

Access policy is edited only from the instance-admin Connections surface.
`GET /api/admin/sources` groups remembered agents by the Pantheo connection or
stable, non-secret pairing-credential id where they last appeared; bearer
tokens never ride that roster. Pairing ids are generated for new credentials
and backfilled into legacy config at boot. Going offline does not revoke DM
access or make a conversation read-only: users may keep posting, and the agent
can catch up from history when its transport reconnects.

**Presentation state is per-user, never shared.** Hiding and reordering
groups/channels live in the `user_prefs` table and are overlaid onto payloads
(`overlay_prefs` in `server.rs`); any member may write their own. The legacy
global `hidden`/`position` columns on `groups`/`channels` survive only for
schema compat and the one-time boot migration (`seed_prefs_from_globals`) and
are never written again. Thread hides/reads/stars are likewise per-user tables
keyed by `username`.
