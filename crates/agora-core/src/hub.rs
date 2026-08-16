//! The hub: Agora's in-process message bus.
//!
//! A posted message is persisted, broadcast to every connected UI websocket
//! that may see the channel, and fanned out to each member agent's live
//! connection (dial-in bridge or dial-out Pantheo link) as an `inbound`
//! protocol frame. Agent `post` frames come back through the same hub, so
//! every viewer of a channel sees the whole conversation.
//!
//! Ported from Pantheo's `engine/agora/hub.py`; the wire events pushed to UI
//! sockets are shape-identical so the ported web UI works unchanged.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use base64::Engine;
use serde_json::{json, Value};
use tokio::sync::{mpsc::UnboundedSender, Notify};

use crate::store::{slugify, NewAttachment, Store};
use crate::attachments::{safe_filename, sniff_image_mime};

/// Max consecutive agent-authored messages fanned out to other agents in one
/// channel/thread before the hub goes quiet until a human speaks again: the
/// first `BOT_LOOP_LIMIT` messages of a streak are relayed to @mentioned
/// agents; the next one is stored and shown to humans but triggers no agent.
/// Any human message resets the streak.
pub const BOT_LOOP_LIMIT: i64 = 5;

/// How much of a thread's root message is inlined as context when an agent
/// first joins the thread.
const ROOT_CONTEXT_MAX_CHARS: usize = 500;

/// Attachments larger than this are referenced by name only in the inbound
/// frame (no inline bytes) — remote agents may not be able to reach our HTTP.
pub const MAX_INLINE_ATTACHMENT: usize = 8 * 1024 * 1024;
pub const MAX_FILES_PER_AGENT_POST: usize = 5;

/// Page size for an agent `history_request` when it names none, and the hard
/// cap applied regardless of what it asks for — an agent can page back with
/// `before_id`, never pull a whole channel in one frame.
pub const HISTORY_PAGE_DEFAULT: i64 = 20;
pub const HISTORY_PAGE_MAX: i64 = 50;

/// Same idea for an agent `search_request`: default page size and hard cap;
/// agents page with `offset`.
pub const SEARCH_PAGE_DEFAULT: i64 = 20;
pub const SEARCH_PAGE_MAX: i64 = 50;

/// Keep agent-originated reactions bounded by the same practical limit as
/// the REST surface. This protects message payloads even for custom bridges.
const MAX_REACTION_KINDS_PER_MESSAGE: usize = 20;

/// Longest `tldr` accepted on an agent `post` frame; anything longer (or not
/// strictly shorter than the message text) is dropped — the full text always
/// stands on its own.
pub const MAX_TLDR_CHARS: usize = 2_000;

/// Guardrails for agent-supplied interactive forms on a `post` frame. Caps
/// are applied while sanitizing (extra fields/buttons dropped, long labels
/// clipped); a form left without fields or buttons is dropped entirely — the
/// post itself still lands as plain text, mirroring the tldr/sources rules.
pub const MAX_FORM_FIELDS: usize = 12;
pub const MAX_FORM_BUTTONS: usize = 2;
pub const MAX_FORM_LABEL_CHARS: usize = 120;
pub const MAX_FORM_VALUE_CHARS: usize = 2_000;

/// Validate and normalize an agent-supplied form spec into the stored
/// `meta.form` shape: `fields` of kind `input`/`checkbox` (each with an id
/// safe to round-trip, a label, and a typed initial `value`) plus one or two
/// `buttons` whose `style` is normalized to `primary`/`secondary`.
pub fn sanitize_form(form: &Value) -> Option<Value> {
    fn clean_id(v: &Value) -> Option<String> {
        let id = v.as_str()?.trim();
        let ok = !id.is_empty()
            && id.len() <= 64
            && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-');
        ok.then(|| id.to_string())
    }
    fn clip(s: &str, max: usize) -> String {
        s.chars().take(max).collect()
    }
    let mut fields = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for f in form.get("fields")?.as_array()? {
        if fields.len() == MAX_FORM_FIELDS {
            break;
        }
        let Some(id) = clean_id(&f["id"]) else { continue };
        let kind = match f["kind"].as_str() {
            Some(k @ ("input" | "checkbox")) => k,
            _ => continue,
        };
        let label = clip(f["label"].as_str().unwrap_or("").trim(), MAX_FORM_LABEL_CHARS);
        if label.is_empty() || !seen.insert(id.clone()) {
            continue;
        }
        let mut field = json!({"id": id, "kind": kind, "label": label});
        if kind == "input" {
            if let Some(p) = f["placeholder"].as_str() {
                let p = clip(p.trim(), MAX_FORM_LABEL_CHARS);
                if !p.is_empty() {
                    field["placeholder"] = json!(p);
                }
            }
            field["value"] =
                json!(clip(f["value"].as_str().unwrap_or(""), MAX_FORM_VALUE_CHARS));
        } else {
            field["value"] = json!(f["value"].as_bool().unwrap_or(false));
        }
        fields.push(field);
    }
    let mut buttons = Vec::new();
    let mut seen_buttons = std::collections::HashSet::new();
    for b in form.get("buttons")?.as_array()? {
        if buttons.len() == MAX_FORM_BUTTONS {
            break;
        }
        let Some(id) = clean_id(&b["id"]) else { continue };
        let label = clip(b["label"].as_str().unwrap_or("").trim(), MAX_FORM_LABEL_CHARS);
        if label.is_empty() || !seen_buttons.insert(id.clone()) {
            continue;
        }
        let style = match b["style"].as_str() {
            Some("primary") => "primary",
            _ => "secondary",
        };
        buttons.push(json!({"id": id, "label": label, "style": style}));
    }
    if fields.is_empty() || buttons.is_empty() {
        return None;
    }
    Some(json!({"fields": fields, "buttons": buttons}))
}

/// Minimum gap between notifications for the same channel, so a burst of
/// agent replies (or a bot exchange) becomes one banner, not a pile.
const NOTIFY_THROTTLE: Duration = Duration::from_secs(5);

/// Longest notification body; longer messages are cut at a char boundary.
const NOTIFY_BODY_MAX_CHARS: usize = 180;

/// A new-message notification for the platform layer (the desktop shell
/// shows it natively; headless deployments fan the same payload out via
/// Expo push when mobile tokens are registered).
#[derive(Clone, Debug)]
pub struct NotifyEvent {
    pub channel_id: String,
    pub thread_id: Option<i64>,
    pub message_id: i64,
    /// "Author — Group / #channel"
    pub title: String,
    /// Message snippet.
    pub body: String,
}

type Notifier = Box<dyn Fn(NotifyEvent) + Send + Sync>;

#[derive(Clone, Debug)]
pub struct ReadNotifyEvent {
    pub channel_id: String,
    pub thread_id: Option<i64>,
    pub last_read_id: i64,
}

type ReadNotifier = Box<dyn Fn(ReadNotifyEvent) + Send + Sync>;

pub fn mention_tokens(text: &str) -> Vec<String> {
    // @name tokens: alnum start, then word chars / dots / dashes.
    let mut out = Vec::new();
    let bytes: Vec<char> = text.chars().collect();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == '@' && i + 1 < bytes.len() && bytes[i + 1].is_alphanumeric() {
            let mut j = i + 1;
            while j < bytes.len()
                && (bytes[j].is_alphanumeric() || bytes[j] == '_' || bytes[j] == '.' || bytes[j] == '-')
            {
                j += 1;
            }
            out.push(bytes[i + 1..j].iter().collect::<String>().to_lowercase());
            i = j;
        } else {
            i += 1;
        }
    }
    out
}

/// A live agent registration: which connection it arrived on and how to
/// push frames to that connection.
#[derive(Clone)]
pub struct AgentHandle {
    pub agent_id: String,
    pub agent_name: String,
    pub requires_mention: bool,
    /// Whether this connection wants a *context feed*: copies of agent-authored
    /// messages it isn't @mentioned in, delivered so it can keep conversational
    /// context even while staying silent. Native agents leave this off; the CLI
    /// bridges opt in so a later @mention arrives with the backlog already seen.
    /// These frames are context only — the bridge never drives its CLI from a
    /// non-human author, so a context feed can't create bot loops.
    pub wants_context_feed: bool,
    /// Whether the agent's home instance has a profile picture for it, plus
    /// a cache-busting stamp; the bytes are proxied via /api/agents/{id}/avatar.
    pub has_avatar: bool,
    pub avatar_v: i64,
    /// Label of the connection ("pantheo-home", "pairing:xyz", ...).
    pub source: String,
    /// Internal id of the carrying connection (one connection may carry
    /// several agents; dropping it unregisters them all).
    pub conn_id: u64,
    pub tx: UnboundedSender<Value>,
}

struct UiSocket {
    id: u64,
    username: String,
    privileged: bool,
    tx: UnboundedSender<Value>,
}

struct PairingConn {
    token: String,
    close: Arc<Notify>,
}

#[derive(Default)]
struct HubState {
    agents: HashMap<String, AgentHandle>,
    sockets: Vec<UiSocket>,
    /// Live dial-in bridge sockets: conn_id -> pairing token. Keyed by the
    /// token (not its label) so tokens sharing a label stay distinct.
    pairing_conns: HashMap<u64, PairingConn>,
    next_id: u64,
    /// Consecutive agent-authored messages per (channel_id, thread_id or 0).
    bot_streak: HashMap<(String, i64), i64>,
    /// channel_id -> {"typing": {agent_id: event}, "progress": {handle: event}}
    activity: HashMap<String, Activity>,
    /// channel_id -> when it was last notified (see NOTIFY_THROTTLE).
    last_notified: HashMap<String, Instant>,
}

#[derive(Default, Clone)]
struct Activity {
    typing: HashMap<String, Value>,
    progress: HashMap<String, Value>,
}

pub struct Hub {
    pub store: Arc<Store>,
    state: Mutex<HubState>,
    /// Whether the user is actively looking at the app (desktop window
    /// focused). Set by the shell; defaults to true so a headless server —
    /// which never has a notifier anyway — behaves neutrally.
    ui_active: AtomicBool,
    /// Platform notification callback (desktop shell only).
    notifier: Mutex<Option<Notifier>>,
    /// Desktop-only hook for removing delivered notifications after a read.
    read_notifier: Mutex<Option<ReadNotifier>>,
    /// Queue to the link-unfurl worker (installed at boot; unit tests leave
    /// it empty so posting never touches the network).
    unfurl_tx: Mutex<Option<UnboundedSender<i64>>>,
    max_attachment_bytes: usize,
}

impl Hub {
    /// Test/default constructor. Production passes the configured boot-time
    /// snapshot through `new_with_attachment_limit`; 10 MB mirrors config's default.
    /// Agent uploads retain that snapshot until restart while REST reads live config.
    pub fn new(store: Arc<Store>) -> Self {
        Self::new_with_attachment_limit(store, 10 * 1024 * 1024)
    }

    pub fn new_with_attachment_limit(store: Arc<Store>, max_attachment_bytes: usize) -> Self {
        Self {
            store,
            state: Mutex::new(HubState::default()),
            ui_active: AtomicBool::new(true),
            notifier: Mutex::new(None),
            read_notifier: Mutex::new(None),
            unfurl_tx: Mutex::new(None),
            max_attachment_bytes,
        }
    }

    /// Install the unfurl worker's queue (see [`crate::unfurl::spawn_worker`]).
    pub fn set_unfurler(&self, tx: UnboundedSender<i64>) {
        *self.unfurl_tx.lock().unwrap() = Some(tx);
    }

    /// Queue a just-posted message for link unfurling when it could need it:
    /// any http(s) URL in the text, or cited sources to enrich.
    fn maybe_unfurl(&self, message: &Value) {
        let text = message["text"].as_str().unwrap_or_default();
        if !text.contains("http://")
            && !text.contains("https://")
            && !message["meta"]["sources"].is_array()
        {
            return;
        }
        if let (Some(tx), Some(id)) = (
            self.unfurl_tx.lock().unwrap().as_ref(),
            message["id"].as_i64(),
        ) {
            let _ = tx.send(id);
        }
    }

    // ------------------------------------------------------------- notifications

    pub fn set_notifier(&self, f: impl Fn(NotifyEvent) + Send + Sync + 'static) {
        *self.notifier.lock().unwrap() = Some(Box::new(f));
    }

    pub fn set_read_notifier(&self, f: impl Fn(ReadNotifyEvent) + Send + Sync + 'static) {
        *self.read_notifier.lock().unwrap() = Some(Box::new(f));
    }

    /// The shell reports window focus; while inactive, new messages the user
    /// hasn't seen surface as platform notifications.
    pub fn set_ui_active(&self, active: bool) {
        self.ui_active.store(active, Ordering::Relaxed);
    }

    /// Notify about a freshly posted agent message when nobody is looking.
    ///
    /// Desktop: banners only while the window is unfocused (and a notifier
    /// is installed). Mobile: Expo push to the devices of accounts that can
    /// see the channel (never the author's own) — independent of `ui_active`,
    /// because a headless server never flips that flag and a phone can be
    /// suspended while the desktop is focused. Throttled per channel so
    /// bursts collapse into one banner / push.
    fn maybe_notify(&self, message: &Value) {
        let channel_id = message["channel_id"].as_str().unwrap_or_default();
        let is_dm = self.store.channel(channel_id).is_some_and(|c| c["kind"] == "agent_dm");
        let want_desktop = !is_dm && !self.ui_active.load(Ordering::Relaxed)
            && self.notifier.lock().unwrap().is_some();
        let author = (message["author_type"] == "user")
            .then(|| message["author_id"].as_str().unwrap_or_default());
        let tokens = self.store.push_tokens_for_channel(channel_id, author);
        let want_push = !tokens.is_empty();
        if !want_desktop && !want_push {
            return;
        }
        {
            let mut st = self.state.lock().unwrap();
            if let Some(at) = st.last_notified.get(channel_id) {
                if at.elapsed() < NOTIFY_THROTTLE {
                    return;
                }
            }
            st.last_notified.insert(channel_id.to_string(), Instant::now());
        }
        let place = match self.store.channel(channel_id) {
            Some(channel) => {
                let chan_name = channel["name"].as_str().unwrap_or("?").to_string();
                if channel["kind"] == "agent_dm" { format!("Direct message with {chan_name}") }
                else { match self.store.group(channel["group_id"].as_str().unwrap_or_default()) {
                    Some(g) => format!("{} / #{}", g["name"].as_str().unwrap_or("?"), chan_name),
                    None => format!("#{chan_name}"),
                }}
            }
            None => return,
        };
        let author = message["author_name"]
            .as_str()
            .or(message["author_id"].as_str())
            .unwrap_or("?");
        let mut body: String = message["text"]
            .as_str()
            .unwrap_or_default()
            .chars()
            .take(NOTIFY_BODY_MAX_CHARS)
            .collect();
        if body.is_empty() {
            body = "New message".to_string();
        } else if message["text"].as_str().unwrap_or_default().chars().count()
            > NOTIFY_BODY_MAX_CHARS
        {
            body.push('…');
        }
        let event = NotifyEvent {
            channel_id: channel_id.to_string(),
            thread_id: message["thread_id"].as_i64(),
            message_id: message["id"].as_i64().unwrap_or_default(),
            title: format!("{author} — {place}"),
            body,
        };
        if want_desktop {
            let notifier = self.notifier.lock().unwrap();
            if let Some(notify) = notifier.as_ref() {
                notify(event.clone());
            }
        }
        if want_push {
            let store = Arc::clone(&self.store);
            let push = crate::push::PushMessage {
                title: event.title,
                body: event.body,
                channel_id: event.channel_id,
                thread_id: event.thread_id,
                message_id: event.message_id,
            };
            std::thread::spawn(move || {
                let dead = crate::push::send(&push, &tokens);
                for token in dead {
                    store.delete_push_token(&token);
                }
            });
        }
    }

    // ------------------------------------------------------------- agents

    pub fn next_conn_id(&self) -> u64 {
        let mut st = self.state.lock().unwrap();
        st.next_id += 1;
        st.next_id
    }

    /// Register (or re-register) an agent id: the last hello wins. When the
    /// id was live on a *different* connection, that connection is told —
    /// frame binding will silently drop everything it sends from here on,
    /// and without the notice a bridge whose id was claimed (two bridges
    /// left on the default id, say) would stay mute with no diagnostic.
    pub fn register_agent(&self, handle: AgentHandle) {
        {
            let st = self.state.lock().unwrap();
            if let Some(displaced) = st.agents.get(&handle.agent_id) {
                if displaced.conn_id != handle.conn_id {
                    tracing::warn!(
                        agent_id = handle.agent_id,
                        displaced_conn_id = displaced.conn_id,
                        new_conn_id = handle.conn_id,
                        "agent id re-registered by another connection"
                    );
                    let _ = displaced.tx.send(json!({
                        "type": "error",
                        "frame_type": "hello",
                        "agent_id": handle.agent_id,
                        "error": "agent id was claimed by another connection; reconnect to reclaim it",
                    }));
                }
            }
        }
        self.store.upsert_agent(
            &handle.agent_id,
            &handle.agent_name,
            &handle.source,
            handle.requires_mention,
            handle.has_avatar,
            handle.avatar_v,
        );
        let mut st = self.state.lock().unwrap();
        st.agents.insert(handle.agent_id.clone(), handle);
    }

