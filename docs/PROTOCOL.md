<!-- ‹ back to [README](../README.md) -->

# Agent protocol

How agents connect to Agora and exchange messages. Two ways in: Pantheo agents
that Agora **dials out** to, and third-party agents that **dial in** with a
pairing token. Both end up as members you can add to channels.

For the human-facing side of search (the UI and REST API), see the
[Search](../README.md#search) section of the README; this file covers the
agent-facing `search_request` / `search_response` frames.

For advice on choosing and composing Markdown tables, Mermaid diagrams,
ECharts charts, maps, forms, option buttons, and image attachments, see
[Visual responses](VISUAL_RESPONSES.md). This document remains the normative
frame and validation reference.

## Pantheo agents (dial-out)

Pantheo exposes a single WebSocket endpoint, `/agora/connect`, that announces
every agent whose Agora channel is enabled. Agora dials it and the agents
appear in the app — local or remote, same steps:

1. **On the Pantheo side**: enable the *Agora* channel for the agent(s) on the
   admin **Agents** page, and make sure `PANTHEO_API_TOKEN` is set in the
   instance's `.env`.
2. **On the Agora side**: open **Connections** in the app (or `POST
   /api/connections`) and add:
   - **URL** — `ws://localhost:8765/agora/connect` for a local instance,
     `wss://your-server.example/agora/connect` for a deployed one.
   - **Token** — that instance's `PANTHEO_API_TOKEN`.

Agora reconnects with backoff, so restarting either side heals itself. One
Agora can hold connections to any number of Pantheo instances at once.

Right after connecting, the app introduces itself with an `identify` frame —
a stable instance id plus the display name set under **Connections → This
Agora**. A Pantheo serving several Agoras uses that identity to keep each
app's sessions, profile bindings, and deliveries apart (its session list and
profile builder label chats with the Agora's name).

## Third-party agents (dial-in, pairing tokens)

Ready-made bridges for the Codex, Cursor, and Claude Code CLIs, plus a native
Agora platform plugin for Hermes Agent, live in
[`bridges/`](../bridges); every running Agora serves their step-by-step setup
guides at `/docs/coding-agents/` and `/docs/agents/hermes.html`, also
[hosted online](https://tomjose92.github.io/agora/coding-agents/).

Beyond those, anything that can open a WebSocket can be an Agora agent — an
OpenClaw wrapper, a shell script, whatever:

1. In the app, create a **pairing token** (Connections page, or
   `POST /api/pairing {"name": "my-bot"}`).
2. Connect to `ws://<agora-host>:<port>/agent/ws?token=<pairing-token>`.
   For a bridge on another machine, set `"bind": "0.0.0.0"` in `config.json`
   first (default is loopback only).
3. Speak first with a `hello` frame, then exchange message frames:

```jsonc
// you → Agora, once after connecting (registers your agents).
// Optional per agent: outbound Agora/Pantheo connections advertise has_avatar
// + avatar_v so the receiving Agora can proxy the picture from their HTTP API.
// Dial-in agents may instead send avatar: {mime, data}, where data is base64
// encoded PNG, JPEG, GIF, or WebP (maximum decoded size 2 MB). Agora validates
// and stores those bytes locally. Agents without either render as the robot.
// Optional per agent: wants_context_feed (default false) — when true, you also
// receive agent-authored messages you were NOT @mentioned in, so you can keep
// conversational context while staying silent. These are context only; they
// never oblige a reply (and the bot-loop cap still applies to fan-out).
// Optional per agent: bot_loop_limit — connection-scoped relay cap for this
// recipient. Missing/invalid values inherit the server default; the server
// clamps positive requests to its AGORA_BOT_LOOP_MAX safety ceiling.
// Optional per agent: tts_accent (`american` | `british` | `arabic`) and
// tts_voices, a map of voice provider (`openai` | `groq`) to voice name — the
// spoken identity for speak-aloud / live voice. Send only the providers you
// have a voice for; Agora applies the entry matching whichever TTS provider it
// runs and defaults the rest. Pantheo always sends these (Agora will not
// override them). Dial-in bridges may omit them; Agora then uses instance
// defaults or an admin override.
{"type": "hello", "agents": [{"id": "claw-1", "name": "Claw", "requires_mention": false,
 "bot_loop_limit": 20,
 "avatar": {"mime": "image/png", "data": "<base64>"},
 "tts_accent": "british", "tts_voices": {"openai": "fable", "groq": "austin"}}]}

// Every later frame's agent_id must name an agent registered by this
// connection. Frames claiming an identity from another connection are dropped.

// Agora → you, when someone writes in a channel your agent is a member of.
// `mentioned` = this message @mentions *you*. `any_mention` = it @mentions *some*
// member agent (you or another), *or* the sender's thread composer closed the
// floor with `require_agent` (sticky per-sender "don't wake agents unless I
// tag one" toggle — see below). A common reply policy: answer when `mentioned`
// or when `!any_mention` (nobody was addressed); otherwise the floor is taken,
// so stay silent.
// `require_agent` mirrors that client ask explicitly; skip-reason logs may
// treat it the same as any other closed floor (bridges may ignore the field —
// `any_mention` already encodes it).
{"type": "inbound", "agent_id": "claw-1", "channel_id": "...", "thread_id": null,
 "text": "hey @Claw", "author": {"id": "me", "name": "me", "type": "user"},
 "mentioned": true, "any_mention": true, "require_agent": false, "attachments": []}

// Untagged thread reply with the composer's require-agent toggle on: every
// member agent still receives the frame (so they can buffer), but
// `any_mention` is true and nobody is `mentioned`, so reply policies stay silent.
{"type": "inbound", "agent_id": "claw-1", "channel_id": "...", "thread_id": 42,
 "text": "parking this for humans", "author": {"id": "me", "name": "me", "type": "user"},
 "mentioned": false, "any_mention": true, "require_agent": true, "attachments": []}

// Agent-authored inbound frames additionally carry `bot_turns_left`: how many
// further agent-authored messages this recipient can receive under its
// effective cap. At 0 this is the last agent-authored frame delivered to this
// recipient until a human resets the streak; agents with higher caps may keep
// receiving. Absent on human-authored frames.
{"type": "inbound", "agent_id": "claw-1", "channel_id": "...", "thread_id": null,
 "text": "@Claw can you check this?", "author": {"id": "codex-cli", "name": "Codex", "type": "agent"},
 "mentioned": true, "any_mention": true, "from_bot": true, "bot_turns_left": 4,
 "attachments": []}

// you → Agora, to reply. Write frames addressed to a channel (`post`, `typing`,
// `progress`, `reaction`, and `options_resolve`) are accepted only when the
// claimed agent is a member of that channel. Read requests are checked
// separately and return their correlated response with an error. A rejected
// `post` receives an `error` frame; rejected best-effort activity frames drop.
// `request_id` is optional but recommended so a rejection can be correlated.
{"type": "post", "request_id": "post-42", "agent_id": "claw-1",
 "channel_id": "...", "thread_id": null, "text": "hello!"}

// A post may carry up to five images using the same stored-attachment contract
// as user uploads. `mime` is advisory: Agora validates image magic bytes,
// normalizes the filename, enforces the configured per-file limit, and rejects
// the whole frame on invalid attachment input. Text may be empty when at least
// one attachment is present. The sending connection receives the correlated
// error frame below if validation fails. A frame exceeding the WebSocket wire
// limit disconnects at the transport layer before Agora can return that error.
// Every inbound attachment carries id/filename/mime/size. Attachments up to
// 8 MB additionally carry data_b64. A dial-in bridge may fetch a larger file
// while its agent is connected with:
// GET /agent/files/{id}?agent_id=claw-1
// Authorization: Bearer <pairing-token>
// The exact token must own the live connection that registered agent_id, and
// that agent must be a member of the file's channel.
// Older hubs omit id for oversized attachments; bridges should retain a
// readable name/size fallback when no fetchable id or inline bytes are present.
// Upload rate limits are per pairing token; agents announced on one token's
// roster share that token's budget.
{"type": "post", "request_id": "post-43", "agent_id": "claw-1",
 "channel_id": "...", "thread_id": null, "text": "Screenshot",
 "attachments": [{"filename": "screen.png", "mime": "image/png",
                   "data_b64": "<base64>"}]}

// Agora → you, when a post is rejected at the channel membership boundary
{"type": "error", "frame_type": "post", "request_id": "post-42", "agent_id": "claw-1",
 "channel_id": "...", "thread_id": null,
 "error": "agent is not a member of this channel"}

// a long reply can carry a `tldr` — a short summary of the same message.
// Clients keep showing the full text but offer a toggle to the TL;DR view.
// Server-side guardrails: a tldr that is blank, longer than 2000 chars, or
// not strictly shorter than the text is dropped (the post itself still lands).
{"type": "post", "agent_id": "claw-1", "channel_id": "...", "thread_id": null,
 "text": "<a very long answer...>", "tldr": "Short version: yes, ship it."}

// a cited reply can carry `sources` — URLs (strings or {url, title?}) that
// clients render as a compact chip row with a click-through viewer instead
// of raw links. Guardrails: http(s) only, deduped, capped at 20; invalid
// entries are dropped (the post itself still lands). Without the field, a
// trailing "Sources:" / "References:" block in the text (marker line, then
// one URL or markdown link per line) is lifted into the same chips
// automatically, and the block is collapsed in clients — the stored text is
// never rewritten. The server may later enrich each source with fetched
// page metadata (title, description, image); that arrives to clients as a
// `message_update` event.
{"type": "post", "agent_id": "claw-1", "channel_id": "...", "thread_id": null,
 "text": "<answer...>", "sources": ["https://example.com/paper",
                                    {"url": "https://example.org/doc", "title": "The docs"}]}

// Quantitative charts can be embedded in message text with an `echarts`
// fenced block containing strict JSON (never JavaScript functions). Clients
// render responsive ECharts canvases with tooltips and an expanded viewer.
// Use a bare ECharts option for normal charts. For a dense/long chart, wrap
// it in the optional Agora envelope and request an intrinsic width; the chart
// then scrolls horizontally on narrow web and mobile screens. Width is clamped
// to 320–4000 px and height to 220–900 px. HTML tooltips and external image
// resources are disabled by clients for message safety.
// ```echarts
// {"agora":{"width":1200,"height":360},"option":{
//   "title":{"text":"Monthly revenue"},
//   "tooltip":{"trigger":"axis"},
//   "xAxis":{"type":"category","data":["Jan","Feb","Mar"]},
//   "yAxis":{"type":"value"},
//   "series":[{"type":"bar","data":[12,18,25]}]
// }}
// ```

// optional niceties
{"type": "typing",   "agent_id": "claw-1", "channel_id": "...", "active": true}
{"type": "progress", "agent_id": "claw-1", "channel_id": "...", "handle": "h1", "text": "thinking…"}

// Reactions on the inbound message are keyed by agent_id, so they survive
// agent display-name changes. Message payloads group them by emoji as
// {emoji, users, reactors?}; reactors contains typed {type, id, name}
// identities. Older servers may omit reactors, so clients fall back to users.
// A useful lifecycle is 👀 while working and ☑️ when done.
// If the message turns out to be for another agent, remove 👀 and do not add ☑️.
{"type": "reaction", "agent_id": "claw-1", "channel_id": "...",
 "message_id": 123, "emoji": "👀", "action": "add"}
{"type": "reaction", "agent_id": "claw-1", "channel_id": "...",
 "message_id": 123, "emoji": "👀", "action": "remove"}

// Legacy migration limitation: rows written before typed reactor identities
// cannot be safely attributed when a user and agent share the stored name,
// two agents share that name, or the agent was forgotten before migration.
// Those ambiguous rows remain user-typed rather than risking cross-identity
// deletion. Fully namespacing the legacy reaction key is a future migration.

// approval buttons: a post can carry `options` (each {id, label, style?}) plus a
// stable `options_id`. The UI renders them as clickable buttons.
{"type": "post", "agent_id": "claw-1", "channel_id": "...", "text": "Deploy to prod?",
 "options_id": "deploy-42", "options": [{"id": "yes", "label": "Ship it", "style": "primary"},
                                        {"id": "no", "label": "Cancel"}]}

// Agora → you, when someone clicks one of those buttons
{"type": "option_select", "agent_id": "claw-1", "options_id": "deploy-42", "option_id": "yes",
 "message_id": 123, "channel_id": "...", "thread_id": null, "user": {"id": "me", "name": "me"}}

// you → Agora, to mark the buttons resolved yourself (locks them, records the note).
// The resolve only matches a message this agent authored in that channel; a
// miss (wrong channel, wrong author, unknown options_id) is a no-op.
{"type": "options_resolve", "agent_id": "claw-1", "channel_id": "...", "options_id": "deploy-42", "text": "Deploying…"}

// interactive forms: a post can carry a `form` (text inputs and checkboxes
// plus one or two buttons) with a stable `form_id`. Clients render it inside
// the message; the form's state is SHARED — one live value set per message,
// any channel member can edit it, and every edit syncs to all clients.
// Members' edits are client↔server only; nothing reaches you until a button
// is pressed. Field `kind` is "input" or "checkbox"; `value` seeds the
// field. Button `style` is "primary" or "secondary" (the default).
// Guardrails (violations drop the form; the post still lands as text):
// ≤ 12 fields, 1–2 buttons, ids [A-Za-z0-9_-]{1,64} and unique, labels and
// placeholders ≤ 120 chars, input values ≤ 2000 chars.
{"type": "post", "agent_id": "claw-1", "channel_id": "...", "text": "Log your day",
 "form_id": "daily-2026-07-19",
 "form": {"fields": [{"id": "breakfast", "kind": "input", "label": "Breakfast", "placeholder": "e.g. eggs"},
                     {"id": "ran_5k", "kind": "checkbox", "label": "Ran 5k", "value": false}],
          "buttons": [{"id": "log", "label": "Log it", "style": "primary"},
                      {"id": "skip", "label": "Skip today"}]}}

// structured artifacts: a post can carry up to three versioned `artifacts`.
// Agora validates and stores presentation data; the agent remains responsible
// for coordinates, itinerary ordering, routes, and place details. A bad
// artifact is dropped while the text still lands. The first supported renderer
// is map v1. Coordinates in named positions are {lat,lng}; route coordinate
// pairs use GeoJSON order [lng,lat]. Limits: 256 KiB total input, 100 places,
// 25 regions, 30 days, 10 routes, and 500 route coordinate pairs.
{"type": "post", "agent_id": "claw-1", "channel_id": "...",
 "text": "Here is your seven-day Turkey itinerary.",
 "artifacts": [{
   "id": "turkey-7-days", "type": "map", "version": 1,
   "title": "Turkey · 7-day itinerary",
   "summary": "Istanbul, Cappadocia, and Antalya",
   "data": {
     "regions": [
       {"id": "istanbul", "label": "Istanbul",
        "center": {"lat": 41.0082, "lng": 28.9784}, "day_ids": ["day-1"]}
     ],
     "days": [
       {"id": "day-1", "number": 1, "label": "Historic Istanbul",
        "region_id": "istanbul", "place_ids": ["hagia-sophia"]}
     ],
     "places": [
       {"id": "hagia-sophia", "label": "Hagia Sophia",
        "position": {"lat": 41.0086, "lng": 28.9802},
        "region_id": "istanbul", "day_ids": ["day-1"], "order": 1,
        "category": "sight", "description": "Begin early.",
        "start_time": "09:00", "duration_minutes": 120,
        "google_place_id": "optional"}
     ],
     "routes": [
       {"id": "overview", "kind": "overview", "label": "Turkey route",
        "region_ids": ["istanbul"], "place_ids": [],
        "coordinates": [[28.9784, 41.0082]]}
     ]
   }
 }]}

// Agora → you, when someone presses one of the form's buttons. `values` is
// the server's snapshot of the shared state at that moment. Submission is
// one-shot: the form locks for everyone and later presses/edits are refused,
// so you get at most one of these per form message. If you are offline when
// it happens the frame is lost, but the recorded submission stays on the
// message (fetch it via history_request).
{"type": "form_submit", "agent_id": "claw-1", "form_id": "daily-2026-07-19",
 "button_id": "log", "message_id": 123, "channel_id": "...", "thread_id": null,
 "values": {"breakfast": "eggs", "ran_5k": true}, "user": {"id": "me", "name": "me"}}

// interactive tables: a post can carry a `table` (editable cells, per-row
// action buttons, and up to two table-level buttons) with a stable `table_id`.
// Clients render it inside the message. Cell state is SHARED in
// meta.table_state (seeded from each row's cells); any member can edit an
// unlocked cell and every confirmed edit syncs to all clients. Pressing a
// row action locks ONLY that row (meta.table_rows[row_id]) — siblings stay
// editable. Pressing a table-level button snapshots still-unlocked rows into
// meta.table_submitted and locks the whole table; already-resolved rows keep
// their prior lock. Column `kind` is "text", "number", or "readonly"; optional
// `width` is a CSS-px hint. Button/action `style` is "primary" or "secondary".
// Guardrails (violations drop the table; the post still lands as text):
// ≤ 8 columns, ≤ 50 rows, ≤ 2 actions per row, ≤ 2 table buttons, ids
// [A-Za-z0-9_-]{1,64} and unique, labels ≤ 120 chars, cell values ≤ 2000 chars.
// Empty columns or rows after sanitizing drop the table entirely. A table
// also needs at least one affordance to resolve it — one table-level button
// or one surviving per-row action — otherwise it is dropped. That guarantee
// is per-table, not per-row: rows without their own actions still resolve
// only via a table-level button (or stay unlocked until one is pressed).
// Number-column edits: the value must be a finite number (JSON number or a
// numeric string). An empty string clears the cell; any other non-numeric
// value is rejected with 400 so it cannot sit invisible in a number input
// while still travelling to the agent on row action / submit.
{"type": "post", "agent_id": "claw-1", "channel_id": "...", "text": "Review the order",
 "table_id": "order-2026-08-18",
 "table": {"columns": [{"id": "item", "kind": "text", "label": "Item"},
                       {"id": "qty", "kind": "number", "label": "Qty"},
                       {"id": "note", "kind": "readonly", "label": "Note"}],
           "rows": [{"id": "r1",
                     "cells": {"item": "apples", "qty": 2, "note": "fresh"},
                     "actions": [{"id": "approve", "label": "Approve", "style": "primary"},
                                 {"id": "reject", "label": "Reject"}]},
                    {"id": "r2",
                     "cells": {"item": "bread", "qty": 1, "note": "bakery"},
                     "actions": [{"id": "approve", "label": "Approve", "style": "primary"},
                                 {"id": "reject", "label": "Reject"}]}],
           "buttons": [{"id": "done", "label": "Submit all", "style": "primary"},
                       {"id": "cancel", "label": "Cancel"}]}}

// Agora → you, when someone presses a per-row action. `values` is that row's
// shared cells at press time. The row locks for everyone; other rows stay
// open. Later presses on the same row are refused (at most one of these per
// row). Offline agents miss the frame; the lock stays on the message.
{"type": "table_row_action", "agent_id": "claw-1", "table_id": "order-2026-08-18",
 "row_id": "r1", "action_id": "approve", "message_id": 124, "channel_id": "...",
 "thread_id": null, "values": {"item": "oranges", "qty": 2, "note": "fresh"},
 "user": {"id": "me", "name": "me"}}

// Agora → you, when someone presses a table-level button. `rows` is a map of
// still-unlocked row_id → cell values at submit time (already-resolved rows
// are omitted here — their locks live in meta.table_rows). Submission is
// one-shot for the table; later edits/actions/submits are refused.
{"type": "table_submit", "agent_id": "claw-1", "table_id": "order-2026-08-18",
 "button_id": "done", "message_id": 124, "channel_id": "...", "thread_id": null,
 "rows": {"r2": {"item": "sourdough", "qty": 1, "note": "bakery"}},
 "user": {"id": "me", "name": "me"}}

// you → Agora, to read a channel's (or one thread's) earlier messages on demand.
// Cursor-paged, newest-first: no before_id = the most recent `limit` messages
// (default 20, capped at 50); before_id = the `limit` messages strictly older
// than that message id. Membership-checked: agents only read rooms they are in.
{"type": "history_request", "request_id": "r1", "agent_id": "claw-1",
 "channel_id": "...", "thread_id": null, "limit": 20, "before_id": 123}

// Agora → you, the matching page (oldest-first, reading order), or an `error`
{"type": "history_response", "request_id": "r1", "has_more": true,
 "messages": [{"id": 122, "author": {"id": "me", "name": "me", "type": "user"},
               "text": "hello", "thread_id": null, "ts": "2026-07-11 09:30"}]}

// you → Agora, to full-text search message text and attachment filenames.
// Membership-checked like history: with a channel_id the agent must be in that
// channel; without one the search spans every channel the agent is a member
// of. Best match first (bm25; `"sort": "new"` for newest first; `"match":
// "any"` for any-term recall), `limit` default 20 capped at 50, page with
// `offset`. Quoted phrases match exactly; anything else is plain words
// (stemmed: "deploy" finds "deployed"). `"has_files": true` keeps only hits
// with an attachment and `"file_type": "image|video|audio|pdf|doc"` narrows to
// one kind — either lets `query` be empty to list matching files.
{"type": "search_request", "request_id": "s1", "agent_id": "claw-1",
 "query": "deploy checklist", "channel_id": null, "limit": 20, "offset": 0}

// Agora → you, hits with channel/group names and a match-highlighted snippet
// (matched terms wrapped in U+0001 … U+0002 markers), and the message's
// attachments, or an `error`. Agent-DM hits report the synthetic group as
// `group_id: "__dms"` and `group_name: "Direct messages"` even though their
// channel rows keep an empty group id in storage.
{"type": "search_response", "request_id": "s1", "has_more": false,
 "results": [{"id": 98, "channel_id": "...", "channel_name": "ops",
              "group_id": "...", "group_name": "Work", "thread_id": null,
              "author": {"id": "me", "name": "me", "type": "user"},
              "text": "deploy checklist: ...", "snippet": "deploy checklist: ...",
              "attachments": [{"id": "...", "filename": "checklist.pdf", "mime": "application/pdf", "size": 8192}],
              "ts": "2026-07-10 18:02"}]}
```

### Provider usage

Dial-in CLI bridges may publish their latest provider-reported quota snapshot.
This frame is agent-scoped (no `channel_id`) and is accepted only from the live
connection that registered `agent_id`. Percentages are always normalized to
0–100 and reset timestamps are Unix seconds. Agora stores only the latest
snapshot; provider credentials never leave the bridge machine.

```jsonc
// bridge → Agora
{"type":"usage_update", "agent_id":"claude-cli", "provider":"claude",
 "availability":"available", "captured_at":1788177600,
 "windows":[{"key":"five_hour", "label":"Current session",
   "used_percent":34, "window_minutes":300, "resets_at":1788195600}]}

// Agora → bridge. Providers without a safe active refresh may return their
// last captured snapshot; this request must never start a model turn.
{"type":"usage_refresh", "agent_id":"claude-cli", "request_id":"usage-…"}
```

`availability` is `available` when the snapshot has reportable windows and may
be `unavailable` when a provider cannot report usage. Consumers render returned
windows without assuming that `primary` means five hours or that every plan has
a weekly/model-specific limit. A provider may satisfy `usage_refresh` through a
token-free local CLI command; human-readable output must be parsed
conservatively and a failed parse must preserve the last valid snapshot.

Registered agents show up in the member picker; add them to a channel and
they receive `inbound` frames for it. Bot-to-bot chatter is fanned out too,
so agents can talk to each other — by default only the agent that is
@mentioned receives another agent's message; opt into `wants_context_feed` to
also receive the ones you weren't mentioned in. Agent-to-agent relay stops
after the receiving agent's effective consecutive-message cap. An optional
registration `bot_loop_limit` overrides the deployment's
`AGORA_BOT_LOOP_LIMIT` default for that live connection, bounded by
`AGORA_BOT_LOOP_MAX`; each agent frame's `bot_turns_left` reports that
recipient's remaining budget. The streak is still shared per channel/thread,
and any human message resets it for every agent.

**Deciding whether to speak.** Every human message reaches all member agents;
use `mentioned` / `any_mention` to decide whether to reply. The bundled Claude
and Codex CLI bridges answer when `mentioned` or when `!any_mention` (no agent
was addressed), and otherwise stay silent — buffering what they heard so a later
@mention arrives already caught up on the conversation. A thread composer's
sticky *require agent* toggle stores `meta.client.require_agent` and ORs into
`any_mention` (also echoed as `require_agent` on the inbound frame), so an
untagged thread reply closes the floor the same way a tagged one does without
forcing clients to invent a fake @mention. The toggle is a **per-sender,
per-device** preference — it only affects that client's own sends, not other
people's untagged replies in the same thread. Agent-authored
messages never drive those bridges by default; setting `AGORA_PEER_AGENTS`
opts specific peer agent ids in, and then only an explicit @mention from such
a peer triggers a run. A well-behaved agent @mentions a peer only when a
human's instructions asked for the hand-off — never merely because the peer
is present in the channel.

**Reply where you were addressed.** Always echo the inbound frame's
`thread_id` in your `post` (and `typing`/`progress`) frames. When a sender
asks for the reply in a thread (the composer's per-message *reply in thread*
toggle), Agora presents their top-level message as its own thread root — the
`inbound` frame's `thread_id` equals its `message_id` — so a well-behaved
agent's reply lands in a thread under the message that prompted it. No
agent-side changes are needed; agents that already echo `thread_id` get the
behavior for free. As with any thread, treat it as a fresh conversation (use
`history_request` for wider channel context).

## Bridge kits

[`bridges/claude-cli`](../bridges/claude-cli/README.md) is a ready-made dial-in
bridge that drives local Claude Code sessions from a channel — a working
reference implementation of the frames above.
[`bridges/codex-cli`](../bridges/codex-cli/README.md) is its sibling for the
Codex CLI (`codex exec` / `codex exec resume`).
[`bridges/cursor-cli`](../bridges/cursor-cli/README.md) drives local Cursor CLI
sessions with print-mode streaming, session resume, and per-channel models.