    /// A dial-in bridge socket authenticated with `token`; up from the WS
    /// upgrade (before any hello), gone when `unregister_connection` runs.
    pub fn register_pairing_conn(&self, conn_id: u64, token: &str) -> Arc<Notify> {
        let close = Arc::new(Notify::new());
        self.state.lock().unwrap().pairing_conns.insert(
            conn_id,
            PairingConn {
                token: token.to_string(),
                close: Arc::clone(&close),
            },
        );
        close
    }

    /// Ask every live socket authenticated by `token` to use its normal exit
    /// path. `notify_one` stores a permit if the socket is between loop polls.
    pub fn close_pairing_conns(&self, token: &str) -> usize {
        let st = self.state.lock().unwrap();
        let mut count = 0;
        for conn in st.pairing_conns.values().filter(|conn| conn.token == token) {
            conn.close.notify_one();
            count += 1;
        }
        count
    }

    /// Live dial-in status per pairing token: a key is present iff some
    /// socket for that token is up; the value lists the (id, name) of the
    /// agents it registered (empty until its hello arrives).
    pub fn pairing_status(&self) -> HashMap<String, Vec<(String, String)>> {
        let st = self.state.lock().unwrap();
        let conn_tokens: HashMap<u64, &str> = st
            .pairing_conns
            .iter()
            .map(|(conn_id, conn)| (*conn_id, conn.token.as_str()))
            .collect();
        let mut out: HashMap<String, Vec<(String, String)>> = conn_tokens
            .values()
            .map(|token| ((*token).to_string(), Vec::new()))
            .collect();
        for agent in st.agents.values() {
            if let Some(token) = conn_tokens.get(&agent.conn_id) {
                out.entry((*token).to_string())
                    .or_default()
                    .push((agent.agent_id.clone(), agent.agent_name.clone()));
            }
        }
        for agents in out.values_mut() {
            agents.sort_by(|a, b| a.0.cmp(&b.0));
        }
        out
    }

    /// Drop every agent that arrived on `conn_id`; clears their stale
    /// typing/progress lines so late viewers don't see ghosts.
    pub fn unregister_connection(&self, conn_id: u64) -> Vec<String> {
        let mut st = self.state.lock().unwrap();
        st.pairing_conns.remove(&conn_id);
        let gone: Vec<String> = st
            .agents
            .values()
            .filter(|h| h.conn_id == conn_id)
            .map(|h| h.agent_id.clone())
            .collect();
        for id in &gone {
            st.agents.remove(id);
        }
        let channels: Vec<String> = st.activity.keys().cloned().collect();
        for cid in channels {
            for aid in &gone {
                drop_agent_activity(&mut st, &cid, aid);
            }
        }
        gone
    }

    pub fn live_agent_ids(&self) -> Vec<String> {
        self.state.lock().unwrap().agents.keys().cloned().collect()
    }

    pub fn agent_handle(&self, agent_id: &str) -> Option<AgentHandle> {
        self.state.lock().unwrap().agents.get(agent_id).cloned()
    }

    /// Whether this exact pairing credential owns the live socket that
    /// registered `agent_id`. Pairing display names are deliberately not an
    /// identity boundary: multiple credentials may share one.
    pub fn pairing_token_owns_agent(&self, token: &str, agent_id: &str) -> bool {
        let st = self.state.lock().unwrap();
        let Some(agent) = st.agents.get(agent_id) else {
            return false;
        };
        st.pairing_conns
            .get(&agent.conn_id)
            .is_some_and(|conn| conn.token == token)
    }

    /// The channel's member agents that are live right now (id + name).
    pub fn channel_agents(&self, channel_id: &str) -> Vec<Value> {
        let members = self.store.agents_for_channel(channel_id);
        let st = self.state.lock().unwrap();
        members
            .iter()
            .filter_map(|id| st.agents.get(id))
            .map(|h| json!({"id": h.agent_id, "name": h.agent_name}))
            .collect()
    }

    // ------------------------------------------------------------- sockets

    pub fn attach_socket(&self, username: &str, privileged: bool, tx: UnboundedSender<Value>) -> u64 {
        let mut st = self.state.lock().unwrap();
        st.next_id += 1;
        let id = st.next_id;
        st.sockets.push(UiSocket {
            id,
            username: username.to_string(),
            privileged,
            tx,
        });
        id
    }

    pub fn detach_socket(&self, socket_id: u64) {
        let mut st = self.state.lock().unwrap();
        st.sockets.retain(|s| s.id != socket_id);
    }

    /// Push an event to every UI socket allowed to see the channel. Failed
    /// sends mark dead sockets, which are dropped; never raises.
    fn broadcast(&self, channel_id: &str, event: &Value) {
        // Membership checks hit the store; collect targets under the lock,
        // check visibility outside it to keep the lock scope small.
        let targets: Vec<(u64, String, bool, UnboundedSender<Value>)> = {
            let st = self.state.lock().unwrap();
            st.sockets
                .iter()
                .map(|s| (s.id, s.username.clone(), s.privileged, s.tx.clone()))
                .collect()
        };
        let mut dead = Vec::new();
        // DMs are owner-only even for privileged sockets; resolve the channel
        // kind once, not per socket.
        let is_dm = self.store.channel(channel_id).is_some_and(|c| c["kind"] == "agent_dm");
        for (id, username, privileged, tx) in targets {
            if (is_dm || !privileged) && !self.store.user_can_see_channel(&username, channel_id) {
                continue;
            }
            if tx.send(event.clone()).is_err() {
                dead.push(id);
            }
        }
        for id in dead {
            self.detach_socket(id);
        }
    }

    /// Push an event to every socket belonging to one user only — personal
    /// state (read markers) other viewers must not see.
    fn send_to_user(&self, username: &str, event: &Value) {
        let targets: Vec<(u64, UnboundedSender<Value>)> = {
            let st = self.state.lock().unwrap();
            st.sockets
                .iter()
                .filter(|s| s.username == username)
                .map(|s| (s.id, s.tx.clone()))
                .collect()
        };
        for (id, tx) in targets {
            if tx.send(event.clone()).is_err() {
                self.detach_socket(id);
            }
        }
    }

    // ------------------------------------------------------------- reads

    pub fn mark_read(&self, username: &str, channel_id: &str, message_id: Option<i64>) -> i64 {
        let last = self.store.mark_read(username, channel_id, message_id);
        self.send_to_user(
            username,
            &json!({"type": "read", "channel_id": channel_id, "last_read_id": last}),
        );
        if let Some(notify) = self.read_notifier.lock().unwrap().as_ref() {
            notify(ReadNotifyEvent {
                channel_id: channel_id.to_string(),
                thread_id: None,
                last_read_id: last,
            });
        }
        last
    }

    /// Advance a per-thread read marker and tell the user's other devices.
    pub fn mark_thread_read(
        &self,
        username: &str,
        thread_id: i64,
        message_id: Option<i64>,
    ) -> i64 {
        let last = self.store.mark_thread_read(username, thread_id, message_id);
        let channel_id = self
            .store
            .message(thread_id)
            .and_then(|m| m["channel_id"].as_str().map(str::to_string))
            .unwrap_or_default();
        self.send_to_user(
            username,
            &json!({
                "type": "thread_read", "thread_id": thread_id,
                "channel_id": channel_id, "last_read_id": last,
            }),
        );
        if let Some(notify) = self.read_notifier.lock().unwrap().as_ref() {
            notify(ReadNotifyEvent {
                channel_id,
                thread_id: Some(thread_id),
                last_read_id: last,
            });
        }
        last
    }

    /// Persist @user mentions so unread badges can distinguish "spoken to
    /// you" from mere traffic. Matches mention tokens against the channel's
    /// group members; self-mentions are ignored.
    fn record_mentions(&self, message: &Value) {
        let tokens = mention_tokens(message["text"].as_str().unwrap_or_default());
        if tokens.is_empty() {
            return;
        }
        let channel_id = message["channel_id"].as_str().unwrap_or_default();
        let Some(channel) = self.store.channel(channel_id) else { return };
        let group_id = channel["group_id"].as_str().unwrap_or_default();
        let author_is_user = message["author_type"] == "user";
        let author_id = message["author_id"].as_str().unwrap_or_default();
        let mentioned: Vec<String> = self
            .store
            .members(group_id)
            .iter()
            .filter(|m| m["member_type"] == "user")
            .filter_map(|m| m["member_id"].as_str().map(str::to_string))
            .filter(|u| tokens.contains(&u.to_lowercase()))
            .filter(|u| !(author_is_user && u == author_id))
            .collect();
        if let Some(id) = message["id"].as_i64() {
            self.store.add_mentions(id, channel_id, &mentioned);
        }
    }

    // ------------------------------------------------------------- posting

    pub fn post_user_message(
        &self,
        channel_id: &str,
        text: &str,
        username: &str,
        user_name: Option<&str>,
        thread_id: Option<i64>,
        attachments: Vec<NewAttachment>,
    ) -> Value {
        self.post_user_message_opts(
            channel_id, text, username, user_name, thread_id, attachments, false, None, false,
            false,
        )
    }

    /// `voice` marks a spoken (live voice) turn: it rides on the inbound
    /// fan-out only — the stored message is a normal transcript — steering
    /// agents toward plain spoken prose, since replies will be read aloud.
    ///
    /// `timezone` is the sender's IANA timezone, sent hidden by clients with
    /// each message. It's kept in message `meta` (never rendered by the UI)
    /// and forwarded to agents on the inbound frame so they can reason about
    /// the sender's local time.
    ///
    /// `reply_in_thread` is the composer's per-message ask: address agents as
    /// if this (top-level) message were already a thread root, so their
    /// replies land in a thread under it (see [`Self::build_inbound`]). Kept
    /// hidden in message `meta.client` like the timezone; meaningless on
    /// thread replies and voice turns, so ignored there.
    ///
    /// `require_agent` is the thread composer's sticky ask: close the agent
    /// floor unless someone is @mentioned (bridges treat it like
    /// `any_mention`, so untagged replies are buffered as context). Only
    /// honored on thread replies, never on top-level or voice turns.
    #[allow(clippy::too_many_arguments)]
    pub fn post_user_message_opts(
        &self,
        channel_id: &str,
        text: &str,
        username: &str,
        user_name: Option<&str>,
        thread_id: Option<i64>,
        attachments: Vec<NewAttachment>,
        voice: bool,
        timezone: Option<&str>,
        reply_in_thread: bool,
        require_agent: bool,
    ) -> Value {
        let mut client = serde_json::Map::new();
        if let Some(tz) = timezone {
            client.insert("tz".into(), json!(tz));
        }
        if reply_in_thread && thread_id.is_none() && !voice {
            client.insert("reply_thread".into(), json!(true));
        }
        if require_agent && thread_id.is_some() && !voice {
            client.insert("require_agent".into(), json!(true));
        }
        let meta = (!client.is_empty()).then(|| json!({"client": client}));
        let message = self.store.add_message_with_meta(
            channel_id,
            text,
            "user",
            username,
            Some(user_name.unwrap_or(username)),
            thread_id,
            &attachments,
            meta.as_ref(),
        );
        {
            let mut st = self.state.lock().unwrap();
            st.bot_streak.remove(&(channel_id.to_string(), thread_id.unwrap_or(0)));
        }
        // Your own message is never unread to you.
        self.store
            .mark_read(username, channel_id, message["id"].as_i64());
        if let Some(tid) = thread_id {
            self.store
                .mark_thread_read(username, tid, message["id"].as_i64());
        }
        self.record_mentions(&message);
        self.broadcast(channel_id, &json!({"type": "message", "message": message}));
        self.maybe_unfurl(&message);
        self.fan_out(&message, false, None, false, voice, None);
        message
    }

    /// An agent's outbound message. Broadcast to viewers; relayed to *other*
    /// member agents only when @mentioned, under the bot-loop cap.
    ///
    /// ``options`` (optional) is a list of ``{id, label, style?}`` buttons the
    /// UI renders on the message; ``options_id`` ties a click back to the
    /// agent's pending approval. ``tldr`` (optional) is a short summary of a
    /// long message; clients offer it as an alternate view of the same text.
    /// ``sources`` (optional) is a list of cited URLs (strings or
    /// ``{url, title?}``) rendered as compact chips instead of raw links;
    /// without it a trailing "Sources:" block in the text is lifted out
    /// automatically (see [`crate::sources`]).
    pub fn post_agent_message(
        &self,
        agent_id: &str,
        agent_name: &str,
        channel_id: &str,
        text: &str,
        thread_id: Option<i64>,
    ) -> Value {
        self.post_agent_message_with_options(
            agent_id, agent_name, channel_id, text, thread_id, None, None, None, None, None, None,
            None, vec![],
        )
    }

    fn decode_agent_attachments(&self, raw: Option<&Value>) -> Result<Vec<NewAttachment>, String> {
        let Some(raw) = raw.filter(|value| !value.is_null()) else { return Ok(vec![]) };
        let files = raw.as_array().ok_or("attachments must be an array")?;
        if files.len() > MAX_FILES_PER_AGENT_POST {
            return Err(format!("too many attachments (max {MAX_FILES_PER_AGENT_POST})"));
        }
        let mut out = Vec::with_capacity(files.len());
        for file in files {
            let filename = file["filename"].as_str().ok_or("attachment filename required")?;
            let encoded = file["data_b64"].as_str().ok_or("attachment data_b64 required")?;
            let encoded_limit = self.max_attachment_bytes.saturating_add(2) / 3 * 4 + 4;
            if encoded.len() > encoded_limit { return Err("attachment too large".into()); }
            let data = base64::engine::general_purpose::STANDARD
                .decode(encoded).map_err(|_| "invalid attachment base64")?;
            if data.is_empty() { return Err("empty attachment".into()); }
            if data.len() > self.max_attachment_bytes { return Err("attachment too large".into()); }
            let mime = sniff_image_mime(&data)
                .ok_or("unsupported attachment type (images only)")?.to_string();
            out.push(NewAttachment { filename: safe_filename(filename), mime, data });
        }
        Ok(out)
    }

    pub fn post_agent_message_with_options(
        &self,
        agent_id: &str,
        agent_name: &str,
        channel_id: &str,
        text: &str,
        thread_id: Option<i64>,
        options: Option<&Value>,
        options_id: Option<&str>,
        tldr: Option<&str>,
        sources: Option<&Value>,
        form: Option<&Value>,
        form_id: Option<&str>,
        artifacts: Option<&Value>,
        attachments: Vec<NewAttachment>,
    ) -> Value {
        let mut meta_obj = serde_json::Map::new();
        if let Some(opts) = options {
            if opts.as_array().map(|a| !a.is_empty()).unwrap_or(false) {
                meta_obj.insert("options".into(), opts.clone());
                meta_obj.insert("options_id".into(), json!(options_id.unwrap_or("")));
                meta_obj.insert("resolved".into(), Value::Null);
            }
        }
        // An interactive form: the sanitized spec, its shared live state
        // (seeded from each field's initial value; members' edits land here),
        // and the not-yet-submitted lock. A form that fails sanitizing is
        // dropped while the post still lands, like a bad tldr.
        if let Some(sanitized) = form.and_then(sanitize_form) {
            let mut state = serde_json::Map::new();
            for f in sanitized["fields"].as_array().into_iter().flatten() {
                if let Some(id) = f["id"].as_str() {
                    state.insert(id.to_string(), f["value"].clone());
                }
            }
            meta_obj.insert("form".into(), sanitized);
            meta_obj.insert("form_id".into(), json!(form_id.unwrap_or("")));
            meta_obj.insert("form_state".into(), Value::Object(state));
            meta_obj.insert("form_submitted".into(), Value::Null);
        }
        if let Some(t) = tldr {
            meta_obj.insert("tldr".into(), json!(t));
        }
        if let Some(sanitized) = artifacts.and_then(crate::artifacts::sanitize_artifacts) {
            meta_obj.insert("artifacts".into(), sanitized);
        }
        // Sources: an explicit list from the agent wins; a trailing
        // "Sources:" block in the text supplies the list otherwise. Either
        // way a detected block's offset lets clients collapse it into chips
        // without the stored text changing.
        let detected = crate::sources::extract_trailing_sources(text);
        let provided = sources.and_then(crate::sources::normalize_sources);
        if let Some((start, _)) = &detected {
            meta_obj.insert("sources_start".into(), json!(start));
        }
        if let Some(list) = provided.or_else(|| detected.map(|(_, list)| list)) {
            meta_obj.insert("sources".into(), list);
        }
        let meta = (!meta_obj.is_empty()).then(|| Value::Object(meta_obj));
        let message = self.store.add_message_with_meta(
            channel_id,
            text,
            "agent",
            agent_id,
            Some(agent_name),
            thread_id,
            &attachments,
            meta.as_ref(),
        );
        let streak = {
            let mut st = self.state.lock().unwrap();
            let key = (channel_id.to_string(), thread_id.unwrap_or(0));
            let v = st.bot_streak.entry(key).or_insert(0);
            *v += 1;
            *v
        };
        self.record_mentions(&message);
        self.broadcast(channel_id, &json!({"type": "message", "message": message}));
        self.maybe_unfurl(&message);
        self.maybe_notify(&message);
        if streak <= BOT_LOOP_LIMIT {
            self.fan_out(
                &message,
                true,
                Some(agent_id),
                true,
                false,
                Some((BOT_LOOP_LIMIT - streak).max(0)),
            );
        } else if streak == BOT_LOOP_LIMIT + 1 {
            tracing::info!("bot-loop limit hit in {channel_id} (thread {thread_id:?})");
        }
        message
    }

    /// Resolve an interactive option on a message: persist the choice, update
    /// all UIs, and notify the owning agent via an ``option_select`` frame.
    pub fn select_option(
        &self,
        message_id: i64,
        option_id: &str,
        user: &str,
    ) -> Result<Value, &'static str> {
        let message = self.store.message(message_id).ok_or("Message not found")?;
        let meta = message.get("meta").cloned().unwrap_or(Value::Null);
        let options = meta
            .get("options")
            .and_then(|o| o.as_array())
            .ok_or("Message has no options")?;
        if meta.get("resolved").map(|r| !r.is_null()).unwrap_or(false) {
            return Err("Options already resolved");
        }
        if !options.iter().any(|o| o["id"].as_str() == Some(option_id)) {
            return Err("Unknown option");
        }
        let options_id = meta["options_id"].as_str().unwrap_or("").to_string();
        let resolved = json!({
            "option_id": option_id,
            "by": user,
            "ts": crate::store::now(),
        });
        let updated = self
            .store
            .update_message_meta(message_id, &json!({"resolved": resolved}))
            .ok_or("Failed to update message")?;
        let channel_id = updated["channel_id"].as_str().unwrap_or_default();
        self.broadcast(
            channel_id,
            &json!({"type": "message_update", "message": updated}),
        );
        // Notify the agent that authored the options message.
        let agent_id = updated["author_id"].as_str().unwrap_or_default();
        if let Some(handle) = self.agent_handle(agent_id) {
            let frame = json!({
                "type": "option_select",
                "agent_id": agent_id,
                "options_id": options_id,
                "option_id": option_id,
                "message_id": message_id,
                "channel_id": channel_id,
                "thread_id": updated["thread_id"],
                "user": {"id": user, "name": user},
            });
            let _ = handle.tx.send(frame);
        }
        Ok(updated)
    }

    /// Persist one member's edit to a form field — a checkbox toggle or a
    /// confirmed input value — and fan the updated message out to every
    /// client. Draft edits never reach the authoring agent; only
    /// [`Hub::submit_form`] does.
    pub fn update_form_field(
        &self,
        message_id: i64,
        field_id: &str,
        value: &Value,
    ) -> Result<Value, &'static str> {
        let message = self.store.message(message_id).ok_or("Message not found")?;
        let meta = message.get("meta").cloned().unwrap_or(Value::Null);
        let fields = meta
            .get("form")
            .and_then(|f| f.get("fields"))
            .and_then(|f| f.as_array())
            .ok_or("Message has no form")?;
        let field = fields
            .iter()
            .find(|f| f["id"].as_str() == Some(field_id))
            .ok_or("Unknown field")?;
        let normalized = match field["kind"].as_str() {
            Some("checkbox") => json!(value.as_bool().ok_or("Expected a boolean value")?),
            Some("input") => {
                let s = value.as_str().ok_or("Expected a string value")?;
                if s.chars().count() > MAX_FORM_VALUE_CHARS {
                    return Err("Value too long");
                }
                json!(s)
            }
            _ => return Err("Unknown field"),
        };
        let updated = self.store.update_form_field(message_id, field_id, &normalized)?;
        let channel_id = updated["channel_id"].as_str().unwrap_or_default();
        self.broadcast(
            channel_id,
            &json!({"type": "message_update", "message": updated}),
        );
        Ok(updated)
    }

    /// Press one of a form's buttons: atomically lock the form with a
    /// snapshot of the shared state, update all UIs, and notify the
    /// authoring agent with a ``form_submit`` frame carrying the values
    /// (mirrors [`Hub::select_option`]; an offline agent just misses the
    /// frame while the recorded submission stands).
    pub fn submit_form(
        &self,
        message_id: i64,
        button_id: &str,
        user: &str,
    ) -> Result<Value, &'static str> {
        let message = self.store.message(message_id).ok_or("Message not found")?;
        let meta = message.get("meta").cloned().unwrap_or(Value::Null);
        let buttons = meta
            .get("form")
            .and_then(|f| f.get("buttons"))
            .and_then(|b| b.as_array())
            .ok_or("Message has no form")?;
        if !buttons.iter().any(|b| b["id"].as_str() == Some(button_id)) {
            return Err("Unknown button");
        }
        let updated = self.store.submit_form(message_id, button_id, user)?;
        let channel_id = updated["channel_id"].as_str().unwrap_or_default().to_string();
        self.broadcast(
            &channel_id,
            &json!({"type": "message_update", "message": updated}),
        );
        let agent_id = updated["author_id"].as_str().unwrap_or_default();
        if let Some(handle) = self.agent_handle(agent_id) {
            let frame = json!({
                "type": "form_submit",
                "agent_id": agent_id,
                "form_id": updated["meta"]["form_id"],
                "button_id": button_id,
                "message_id": message_id,
                "channel_id": channel_id,
                "thread_id": updated["thread_id"],
                "values": updated["meta"]["form_submitted"]["values"],
                "user": {"id": user, "name": user},
            });
            let _ = handle.tx.send(frame);
        }
        Ok(updated)
    }

    /// Broadcast a non-persisted event (typing, progress, pin) to viewers.
    pub fn post_transient(&self, channel_id: &str, event: Value) {
        self.record_activity(channel_id, &event);
        self.broadcast(channel_id, &event);
    }

    fn record_activity(&self, channel_id: &str, event: &Value) {
        let mut st = self.state.lock().unwrap();
        match event["type"].as_str() {
            Some("typing") => {
                let agent_id = event["agent_id"].as_str().unwrap_or_default().to_string();
                if event["active"].as_bool().unwrap_or(false) {
                    st.activity
                        .entry(channel_id.to_string())
                        .or_default()
                        .typing
                        .insert(agent_id, event.clone());
                } else {
                    // Agent finished: its progress lines are stale too.
                    drop_agent_activity(&mut st, channel_id, &agent_id);
                }
            }
            Some("progress") => {
                let handle = event["handle"].as_str().unwrap_or_default().to_string();
                st.activity
                    .entry(channel_id.to_string())
                    .or_default()
                    .progress
                    .insert(handle, event.clone());
            }
            _ => {}
        }
    }

    /// Current in-flight typing/progress — what a viewer opening the channel
    /// right now should render.
    pub fn channel_activity(&self, channel_id: &str) -> Value {
        let st = self.state.lock().unwrap();
        let chan = st.activity.get(channel_id);
        json!({
            "typing": chan.map(|c| c.typing.values().cloned().collect::<Vec<_>>()).unwrap_or_default(),
            "progress": chan.map(|c| c.progress.values().cloned().collect::<Vec<_>>()).unwrap_or_default(),
        })
    }

    // ------------------------------------------------------------- fan-out

    fn fan_out(
        &self,
        message: &Value,
        from_bot: bool,
        exclude_agent: Option<&str>,
        mentioned_only: bool,
        voice: bool,
        bot_turns_left: Option<i64>,
    ) {
        let channel_id = message["channel_id"].as_str().unwrap_or_default();
        let Some(channel) = self.store.channel(channel_id) else {
            return;
        };
        let tokens = mention_tokens(message["text"].as_str().unwrap_or_default());
        let is_dm = channel["kind"] == "agent_dm";
        // Thread composers can ask to close the floor even without an @tag
        // (`meta.client.require_agent`). OR'd into `any_mention` so existing
        // bridges buffer untagged replies as context without a protocol bump.
        let require_agent = message["meta"]["client"]["require_agent"]
            .as_bool()
            .unwrap_or(false);
        // Was any *member agent* @mentioned? This drives the CLI bridges' reply
        // policy: a human message that tags no agent is open to everyone, while
        // one that tags an agent is only for the tagged agent(s). Carried to the
        // agent as `any_mention`; the recipient decides what to do with it.
        let any_agent_mentioned = require_agent
            || self.store.agents_for_channel(channel_id).iter().any(|aid| {
                tokens.contains(&aid.to_lowercase())
                    || self
                        .agent_handle(aid)
                        .is_some_and(|h| tokens.contains(&slugify(&h.agent_name)))
            });
        for agent_id in self.store.agents_for_channel(channel_id) {
            if Some(agent_id.as_str()) == exclude_agent {
                continue;
            }
            let Some(handle) = self.agent_handle(&agent_id) else {
                continue;
            };
            let mentioned = is_dm || tokens.contains(&agent_id.to_lowercase())
                || tokens.contains(&slugify(&handle.agent_name));
            // Normally an unmentioned agent is skipped when the message is
            // agents-only (`mentioned_only`) or the agent opted into
            // mention-gating. A context-feed agent still gets a copy so it can
            // buffer the conversation while staying silent — bot loops are held
            // off by the caller's bot-streak cap on agent-authored fan-out.
            if !mentioned
                && (mentioned_only || handle.requires_mention)
                && !handle.wants_context_feed
            {
                continue;
            }
            let inbound = self.build_inbound(
                message,
                &channel,
                &handle,
                mentioned,
                any_agent_mentioned,
                from_bot,
                voice,
                bot_turns_left,
            );
            let _ = handle.tx.send(inbound);
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn build_inbound(
        &self,
        message: &Value,
        channel: &Value,
        handle: &AgentHandle,
        mentioned: bool,
        any_mention: bool,
        from_bot: bool,
        voice: bool,
        bot_turns_left: Option<i64>,
    ) -> Value {
        let mut text = message["text"].as_str().unwrap_or_default().to_string();
        // A sender's "reply in thread" ask (meta.client.reply_thread, set by
        // the composer toggle) presents their top-level message to agents as
        // if it were already a thread root: agents echo `thread_id` back, so
        // their replies land in a thread under the message instead of the
        // channel. The stored message keeps thread_id NULL. Live-voice turns
        // are exempt — those replies are read aloud, not browsed.
        let mut thread_id = message["thread_id"].as_i64();
        if thread_id.is_none()
            && !voice
            && message["meta"]["client"]["reply_thread"].as_bool().unwrap_or(false)
        {
            thread_id = message["id"].as_i64();
        }
        // First reply in a thread: inline the root message so the agent's
        // fresh per-thread session starts with what the thread is about.
        if let Some(tid) = thread_id {
            if self.store.thread_size(tid) == 1 {
                if let Some(root) = self.store.message(tid) {
                    let root_text = root["text"].as_str().unwrap_or_default();
                    let snippet: String = root_text.chars().take(ROOT_CONTEXT_MAX_CHARS).collect();
                    let author = root["author_name"]
                        .as_str()
                        .or(root["author_id"].as_str())
                        .unwrap_or("?");
                    text = format!("[thread on: \"{snippet}\" — by {author}]\n{text}");
                }
            }
        }
        let group = self.store.group(channel["group_id"].as_str().unwrap_or_default());
        let chat_name = match &group {
            Some(g) => format!(
                "{} / {}",
                g["name"].as_str().unwrap_or("?"),
                channel["name"].as_str().unwrap_or("?")
            ),
            None => channel["name"].as_str().unwrap_or("?").to_string(),
        };
        // Inline small attachment bytes (base64); oversized files carry an id
        // that dial-in bridges can fetch through the authenticated agent route.
        let mut atts = Vec::new();
        for f in message["attachments"].as_array().cloned().unwrap_or_default() {
            let file_id = f["id"].as_str().unwrap_or_default();
            let size = f["size"].as_i64().unwrap_or(0) as usize;
            let mut entry = json!({
                "id": f["id"], "filename": f["filename"], "mime": f["mime"],
                "size": f["size"],
            });
            if size <= MAX_INLINE_ATTACHMENT {
                if let Ok(data) = std::fs::read(self.store.file_path(file_id)) {
                    entry["data_b64"] =
                        json!(base64::engine::general_purpose::STANDARD.encode(data));
                }
            }
            atts.push(entry);
        }
        let mut frame = json!({
            "type": "inbound",
            "agent_id": handle.agent_id,
            "message_id": message["id"],
            "channel_id": message["channel_id"],
            "thread_id": thread_id,
            "author": {
                "type": message["author_type"],
                "id": message["author_id"],
                "name": message["author_name"],
            },
            "text": text,
            "chat_name": chat_name,
            "context_note": self.context_note(channel, &group, thread_id, handle, voice),
            "mentioned": mentioned,
            // Whether any member agent was @mentioned anywhere in this message.
            // Bridges reply when addressed (`mentioned`) or when the floor is
            // open (`!any_mention`); otherwise they buffer it as context.
            // Also true when the sender's thread toggle closed the floor via
            // `meta.client.require_agent` (see `require_agent` on this frame).
            "any_mention": any_mention,
            // Explicit copy of the composer's sticky thread ask. Bridges may
            // ignore it — `any_mention` already encodes the closed floor.
            "require_agent": message["meta"]["client"]["require_agent"]
                .as_bool()
                .unwrap_or(false),
            "from_bot": from_bot,
            "voice_live": voice,
            "attachments": atts,
            // Server receipt time (unix epoch seconds) and the sender's IANA
            // timezone (when the client sent one) — agent-only context, never
            // rendered in chat.
            "ts": message["ts"],
            "timezone": message["meta"]["client"]["tz"],
        });
        // Only on agent-authored frames: how many further agent messages will
        // still be relayed before a human must speak. The recipient's own
        // reply reaches a @mentioned agent iff this is >= 1; at 0 it reaches
        // humans only.
        if let Some(n) = bot_turns_left {
            frame["bot_turns_left"] = json!(n);
        }
        frame
    }

    /// "Where you are" prompt block for the agent: group, channel, thread
    /// root, member agents with @mention handles, and people with roles.
    fn context_note(
        &self,
        channel: &Value,
        group: &Option<Value>,
        thread_id: Option<i64>,
        handle: &AgentHandle,
        voice: bool,
    ) -> String {
        let mut lines = vec![
            "You are chatting in Agora, a group chat platform for agents and people \
             (groups contain channels; messages can branch into threads)."
                .to_string(),
        ];
        if channel["kind"] == "agent_dm" {
            lines.clear();
            lines.push(format!("This is a private Agora direct message between you and {}. Treat its contents as private and reply directly without requiring an @mention.", channel["dm_user_id"].as_str().unwrap_or("the user")));
        }
        if let Some(g) = group {
            let desc = g["description"].as_str().unwrap_or_default();
            lines.push(format!(
                "Group: {}{}",
                g["name"].as_str().unwrap_or("?"),
                if desc.is_empty() { String::new() } else { format!(" — {desc}") }
            ));
        }
        let topic = channel["topic"].as_str().unwrap_or_default();
        lines.push(format!(
            "Channel: #{}{}",
            channel["name"].as_str().unwrap_or("?"),
            if topic.is_empty() { String::new() } else { format!(" — {topic}") }
        ));
        if let Some(tid) = thread_id {
            if let Some(root) = self.store.message(tid) {
                let root_text = root["text"].as_str().unwrap_or_default();
                let snippet: String = root_text.chars().take(140).collect();
                let ellipsis = if root_text.chars().count() > 140 { "…" } else { "" };
                let author = root["author_name"]
                    .as_str()
                    .or(root["author_id"].as_str())
                    .unwrap_or("?");
                lines.push(format!(
                    "Thread: you are replying in a thread under {author}'s message: \"{snippet}{ellipsis}\""
                ));
            }
        }
        let channel_id = channel["id"].as_str().unwrap_or_default();
        let group_id = channel["group_id"].as_str().unwrap_or_default();
        let (mut agents, mut people) = (Vec::new(), Vec::new());
        let mut live_peer = false;
        {
            let st = self.state.lock().unwrap();
            for m in self.store.members(group_id) {
                // Skip members scoped to a *different* channel of this group.
                if let Some(scoped) = m["channel_id"].as_str() {
                    if !scoped.is_empty() && scoped != channel_id {
                        continue;
                    }
                }
                let member_id = m["member_id"].as_str().unwrap_or_default();
                if m["member_type"] == "agent" {
                    let live = st.agents.get(member_id);
                    let name = live
                        .map(|h| h.agent_name.clone())
                        .or_else(|| {
                            self.store.agent(member_id).and_then(|a| {
                                a["name"].as_str().map(String::from)
                            })
                        })
                        .unwrap_or_else(|| member_id.to_string());
                    if member_id == handle.agent_id {
                        agents.push(format!("{name} (you)"));
                    } else if live.is_some() {
                        live_peer = true;
                        agents.push(format!("{name} (@{})", slugify(&name)));
                    } else {
                        agents.push(format!("{name} (offline)"));
                    }
                } else {
                    people.push(format!("{member_id} ({})", m["role"].as_str().unwrap_or("member")));
                }
            }
        }
        if !agents.is_empty() {
            lines.push(format!("Agents in this channel: {}.", agents.join(", ")));
        }
        if !people.is_empty() {
            lines.push(format!("People in this group: {}.", people.join(", ")));
        }
        lines.push(format!(
            "Anyone here can address a specific agent with its @mention; your replies post to this channel{}",
            if thread_id.is_some() { " thread." } else { "." }
        ));
        if live_peer {
            lines.push(format!(
                "Other agents here are colleagues, not users. Only @mention another \
                 agent when a human's instructions ask you to collaborate with, \
                 delegate to, or get a review from it — never tag an agent merely \
                 because it is listed here. Agent-to-agent exchanges stop being \
                 relayed after {BOT_LOOP_LIMIT} consecutive agent messages without \
                 a human message."
            ));
        }
        if voice {
            // Live voice: the transcript came from speech and the reply will
            // be read aloud by TTS — markdown would be spoken verbatim.
            lines.push(
                "Voice conversation: the user is speaking aloud and your reply \
                 will be read out by text-to-speech. Answer conversationally \
                 and briefly, in plain spoken prose — no markdown, tables, \
                 code blocks, bullet lists, links, or emoji."
                    .to_string(),
            );
        } else {
            lines.push(
                "Formatting: this chat renders Markdown including GitHub-style pipe \
                 tables. Prefer a table when presenting tabular or comparative data."
                    .to_string(),
            );
        }
        lines.join("\n")
    }

    // ------------------------------------------------------------- agent frames

    /// Test/in-process entry point without a carrying socket. Production
    /// callers must use `handle_agent_frame_from` so identity is connection-bound.
    #[cfg(test)]
    fn handle_agent_frame(&self, frame: &Value) {
        self.handle_agent_frame_inner(None, frame);
    }

    /// Handle an agent frame from a live connection. The claimed agent id
    /// must be registered on that same connection before any read or write.
    pub fn handle_agent_frame_from(&self, conn_id: u64, frame: &Value) {
        self.handle_agent_frame_inner(Some(conn_id), frame);
    }

    fn handle_agent_frame_inner(&self, sender_conn_id: Option<u64>, frame: &Value) {
        let agent_id = frame["agent_id"].as_str().unwrap_or_default().to_string();
        let Some(handle) = self.agent_handle(&agent_id) else {
            return;
        };
        if sender_conn_id.is_some_and(|conn_id| handle.conn_id != conn_id) {
            tracing::warn!(
                agent_id,
                sender_conn_id,
                "dropping agent frame whose identity is not registered on the connection"
            );
            return;
        }
        let agent_name = handle.agent_name.clone();
        let channel_id = frame["channel_id"].as_str().unwrap_or_default().to_string();
        // history_request answers with an error frame instead of the silent
        // drop below — the asking agent is awaiting a correlated response.
        if frame["type"].as_str() == Some("history_request") {
            self.handle_history_request(&agent_id, &channel_id, frame);
            return;
        }
        // search_request likewise answers on the asking connection, and its
        // channel_id is an optional scope, not an address — handle it before
        // the empty-channel drop below.
        if frame["type"].as_str() == Some("search_request") {
            self.handle_search_request(&agent_id, frame);
            return;
        }
        if channel_id.is_empty() || self.store.channel(&channel_id).is_none() {
            return;
        }
        // Everything reaching this point is addressed to a room. Gate it
        // unconditionally so future write frames fail closed instead of
        // relying on a second frame-type allowlist being kept in sync with
        // the match below. Connection ownership was established above;
        // membership is the remaining channel-level authorization boundary.
        if !self.store.agent_in_channel(&agent_id, &channel_id) {
            let frame_type = frame["type"].as_str().unwrap_or("<missing>");
            tracing::debug!(
                agent_id,
                channel_id,
                frame_type,
                "dropping agent frame outside channel membership"
            );
            // Posts have a durable side effect the sender expects. Tell the
            // live agent that the write was rejected instead of letting it
            // assume the message landed. Activity frames remain best-effort.
            if frame_type == "post" && sender_conn_id.is_some() {
                let _ = handle.tx.send(json!({
                    "type": "error",
                    "frame_type": "post",
                    "agent_id": agent_id,
                    "request_id": frame["request_id"],
                    "error": "agent is not a member of this channel",
                    "channel_id": channel_id,
                    "thread_id": frame["thread_id"].as_i64(),
                }));
            }
            return;
        }
        if !self.store.agent_dm_route_allowed(&channel_id, &agent_id) {
            if frame["type"] == "post" { let _=handle.tx.send(json!({"type":"error","frame_type":"post","agent_id":agent_id,"request_id":frame["request_id"],"error":"agent DM access has been revoked","channel_id":channel_id})); }
            return;
        }
        let thread_id = frame["thread_id"].as_i64();
        match frame["type"].as_str() {
            Some("post") => {
                let text = frame["text"].as_str().unwrap_or_default();
                let attachments = match self.decode_agent_attachments(frame.get("attachments")) {
                    Ok(files) => files,
                    Err(error) => {
                        if sender_conn_id.is_some() {
                            let _ = handle.tx.send(json!({
                                "type": "error", "frame_type": "post", "agent_id": agent_id,
                                "request_id": frame["request_id"], "error": error,
                                "channel_id": channel_id, "thread_id": thread_id,
                            }));
                        }
                        return;
                    }
                };
                if !text.is_empty() || !attachments.is_empty() {
                    let options = frame.get("options");
                    let options_id = frame["options_id"].as_str();
                    let tldr = frame["tldr"].as_str().map(str::trim).filter(|t| {
                        !t.is_empty()
                            && t.chars().count() <= MAX_TLDR_CHARS
                            && t.chars().count() < text.chars().count()
                    });
                    self.post_agent_message_with_options(
                        &agent_id,
                        &agent_name,
                        &channel_id,
                        text,
                        thread_id,
                        options,
                        options_id,
                        tldr,
                        frame.get("sources"),
                        frame.get("form"),
                        frame["form_id"].as_str(),
                        frame.get("artifacts"),
                        attachments,
                    );
                }
            }
            Some("typing") => {
                self.post_transient(
                    &channel_id,
                    json!({
                        "type": "typing", "channel_id": channel_id, "thread_id": thread_id,
                        "agent_id": agent_id, "agent_name": agent_name,
                        "active": frame["active"].as_bool().unwrap_or(false),
                    }),
                );
            }
            Some("progress") => {
                self.post_transient(
                    &channel_id,
                    json!({
                        "type": "progress", "channel_id": channel_id, "thread_id": thread_id,
                        "agent_id": agent_id, "agent_name": agent_name,
                        "handle": frame["handle"], "text": frame["text"],
                    }),
                );
            }
            Some("reaction") => {
                let Some(message_id) = frame["message_id"].as_i64() else {
                    return;
                };
                let emoji = frame["emoji"].as_str().unwrap_or_default();
                if emoji.is_empty()
                    || emoji.len() > 32
                    || emoji.chars().any(|c| c.is_ascii())
                {
                    return;
                }
                let Some(message) = self
                    .store
                    .message(message_id)
                    .filter(|m| m["channel_id"] == channel_id.as_str())
                else {
                    return;
                };
                let changed = if frame["action"].as_str() == Some("remove") {
                    self.store.remove_agent_reaction(&agent_id, message_id, emoji)
                } else {
                    let groups = message["reactions"].as_array().cloned().unwrap_or_default();
                    let already = groups.iter().any(|r| r["emoji"] == emoji);
                    if !already && groups.len() >= MAX_REACTION_KINDS_PER_MESSAGE {
                        return;
                    }
                    self.store
                        .add_agent_reaction(&agent_id, &agent_name, &channel_id, message_id, emoji)
                };
                if changed {
                    if let Some(updated) = self.store.message(message_id) {
                        self.post_transient(
                            &channel_id,
                            json!({"type": "message_update", "message": updated}),
                        );
                    }
                }
            }
            Some("options_resolve") => {
                let options_id = frame["options_id"].as_str().unwrap_or_default();
                let text = frame["text"].as_str().unwrap_or("Resolved.");
                if let Some(message_id) = self
                    .store
                    .find_message_by_options_id(&channel_id, &agent_id, options_id)
                {
                    let _ = self.resolve_options_by_agent(message_id, text);
                }
            }
            _ => {}
        }
    }

    /// A `history_request` from an agent: one membership-checked, cursor-paged
    /// page of a channel's top level (or one thread), answered on the same
    /// connection as a `history_response` carrying the frame's `request_id`.
    ///
    /// Paging is newest-first: no `before_id` returns the most recent `limit`
    /// messages, `before_id` the `limit` strictly older than it; `messages`
    /// come back oldest-first (reading order) with `has_more` set while older
    /// rows remain.
    fn handle_history_request(&self, agent_id: &str, channel_id: &str, frame: &Value) {
        let Some(handle) = self.agent_handle(agent_id) else {
            return; // no live connection to answer on
        };
        let mut response = json!({
            "type": "history_response",
            "request_id": frame["request_id"],
        });
        if channel_id.is_empty() || self.store.channel(channel_id).is_none() {
            response["error"] = json!("unknown channel");
            let _ = handle.tx.send(response);
            return;
        }
        // Membership is the read boundary: an agent can only read rooms it
        // is in, exactly like the inbound fan-out.
        if !self.store.agent_in_channel(agent_id, channel_id) || !self.store.agent_dm_route_allowed(channel_id, agent_id) {
            response["error"] = json!("agent is not a member of this channel");
            let _ = handle.tx.send(response);
            return;
        }
        let thread_id = frame["thread_id"].as_i64();
        // Pantheo sends the cursor back as it appeared in the transcript hint,
        // which may make it a string; accept both.
        let before_id = frame["before_id"]
            .as_i64()
            .or_else(|| frame["before_id"].as_str().and_then(|s| s.parse().ok()));
        let limit = frame["limit"]
            .as_i64()
            .unwrap_or(HISTORY_PAGE_DEFAULT)
            .clamp(1, HISTORY_PAGE_MAX) as usize;
        // One extra row decides has_more without a second query; rows are
        // oldest-first, so the surplus row is the head of the page.
        let mut rows = self.store.messages(channel_id, thread_id, before_id, limit + 1);
        let has_more = rows.len() > limit;
        if has_more {
            rows.remove(0);
        }
        let messages: Vec<Value> = rows
            .iter()
            .map(|m| {
                json!({
                    "id": m["id"],
                    "author": {
                        "type": m["author_type"],
                        "id": m["author_id"],
                        "name": m["author_name"],
                    },
                    "text": m["text"],
                    "thread_id": m["thread_id"],
                    "ts": format_ts(m["ts"].as_f64().unwrap_or(0.0)),
                })
            })
            .collect();
        response["messages"] = json!(messages);
        response["has_more"] = json!(has_more);
        let _ = handle.tx.send(response);
    }

    /// A `search_request` from an agent: full-text search over message text,
    /// answered on the same connection as a `search_response` carrying the
    /// frame's `request_id`. Visibility is membership, exactly like history:
    /// with a `channel_id` the agent must be in that channel; without one the
    /// search spans every channel the agent is a member of. Results come back
    /// best match first (`sort: "new"` for newest first, `match: "any"` for
    /// any-term recall); page with `offset`.
    fn handle_search_request(&self, agent_id: &str, frame: &Value) {
        let Some(handle) = self.agent_handle(agent_id) else {
            return; // no live connection to answer on
        };
        let mut response = json!({
            "type": "search_response",
            "request_id": frame["request_id"],
        });
        let query = frame["query"].as_str().unwrap_or_default().trim().to_string();
        let has_files = frame["has_files"].as_bool().unwrap_or(false);
        let file_type = frame["file_type"].as_str().filter(|s| !s.is_empty());
        // A query is required unless an attachment filter is doing the work.
        if query.is_empty() && !has_files && file_type.is_none() {
            response["error"] = json!("query required");
            let _ = handle.tx.send(response);
            return;
        }
        let channel_id = frame["channel_id"].as_str().unwrap_or_default();
        if !channel_id.is_empty() {
            if self.store.channel(channel_id).is_none() {
                response["error"] = json!("unknown channel");
                let _ = handle.tx.send(response);
                return;
            }
            if !self.store.agent_in_channel(agent_id, channel_id) || !self.store.agent_dm_route_allowed(channel_id, agent_id) {
                response["error"] = json!("agent is not a member of this channel");
                let _ = handle.tx.send(response);
                return;
            }
        }
        let limit = frame["limit"]
            .as_i64()
            .unwrap_or(SEARCH_PAGE_DEFAULT)
            .clamp(1, SEARCH_PAGE_MAX) as usize;
        let offset = frame["offset"].as_i64().unwrap_or(0).max(0) as usize;
        let newest_first = frame["sort"].as_str() == Some("new");
        let match_any = frame["match"].as_str() == Some("any");
        // One extra row decides has_more without a second query.
        let mut rows = self.store.search_messages_ext(
            &query,
            match_any,
            (!channel_id.is_empty()).then_some(channel_id),
            None,
            None,
            Some(agent_id),
            None,
            newest_first,
            has_files,
            file_type,
            limit + 1,
            offset,
        );
        let has_more = rows.len() > limit;
        rows.truncate(limit);
        let results: Vec<Value> = rows
            .iter()
            .map(|m| {
                json!({
                    "id": m["id"],
                    "channel_id": m["channel_id"],
                    "channel_name": m["channel_name"],
                    "group_id": m["group_id"],
                    "group_name": m["group_name"],
                    "thread_id": m["thread_id"],
                    "author": {
                        "type": m["author_type"],
                        "id": m["author_id"],
                        "name": m["author_name"],
                    },
                    "text": m["text"],
                    "snippet": m["snippet"],
                    "attachments": m["attachments"],
                    "ts": format_ts(m["ts"].as_f64().unwrap_or(0.0)),
                })
            })
            .collect();
        response["results"] = json!(results);
        response["has_more"] = json!(has_more);
        let _ = handle.tx.send(response);
    }

    fn resolve_options_by_agent(&self, message_id: i64, text: &str) -> Result<Value, &'static str> {
        let message = self.store.message(message_id).ok_or("Message not found")?;
        let meta = message.get("meta").cloned().unwrap_or(Value::Null);
        if meta.get("resolved").map(|r| !r.is_null()).unwrap_or(false) {
            return Err("Options already resolved");
        }
        let resolved = json!({
            "option_id": "",
            "by": "agent",
            "label": text,
            "ts": crate::store::now(),
        });
        let updated = self
            .store
            .update_message_meta(message_id, &json!({"resolved": resolved}))
            .ok_or("Failed to update message")?;
        let channel_id = updated["channel_id"].as_str().unwrap_or_default();
        self.broadcast(
            channel_id,
            &json!({"type": "message_update", "message": updated}),
        );
        Ok(updated)
    }
}

/// Epoch seconds -> "YYYY-MM-DD HH:MM" (UTC). History transcripts are read by
/// language models, so a plain calendar stamp beats a raw epoch number.
pub(crate) fn format_ts(epoch: f64) -> String {
    let secs = epoch as i64;
    let (y, m, d) = civil_from_days(secs.div_euclid(86_400));
    let rem = secs.rem_euclid(86_400);
    format!("{y:04}-{m:02}-{d:02} {:02}:{:02}", rem / 3600, (rem % 3600) / 60)
}

/// Days since 1970-01-01 -> (year, month, day). Howard Hinnant's civil
/// calendar algorithm; exact for the whole proleptic Gregorian range.
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (yoe + era * 400 + i64::from(m <= 2), m, d)
}

fn drop_agent_activity(st: &mut HubState, channel_id: &str, agent_id: &str) {
    if let Some(chan) = st.activity.get_mut(channel_id) {
        chan.typing.remove(agent_id);
        chan.progress.retain(|_, e| e["agent_id"].as_str() != Some(agent_id));
        if chan.typing.is_empty() && chan.progress.is_empty() {
            st.activity.remove(channel_id);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::sync::mpsc::unbounded_channel;

    fn hub() -> Hub {
        Hub::new(Arc::new(Store::open_in_memory().unwrap()))
    }

    fn add_agent(
        h: &Hub,
        id: &str,
        name: &str,
        requires_mention: bool,
    ) -> tokio::sync::mpsc::UnboundedReceiver<Value> {
        add_agent_full(h, id, name, requires_mention, false)
    }

    fn add_agent_full(
        h: &Hub,
        id: &str,
        name: &str,
        requires_mention: bool,
        wants_context_feed: bool,
    ) -> tokio::sync::mpsc::UnboundedReceiver<Value> {
        let (tx, rx) = unbounded_channel();
        let conn_id = h.next_conn_id();
        h.register_agent(AgentHandle {
            agent_id: id.into(),
            agent_name: name.into(),
            requires_mention,
            wants_context_feed,
            has_avatar: false,
            avatar_v: 0,
            source: "test".into(),
            conn_id,
            tx,
        });
        rx
    }

    fn setup_channel(h: &Hub, agents: &[&str]) -> String {
        let g = h.store.create_group("G", "", Some("tom"));
        let gid = g["id"].as_str().unwrap();
        let c = h.store.create_channel(gid, "main", "");
        for a in agents {
            h.store.add_member(gid, "agent", a, "member", None);
        }
        c["id"].as_str().unwrap().to_string()
    }

    /// Drain *rx*, returning the last frame of the given type (posts fan
    /// inbound frames to member agents, so tests skip past those).
    fn last_frame(
        rx: &mut tokio::sync::mpsc::UnboundedReceiver<Value>,
        ftype: &str,
    ) -> Option<Value> {
        let mut found = None;
        while let Ok(f) = rx.try_recv() {
            if f["type"] == ftype {
                found = Some(f);
            }
        }
        found
    }

    fn sample_form() -> Value {
        json!({
            "fields": [
                {"id": "breakfast", "kind": "input", "label": "Breakfast", "placeholder": "e.g. eggs"},
                {"id": "ran_5k", "kind": "checkbox", "label": "Ran 5k", "value": true},
            ],
            "buttons": [
                {"id": "log", "label": "Log it", "style": "primary"},
                {"id": "skip", "label": "Skip today"},
            ],
        })
    }

    /// Post a form-carrying agent message into a fresh channel; returns the
    /// hub, the authoring agent's frame receiver, and the message id.
    fn setup_form() -> (Hub, tokio::sync::mpsc::UnboundedReceiver<Value>, i64) {
        let h = hub();
        let rx = add_agent(&h, "bot-a", "Bot A", false);
        let cid = setup_channel(&h, &["bot-a"]);
        h.handle_agent_frame(&json!({
            "type": "post", "agent_id": "bot-a", "channel_id": cid,
            "text": "Log your day", "form_id": "daily-1", "form": sample_form(),
        }));
        let mid = h.store.messages(&cid, None, None, 50)[0]["id"].as_i64().unwrap();
        (h, rx, mid)
    }

    #[test]
    fn sanitize_form_normalizes_and_rejects() {
        // Whole form dropped: no usable fields / no buttons / bad shape.
        assert!(sanitize_form(&json!({})).is_none());
        assert!(sanitize_form(&json!({"fields": [], "buttons": [{"id": "a", "label": "A"}]})).is_none());
        assert!(sanitize_form(&json!({
            "fields": [{"id": "x", "kind": "input", "label": "X"}], "buttons": [],
        }))
        .is_none());
        assert!(sanitize_form(&json!({
            "fields": [{"id": "bad id!", "kind": "input", "label": "X"}],
            "buttons": [{"id": "a", "label": "A"}],
        }))
        .is_none());

        // Bad entries dropped, dupes deduped, caps applied, styles normalized.
        let many_fields: Vec<Value> = (0..20)
            .map(|i| json!({"id": format!("f{i}"), "kind": "checkbox", "label": "L"}))
            .collect();
        let f = sanitize_form(&json!({
            "fields": many_fields,
            "buttons": [
                {"id": "a", "label": "A", "style": "primary"},
                {"id": "a", "label": "dupe"},
                {"id": "b", "label": "B", "style": "danger"},
                {"id": "c", "label": "over the cap"},
            ],
        }))
        .unwrap();
        assert_eq!(f["fields"].as_array().unwrap().len(), MAX_FORM_FIELDS);
        let buttons = f["buttons"].as_array().unwrap();
        assert_eq!(buttons.len(), 2);
        assert_eq!(buttons[0]["style"], "primary");
        assert_eq!(buttons[1]["id"], "b");
        assert_eq!(buttons[1]["style"], "secondary"); // unknown style normalized

        // Typed initial values: inputs stringly (clipped), checkboxes bool.
        let f = sanitize_form(&json!({
            "fields": [
                {"id": "a", "kind": "input", "label": "A", "value": "x".repeat(MAX_FORM_VALUE_CHARS * 2)},
                {"id": "b", "kind": "checkbox", "label": "B", "value": "yes"},
                {"id": "c", "kind": "dropdown", "label": "C"},
            ],
            "buttons": [{"id": "ok", "label": "OK"}],
        }))
        .unwrap();
        let fields = f["fields"].as_array().unwrap();
        assert_eq!(fields.len(), 2); // unknown kind dropped
        assert_eq!(fields[0]["value"].as_str().unwrap().len(), MAX_FORM_VALUE_CHARS);
        assert_eq!(fields[1]["value"], false); // non-bool coerced
    }

    #[test]
    fn form_post_seeds_state_and_bad_forms_drop() {
        let (h, _rx, mid) = setup_form();
        let meta = &h.store.message(mid).unwrap()["meta"];
        assert_eq!(meta["form_id"], "daily-1");
        assert_eq!(meta["form"]["fields"].as_array().unwrap().len(), 2);
        assert_eq!(meta["form_state"]["breakfast"], "");
        assert_eq!(meta["form_state"]["ran_5k"], true);
        assert!(meta["form_submitted"].is_null());

        // A malformed form is dropped while the post still lands.
        let cid = h.store.message(mid).unwrap()["channel_id"].as_str().unwrap().to_string();
        h.handle_agent_frame(&json!({
            "type": "post", "agent_id": "bot-a", "channel_id": cid,
            "text": "no form here", "form": {"fields": "nope"},
        }));
        let msgs = h.store.messages(&cid, None, None, 50);
        let last = msgs.last().unwrap();
        assert_eq!(last["text"], "no form here");
        assert!(last["meta"].get("form").is_none());
    }

    #[test]
    fn form_field_updates_persist_and_validate() {
        let (h, _rx, mid) = setup_form();
        let updated = h.update_form_field(mid, "breakfast", &json!("eggs")).unwrap();
        assert_eq!(updated["meta"]["form_state"]["breakfast"], "eggs");
        let updated = h.update_form_field(mid, "ran_5k", &json!(false)).unwrap();
        assert_eq!(updated["meta"]["form_state"]["ran_5k"], false);

        assert_eq!(h.update_form_field(mid, "nope", &json!("x")), Err("Unknown field"));
        assert_eq!(
            h.update_form_field(mid, "breakfast", &json!(true)),
            Err("Expected a string value")
        );
        assert_eq!(
            h.update_form_field(mid, "ran_5k", &json!("yes")),
            Err("Expected a boolean value")
        );
        assert_eq!(
            h.update_form_field(mid, "breakfast", &json!("x".repeat(MAX_FORM_VALUE_CHARS + 1))),
            Err("Value too long")
        );
        // A formless message takes no form writes.
        let cid = h.store.message(mid).unwrap()["channel_id"].as_str().unwrap().to_string();
        let plain = h.post_user_message(&cid, "plain", "tom", None, None, vec![]);
        assert_eq!(
            h.update_form_field(plain["id"].as_i64().unwrap(), "breakfast", &json!("x")),
            Err("Message has no form")
        );
    }

    #[test]
    fn form_submit_locks_snapshots_and_notifies_agent() {
        let (h, mut rx, mid) = setup_form();
        h.update_form_field(mid, "breakfast", &json!("eggs")).unwrap();

        assert_eq!(h.submit_form(mid, "nope", "tom"), Err("Unknown button"));
        let updated = h.submit_form(mid, "log", "tom").unwrap();
        let submitted = &updated["meta"]["form_submitted"];
        assert_eq!(submitted["button_id"], "log");
        assert_eq!(submitted["by"], "tom");
        assert_eq!(submitted["values"]["breakfast"], "eggs");
        assert_eq!(submitted["values"]["ran_5k"], true);

        // The authoring agent hears exactly one form_submit with the values.
        let frame = last_frame(&mut rx, "form_submit").unwrap();
        assert_eq!(frame["form_id"], "daily-1");
        assert_eq!(frame["button_id"], "log");
        assert_eq!(frame["message_id"].as_i64(), Some(mid));
        assert_eq!(frame["values"]["breakfast"], "eggs");
        assert_eq!(frame["user"]["name"], "tom");

        // One-shot: the loser of the race and later edits both bounce.
        assert_eq!(h.submit_form(mid, "skip", "ana"), Err("Form already submitted"));
        assert_eq!(
            h.update_form_field(mid, "breakfast", &json!("toast")),
            Err("Form already submitted")
        );
        // The recorded submission still names the winner.
        let meta = &h.store.message(mid).unwrap()["meta"];
        assert_eq!(meta["form_submitted"]["by"], "tom");
    }

    #[test]
    fn history_request_pages_newest_first_with_cursor() {
        let h = hub();
        let mut rx = add_agent(&h, "bot-a", "Bot A", false);
        let cid = setup_channel(&h, &["bot-a"]);
        for i in 1..=5 {
            h.post_user_message(&cid, &format!("m{i}"), "tom", Some("Tom"), None, vec![]);
        }

        h.handle_agent_frame(&json!({
            "type": "history_request", "request_id": "r1", "agent_id": "bot-a",
            "channel_id": cid, "thread_id": null, "limit": 2,
        }));
        let resp = last_frame(&mut rx, "history_response").unwrap();
        assert_eq!(resp["request_id"], "r1");
        assert_eq!(resp["has_more"], true);
        let msgs = resp["messages"].as_array().unwrap();
        // Most recent page, oldest-first within it.
        let texts: Vec<_> = msgs.iter().map(|m| m["text"].as_str().unwrap()).collect();
        assert_eq!(texts, ["m4", "m5"]);
        assert_eq!(msgs[0]["author"]["name"], "Tom");
        assert_eq!(msgs[0]["author"]["type"], "user");
        assert!(msgs[0]["ts"].as_str().unwrap().len() == 16); // "YYYY-MM-DD HH:MM"

        // Page back with the cursor (as a string, the way Pantheo relays it).
        let oldest = msgs[0]["id"].as_i64().unwrap();
        h.handle_agent_frame(&json!({
            "type": "history_request", "request_id": "r2", "agent_id": "bot-a",
            "channel_id": cid, "limit": 2, "before_id": oldest.to_string(),
        }));
        let resp = last_frame(&mut rx, "history_response").unwrap();
        let texts: Vec<_> = resp["messages"]
            .as_array()
            .unwrap()
            .iter()
            .map(|m| m["text"].as_str().unwrap())
            .collect();
        assert_eq!(texts, ["m2", "m3"]);
        assert_eq!(resp["has_more"], true);

        // Final page exhausts the channel.
        let oldest = resp["messages"][0]["id"].as_i64().unwrap();
        h.handle_agent_frame(&json!({
            "type": "history_request", "request_id": "r3", "agent_id": "bot-a",
            "channel_id": cid, "limit": 2, "before_id": oldest,
        }));
        let resp = last_frame(&mut rx, "history_response").unwrap();
        let msgs = resp["messages"].as_array().unwrap();
        assert_eq!(msgs.len(), 1);
        assert_eq!(msgs[0]["text"], "m1");
        assert_eq!(resp["has_more"], false);
    }

    #[test]
    fn history_request_scopes_to_a_thread() {
        let h = hub();
        let mut rx = add_agent(&h, "bot-a", "Bot A", false);
        let cid = setup_channel(&h, &["bot-a"]);
        let root = h.post_user_message(&cid, "root", "tom", None, None, vec![]);
        let tid = root["id"].as_i64().unwrap();
        h.post_user_message(&cid, "in thread", "tom", None, Some(tid), vec![]);
        h.post_user_message(&cid, "top level", "tom", None, None, vec![]);

        h.handle_agent_frame(&json!({
            "type": "history_request", "request_id": "r1", "agent_id": "bot-a",
            "channel_id": cid, "thread_id": tid,
        }));
        let resp = last_frame(&mut rx, "history_response").unwrap();
        let msgs = resp["messages"].as_array().unwrap();
        assert_eq!(msgs.len(), 1);
        assert_eq!(msgs[0]["text"], "in thread");
        assert_eq!(msgs[0]["thread_id"].as_i64(), Some(tid));
    }

    #[test]
    fn history_request_denied_outside_membership() {
        let h = hub();
        let _rx_a = add_agent(&h, "bot-a", "Bot A", false);
        let mut rx_b = add_agent(&h, "bot-b", "Bot B", false);
        let cid = setup_channel(&h, &["bot-a"]); // bot-b is live but not a member
        h.post_user_message(&cid, "secret", "tom", None, None, vec![]);

        h.handle_agent_frame(&json!({
            "type": "history_request", "request_id": "r1", "agent_id": "bot-b",
            "channel_id": cid,
        }));
        let resp = last_frame(&mut rx_b, "history_response").unwrap();
        assert_eq!(resp["error"], "agent is not a member of this channel");
        assert!(resp.get("messages").is_none());

        // Unknown channels answer with an error too (never a silent drop —
        // the agent side is awaiting this request_id).
        h.handle_agent_frame(&json!({
            "type": "history_request", "request_id": "r2", "agent_id": "bot-b",
            "channel_id": "nope",
        }));
        let resp = last_frame(&mut rx_b, "history_response").unwrap();
        assert_eq!(resp["request_id"], "r2");
        assert_eq!(resp["error"], "unknown channel");
    }

    #[test]
    fn history_request_limit_is_defaulted_and_capped() {
        let h = hub();
        let mut rx = add_agent(&h, "bot-a", "Bot A", false);
        let cid = setup_channel(&h, &["bot-a"]);
        for i in 1..=(HISTORY_PAGE_MAX + 5) {
            h.post_user_message(&cid, &format!("m{i}"), "tom", None, None, vec![]);
        }

        // No limit named -> the default page size.
        h.handle_agent_frame(&json!({
            "type": "history_request", "request_id": "r1", "agent_id": "bot-a",
            "channel_id": cid,
        }));
        let resp = last_frame(&mut rx, "history_response").unwrap();
        assert_eq!(resp["messages"].as_array().unwrap().len() as i64, HISTORY_PAGE_DEFAULT);

        // An oversized ask is clamped to the cap, never trusted.
        h.handle_agent_frame(&json!({
            "type": "history_request", "request_id": "r2", "agent_id": "bot-a",
            "channel_id": cid, "limit": 9999,
        }));
        let resp = last_frame(&mut rx, "history_response").unwrap();
        assert_eq!(resp["messages"].as_array().unwrap().len() as i64, HISTORY_PAGE_MAX);
        assert_eq!(resp["has_more"], true);
    }

    #[test]
    fn notifications_only_when_ui_inactive_and_throttled() {
        let h = hub();
        let _rx = add_agent(&h, "bot-a", "Bot A", false);
        let cid = setup_channel(&h, &["bot-a"]);
        let seen: Arc<Mutex<Vec<NotifyEvent>>> = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&seen);
        h.set_notifier(move |ev| sink.lock().unwrap().push(ev));

        // Focused window: the in-app badge is enough, no banner.
        h.set_ui_active(true);
        h.post_agent_message("bot-a", "Bot A", &cid, "hi", None);
        assert!(seen.lock().unwrap().is_empty());

        h.set_ui_active(false);
        h.post_agent_message("bot-a", "Bot A", &cid, "are you there?", None);
        {
            let events = seen.lock().unwrap();
            assert_eq!(events.len(), 1);
            assert_eq!(events[0].title, "Bot A — G / #main");
            assert_eq!(events[0].body, "are you there?");
            assert_eq!(events[0].channel_id, cid);
        }

        // A burst right after stays one banner (per-channel throttle).
        h.post_agent_message("bot-a", "Bot A", &cid, "hello?", None);
        assert_eq!(seen.lock().unwrap().len(), 1);

        // A user's own post never notifies.
        h.post_user_message(&cid, "back!", "tom", None, None, vec![]);
        assert_eq!(seen.lock().unwrap().len(), 1);
    }

    #[test]
    fn notification_body_is_truncated() {
        let h = hub();
        let _rx = add_agent(&h, "bot-a", "Bot A", false);
        let cid = setup_channel(&h, &["bot-a"]);
        let seen: Arc<Mutex<Vec<NotifyEvent>>> = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&seen);
        h.set_notifier(move |ev| sink.lock().unwrap().push(ev));
        h.set_ui_active(false);
        h.post_agent_message("bot-a", "Bot A", &cid, &"x".repeat(500), None);
        let events = seen.lock().unwrap();
        assert_eq!(events[0].body.chars().count(), NOTIFY_BODY_MAX_CHARS + 1);
        assert!(events[0].body.ends_with('…'));
    }

    #[test]
    fn fan_out_reaches_member_agents_only() {
        let h = hub();
        let mut rx_a = add_agent(&h, "bot-a", "Bot A", false);
        let mut rx_b = add_agent(&h, "bot-b", "Bot B", false);
        let cid = setup_channel(&h, &["bot-a"]);
        h.post_user_message(&cid, "hello", "tom", Some("Tom"), None, vec![]);
        let frame = rx_a.try_recv().unwrap();
        assert_eq!(frame["type"], "inbound");
        assert_eq!(frame["agent_id"], "bot-a");
        assert_eq!(frame["text"], "hello");
        assert!(frame["context_note"].as_str().unwrap().contains("#main"));
        assert!(rx_b.try_recv().is_err());
    }

    #[test]
    fn requires_mention_gates() {
        let h = hub();
        let mut rx = add_agent(&h, "bot-a", "Bot A", true);
        let cid = setup_channel(&h, &["bot-a"]);
        h.post_user_message(&cid, "hello", "tom", None, None, vec![]);
        assert!(rx.try_recv().is_err());
        h.post_user_message(&cid, "hey @bot-a", "tom", None, None, vec![]);
        let frame = rx.try_recv().unwrap();
        assert_eq!(frame["mentioned"], true);
    }

    #[test]
    fn mention_matches_slugified_name() {
        let h = hub();
        let mut rx = add_agent(&h, "agent-1", "Data Cruncher", true);
        let cid = setup_channel(&h, &["agent-1"]);
        h.post_user_message(&cid, "@data-cruncher go", "tom", None, None, vec![]);
        assert_eq!(rx.try_recv().unwrap()["mentioned"], true);
    }

    #[test]
    fn any_mention_flag_reflects_agent_tags() {
        let h = hub();
        let mut rx_a = add_agent(&h, "bot-a", "Bot A", false);
        let mut rx_b = add_agent(&h, "bot-b", "Bot B", false);
        let cid = setup_channel(&h, &["bot-a", "bot-b"]);
        // No agent tagged: both hear it and the floor is open.
        h.post_user_message(&cid, "anyone around?", "tom", None, None, vec![]);
        let fa = rx_a.try_recv().unwrap();
        assert_eq!(fa["mentioned"], false);
        assert_eq!(fa["any_mention"], false);
        assert_eq!(rx_b.try_recv().unwrap()["any_mention"], false);
        // One agent tagged: the other still receives it (so it can buffer), but
        // `any_mention` tells it the floor is taken so it can stay silent.
        h.post_user_message(&cid, "hey @bot-a", "tom", None, None, vec![]);
        let fa = rx_a.try_recv().unwrap();
        assert_eq!(fa["mentioned"], true);
        assert_eq!(fa["any_mention"], true);
        let fb = rx_b.try_recv().unwrap();
        assert_eq!(fb["mentioned"], false);
        assert_eq!(fb["any_mention"], true);
    }

    #[test]
    fn require_agent_closes_floor_on_thread_replies() {
        let h = hub();
        let mut rx_a = add_agent(&h, "bot-a", "Bot A", false);
        let mut rx_b = add_agent(&h, "bot-b", "Bot B", false);
        let cid = setup_channel(&h, &["bot-a", "bot-b"]);
        let root = h.post_user_message(&cid, "root", "tom", None, None, vec![]);
        let root_id = root["id"].as_i64();
        let _ = rx_a.try_recv();
        let _ = rx_b.try_recv();

        // Toggle on, no tag: both hear it, floor closed, require_agent flagged.
        let msg = h.post_user_message_opts(
            &cid, "note for humans", "tom", None, root_id, vec![], false, None, false, true,
        );
        assert_eq!(msg["meta"]["client"]["require_agent"], true);
        let fa = rx_a.try_recv().unwrap();
        assert_eq!(fa["mentioned"], false);
        assert_eq!(fa["any_mention"], true);
        assert_eq!(fa["require_agent"], true);
        let fb = rx_b.try_recv().unwrap();
        assert_eq!(fb["mentioned"], false);
        assert_eq!(fb["any_mention"], true);
        assert_eq!(fb["require_agent"], true);

        // Toggle on + tag: tagged agent still mentioned; OR is a no-op.
        h.post_user_message_opts(
            &cid, "hey @bot-a", "tom", None, root_id, vec![], false, None, false, true,
        );
        let fa = rx_a.try_recv().unwrap();
        assert_eq!(fa["mentioned"], true);
        assert_eq!(fa["any_mention"], true);
        assert_eq!(fa["require_agent"], true);
        let fb = rx_b.try_recv().unwrap();
        assert_eq!(fb["mentioned"], false);
        assert_eq!(fb["any_mention"], true);

        // Ignored on top-level (even when asked) and on voice turns.
        let top = h.post_user_message_opts(
            &cid, "channel note", "tom", None, None, vec![], false, None, false, true,
        );
        assert!(top["meta"]["client"]["require_agent"].is_null());
        assert_eq!(rx_a.try_recv().unwrap()["any_mention"], false);
        let _ = rx_b.try_recv();
        let spoken = h.post_user_message_opts(
            &cid, "spoken", "tom", None, root_id, vec![], true, None, false, true,
        );
        assert!(spoken["meta"]["client"]["require_agent"].is_null());
        assert_eq!(rx_a.try_recv().unwrap()["require_agent"], false);
    }

    #[test]
    fn context_feed_delivers_unmentioned_agent_messages() {
        let h = hub();
        let mut rx_feed = add_agent_full(&h, "claude", "Claude", false, true);
        let mut rx_plain = add_agent(&h, "bot-b", "Bot B", false);
        let _rx_c = add_agent(&h, "bot-c", "Bot C", false);
        let cid = setup_channel(&h, &["claude", "bot-b", "bot-c"]);
        // bot-c speaks without tagging anyone.
        h.post_agent_message("bot-c", "Bot C", &cid, "thinking out loud", None);
        // The context-feed agent gets a copy (unmentioned) so it can buffer.
        let f = rx_feed.try_recv().unwrap();
        assert_eq!(f["type"], "inbound");
        assert_eq!(f["mentioned"], false);
        assert_eq!(f["from_bot"], true);
        // A plain agent does not — relay-only-when-mentioned is unchanged.
        assert!(rx_plain.try_recv().is_err());
    }

    #[test]
    fn agent_relay_mention_only_and_loop_cap() {
        let h = hub();
        let _rx_a = add_agent(&h, "bot-a", "Bot A", false);
        let mut rx_b = add_agent(&h, "bot-b", "Bot B", false);
        let cid = setup_channel(&h, &["bot-a", "bot-b"]);
        // Agent message without mention: no relay.
        h.post_agent_message("bot-a", "Bot A", &cid, "just musing", None);
        assert!(rx_b.try_recv().is_err());
        // With mention: relayed while under the cap.
        for _ in 0..BOT_LOOP_LIMIT {
            h.post_agent_message("bot-a", "Bot A", &cid, "hey @bot-b", None);
        }
        // 1 message already posted + BOT_LOOP_LIMIT more = cap exceeded on last.
        // Each relayed frame carries the remaining agent-turn budget, counting
        // down to 0 as the streak approaches the cap.
        let mut turns = Vec::new();
        while let Ok(f) = rx_b.try_recv() {
            turns.push(f["bot_turns_left"].as_i64().unwrap());
        }
        let expected: Vec<i64> = (0..=BOT_LOOP_LIMIT - 2).rev().collect();
        assert_eq!(turns, expected);
        // Human speaking resets the streak; human frames carry no budget field.
        h.post_user_message(&cid, "humans back", "tom", None, None, vec![]);
        let f = rx_b.try_recv().unwrap();
        assert!(f["bot_turns_left"].is_null());
        h.post_agent_message("bot-a", "Bot A", &cid, "hi again @bot-b", None);
        let f = rx_b.try_recv().unwrap();
        assert_eq!(f["bot_turns_left"].as_i64().unwrap(), BOT_LOOP_LIMIT - 1);
    }

    #[test]
    fn bot_turns_left_rides_agent_frames_only() {
        let h = hub();
        let _rx_a = add_agent(&h, "bot-a", "Bot A", false);
        let mut rx_b = add_agent(&h, "bot-b", "Bot B", false);
        let cid = setup_channel(&h, &["bot-a", "bot-b"]);
        h.post_user_message(&cid, "hello", "tom", None, None, vec![]);
        assert!(rx_b.try_recv().unwrap()["bot_turns_left"].is_null());
        // One agent message past the cap: only BOT_LOOP_LIMIT are relayed,
        // budgets counting down to 0, but every message is stored for humans.
        for _ in 0..=BOT_LOOP_LIMIT {
            h.post_agent_message("bot-a", "Bot A", &cid, "ping @bot-b", None);
        }
        let mut turns = Vec::new();
        while let Ok(f) = rx_b.try_recv() {
            turns.push(f["bot_turns_left"].as_i64().unwrap());
        }
        assert_eq!(turns, (0..BOT_LOOP_LIMIT).rev().collect::<Vec<i64>>());
        assert_eq!(
            h.store.messages(&cid, None, None, 50).len() as i64,
            BOT_LOOP_LIMIT + 2
        );
    }

    #[test]
    fn context_note_includes_collab_etiquette_with_peers() {
        let h = hub();
        let mut rx_a = add_agent(&h, "bot-a", "Bot A", false);
        let cid = setup_channel(&h, &["bot-a", "bot-b"]);
        // Peer is a member but offline: no etiquette note.
        h.post_user_message(&cid, "hi", "tom", None, None, vec![]);
        let note = rx_a.try_recv().unwrap()["context_note"].as_str().unwrap().to_string();
        assert!(!note.contains("Other agents here are colleagues"));
        // Peer comes online: etiquette (with the cap) appears.
        let _rx_b = add_agent(&h, "bot-b", "Bot B", false);
        h.post_user_message(&cid, "hi again", "tom", None, None, vec![]);
        let note = rx_a.try_recv().unwrap()["context_note"].as_str().unwrap().to_string();
        assert!(note.contains("Other agents here are colleagues"));
        assert!(note.contains(&format!(
            "{BOT_LOOP_LIMIT} consecutive agent messages"
        )));
    }

    #[test]
    fn voice_turn_rides_fan_out_and_steers_context_note() {
        let h = hub();
        let mut rx = add_agent(&h, "bot-a", "Bot A", false);
        let cid = setup_channel(&h, &["bot-a"]);
        // Normal message: not a voice turn, markdown hint present.
        h.post_user_message(&cid, "hello", "tom", None, None, vec![]);
        let frame = rx.try_recv().unwrap();
        assert_eq!(frame["voice_live"], false);
        assert!(frame["context_note"].as_str().unwrap().contains("Markdown"));
        // Live voice turn: flagged, spoken-prose steering replaces the hint.
        let msg = h.post_user_message_opts(&cid, "spoken words", "tom", None, None, vec![], true, None, false, false);
        // The stored message is a plain transcript — nothing voice-specific.
        assert_eq!(msg["text"], "spoken words");
        let frame = rx.try_recv().unwrap();
        assert_eq!(frame["voice_live"], true);
        let note = frame["context_note"].as_str().unwrap();
        assert!(note.contains("read out by text-to-speech"));
        assert!(!note.contains("Markdown"));
    }

    #[test]
    fn timezone_rides_meta_and_inbound_frame() {
        let h = hub();
        let mut rx = add_agent(&h, "bot-a", "Bot A", false);
        let cid = setup_channel(&h, &["bot-a"]);
        let msg = h.post_user_message_opts(
            &cid, "what time is it?", "tom", None, None, vec![], false,
            Some("Asia/Kolkata"), false, false,
        );
        // Stored hidden in meta (the UI only renders meta.options/resolved).
        assert_eq!(msg["meta"]["client"]["tz"], "Asia/Kolkata");
        // Forwarded to agents with the server receipt time.
        let frame = rx.try_recv().unwrap();
        assert_eq!(frame["timezone"], "Asia/Kolkata");
        assert!(frame["ts"].as_f64().unwrap() > 0.0);
        // No timezone: frame field is null, meta stays empty.
        let msg = h.post_user_message(&cid, "plain", "tom", None, None, vec![]);
        assert!(msg["meta"].is_null());
        let frame = rx.try_recv().unwrap();
        assert!(frame["timezone"].is_null());
    }

    #[test]
    fn thread_root_seeds_context() {
        let h = hub();
        let mut rx = add_agent(&h, "bot-a", "Bot A", false);
        let cid = setup_channel(&h, &["bot-a"]);
        let root = h.post_user_message(&cid, "the plan doc", "tom", None, None, vec![]);
        rx.try_recv().unwrap();
        let root_id = root["id"].as_i64();
        h.post_user_message(&cid, "thoughts?", "tom", None, root_id, vec![]);
        let frame = rx.try_recv().unwrap();
        assert!(frame["text"].as_str().unwrap().starts_with("[thread on: \"the plan doc\""));
        // Second reply: no re-seeding.
        h.post_user_message(&cid, "more", "tom", None, root_id, vec![]);
        assert_eq!(rx.try_recv().unwrap()["text"], "more");
    }

    #[test]
    fn unregister_connection_drops_agents_and_activity() {
        let h = hub();
        let (tx, _rx) = unbounded_channel();
        let conn_id = h.next_conn_id();
        h.register_agent(AgentHandle {
            agent_id: "bot-a".into(),
            agent_name: "Bot A".into(),
            requires_mention: false,
            wants_context_feed: false,
            has_avatar: false,
            avatar_v: 0,
            source: "test".into(),
            conn_id,
            tx,
        });
        let cid = setup_channel(&h, &["bot-a"]);
        h.post_transient(
            &cid,
            json!({"type": "typing", "channel_id": cid, "agent_id": "bot-a", "agent_name": "Bot A", "active": true}),
        );
        assert_eq!(h.channel_activity(&cid)["typing"].as_array().unwrap().len(), 1);
        let gone = h.unregister_connection(conn_id);
        assert_eq!(gone, vec!["bot-a".to_string()]);
        assert!(h.live_agent_ids().is_empty());
        assert!(h.channel_activity(&cid)["typing"].as_array().unwrap().is_empty());
        // Still remembered for the member picker.
        assert!(h.store.agent("bot-a").is_some());
    }

    #[test]
    fn ui_broadcast_respects_membership() {
        let h = hub();
        let cid = setup_channel(&h, &[]);
        let group_id = h.store.channel(&cid).unwrap()["group_id"].as_str().unwrap().to_string();
        let sibling = h.store.create_channel(&group_id, "sibling", "");
        let sibling_id = sibling["id"].as_str().unwrap().to_string();
        h.store.create_user("alice", "Alice", None, "member");
        h.store.add_member(&group_id, "user", "alice", "member", Some(&cid));
        let (tx_member, mut rx_member) = unbounded_channel();
        let (tx_out, mut rx_out) = unbounded_channel();
        let (tx_root, mut rx_root) = unbounded_channel();
        let (tx_scoped, mut rx_scoped) = unbounded_channel();
        h.attach_socket("tom", false, tx_member);
        h.attach_socket("mallory", false, tx_out);
        h.attach_socket("root", true, tx_root);
        h.attach_socket("alice", false, tx_scoped);
        h.post_user_message(&cid, "hi", "tom", None, None, vec![]);
        assert_eq!(rx_member.try_recv().unwrap()["type"], "message");
        assert!(rx_out.try_recv().is_err());
        assert_eq!(rx_root.try_recv().unwrap()["type"], "message");
        assert_eq!(rx_scoped.try_recv().unwrap()["type"], "message");
        // Transient events (typing, pins) honor the same visibility line.
        h.post_transient(&cid, json!({"type": "pin", "channel_id": cid, "pinned": true}));
        assert_eq!(rx_member.try_recv().unwrap()["type"], "pin");
        assert!(rx_out.try_recv().is_err());
        assert_eq!(rx_root.try_recv().unwrap()["type"], "pin");
        assert_eq!(rx_scoped.try_recv().unwrap()["type"], "pin");
        h.post_user_message(&sibling_id, "secret sibling", "tom", None, None, vec![]);
        assert!(rx_scoped.try_recv().is_err());
    }

    #[test]
    fn agent_dm_broadcast_and_routing_are_private_and_implicit() {
        let h = hub();
        h.store.create_user("alice", "Alice", None, "member");
        h.store.create_user("root", "Root", None, "admin");
        let mut agent_rx = add_agent(&h, "bot-a", "Bot A", true);
        h.store.set_agent_dm_policy("bot-a", false, &["alice".into()]);
        let dm = h.store.open_agent_dm("alice", "bot-a", "Bot A");
        let cid = dm["id"].as_str().unwrap().to_string();
        let (owner_tx, mut owner_rx) = unbounded_channel();
        let (admin_tx, mut admin_rx) = unbounded_channel();
        h.attach_socket("alice", false, owner_tx);
        h.attach_socket("root", true, admin_tx);
        h.post_user_message(&cid, "hello without a mention", "alice", Some("Alice"), None, vec![]);
        assert_eq!(owner_rx.try_recv().unwrap()["type"], "message");
        assert!(admin_rx.try_recv().is_err());
        let inbound = last_frame(&mut agent_rx, "inbound").unwrap();
        assert_eq!(inbound["mentioned"], true);
        assert!(inbound["context_note"].as_str().unwrap().contains("private Agora direct message"));

        h.store.set_agent_dm_policy("bot-a", false, &[]);
        h.handle_agent_frame(&json!({
            "type": "post", "agent_id": "bot-a", "channel_id": cid,
            "request_id": "revoked", "text": "must not land",
        }));
        assert_eq!(last_frame(&mut agent_rx, "error").unwrap()["error"], "agent DM access has been revoked");
        assert_eq!(h.store.messages(&cid, None, None, 50).len(), 1);
    }

    #[test]
    fn mentions_recorded_for_group_users() {
        let h = hub();
        let _rx = add_agent(&h, "bot-a", "Bot A", false);
        let cid = setup_channel(&h, &["bot-a"]);
        // Self-mention: not recorded (and your own post acks the channel).
        h.post_user_message(&cid, "note to @tom self", "tom", None, None, vec![]);
        let u = h.store.unread_counts("tom", &[cid.clone()]);
        assert_eq!(u[&cid]["mentions"], 0);
        // Agent @mentions tom: recorded. Unknown token: not recorded.
        h.post_agent_message("bot-a", "Bot A", &cid, "ping @tom", None);
        h.post_agent_message("bot-a", "Bot A", &cid, "cc @nobody", None);
        let u = h.store.unread_counts("tom", &[cid.clone()]);
        assert_eq!(u[&cid]["mentions"], 1);
    }

    #[test]
    fn agent_reactions_are_attributed_broadcast_and_membership_checked() {
        let h = hub();
        let _agent_rx = add_agent(&h, "bot-a", "Bot A", false);
        let _outsider_rx = add_agent(&h, "bot-b", "Bot B", false);
        let cid = setup_channel(&h, &["bot-a"]);
        let message = h.post_user_message(&cid, "please investigate", "tom", None, None, vec![]);
        let mid = message["id"].as_i64().unwrap();
        let (tx, mut rx) = unbounded_channel();
        h.attach_socket("tom", false, tx);

        h.handle_agent_frame(&json!({
            "type": "reaction", "agent_id": "bot-a", "channel_id": cid,
            "message_id": mid, "emoji": "👀", "action": "add",
        }));
        let reactions = h.store.message(mid).unwrap()["reactions"].clone();
        assert_eq!(reactions[0]["users"], json!(["Bot A"]));
        assert_eq!(reactions[0]["reactors"], json!([
            {"type": "agent", "id": "bot-a", "name": "Bot A"}
        ]));
        assert_eq!(rx.try_recv().unwrap()["type"], "message_update");

        // A connected agent that is not a member cannot react in the room.
        h.handle_agent_frame(&json!({
            "type": "reaction", "agent_id": "bot-b", "channel_id": cid,
            "message_id": mid, "emoji": "✅", "action": "add",
        }));
        assert_eq!(h.store.message(mid).unwrap()["reactions"].as_array().unwrap().len(), 1);

        h.handle_agent_frame(&json!({
            "type": "reaction", "agent_id": "bot-a", "channel_id": cid,
            "message_id": mid, "emoji": "👀", "action": "remove",
        }));
        assert_eq!(h.store.message(mid).unwrap()["reactions"], json!([]));
    }

    #[test]
    fn thread_read_events_go_to_acking_user_only() {
        let h = hub();
        let cid = setup_channel(&h, &[]);
        h.store.add_member(
            h.store.channel(&cid).unwrap()["group_id"].as_str().unwrap(),
            "user",
            "alice",
            "member",
            None,
        );
        let root = h.post_user_message(&cid, "root", "tom", None, None, vec![]);
        let root_id = root["id"].as_i64().unwrap();
        h.post_user_message(&cid, "reply", "tom", None, Some(root_id), vec![]);
        let (tx_tom, mut rx_tom) = unbounded_channel();
        let (tx_alice, mut rx_alice) = unbounded_channel();
        h.attach_socket("tom", false, tx_tom);
        h.attach_socket("alice", false, tx_alice);
        let reads: Arc<Mutex<Vec<ReadNotifyEvent>>> = Arc::new(Mutex::new(Vec::new()));
        let read_sink = Arc::clone(&reads);
        h.set_read_notifier(move |ev| read_sink.lock().unwrap().push(ev));
        h.mark_thread_read("alice", root_id, None);
        let ev = rx_alice.try_recv().unwrap();
        assert_eq!(ev["type"], "thread_read");
        assert_eq!(ev["thread_id"], root_id);
        assert_eq!(ev["channel_id"], cid);
        assert!(rx_tom.try_recv().is_err());
        let reads = reads.lock().unwrap();
        assert_eq!(reads.len(), 1);
        assert_eq!(reads[0].channel_id, cid);
        assert_eq!(reads[0].thread_id, Some(root_id));
        assert!(reads[0].last_read_id > root_id);
    }

    #[test]
    fn reply_in_thread_ask_threads_agent_replies_under_the_message() {
        let h = hub();
        let mut rx = add_agent(&h, "bot-a", "Bot A", false);
        let cid = setup_channel(&h, &["bot-a"]);

        let msg = h.post_user_message_opts(
            &cid, "explain x", "tom", Some("Tom"), None, vec![], false, None, true, false,
        );
        let mid = msg["id"].as_i64().unwrap();
        // The stored message stays a top-level root, the ask hidden in meta...
        assert!(msg["thread_id"].is_null());
        assert_eq!(msg["meta"]["client"]["reply_thread"], true);
        // ...but agents are addressed as if it were already a thread root.
        let inbound = last_frame(&mut rx, "inbound").unwrap();
        assert_eq!(inbound["thread_id"].as_i64(), Some(mid));
        assert_eq!(inbound["message_id"].as_i64(), Some(mid));

        // The agent echoes thread_id (as bridges do): the reply is a thread reply.
        h.handle_agent_frame(&json!({
            "type": "post", "agent_id": "bot-a", "channel_id": cid,
            "thread_id": mid, "text": "the answer",
        }));
        assert_eq!(h.store.thread_size(mid), 1);

        // On a thread reply the ask is meaningless: dropped from meta, the
        // message keeps its own thread, no re-rooting.
        let reply = h.post_user_message_opts(
            &cid, "follow-up", "tom", Some("Tom"), Some(mid), vec![], false, None, true, false,
        );
        assert!(reply["meta"]["client"]["reply_thread"].is_null());
        let inbound = last_frame(&mut rx, "inbound").unwrap();
        assert_eq!(inbound["thread_id"].as_i64(), Some(mid));

        // Live-voice turns are exempt: replies read aloud, not threaded.
        let spoken = h.post_user_message_opts(
            &cid, "say hi", "tom", Some("Tom"), None, vec![], true, None, true, false,
        );
        assert!(spoken["meta"]["client"]["reply_thread"].is_null());
        let inbound = last_frame(&mut rx, "inbound").unwrap();
        assert!(inbound["thread_id"].is_null());
    }

    #[test]
    fn agent_replies_stay_top_level_without_reply_in_thread_ask() {
        let h = hub();
        let mut rx = add_agent(&h, "bot-a", "Bot A", false);
        let cid = setup_channel(&h, &["bot-a"]);
        h.post_user_message(&cid, "explain x", "tom", Some("Tom"), None, vec![]);
        let inbound = last_frame(&mut rx, "inbound").unwrap();
        assert!(inbound["thread_id"].is_null());
    }

    #[test]
    fn own_thread_reply_acks_thread_marker() {
        let h = hub();
        let cid = setup_channel(&h, &[]);
        let root = h.post_user_message(&cid, "root", "tom", None, None, vec![]);
        let root_id = root["id"].as_i64().unwrap();
        h.post_user_message(&cid, "my reply", "tom", None, Some(root_id), vec![]);
        let threads = h.store.my_threads("tom", 10);
        assert_eq!(threads.len(), 1);
        assert_eq!(threads[0]["unread"], 0);
    }

    #[test]
    fn read_events_go_to_acking_user_only() {
        let h = hub();
        let cid = setup_channel(&h, &[]);
        h.store.add_member(
            h.store.channel(&cid).unwrap()["group_id"].as_str().unwrap(),
            "user",
            "alice",
            "member",
            None,
        );
        let (tx_tom, mut rx_tom) = unbounded_channel();
        let (tx_alice, mut rx_alice) = unbounded_channel();
        h.attach_socket("tom", false, tx_tom);
        h.attach_socket("alice", false, tx_alice);
        h.post_user_message(&cid, "hi", "tom", None, None, vec![]);
        rx_tom.try_recv().unwrap();
        rx_alice.try_recv().unwrap();
        h.mark_read("alice", &cid, None);
        assert_eq!(rx_alice.try_recv().unwrap()["type"], "read");
        assert!(rx_tom.try_recv().is_err());
    }

    #[test]
    fn agent_frames_post_and_progress() {
        let h = hub();
        let _rx = add_agent(&h, "bot-a", "Bot A", false);
        let cid = setup_channel(&h, &["bot-a"]);
        let (tx_ui, mut rx_ui) = unbounded_channel();
        h.attach_socket("tom", false, tx_ui);
        h.handle_agent_frame(&json!({
            "type": "progress", "agent_id": "bot-a", "channel_id": cid,
            "handle": "h1", "text": "working...",
        }));
        assert_eq!(rx_ui.try_recv().unwrap()["type"], "progress");
        h.handle_agent_frame(&json!({
            "type": "post", "agent_id": "bot-a", "channel_id": cid, "text": "done!",
        }));
        let ev = rx_ui.try_recv().unwrap();
        assert_eq!(ev["type"], "message");
        assert_eq!(ev["message"]["author_id"], "bot-a");
        assert_eq!(h.store.messages(&cid, None, None, 10).len(), 1);
    }

    #[test]
    fn re_registering_an_agent_id_notifies_the_displaced_connection() {
        let h = hub();
        let mut displaced_rx = add_agent(&h, "bot-a", "Bot A", false);
        let displaced_conn = h.agent_handle("bot-a").unwrap().conn_id;
        let cid = setup_channel(&h, &["bot-a"]);

        // A second connection claims the id: last hello wins, and the
        // displaced connection is told so it doesn't go silently mute.
        let mut claimant_rx = add_agent(&h, "bot-a", "Bot A", false);
        let notice = displaced_rx.try_recv().unwrap();
        assert_eq!(notice["type"], "error");
        assert_eq!(notice["frame_type"], "hello");
        assert_eq!(notice["agent_id"], "bot-a");
        assert_ne!(h.agent_handle("bot-a").unwrap().conn_id, displaced_conn);

        // Frames from the displaced connection are bound out.
        h.handle_agent_frame_from(displaced_conn, &json!({
            "type": "post", "agent_id": "bot-a", "channel_id": cid,
            "text": "from the stale socket",
        }));
        assert!(h.store.messages(&cid, None, None, 10).is_empty());

        // A plain re-announce on the same connection stays silent.
        let live = h.agent_handle("bot-a").unwrap();
        h.register_agent(live);
        assert!(claimant_rx.try_recv().is_err());
    }

    #[test]
    fn member_agent_frames_are_accepted_through_the_connection_bound_path() {
        // The accept path must go through the production entry point: if the
        // conn_id wiring at a call site broke, every frame from every real
        // bridge would be dropped while helper-based tests stayed green.
        let h = hub();
        let mut agent_rx = add_agent(&h, "bot-a", "Bot A", false);
        let conn_id = h.agent_handle("bot-a").unwrap().conn_id;
        let cid = setup_channel(&h, &["bot-a"]);

        h.handle_agent_frame_from(conn_id, &json!({
            "type": "typing", "agent_id": "bot-a", "channel_id": cid,
            "active": true,
        }));
        h.handle_agent_frame_from(conn_id, &json!({
            "type": "post", "agent_id": "bot-a", "channel_id": cid,
            "request_id": "post-accepted", "text": "hello from the wire",
        }));

        let messages = h.store.messages(&cid, None, None, 10);
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0]["text"], "hello from the wire");
        assert!(std::iter::from_fn(|| agent_rx.try_recv().ok())
            .all(|frame| frame["type"] != "error"));
    }

    #[test]
    fn agent_image_only_post_is_stored_and_fanned_out() {
        let h = hub();
        let _sender_rx = add_agent(&h, "bot-a", "Bot A", false);
        let mut recipient_rx = add_agent_full(&h, "bot-b", "Bot B", false, true);
        let conn_id = h.agent_handle("bot-a").unwrap().conn_id;
        let cid = setup_channel(&h, &["bot-a", "bot-b"]);
        let png = b"\x89PNG\r\n\x1a\nimage";
        h.handle_agent_frame_from(conn_id, &json!({
            "type": "post", "agent_id": "bot-a", "channel_id": cid,
            "request_id": "image-only", "text": "",
            "attachments": [{"filename": "../shot.png", "mime": "text/plain",
                "data_b64": base64::engine::general_purpose::STANDARD.encode(png)}],
        }));
        let messages = h.store.messages(&cid, None, None, 10);
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0]["attachments"][0]["filename"], "shot.png");
        assert_eq!(messages[0]["attachments"][0]["mime"], "image/png");
        let inbound = last_frame(&mut recipient_rx, "inbound").unwrap();
        assert_eq!(inbound["attachments"][0]["id"], messages[0]["attachments"][0]["id"]);
        assert_eq!(inbound["attachments"][0]["data_b64"],
            base64::engine::general_purpose::STANDARD.encode(png));
    }

    #[test]
    fn invalid_agent_attachment_rejects_the_whole_post() {
        let h = Hub::new_with_attachment_limit(Arc::new(Store::open_in_memory().unwrap()), 8);
        let mut rx = add_agent(&h, "bot-a", "Bot A", false);
        let conn_id = h.agent_handle("bot-a").unwrap().conn_id;
        let cid = setup_channel(&h, &["bot-a"]);
        h.handle_agent_frame_from(conn_id, &json!({
            "type": "post", "agent_id": "bot-a", "channel_id": cid,
            "request_id": "bad-image", "text": "must not land",
            "attachments": [{"filename": "x.png", "mime": "image/png", "data_b64": "not-base64"}],
        }));
        assert!(h.store.messages(&cid, None, None, 10).is_empty());
        let error = last_frame(&mut rx, "error").unwrap();
        assert_eq!(error["request_id"], "bad-image");
        assert_eq!(error["frame_type"], "post");
    }

    #[test]
    fn null_agent_attachments_are_treated_as_absent() {
        let h = hub();
        let _rx = add_agent(&h, "bot-a", "Bot A", false);
        let conn_id = h.agent_handle("bot-a").unwrap().conn_id;
        let cid = setup_channel(&h, &["bot-a"]);
        h.handle_agent_frame_from(conn_id, &json!({
            "type": "post", "agent_id": "bot-a", "channel_id": cid,
            "request_id": "null-attachments", "text": "still lands", "attachments": null,
        }));
        let messages = h.store.messages(&cid, None, None, 10);
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0]["text"], "still lands");
    }

    #[test]
    fn agent_attachment_decoder_rejects_every_invalid_shape() {
        let h = Hub::new_with_attachment_limit(Arc::new(Store::open_in_memory().unwrap()), 8);
        let file = |data: &str| json!({"filename": "x.png", "mime": "image/png", "data_b64": data});
        assert!(h.decode_agent_attachments(Some(&json!({}))).is_err());
        assert!(h.decode_agent_attachments(Some(&Value::Null)).unwrap().is_empty());
        assert!(h.decode_agent_attachments(Some(&json!([1, 2, 3]))).is_err());
        assert!(h.decode_agent_attachments(Some(&json!([
            file("eA=="), file("eA=="), file("eA=="), file("eA=="), file("eA=="), file("eA==")
        ]))).is_err());
        assert!(h.decode_agent_attachments(Some(&json!([file("")]))).is_err());
        let plain = base64::engine::general_purpose::STANDARD.encode(b"plain");
        assert!(h.decode_agent_attachments(Some(&json!([file(&plain)]))).is_err());
        let oversized = base64::engine::general_purpose::STANDARD
            .encode(b"\x89PNG\r\n\x1a\nextra");
        assert!(h.decode_agent_attachments(Some(&json!([file(&oversized)]))).is_err());
        let exact = b"\x89PNG\r\n\x1a\n";
        assert_eq!(exact.len(), 8);
        let encoded = base64::engine::general_purpose::STANDARD.encode(exact);
        assert_eq!(h.decode_agent_attachments(Some(&json!([file(&encoded)]))).unwrap().len(), 1);
    }

    #[test]
    fn agent_writes_are_denied_outside_channel_membership() {
        let h = hub();
        let _member_rx = add_agent(&h, "bot-a", "Bot A", false);
        let mut outsider_rx = add_agent(&h, "bot-b", "Bot B", false);
        let outsider_conn_id = h.agent_handle("bot-b").unwrap().conn_id;
        let cid = setup_channel(&h, &["bot-a"]);
        let (tx_ui, mut rx_ui) = unbounded_channel();
        h.attach_socket("tom", false, tx_ui);

        for frame in [
            json!({
                "type": "typing", "agent_id": "bot-b", "channel_id": cid,
                "active": true,
            }),
            json!({
                "type": "progress", "agent_id": "bot-b", "channel_id": cid,
                "handle": "outside", "text": "should not appear",
            }),
            json!({
                "type": "post", "agent_id": "bot-b", "channel_id": cid,
                "request_id": "post-denied", "text": "should not be stored",
            }),
        ] {
            h.handle_agent_frame_from(outsider_conn_id, &frame);
        }

        assert!(rx_ui.try_recv().is_err());
        assert!(h.store.messages(&cid, None, None, 10).is_empty());
        assert!(h.channel_activity(&cid)["typing"].as_array().unwrap().is_empty());
        assert!(h.channel_activity(&cid)["progress"].as_array().unwrap().is_empty());
        let errors: Vec<_> = std::iter::from_fn(|| outsider_rx.try_recv().ok())
            .filter(|frame| frame["type"] == "error")
            .collect();
        assert_eq!(errors.len(), 1);
        let error = &errors[0];
        assert_eq!(error["frame_type"], "post");
        assert_eq!(error["agent_id"], "bot-b");
        assert_eq!(error["request_id"], "post-denied");
        assert_eq!(error["channel_id"], cid);
        assert!(error["thread_id"].is_null());
        assert_eq!(error["error"], "agent is not a member of this channel");
    }

    #[test]
    fn frames_cannot_spoof_an_agent_on_another_connection() {
        let h = hub();
        let mut victim_rx = add_agent(&h, "victim", "Victim", false);
        let mut sender_rx = add_agent(&h, "sender", "Sender", false);
        let sender_conn_id = h.agent_handle("sender").unwrap().conn_id;
        let cid = setup_channel(&h, &["sender"]);

        // None of the frame families may be sent under an identity registered
        // on another connection, and no response may be injected there.
        for frame in [
            json!({
                "type": "post", "agent_id": "victim", "channel_id": cid,
                "thread_id": 42, "text": "spoofed",
            }),
            json!({
                "type": "history_request", "request_id": "h-spoof",
                "agent_id": "victim", "channel_id": cid,
            }),
            json!({
                "type": "search_request", "request_id": "s-spoof",
                "agent_id": "victim", "channel_id": cid, "query": "secret",
            }),
        ] {
            h.handle_agent_frame_from(sender_conn_id, &frame);
        }

        assert!(victim_rx.try_recv().is_err());
        assert!(sender_rx.try_recv().is_err());
        assert!(h.store.messages(&cid, None, None, 10).is_empty());
    }

    #[test]
    fn channel_scoped_agent_writes_only_to_its_assigned_channel() {
        let h = hub();
        let _agent_rx = add_agent(&h, "bot-a", "Bot A", false);
        let g = h.store.create_group("G", "", Some("tom"));
        let gid = g["id"].as_str().unwrap();
        let allowed = h.store.create_channel(gid, "allowed", "");
        let denied = h.store.create_channel(gid, "denied", "");
        let allowed_id = allowed["id"].as_str().unwrap();
        let denied_id = denied["id"].as_str().unwrap();
        h.store
            .add_member(gid, "agent", "bot-a", "member", Some(allowed_id));

        for frame in [
            json!({
                "type": "typing", "agent_id": "bot-a", "channel_id": denied_id,
                "active": true,
            }),
            json!({
                "type": "progress", "agent_id": "bot-a", "channel_id": denied_id,
                "handle": "outside", "text": "should not appear",
            }),
            json!({
                "type": "post", "agent_id": "bot-a", "channel_id": denied_id,
                "text": "should not be stored",
            }),
        ] {
            h.handle_agent_frame(&frame);
        }
        assert!(h.store.messages(denied_id, None, None, 10).is_empty());
        assert!(h.channel_activity(denied_id)["typing"].as_array().unwrap().is_empty());
        assert!(h.channel_activity(denied_id)["progress"].as_array().unwrap().is_empty());

        h.handle_agent_frame(&json!({
            "type": "post", "agent_id": "bot-a", "channel_id": allowed_id,
            "text": "allowed",
        }));
        assert_eq!(h.store.messages(allowed_id, None, None, 10).len(), 1);
    }

    #[test]
    fn options_resolve_is_membership_gated_and_channel_scoped() {
        let h = hub();
        let _agent_rx = add_agent(&h, "bot-a", "Bot A", false);
        let allowed_id = setup_channel(&h, &["bot-a"]);
        let denied_id = setup_channel(&h, &[]);

        for channel_id in [&allowed_id, &denied_id] {
            h.post_agent_message_with_options(
                "bot-a",
                "Bot A",
                channel_id,
                "Choose",
                None,
                Some(&json!([{"id": "yes", "label": "Yes"}])),
                Some("shared-options"),
                None,
                None,
                None,
                None,
                None,
                vec![],
            );
        }
        let allowed_mid = h.store.messages(&allowed_id, None, None, 10)[0]["id"]
            .as_i64()
            .unwrap();
        let denied_mid = h.store.messages(&denied_id, None, None, 10)[0]["id"]
            .as_i64()
            .unwrap();

        // Naming a channel outside membership cannot resolve its options.
        h.handle_agent_frame(&json!({
            "type": "options_resolve", "agent_id": "bot-a", "channel_id": denied_id,
            "options_id": "shared-options", "text": "denied",
        }));
        assert!(h.store.message(denied_mid).unwrap()["meta"]["resolved"].is_null());

        // The same options_id in another group does not steal the lookup:
        // resolution is scoped to the frame's authorized channel.
        h.handle_agent_frame(&json!({
            "type": "options_resolve", "agent_id": "bot-a", "channel_id": allowed_id,
            "options_id": "shared-options", "text": "allowed",
        }));
        assert_eq!(
            h.store.message(allowed_mid).unwrap()["meta"]["resolved"]["label"],
            "allowed"
        );
        assert!(h.store.message(denied_mid).unwrap()["meta"]["resolved"].is_null());
    }

    #[test]
    fn options_resolve_is_scoped_to_channel_and_author_in_one_group() {
        let h = hub();
        let _rx_a = add_agent(&h, "bot-a", "Bot A", false);
        let _rx_b = add_agent(&h, "bot-b", "Bot B", false);
        let g = h.store.create_group("G", "", Some("tom"));
        let gid = g["id"].as_str().unwrap();
        let allowed = h.store.create_channel(gid, "allowed", "");
        let other = h.store.create_channel(gid, "other", "");
        let allowed_id = allowed["id"].as_str().unwrap();
        let other_id = other["id"].as_str().unwrap();
        h.store
            .add_member(gid, "agent", "bot-a", "member", Some(allowed_id));
        h.store
            .add_member(gid, "agent", "bot-b", "member", Some(allowed_id));

        for (author_id, channel_id) in [
            ("bot-a", allowed_id),
            ("bot-b", allowed_id),
            ("bot-a", other_id),
        ] {
            h.post_agent_message_with_options(
                author_id,
                author_id,
                channel_id,
                "Choose",
                None,
                Some(&json!([{"id": "yes", "label": "Yes"}])),
                Some("shared-options"),
                None,
                None,
                None,
                None,
                None,
                vec![],
            );
        }
        let a_mid = h
            .store
            .messages(allowed_id, None, None, 10)
            .into_iter()
            .find(|m| m["author_id"] == "bot-a")
            .unwrap()["id"]
            .as_i64()
            .unwrap();
        let b_mid = h
            .store
            .messages(allowed_id, None, None, 10)
            .into_iter()
            .find(|m| m["author_id"] == "bot-b")
            .unwrap()["id"]
            .as_i64()
            .unwrap();
        let other_mid = h.store.messages(other_id, None, None, 10)[0]["id"]
            .as_i64()
            .unwrap();

        h.handle_agent_frame(&json!({
            "type": "options_resolve", "agent_id": "bot-a", "channel_id": allowed_id,
            "options_id": "shared-options", "text": "only mine",
        }));

        assert_eq!(
            h.store.message(a_mid).unwrap()["meta"]["resolved"]["label"],
            "only mine"
        );
        assert!(h.store.message(b_mid).unwrap()["meta"]["resolved"].is_null());
        assert!(h.store.message(other_mid).unwrap()["meta"]["resolved"].is_null());
    }

    #[test]
    fn post_frame_tldr_lands_in_meta() {
        let h = hub();
        let _rx = add_agent(&h, "bot-a", "Bot A", false);
        let cid = setup_channel(&h, &["bot-a"]);
        let long = "word ".repeat(400);
        h.handle_agent_frame(&json!({
            "type": "post", "agent_id": "bot-a", "channel_id": cid,
            "text": long, "tldr": "  short version  ",
        }));
        let msg = &h.store.messages(&cid, None, None, 10)[0];
        assert_eq!(msg["meta"]["tldr"], "short version");

        // A tldr can ride alongside options without clobbering them.
        h.handle_agent_frame(&json!({
            "type": "post", "agent_id": "bot-a", "channel_id": cid,
            "text": long, "tldr": "gist",
            "options_id": "o1", "options": [{"id": "yes", "label": "Yes"}],
        }));
        let msg = &h.store.messages(&cid, None, None, 10)[1];
        assert_eq!(msg["meta"]["tldr"], "gist");
        assert_eq!(msg["meta"]["options_id"], "o1");
        assert!(msg["meta"]["resolved"].is_null());
    }

    #[test]
    fn post_frame_map_artifact_lands_sanitized_in_meta() {
        let h = hub();
        let _rx = add_agent(&h, "bot-a", "Bot A", false);
        let cid = setup_channel(&h, &["bot-a"]);
        h.handle_agent_frame(&json!({
            "type": "post", "agent_id": "bot-a", "channel_id": cid,
            "text": "Your trip",
            "artifacts": [{
                "id": "trip", "type": "map", "version": 1, "title": "Turkey",
                "data": {
                    "regions": [{"id": "istanbul", "label": "Istanbul",
                        "center": {"lat": 41.0082, "lng": 28.9784}}],
                    "days": [],
                    "places": [{"id": "hagia", "label": "Hagia Sophia",
                        "position": {"lat": 41.0086, "lng": 28.9802},
                        "category": "sight", "description": "<script>plain text only</script>"}],
                    "routes": []
                }
            }]
        }));
        let msg = &h.store.messages(&cid, None, None, 10)[0];
        assert_eq!(msg["meta"]["artifacts"][0]["type"], "map");
        assert_eq!(msg["meta"]["artifacts"][0]["data"]["places"][0]["label"], "Hagia Sophia");
    }

    #[test]
    fn post_frame_tldr_rejected_when_useless() {
        let h = hub();
        let _rx = add_agent(&h, "bot-a", "Bot A", false);
        let cid = setup_channel(&h, &["bot-a"]);
        // Not shorter than the text, blank, or oversized: dropped, message kept.
        for (text, tldr) in [
            ("short text".to_string(), json!("longer than the text itself")),
            ("short text".to_string(), json!("   ")),
            ("y".repeat(MAX_TLDR_CHARS * 2), json!("x".repeat(MAX_TLDR_CHARS + 1))),
        ] {
            h.handle_agent_frame(&json!({
                "type": "post", "agent_id": "bot-a", "channel_id": cid,
                "text": text, "tldr": tldr,
            }));
        }
        let msgs = h.store.messages(&cid, None, None, 10);
        assert_eq!(msgs.len(), 3);
        for msg in &msgs {
            assert!(msg["meta"].get("tldr").is_none(), "meta: {:?}", msg["meta"]);
        }
    }

    #[test]
    fn post_frame_structured_sources_land_in_meta() {
        let h = hub();
        let _rx = add_agent(&h, "bot-a", "Bot A", false);
        let cid = setup_channel(&h, &["bot-a"]);
        h.handle_agent_frame(&json!({
            "type": "post", "agent_id": "bot-a", "channel_id": cid,
            "text": "Answer without a sources block.",
            "sources": ["https://a.com", {"url": "https://b.com", "title": "B"}, "junk"],
        }));
        let msg = &h.store.messages(&cid, None, None, 10)[0];
        let sources = msg["meta"]["sources"].as_array().unwrap();
        assert_eq!(sources.len(), 2);
        assert_eq!(sources[1]["title"], "B");
        // Text carried no block, so there is nothing to collapse.
        assert!(msg["meta"].get("sources_start").is_none());
    }

    #[test]
    fn post_frame_trailing_sources_block_is_lifted() {
        let h = hub();
        let _rx = add_agent(&h, "bot-a", "Bot A", false);
        let cid = setup_channel(&h, &["bot-a"]);
        h.handle_agent_frame(&json!({
            "type": "post", "agent_id": "bot-a", "channel_id": cid,
            "text": "The answer.\n\nSources:\n- [Doc](https://a.com/doc)\nhttps://b.com",
        }));
        let msg = &h.store.messages(&cid, None, None, 10)[0];
        let sources = msg["meta"]["sources"].as_array().unwrap();
        assert_eq!(sources[0]["url"], "https://a.com/doc");
        assert_eq!(sources[0]["title"], "Doc");
        assert_eq!(msg["meta"]["sources_start"], "The answer.\n\n".len());
        // The stored text is the contract — lifting never rewrites it.
        assert!(msg["text"].as_str().unwrap().contains("Sources:"));

        // An explicit list beats detection, but the block still collapses.
        h.handle_agent_frame(&json!({
            "type": "post", "agent_id": "bot-a", "channel_id": cid,
            "text": "More.\nSources:\nhttps://x.com",
            "sources": ["https://y.com"],
        }));
        let msg = &h.store.messages(&cid, None, None, 10)[1];
        assert_eq!(msg["meta"]["sources"][0]["url"], "https://y.com");
        assert_eq!(msg["meta"]["sources_start"], "More.\n".len());
    }

    #[test]
    fn pairing_status_tracks_sockets_and_their_agents() {
        let h = hub();
        assert!(h.pairing_status().is_empty());

        // Socket up before hello: connected, no agents yet.
        let conn = h.next_conn_id();
        h.register_pairing_conn(conn, "tok-a");
        assert_eq!(h.pairing_status().get("tok-a"), Some(&vec![]));

        // Hello registers an agent on that conn.
        let (tx, _rx) = unbounded_channel();
        h.register_agent(AgentHandle {
            agent_id: "claw-1".into(),
            agent_name: "Claw".into(),
            requires_mention: false,
            wants_context_feed: false,
            has_avatar: false,
            avatar_v: 0,
            source: "pairing:openclaw".into(),
            conn_id: conn,
            tx,
        });
        let (tx, _rx) = unbounded_channel();
        h.register_agent(AgentHandle {
            agent_id: "alpha-1".into(),
            agent_name: "Alpha".into(),
            requires_mention: false,
            wants_context_feed: false,
            has_avatar: false,
            avatar_v: 0,
            source: "pairing:openclaw".into(),
            conn_id: conn,
            tx,
        });
        assert_eq!(
            h.pairing_status().get("tok-a"),
            Some(&vec![
                ("alpha-1".to_string(), "Alpha".to_string()),
                ("claw-1".to_string(), "Claw".to_string()),
            ])
        );

        // A second token is tracked independently — keyed by token, so two
        // tokens sharing a label never merge.
        let conn_b = h.next_conn_id();
        h.register_pairing_conn(conn_b, "tok-b");
        assert!(h.pairing_status().contains_key("tok-b"));

        // Socket drop clears only its own entry.
        h.unregister_connection(conn);
        let st = h.pairing_status();
        assert!(!st.contains_key("tok-a"));
        assert!(st.contains_key("tok-b"));
    }

    #[tokio::test]
    async fn closing_pairing_connections_targets_only_the_revoked_token() {
        let h = hub();
        let close_a = h.register_pairing_conn(h.next_conn_id(), "tok-a");
        let close_b = h.register_pairing_conn(h.next_conn_id(), "tok-b");

        assert_eq!(h.close_pairing_conns("tok-a"), 1);
        assert!(
            tokio::time::timeout(Duration::from_millis(20), close_a.notified())
                .await
                .is_ok()
        );
        assert!(
            tokio::time::timeout(Duration::from_millis(20), close_b.notified())
                .await
                .is_err()
        );
        assert_eq!(h.close_pairing_conns("missing"), 0);
    }
}
