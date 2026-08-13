//! The app's HTTP + WebSocket surface (axum).
//!
//! - `/api/*` — the UI's REST API (admin-key auth; single-user v1).
//! - `/ws?token=` — the UI's live event socket.
//! - `/agent/ws?token=` — dial-in agent bridges (pairing-token auth).
//! - `/` — the bundled web UI (static files).
//!
//! Route shapes mirror Pantheo's old `/agora/api/*` so the ported UI's calls
//! stay mechanical: same payloads, same event frames.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::body::Body;
use axum::extract::ws::{Message as WsMessage, WebSocket, WebSocketUpgrade};
use axum::extract::{ConnectInfo, Multipart, Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, patch, post, put};
use axum::{Json, Router};
use base64::Engine;
use futures_util::stream::SplitSink;
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncSeekExt, SeekFrom};
use tokio::sync::mpsc::{unbounded_channel, UnboundedReceiver};
use tokio_util::io::ReaderStream;

use crate::config::{Config, Connection, PairingToken};
use crate::connections::ConnectionManager;
use crate::hub::{AgentHandle, Hub};
use crate::store::{new_token, now, NewAttachment};
use crate::attachments::{agent_wire_limit, attachment_mime, safe_filename, sniff_video_mime};

const MAX_MESSAGE_CHARS: usize = 20_000;
const MAX_PINS_PER_CHANNEL: i64 = 25;
const MAX_FILES_PER_MESSAGE: usize = 5;
const MAX_AGENT_AVATAR_BYTES: usize = 2 * 1024 * 1024;
/// Distinct emoji per message — bounds the chip row like Slack does.
const MAX_REACTION_KINDS_PER_MESSAGE: usize = 20;

/// Upper bound on an uploaded import archive. An import carries the whole
/// database plus every attachment, so it is legitimately large — but a 1 GiB
/// (or unbounded) body is a cheap way to exhaust memory/disk. 256 MiB covers a
/// substantial personal instance; raise it deliberately for a bigger migration.
const MAX_IMPORT_BYTES: usize = 256 * 1024 * 1024;

/// Voice notes: generous for a spoken message (~10 min of Opus), but a hard
/// stop against arbitrary blobs going to the transcription API.
const MAX_VOICE_BYTES: usize = 15 * 1024 * 1024;

/// Synthesized speech per message, LRU-evicted, so replays and multiple
/// listeners don't re-bill the TTS API. ~64 clips of a few hundred KB each.
const SPEECH_CACHE_MAX: usize = 64;

/// message_id -> mp3 bytes, most-recently-used last.
type SpeechCache = std::sync::Mutex<Vec<(i64, Vec<u8>)>>;

/// Requests per client per window on the auth surface (Google sign-in): enough
/// for a real round-trip and retries, low enough to blunt automated abuse of an
/// unauthenticated, externally-expensive path.
const AUTH_RATE_MAX: u32 = 30;
/// Requests per client per window on the upload surface (message/voice/import).
const UPLOAD_RATE_MAX: u32 = 60;
const RATE_WINDOW: Duration = Duration::from_secs(60);

/// Tiny fixed-window rate limiter — no external dependency. Keyed by an opaque
/// string (client IP when known, a shared bucket otherwise). This is an origin
/// backstop, not an edge control: behind a reverse proxy every request shares
/// the proxy's IP, so pair it with a limiter at the edge for real per-client
/// fairness.
pub struct RateLimiter {
    window: Duration,
    max: u32,
    buckets: std::sync::Mutex<HashMap<String, (Instant, u32)>>,
}

impl RateLimiter {
    fn new(window: Duration, max: u32) -> Self {
        Self {
            window,
            max,
            buckets: std::sync::Mutex::new(HashMap::new()),
        }
    }

    /// True if the request is within budget; false once the key is over it.
    fn allow(&self, key: &str) -> bool {
        let now = Instant::now();
        let mut buckets = self.buckets.lock().unwrap();
        // Opportunistic sweep so a churn of distinct keys can't grow the map
        // without bound.
        if buckets.len() > 4096 {
            buckets.retain(|_, (start, _)| now.duration_since(*start) < self.window);
        }
        let entry = buckets.entry(key.to_string()).or_insert((now, 0));
        if now.duration_since(entry.0) >= self.window {
            *entry = (now, 0);
        }
        entry.1 += 1;
        entry.1 <= self.max
    }
}

/// Rate-limit key for a request: the client IP. `run()` always serves with
/// connect info, so the peer address is present on every transport.
fn rate_key(peer: &SocketAddr) -> String {
    peer.ip().to_string()
}

#[derive(Clone)]
pub struct AppState {
    pub hub: Arc<Hub>,
    pub config: Arc<Config>,
    pub connections: Arc<ConnectionManager>,
    pub ui_dir: Option<std::path::PathBuf>,
    pub data_dir: std::path::PathBuf,
    /// How to restart the process after an import is staged. The headless
    /// server leaves this unset (the supervisor restarts it after exit 0);
    /// the desktop shell installs a relaunch here.
    pub restart_handler: Arc<std::sync::Mutex<Option<Box<dyn Fn() + Send + Sync>>>>,
    /// TTS output per message id (see [`SPEECH_CACHE_MAX`]).
    pub speech_cache: Arc<SpeechCache>,
    /// Per-client fixed-window limiter for the Google sign-in surface.
    pub auth_limiter: Arc<RateLimiter>,
    /// Per-client fixed-window limiter for the upload surface.
    pub upload_limiter: Arc<RateLimiter>,
}

impl AppState {
    /// Build the two rate limiters an [`AppState`] needs, with the standard
    /// windows/budgets. Kept here so every constructor (headless + desktop)
    /// wires the same policy.
    pub fn default_limiters() -> (Arc<RateLimiter>, Arc<RateLimiter>) {
        (
            Arc::new(RateLimiter::new(RATE_WINDOW, AUTH_RATE_MAX)),
            Arc::new(RateLimiter::new(RATE_WINDOW, UPLOAD_RATE_MAX)),
        )
    }
}

type ApiError = (StatusCode, Json<Value>);

fn err(code: StatusCode, detail: &str) -> ApiError {
    (code, Json(json!({"detail": detail})))
}

fn bearer(headers: &HeaderMap) -> Option<String> {
    headers
        .get("authorization")?
        .to_str()
        .ok()?
        .strip_prefix("Bearer ")
        .map(str::to_string)
}

/// The resolved caller of an API request or UI socket.
#[derive(Clone)]
pub struct AuthedUser {
    pub username: String,
    pub display_name: String,
    pub instance_admin: bool,
}

/// Resolve a UI credential to a user. Two kinds exist:
///
/// - the static **admin key** — the operator credential (printed in the
///   server log, used by the desktop shell and automation). It acts as the
///   bootstrap account (`config.username`) with instance-admin powers, even
///   if that account row was deleted.
/// - a **session token** minted by Google/Apple sign-in — resolved to its
///   user row; rejected when the account is missing, disabled, or its
///   session version was bumped (per-user sign-out).
fn authed_user(state: &AppState, token: &str) -> Option<AuthedUser> {
    if state.config.is_admin_key(token) {
        let username = state.config.username();
        let display_name = state
            .hub
            .store
            .user(&username)
            .and_then(|u| u["display_name"].as_str().map(str::to_string))
            .filter(|d| !d.is_empty())
            .unwrap_or_else(|| username.clone());
        return Some(AuthedUser {
            username,
            display_name,
            instance_admin: true,
        });
    }
    let (username, version) =
        crate::auth::verify_session(token, &state.config.session_secret())?;
    let user = state.hub.store.user(&username)?;
    if user["disabled"].as_bool().unwrap_or(false) {
        return None;
    }
    if user["session_version"].as_i64().unwrap_or(1) != version {
        return None;
    }
    let display_name = user["display_name"]
        .as_str()
        .filter(|d| !d.is_empty())
        .unwrap_or(&username)
        .to_string();
    Some(AuthedUser {
        instance_admin: user["instance_role"] == "admin",
        username,
        display_name,
    })
}

fn require_user(
    state: &AppState,
    headers: &HeaderMap,
    query: &HashMap<String, String>,
) -> Result<AuthedUser, ApiError> {
    let token = bearer(headers)
        .or_else(|| query.get("token").cloned())
        .unwrap_or_default();
    authed_user(state, &token)
        .ok_or_else(|| err(StatusCode::UNAUTHORIZED, "Authentication required"))
}

fn require_instance_admin(user: &AuthedUser) -> Result<(), ApiError> {
    if user.instance_admin {
        Ok(())
    } else {
        Err(err(StatusCode::FORBIDDEN, "Instance admin access required"))
    }
}

/// Membership is the visibility boundary: users are group-scoped in v1.
/// Instance admins bypass it (they are the operator).
/// Member-level access: instance admin, membership row, or a public group.
fn require_member(state: &AppState, user: &AuthedUser, group_id: &str) -> Result<(), ApiError> {
    if user.instance_admin || state.hub.store.user_can_access_group(&user.username, group_id) {
        Ok(())
    } else {
        Err(err(StatusCode::FORBIDDEN, "You are not a member of this group"))
    }
}

fn require_group_admin(
    state: &AppState,
    user: &AuthedUser,
    group_id: &str,
) -> Result<(), ApiError> {
    if user.instance_admin || state.hub.store.user_is_group_admin(&user.username, group_id) {
        Ok(())
    } else {
        Err(err(StatusCode::FORBIDDEN, "Group admin access required"))
    }
}

/// The channel if it exists *and* the caller may see it (member of its
/// group). Most message-path handlers start here.
fn require_channel_member(
    state: &AppState,
    user: &AuthedUser,
    channel_id: &str,
) -> Result<Value, ApiError> {
    let channel = channel_or_404(state, channel_id)?;
    if channel["kind"] == "agent_dm" {
        if state.hub.store.user_owns_agent_dm(&user.username, channel_id) { return Ok(channel); }
        return Err(err(StatusCode::FORBIDDEN, "This direct message is private"));
    }
    require_member(state, user, channel["group_id"].as_str().unwrap_or_default())?;
    Ok(channel)
}

fn require_channel_postable(state: &AppState, user: &AuthedUser, channel_id: &str) -> Result<Value, ApiError> {
    let channel = require_channel_member(state, user, channel_id)?;
    if channel["kind"] == "agent_dm" {
        let agent_id = channel["dm_agent_id"].as_str().unwrap_or_default();
        if !state.hub.store.user_can_start_agent_dm(&user.username, agent_id) {
            return Err(err(StatusCode::FORBIDDEN, "Agent DM access has been revoked; history is read-only"));
        }
        if state.hub.store.agent(agent_id).is_none() {
            return Err(err(StatusCode::CONFLICT, "This agent is no longer available; history is read-only"));
        }
    }
    Ok(channel)
}

/// Message lookup gated the same way as [`require_channel_member`].
fn require_message_visible(
    state: &AppState,
    user: &AuthedUser,
    message_id: i64,
) -> Result<Value, ApiError> {
    let message = state
        .hub
        .store
        .message(message_id)
        .ok_or_else(|| err(StatusCode::NOT_FOUND, "Unknown message"))?;
    require_channel_member(state, user, message["channel_id"].as_str().unwrap_or_default())?;
    Ok(message)
}

/// Body cap for the multipart upload routes. Axum's default is 2 MB, which
/// silently rejects any photo-sized attachment before the handler runs; size
/// it to the configured per-file cap times the file count (plus slack for
/// text fields and multipart framing). The handler still enforces the exact
/// per-file limit. Computed at router build, so a runtime max_file_mb change
/// applies after restart.
fn upload_body_limit(state: &AppState) -> axum::extract::DefaultBodyLimit {
    let config = state.config.snapshot();
    axum::extract::DefaultBodyLimit::max(upload_request_max_bytes(&config).saturating_add(1024 * 1024))
}

fn upload_request_max_bytes(config: &crate::config::ConfigData) -> usize {
    let file = (config.max_file_mb as usize).saturating_mul(1024 * 1024);
    let video_mb = if config.max_video_mb == 0 { config.max_file_mb } else { config.max_video_mb };
    let video = (video_mb.max(config.max_file_mb) as usize).saturating_mul(1024 * 1024);
    video.saturating_add(file.saturating_mul(MAX_FILES_PER_MESSAGE - 1))
}

fn voice_body_limit() -> axum::extract::DefaultBodyLimit {
    axum::extract::DefaultBodyLimit::max(voice_request_max_bytes())
}

fn voice_request_max_bytes() -> usize {
    MAX_VOICE_BYTES + 1024 * 1024
}

pub fn router(state: AppState) -> Router {
    let mut app = Router::new()
        .route("/api/me", get(me).patch(update_me).delete(delete_me))
        .route("/api/users", get(list_users))
        .route("/api/users/{username}", patch(update_user))
        .route("/api/invites", get(list_invites).post(create_invite))
        .route("/api/invites/{email}", delete(revoke_invite))
        .route("/join/{token}", get(join_link))
        .route("/api/groups", get(list_groups).post(create_group))
        .route("/api/groups/order", put(reorder_groups))
        .route("/api/groups/{group_id}", patch(update_group).delete(delete_group))
        .route("/api/groups/{group_id}/channels", post(create_channel))
        .route("/api/groups/{group_id}/templates", get(list_templates).post(create_template))
        .route("/api/groups/{group_id}/templates/{template_id}", patch(update_template).delete(delete_template))
        .route("/api/groups/{group_id}/channels/order", put(reorder_channels))
        .route(
            "/api/groups/{group_id}/channels/{channel_id}",
            patch(update_channel).delete(delete_channel),
        )
        .route("/api/groups/{group_id}/members", get(list_members).post(add_member))
        .route(
            "/api/groups/{group_id}/members/{member_type}/{member_id}",
            delete(remove_member),
        )
        .route(
            "/api/channels/{channel_id}/messages",
            get(list_messages).post(post_message),
        )
        .route("/api/channels/{channel_id}/attachments", get(list_attachments))
        .route(
            "/api/channels/{channel_id}/attachments/{file_id}",
            delete(delete_attachment),
        )
        .route(
            "/api/channels/{channel_id}/messages/{message_id}",
            patch(edit_message).delete(delete_message),
        )
        .route(
            "/api/channels/{channel_id}/messages/upload",
            post(post_message_upload).layer(upload_body_limit(&state)),
        )
        .route(
            "/api/channels/{channel_id}/voice",
            post(post_voice_message).layer(voice_body_limit()),
        )
        .route("/api/channels/{channel_id}/read", put(mark_read))
        .route("/api/messages/{message_id}", get(get_message))
        .route("/api/messages/{message_id}/select", post(select_message_option))
        .route(
            "/api/messages/{message_id}/form_state",
            post(update_message_form_state),
        )
        .route(
            "/api/messages/{message_id}/form_submit",
            post(submit_message_form),
        )
        .route("/api/messages/{message_id}/speech", get(message_speech))
        .route("/api/search", get(search))
        .route("/api/search/ask", post(search_ask))
        .route("/api/threads", get(list_threads))
        .route("/api/threads/{thread_id}", patch(update_thread))
        .route("/api/threads/{thread_id}/read", put(mark_thread_read))
        .route(
            "/api/threads/{thread_id}/hide",
            put(hide_thread).delete(unhide_thread),
        )
        .route("/api/channels/{channel_id}/stars", get(list_stars))
        .route(
            "/api/channels/{channel_id}/stars/{message_id}",
            put(star_message).delete(unstar_message),
        )
        .route("/api/channels/{channel_id}/pins", get(list_pins))
        .route(
            "/api/channels/{channel_id}/pins/{message_id}",
            put(pin_message).delete(unpin_message),
        )
        .route(
            "/api/channels/{channel_id}/messages/{message_id}/reactions/{emoji}",
            put(add_reaction).delete(remove_reaction),
        )
        .route("/api/channels/{channel_id}/agents", get(channel_agents))
        .route("/api/channels/{channel_id}/activity", get(channel_activity))
        .route("/api/agents", get(available_agents))
        .route("/api/agents/{agent_id}", delete(forget_agent))
        .route("/api/agents/{agent_id}/avatar", get(agent_avatar))
        .route("/api/dms", get(list_agent_dms))
        .route("/api/dms/{agent_id}", post(open_agent_dm))
        .route("/api/admin/agents/{agent_id}/dm-policy", get(get_agent_dm_policy).put(update_agent_dm_policy))
        .route("/api/admin/sources", get(list_agent_sources))
        .route("/api/files/{file_id}", get(get_file))
        .route("/agent/files/{file_id}", get(get_agent_file))
        .route("/api/connections", get(list_connections).post(add_connection))
        .route(
            "/api/connections/{name}",
            put(update_connection).delete(remove_connection),
        )
        .route("/api/instance", put(update_instance))
        .route("/api/export", get(export_data))
        .route(
            "/api/import",
            post(import_data).layer(axum::extract::DefaultBodyLimit::max(MAX_IMPORT_BYTES)),
        )
        .route("/api/pairing", get(list_pairing).post(create_pairing))
        .route("/api/pairing/{token}", delete(revoke_pairing))
        .route("/api/push-tokens", post(register_push_token).delete(unregister_push_token))
        .route("/api/auth/config", get(auth_config))
        .route("/api/auth/google/start", get(google_start))
        .route("/api/auth/google/callback", get(google_callback))
        .route("/api/auth/apple", post(apple_signin))
        .route("/ws", get(ui_ws))
        .route("/agent/ws", get(agent_ws));
    if let Some(dir) = &state.ui_dir {
        // Conversation deep links are real browser paths. Serve the SPA entry
        // only for that namespace so unknown APIs and assets remain honest
        // 404s instead of returning index.html with a successful status.
        app = app.route_service(
            "/g/{*path}",
            tower_http::services::ServeFile::new(dir.join("index.html")),
        );
        app = app.route_service(
            "/threads",
            tower_http::services::ServeFile::new(dir.join("index.html")),
        );
        app = app.fallback_service(
            tower_http::services::ServeDir::new(dir)
                .append_index_html_on_directories(true),
        );
    }
    app.with_state(state)
}

// ------------------------------------------------------------------ helpers

fn group_or_404(state: &AppState, group_id: &str) -> Result<Value, ApiError> {
    state
        .hub
        .store
        .group(group_id)
        .ok_or_else(|| err(StatusCode::NOT_FOUND, "Unknown group"))
}

fn channel_or_404(state: &AppState, channel_id: &str) -> Result<Value, ApiError> {
    state
        .hub
        .store
        .channel(channel_id)
        .ok_or_else(|| err(StatusCode::NOT_FOUND, "Unknown channel"))
}

/// Overlay one user's sidebar prefs onto a list of groups or channels:
/// `hidden` becomes *their* flag (the legacy global column is ignored), and
/// items they manually ordered sort first; the rest keep the store's order.
fn overlay_prefs(items: Vec<Value>, prefs: &std::collections::HashMap<String, (bool, Option<i64>)>) -> Vec<Value> {
    let mut indexed: Vec<(usize, Value)> = items
        .into_iter()
        .map(|mut item| {
            let id = item["id"].as_str().unwrap_or_default();
            item["hidden"] = json!(prefs.get(id).map(|p| p.0).unwrap_or(false));
            item
        })
        .enumerate()
        .collect();
    indexed.sort_by_key(|(i, item)| {
        let id = item["id"].as_str().unwrap_or_default();
        (prefs.get(id).and_then(|p| p.1).unwrap_or(i64::MAX), *i)
    });
    indexed.into_iter().map(|(_, item)| item).collect()
}

fn group_payload(state: &AppState, group: &Value, user: &AuthedUser) -> Value {
    let gid = group["id"].as_str().unwrap_or_default();
    let chan_prefs = state.hub.store.user_prefs(&user.username, "channel");
    let mut channels = overlay_prefs(state.hub.store.group_channels(gid), &chan_prefs);
    let ids: Vec<String> = channels
        .iter()
        .filter_map(|c| c["id"].as_str().map(String::from))
        .collect();
    let unreads = state.hub.store.unread_counts(&user.username, &ids);
    for c in &mut channels {
        let cid = c["id"].as_str().unwrap_or_default();
        let unread = &unreads[cid];
        c["unread"] = unread["count"].clone();
        c["mentions"] = unread["mentions"].clone();
        c["last_read_id"] = unread["last_read_id"].clone();
    }
    let mut out = group.clone();
    // Hiding is personal: report the caller's flag, not the legacy global.
    let group_prefs = state.hub.store.user_prefs(&user.username, "group");
    out["hidden"] = json!(group_prefs.get(gid).map(|p| p.0).unwrap_or(false));
    out["channels"] = Value::Array(channels);
    let admin =
        user.instance_admin || state.hub.store.user_is_group_admin(&user.username, gid);
    out["role"] = json!(if admin { "admin" } else { "member" });
    out
}

/// The per-attachment cap for these bytes: the video cap only for verified
/// video containers (audio declarations keep the ordinary cap — voice notes
/// share the mp4/webm containers).
fn attachment_max_bytes(data: &[u8], declared: &str, config: &crate::config::ConfigData) -> usize {
    let video = !declared.to_ascii_lowercase().starts_with("audio/") && sniff_video_mime(data).is_some();
    let video_mb = if config.max_video_mb == 0 { config.max_file_mb } else { config.max_video_mb };
    let mb = if video { video_mb } else { config.max_file_mb };
    (mb as usize).saturating_mul(1024 * 1024)
}

fn upload_too_large_message(data: &[u8], declared: &str) -> &'static str {
    if declared.to_ascii_lowercase().starts_with("video/") && sniff_video_mime(data).is_none() {
        "Unrecognized video container — ordinary file limit applies"
    } else {
        "File too large"
    }
}

fn inline_video_mime(mime: &str) -> bool {
    matches!(mime.split(';').next().unwrap_or("").trim().to_ascii_lowercase().as_str(),
        "video/mp4" | "video/webm" | "video/quicktime")
}

fn byte_range(raw: &str, size: u64) -> Option<Result<(u64, u64), ()>> {
    let raw = raw.strip_prefix("bytes=")?;
    if raw.contains(',') { return None; }
    let (start, end) = raw.split_once('-')?;
    let last = match size.checked_sub(1) { Some(last) => last, None => return Some(Err(())) };
    if start.is_empty() {
        let suffix = end.parse::<u64>().ok()?;
        if suffix == 0 { return Some(Err(())); }
        return Some(Ok((size.saturating_sub(suffix), last)));
    }
    let start = start.parse::<u64>().ok()?;
    let end = if end.is_empty() { last } else { end.parse::<u64>().ok()?.min(last) };
    Some(if start <= end && start < size { Ok((start, end)) } else { Err(()) })
}

fn resolve_thread(
    state: &AppState,
    channel_id: &str,
    thread_id: Option<i64>,
) -> Result<Option<i64>, ApiError> {
    let Some(tid) = thread_id else { return Ok(None) };
    let root = state
        .hub
        .store
        .message(tid)
        .filter(|m| m["channel_id"] == channel_id)
        .ok_or_else(|| err(StatusCode::NOT_FOUND, "Unknown thread"))?;
    // Replying to a reply continues that message's thread.
    Ok(Some(root["thread_id"].as_i64().unwrap_or(tid)))
}

// ------------------------------------------------------------------ handlers

async fn me(
    State(state): State<AppState>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers, &q)?;
    let config = state.config.snapshot();
    Ok(Json(json!({
        "username": user.username,
        "display_name": user.display_name,
        "instance_admin": user.instance_admin,
        "version": env!("CARGO_PKG_VERSION"),
        // Clients use the real server limit to reject impossible uploads before
        // copying a promised file into the webview heap.
        "max_file_mb": config.max_file_mb,
        "max_video_mb": config.max_video_mb,
        // Voice features (voice notes, speak-aloud, live voice) need an
        // OPENAI_API_KEY in the server env; clients hide the controls without it.
        "voice": crate::voice::api_key().is_some(),
        // AI search answers (/api/search/ask) need an ANTHROPIC_API_KEY in the
        // server env; clients hide their "Ask AI" controls without it.
        "search_ai": crate::ai::api_key().is_some(),
        // MapLibre style URL for map artifacts; empty when the operator has
        // not configured tiles, in which case clients draw the SVG fallback.
        "map_style_url": state.config.map_style_url(),
    })))
}

/// Profile self-service: the caller edits their own display name. Roles,
/// email and disabled stay admin-only on PATCH /api/users/{username}.
async fn update_me(
    State(state): State<AppState>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
    Json(payload): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers, &q)?;
    let Some(display_name) = payload["display_name"].as_str() else {
        return Err(err(StatusCode::BAD_REQUEST, "display_name required"));
    };
    // '' clears the name back to the username; cap it like a channel name.
    let display_name: String = display_name.trim().chars().take(80).collect();
    state
        .hub
        .store
        .set_user_display_name(&user.username, &display_name);
    let shown = if display_name.is_empty() { user.username.clone() } else { display_name };
    Ok(Json(json!({
        "username": user.username,
        "display_name": shown,
        "instance_admin": user.instance_admin,
    })))
}

/// Account deletion (App Store guideline 5.1.1(v)): erase everything keyed
/// to the caller (authored messages + their attachments, stars, reads,
/// pins, mentions, memberships) including the account row itself — which
/// revokes every session the user holds, since session verification needs
/// a live account. The admin key survives: it is the instance's operator
/// credential (printed in the server log), not a user account.
async fn delete_me(
    State(state): State<AppState>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers, &q)?;
    let store = state.hub.store.clone();
    let username = user.username.clone();
    tokio::task::spawn_blocking(move || store.delete_user_data(&username))
        .await
        .map_err(|_| err(StatusCode::INTERNAL_SERVER_ERROR, "Deletion failed"))?;
    tracing::info!("account data for {} deleted; sessions revoked", user.username);
    Ok(Json(json!({"ok": true})))
}

// ------------------------------------------------------------ users / invites

/// The workspace roster. Any signed-in user may read it (it feeds the
/// members panel's people picker, like Slack's member list); mutations are
/// instance-admin only.
async fn list_users(
    State(state): State<AppState>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    require_user(&state, &headers, &q)?;
    let users: Vec<Value> = state
        .hub
        .store
        .list_users()
        .into_iter()
        .map(|u| {
            json!({
                "username": u["username"],
                "display_name": u["display_name"],
                "email": u["email"],
                "instance_role": u["instance_role"],
                "created_at": u["created_at"],
                "disabled": u["disabled"],
            })
        })
        .collect();
    Ok(Json(json!({"users": users})))
}

/// Instance-admin account management: disable/enable a user (disabling also
/// revokes their sessions) or change their instance role.
async fn update_user(
    State(state): State<AppState>,
    Path(username): Path<String>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
    Json(payload): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let caller = require_user(&state, &headers, &q)?;
    require_instance_admin(&caller)?;
    let store = &state.hub.store;
    if store.user(&username).is_none() {
        return Err(err(StatusCode::NOT_FOUND, "Unknown user"));
    }
    if let Some(disabled) = payload["disabled"].as_bool() {
        if username == caller.username && disabled {
            return Err(err(StatusCode::BAD_REQUEST, "You can't disable your own account"));
        }
        store.set_user_disabled(&username, disabled);
        if disabled {
            store.bump_session_version(&username);
        }
    }
    if let Some(role) = payload["instance_role"].as_str() {
        if !["admin", "member"].contains(&role) {
            return Err(err(StatusCode::BAD_REQUEST, "instance_role must be 'admin' or 'member'"));
        }
        if username == caller.username && role != "admin" {
            return Err(err(StatusCode::BAD_REQUEST, "You can't demote your own account"));
        }
        store.set_user_instance_role(&username, role);
    }
    let user = store.user(&username).unwrap_or(Value::Null);
    Ok(Json(json!({
        "username": user["username"],
        "display_name": user["display_name"],
        "email": user["email"],
        "instance_role": user["instance_role"],
        "created_at": user["created_at"],
        "disabled": user["disabled"],
    })))
}

async fn list_invites(
    State(state): State<AppState>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let caller = require_user(&state, &headers, &q)?;
    require_instance_admin(&caller)?;
    let links: Vec<Value> = state
        .hub
        .store
        .list_invite_links()
        .into_iter()
        .map(|mut l| {
            let token = l["token"].as_str().unwrap_or_default();
            l["url"] = json!(join_url(&state, token));
            l
        })
        .collect();
    Ok(Json(json!({
        "invites": state.hub.store.list_invites(),
        "links": links,
    })))
}

/// How long a shareable invite link can sit unused.
const INVITE_LINK_TTL_SECS: f64 = 7.0 * 24.0 * 3600.0;

/// The absolute /join URL for an invite-link token, based on the configured
/// public URL when there is one.
fn join_url(state: &AppState, token: &str) -> String {
    let base = state.config.public_url();
    if base.is_empty() {
        format!("/join/{token}")
    } else {
        format!("{base}/join/{token}")
    }
}

/// Invite a person. Two modes: `{"email": …}` keys the invite to an exact
/// address (no mail is sent — they just sign in with it), while
/// `{"link": true}` mints a single-use, expiring URL to hand to anyone.
async fn create_invite(
    State(state): State<AppState>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
    Json(payload): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let caller = require_user(&state, &headers, &q)?;
    require_instance_admin(&caller)?;
    let role = payload["instance_role"].as_str().unwrap_or("member");
    if !["admin", "member"].contains(&role) {
        return Err(err(StatusCode::BAD_REQUEST, "instance_role must be 'admin' or 'member'"));
    }
    if payload["link"].as_bool() == Some(true) {
        let mut link = state.hub.store.create_invite_link(
            Some(&caller.username),
            role,
            INVITE_LINK_TTL_SECS,
        );
        let token = link["token"].as_str().unwrap_or_default();
        link["url"] = json!(join_url(&state, token));
        return Ok(Json(link));
    }
    let email = payload["email"].as_str().unwrap_or("").trim().to_lowercase();
    if state.hub.store.user_by_email(&email).is_some() {
        return Err(err(StatusCode::CONFLICT, "That email already has an account"));
    }
    let invite = state
        .hub
        .store
        .create_invite(&email, Some(&caller.username), role)
        .ok_or_else(|| err(StatusCode::BAD_REQUEST, "A valid email is required"))?;
    Ok(Json(invite))
}

/// Revoke a pending invite: the path segment is an email for address
/// invites, or a link token (no '@') for link invites.
async fn revoke_invite(
    State(state): State<AppState>,
    Path(email): Path<String>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let caller = require_user(&state, &headers, &q)?;
    require_instance_admin(&caller)?;
    let ok = if email.contains('@') {
        state.hub.store.delete_invite(&email)
    } else {
        state.hub.store.delete_invite_link(&email)
    };
    Ok(Json(json!({"ok": ok})))
}

/// Landing for a shared invite link: bounce to the web UI with the token in
/// the fragment; the auth gate carries it through sign-in. Expired or used
/// links land with an explanatory error instead.
async fn join_link(
    State(state): State<AppState>,
    Path(token): Path<String>,
) -> Response {
    let target = if state.hub.store.valid_invite_link(&token).is_some() {
        format!("/#join={}", crate::auth::urlencode(&token))
    } else {
        "/#auth_error=invite_invalid".to_string()
    };
    (StatusCode::FOUND, [("location", target)]).into_response()
}

/// The caller's groups plus public ones; instance admins (the operator) see all.
async fn list_groups(
    State(state): State<AppState>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers, &q)?;
    let mine: Vec<Value> = state
        .hub
        .store
        .list_groups()
        .into_iter()
        .filter(|g| {
            user.instance_admin
                || state
                    .hub
                    .store
                    .user_can_access_group(&user.username, g["id"].as_str().unwrap_or_default())
        })
        .collect();
    // The caller's personal order (their reorder drags), not the global one.
    let prefs = state.hub.store.user_prefs(&user.username, "group");
    let mut groups: Vec<Value> = overlay_prefs(mine, &prefs)
        .iter()
        .map(|g| group_payload(&state, g, &user))
        .collect();
    let dm_channels = state.hub.store.agent_dms_for_user(&user.username).into_iter().filter_map(|dm| {
        let mut channel = state.hub.store.channel(dm["channel_id"].as_str()?)?;
        channel["unread"] = dm["unread"].clone(); channel["mentions"] = json!(0);
        channel["dm_can_post"] = json!(state.hub.store.user_can_start_agent_dm(&user.username,
            channel["dm_agent_id"].as_str().unwrap_or_default()));
        Some(channel)
    }).collect::<Vec<_>>();
    // Only surface the DM section to users it means something to: existing
    // conversations, or at least one agent they may DM. Anyone else (and any
    // older client) never sees an empty "Direct messages" group.
    let can_dm_any = dm_channels.is_empty()
        && state.hub.store.known_agents().iter().any(|a| {
            a["id"].as_str()
                .is_some_and(|id| state.hub.store.user_can_start_agent_dm(&user.username, id))
        });
    if !dm_channels.is_empty() || can_dm_any {
        groups.push(json!({"id":"__dms","name":"Direct messages","description":"Private conversations with agents",
            "created_by":Value::Null,"created_at":0.0,"channels":dm_channels,"role":"member","hidden":false,
            "is_public":false,"kind":"agent_dms"}));
    }
    Ok(Json(json!({"groups": groups})))
}

/// Any user may create a group; the creator becomes its (group) admin.
async fn create_group(
    State(state): State<AppState>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
    Json(payload): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers, &q)?;
    let name = payload["name"].as_str().unwrap_or("").trim().to_string();
    if name.is_empty() {
        return Err(err(StatusCode::BAD_REQUEST, "Group name required"));
    }
    let description = payload["description"].as_str().unwrap_or("").trim();
    let group = state
        .hub
        .store
        .create_group(&name, description, Some(&user.username));
    Ok(Json(group_payload(&state, &group, &user)))
}

/// Update a group's flags: `hidden` tucks the group away in *the caller's*
/// sidebar (a personal pref, so any member may set it); `is_public` opens
/// the group to every signed-in user (group-admin gated — it changes access,
/// not presentation).
async fn update_group(
    State(state): State<AppState>,
    Path(group_id): Path<String>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
    Json(payload): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers, &q)?;
    group_or_404(&state, &group_id)?;
    require_member(&state, &user, &group_id)?;
    let is_public = payload.get("is_public").and_then(Value::as_bool);
    let hidden = payload.get("hidden").and_then(Value::as_bool);
    if is_public.is_none() && hidden.is_none() {
        return Err(err(StatusCode::BAD_REQUEST, "hidden or is_public (bool) required"));
    }
    if let Some(public) = is_public {
        require_group_admin(&state, &user, &group_id)?;
        state.hub.store.set_group_public(&group_id, public);
    }
    if let Some(hidden) = hidden {
        state
            .hub
            .store
            .set_pref_hidden(&user.username, "group", &group_id, hidden);
    }
    // Re-read so the payload reflects an is_public change.
    let group = group_or_404(&state, &group_id)?;
    Ok(Json(group_payload(&state, &group, &user)))
}

async fn delete_group(
    State(state): State<AppState>,
    Path(group_id): Path<String>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers, &q)?;
    group_or_404(&state, &group_id)?;
    require_group_admin(&state, &user, &group_id)?;
    state.hub.store.delete_group(&group_id);
    Ok(Json(json!({"ok": true})))
}

/// Message templates are private per-user drafts scoped to a group: every
/// handler reads the owner from the session, never from the payload, so
/// membership is the only authorization question.
const MAX_TEMPLATES_PER_GROUP: usize = 50;
const MAX_TEMPLATE_LABEL_CHARS: usize = 80;

/// Validated `(label, text)`. An absent label falls back to the first line so
/// the picker always has something short to show.
fn template_fields(payload: &Value) -> Result<(String, String), ApiError> {
    let text = payload["text"].as_str().unwrap_or("").to_string();
    if text.trim().is_empty() {
        return Err(err(StatusCode::BAD_REQUEST, "Template text required"));
    }
    if text.chars().count() > MAX_MESSAGE_CHARS {
        return Err(err(StatusCode::BAD_REQUEST, "Template is too long"));
    }
    let mut label = payload["label"].as_str().unwrap_or("").trim().to_string();
    if label.chars().count() > MAX_TEMPLATE_LABEL_CHARS {
        return Err(err(StatusCode::BAD_REQUEST, "Template label is too long"));
    }
    if label.is_empty() {
        label = text
            .lines()
            .find(|line| !line.trim().is_empty())
            .unwrap_or("")
            .trim()
            .chars()
            .take(MAX_TEMPLATE_LABEL_CHARS)
            .collect();
    }
    Ok((label, text))
}

async fn list_templates(
    State(state): State<AppState>,
    Path(group_id): Path<String>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers, &q)?;
    group_or_404(&state, &group_id)?;
    require_member(&state, &user, &group_id)?;
    let templates = state.hub.store.message_templates(&user.username, &group_id);
    Ok(Json(json!({"templates": templates})))
}

async fn create_template(
    State(state): State<AppState>,
    Path(group_id): Path<String>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
    Json(payload): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers, &q)?;
    group_or_404(&state, &group_id)?;
    require_member(&state, &user, &group_id)?;
    let (label, text) = template_fields(&payload)?;
    state.hub.store.create_message_template(
        &user.username, &group_id, &label, &text, MAX_TEMPLATES_PER_GROUP as i64,
    ).map_err(|e| {
        tracing::error!("message template insert failed: {e}");
        err(StatusCode::INTERNAL_SERVER_ERROR, "Could not save template")
    })?.map(Json).ok_or_else(|| err(
        StatusCode::CONFLICT,
        &format!("Up to {MAX_TEMPLATES_PER_GROUP} templates per group — delete one first"),
    ))
}

async fn update_template(
    State(state): State<AppState>,
    Path((group_id, template_id)): Path<(String, String)>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
    Json(mut payload): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers, &q)?;
    group_or_404(&state, &group_id)?;
    require_member(&state, &user, &group_id)?;
    if !payload.is_object() {
        return Err(err(StatusCode::BAD_REQUEST, "Template body must be an object"));
    }
    if payload.get("label").and_then(Value::as_str).is_none() {
        let label = state.hub.store.message_template_label(
            &template_id, &user.username, &group_id,
        ).ok_or_else(|| err(StatusCode::NOT_FOUND, "Unknown template"))?;
        payload["label"] = json!(label);
    }
    let (label, text) = template_fields(&payload)?;
    state
        .hub
        .store
        .update_message_template(&template_id, &user.username, &group_id, &label, &text)
        .map(Json)
        .ok_or_else(|| err(StatusCode::NOT_FOUND, "Unknown template"))
}

async fn delete_template(
    State(state): State<AppState>,
    Path((group_id, template_id)): Path<(String, String)>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers, &q)?;
    group_or_404(&state, &group_id)?;
    require_member(&state, &user, &group_id)?;
    if !state.hub.store.delete_message_template(&template_id, &user.username, &group_id) {
        return Err(err(StatusCode::NOT_FOUND, "Unknown template"));
    }
    Ok(Json(json!({"ok": true})))
}

async fn create_channel(
    State(state): State<AppState>,
    Path(group_id): Path<String>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
    Json(payload): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers, &q)?;
    group_or_404(&state, &group_id)?;
    require_group_admin(&state, &user, &group_id)?;
    let name = payload["name"].as_str().unwrap_or("").trim().to_string();
    if name.is_empty() {
        return Err(err(StatusCode::BAD_REQUEST, "Channel name required"));
    }
    let topic = payload["topic"].as_str().unwrap_or("").trim();
    Ok(Json(state.hub.store.create_channel(&group_id, &name, topic)))
}

async fn update_channel(
    State(state): State<AppState>,
    Path((group_id, channel_id)): Path<(String, String)>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
    Json(payload): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers, &q)?;
    let channel = channel_or_404(&state, &channel_id)?;
    if channel["group_id"] != group_id.as_str() {
        return Err(err(StatusCode::NOT_FOUND, "Channel not in this group"));
    }
    let name = match payload.get("name").and_then(Value::as_str) {
        Some(n) => {
            let n = n.trim();
            if n.is_empty() {
                return Err(err(StatusCode::BAD_REQUEST, "Channel name can't be empty"));
            }
            Some(n.to_string())
        }
        None => None,
    };
    let topic = payload
        .get("topic")
        .and_then(Value::as_str)
        .map(|t| t.trim().to_string());
    let hidden = payload.get("hidden").and_then(Value::as_bool);
    // Rename/topic edit the shared channel (group admins); hiding is the
    // caller's personal sidebar pref (any member).
    if name.is_some() || topic.is_some() {
        require_group_admin(&state, &user, &group_id)?;
    } else {
        require_member(&state, &user, &group_id)?;
    }
    if let Some(h) = hidden {
        state
            .hub
            .store
            .set_pref_hidden(&user.username, "channel", &channel_id, h);
    }
    let mut updated = if name.is_some() || topic.is_some() {
        state
            .hub
            .store
            .update_channel(&channel_id, name.as_deref(), topic.as_deref(), None)
            .ok_or_else(|| err(StatusCode::NOT_FOUND, "Unknown channel"))?
    } else {
        channel_or_404(&state, &channel_id)?
    };
    let prefs = state.hub.store.user_prefs(&user.username, "channel");
    updated["hidden"] = json!(prefs.get(channel_id.as_str()).map(|p| p.0).unwrap_or(false));
    Ok(Json(updated))
}

/// Sidebar ordering is a personal pref: the drag order lands in the
/// caller's own prefs, nobody else's sidebar moves.
async fn reorder_groups(
    State(state): State<AppState>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
    Json(payload): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers, &q)?;
    let ids: Vec<String> = payload["ids"]
        .as_array()
        .map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect())
        .unwrap_or_default();
    if ids.is_empty() {
        return Err(err(StatusCode::BAD_REQUEST, "ids array required"));
    }
    state.hub.store.set_pref_positions(&user.username, "group", &ids);
    Ok(Json(json!({"ok": true})))
}

async fn reorder_channels(
    State(state): State<AppState>,
    Path(group_id): Path<String>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
    Json(payload): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers, &q)?;
    group_or_404(&state, &group_id)?;
    require_member(&state, &user, &group_id)?;
    let ids: Vec<String> = payload["ids"]
        .as_array()
        .map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect())
        .unwrap_or_default();
    if ids.is_empty() {
        return Err(err(StatusCode::BAD_REQUEST, "ids array required"));
    }
    state.hub.store.set_pref_positions(&user.username, "channel", &ids);
    Ok(Json(json!({"ok": true})))
}

async fn delete_channel(
    State(state): State<AppState>,
    Path((group_id, channel_id)): Path<(String, String)>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers, &q)?;
    let channel = channel_or_404(&state, &channel_id)?;
    if channel["group_id"] != group_id.as_str() {
        return Err(err(StatusCode::NOT_FOUND, "Channel not in this group"));
    }
    require_group_admin(&state, &user, &group_id)?;
    state.hub.store.delete_channel(&channel_id);
    Ok(Json(json!({"ok": true})))
}

async fn list_members(
    State(state): State<AppState>,
    Path(group_id): Path<String>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers, &q)?;
    group_or_404(&state, &group_id)?;
    require_member(&state, &user, &group_id)?;
    let known: HashMap<String, String> = state
        .hub
        .store
        .known_agents()
        .iter()
        .filter_map(|a| {
            Some((a["id"].as_str()?.to_string(), a["name"].as_str()?.to_string()))
        })
        .collect();
    let mut members = state.hub.store.members(&group_id);
    for m in &mut members {
        let id = m["member_id"].as_str().unwrap_or_default();
        if m["member_type"] == "agent" {
            m["name"] = json!(known.get(id).cloned().unwrap_or_else(|| id.to_string()));
        } else {
            let display = state
                .hub
                .store
                .user(id)
                .and_then(|u| u["display_name"].as_str().map(str::to_string))
                .filter(|d| !d.is_empty())
                .unwrap_or_else(|| id.to_string());
            m["name"] = json!(display);
        }
    }
    Ok(Json(json!({"members": members})))
}

/// Add a person or an agent to the group (group admins only). Re-adding an
/// existing user member with a different role updates the role — this is
/// also the promote/demote API.
async fn add_member(
    State(state): State<AppState>,
    Path(group_id): Path<String>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
    Json(payload): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers, &q)?;
    group_or_404(&state, &group_id)?;
    require_group_admin(&state, &user, &group_id)?;
    let member_type = payload["member_type"].as_str().unwrap_or("");
    let member_id = payload["member_id"].as_str().unwrap_or("");
    let role = payload["role"].as_str().unwrap_or("member");
    if !["user", "agent"].contains(&member_type) {
        return Err(err(StatusCode::BAD_REQUEST, "member_type must be 'user' or 'agent'"));
    }
    if member_id.is_empty() {
        return Err(err(StatusCode::BAD_REQUEST, "member_id required"));
    }
    if !["member", "admin"].contains(&role) {
        return Err(err(StatusCode::BAD_REQUEST, "role must be 'member' or 'admin'"));
    }
    if member_type == "agent" && state.hub.store.agent(member_id).is_none() {
        return Err(err(StatusCode::BAD_REQUEST, "Unknown agent"));
    }
    if member_type == "user" && state.hub.store.user(member_id).is_none() {
        return Err(err(StatusCode::BAD_REQUEST, "Unknown user"));
    }
    let channel_id = payload["channel_id"].as_str().filter(|s| !s.is_empty());
    if let Some(cid) = channel_id {
        if member_type != "agent" {
            return Err(err(StatusCode::BAD_REQUEST, "Only agents can be scoped to one channel"));
        }
        if channel_or_404(&state, cid)?["group_id"] != group_id.as_str() {
            return Err(err(StatusCode::NOT_FOUND, "Channel not in this group"));
        }
    }
    state.hub.store.add_member(
        &group_id,
        member_type,
        member_id,
        if member_type == "user" { role } else { "member" },
        channel_id,
    );
    Ok(Json(json!({"ok": true})))
}

async fn remove_member(
    State(state): State<AppState>,
    Path((group_id, member_type, member_id)): Path<(String, String, String)>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers, &q)?;
    group_or_404(&state, &group_id)?;
    // Group admins manage the roster; anyone may remove *themselves* (leave).
    let leaving = member_type == "user" && member_id == user.username;
    if !leaving {
        require_group_admin(&state, &user, &group_id)?;
    }
    let channel_id = q.get("channel_id").map(String::as_str).filter(|s| !s.is_empty());
    let removed = state
        .hub
        .store
        .remove_member(&group_id, &member_type, &member_id, channel_id);
    Ok(Json(json!({"ok": removed})))
}

async fn list_messages(
    State(state): State<AppState>,
    Path(channel_id): Path<String>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers, &q)?;
    require_channel_member(&state, &user, &channel_id)?;
    let thread_id = q.get("thread_id").and_then(|s| s.parse().ok());
    let before_id = q.get("before_id").and_then(|s| s.parse().ok());
    let limit: usize = q
        .get("limit")
        .and_then(|s| s.parse().ok())
        .unwrap_or(50)
        .clamp(1, 200);
    Ok(Json(json!({
        "messages": state.hub.store.messages(&channel_id, thread_id, before_id, limit)
    })))
}

/// GET /api/search — full-text search over message text plus name/topic
/// matches on channels and groups, for the search UIs. `q` is required.
/// `limit` (default 20, cap 50) and `offset` page the message hits;
/// `channel_id` / `group_id` / `author` narrow the scope; `sort=new` orders
/// newest-first instead of best-match (bm25); `match=any` widens to
/// any-term recall (default: all terms); `types` picks result kinds
/// (comma list of `messages,channels,groups`, default all three).
/// `has_files=1` keeps only messages carrying an attachment and `file_type`
/// (`image`/`video`/`audio`/`pdf`/`doc`) narrows to one kind; either one lets
/// `q` be empty (browse every message with a matching file, newest first).
/// Attachment filenames are always part of the match, and every message hit
/// carries its `attachments` array.
async fn search(
    State(state): State<AppState>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers, &q)?;
    // Instance admins search everything; everyone else only what they can see.
    let scope_user = (!user.instance_admin).then_some(user.username.as_str());
    let query = q.get("q").map(|s| s.trim()).unwrap_or_default();
    let has_files = matches!(q.get("has_files").map(String::as_str), Some("1" | "true"));
    let file_type = q.get("file_type").map(String::as_str).filter(|s| !s.is_empty());
    let attach_filter = has_files || file_type.is_some();
    // A query is required unless the attachment filter alone is doing the work
    // (browse every message that has a file).
    if query.is_empty() && !attach_filter {
        return Err(err(StatusCode::BAD_REQUEST, "Query required"));
    }
    let limit: usize = q
        .get("limit")
        .and_then(|s| s.parse().ok())
        .unwrap_or(20)
        .clamp(1, 50);
    let offset: usize = q.get("offset").and_then(|s| s.parse().ok()).unwrap_or(0);
    let channel_id = q.get("channel_id").map(String::as_str).filter(|s| !s.is_empty());
    let group_id = q.get("group_id").map(String::as_str).filter(|s| !s.is_empty());
    let author = q.get("author").map(String::as_str).filter(|s| !s.is_empty());
    let newest_first = q.get("sort").map(String::as_str) == Some("new");
    let match_any = q.get("match").map(String::as_str) == Some("any");
    let types = q.get("types").map(String::as_str).unwrap_or("messages,channels,groups");
    let want = |t: &str| types.split(',').any(|x| x.trim() == t);
    let store = &state.hub.store;
    let mut out = json!({"query": query});
    if want("messages") {
        // One extra row decides has_more without a second query.
        let mut rows = store.search_messages_ext(
            query, match_any, channel_id, group_id, author, None, scope_user, newest_first,
            has_files, file_type, limit + 1, offset,
        );
        if user.instance_admin {
            let owned = store.search_messages_ext(query, match_any, channel_id, group_id, author, None,
                Some(&user.username), newest_first, has_files, file_type, limit + 1, offset);
            for row in owned {
                if row["group_id"].as_str() == Some("") && !rows.iter().any(|x| x["id"] == row["id"]) { rows.push(row); }
            }
        }
        let has_more = rows.len() > limit;
        rows.truncate(limit);
        out["messages"] = json!({"items": rows, "has_more": has_more, "offset": offset});
    }
    // Channel/group name matches only make sense with a text query, and are
    // irrelevant to an attachment filter — skip them when browsing files.
    // Their `hidden` badge reflects the caller's own sidebar prefs (keep the
    // relevance order — no positional overlay here).
    let personal_hidden = |mut hits: Vec<Value>, kind: &str| -> Vec<Value> {
        let prefs = store.user_prefs(&user.username, kind);
        for h in &mut hits {
            let id = h["id"].as_str().unwrap_or_default();
            h["hidden"] = json!(prefs.get(id).map(|p| p.0).unwrap_or(false));
        }
        hits
    };
    if want("channels") && !query.is_empty() {
        out["channels"] = json!(personal_hidden(store.search_channels(query, scope_user, 20), "channel"));
    }
    if want("groups") && !query.is_empty() {
        out["groups"] = json!(personal_hidden(store.search_groups(query, scope_user, 20), "group"));
    }
    Ok(Json(out))
}

/// GET /api/channels/{channel_id}/attachments — individual attachment rows,
/// optionally scoped to `thread_id` (root plus replies). Channel membership
/// is the visibility boundary, including for instance admins and agent DMs.
async fn list_attachments(
    State(state): State<AppState>,
    Path(channel_id): Path<String>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers, &q)?;
    let channel = require_channel_member(&state, &user, &channel_id)?;
    let thread_id = q.get("thread_id").and_then(|s| s.parse::<i64>().ok());
    let file_type = q.get("file_type").map(String::as_str).filter(|s| !s.is_empty());
    let limit = q.get("limit").and_then(|s| s.parse().ok()).unwrap_or(50usize).clamp(1, 100);
    let offset = q.get("offset").and_then(|s| s.parse().ok()).unwrap_or(0usize);
    let admin = require_group_admin(
        &state, &user, channel["group_id"].as_str().unwrap_or_default(),
    ).is_ok();
    let mut items = state.hub.store.list_attachments(
        &channel_id, thread_id, file_type, limit + 1, offset,
    );
    let has_more = items.len() > limit;
    items.truncate(limit);
    for item in &mut items {
        let mine = item["author_type"] == "user" && item["author_id"] == user.username.as_str();
        item["can_delete"] = json!(mine || admin);
    }
    Ok(Json(json!({"items": items, "has_more": has_more, "offset": offset})))
}

/// DELETE one attachment while retaining its message and sibling files.
/// User-authored files may be removed by their sender or a group admin;
/// agent-authored files are deliberately group-admin-only.
async fn delete_attachment(
    State(state): State<AppState>,
    Path((channel_id, file_id)): Path<(String, String)>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers, &q)?;
    let channel = require_channel_member(&state, &user, &channel_id)?;
    let file = state.hub.store.file(&file_id)
        .filter(|f| f["channel_id"] == channel_id.as_str())
        .ok_or_else(|| err(StatusCode::NOT_FOUND, "Unknown attachment"))?;
    let message = state.hub.store.message(file["message_id"].as_i64().unwrap_or_default())
        .ok_or_else(|| err(StatusCode::NOT_FOUND, "Unknown message"))?;
    let mine = message["author_type"] == "user" && message["author_id"] == user.username.as_str();
    if !mine {
        require_group_admin(&state, &user, channel["group_id"].as_str().unwrap_or_default())
            .map_err(|_| err(StatusCode::FORBIDDEN, "Only the sender or a group admin can delete an attachment"))?;
    }
    let updated = state.hub.store.delete_attachment(&file_id)
        .ok_or_else(|| err(StatusCode::NOT_FOUND, "Unknown attachment"))?;
    state.hub.post_transient(
        &channel_id, json!({"type": "message_update", "message": updated}),
    );
    Ok(Json(updated))
}

/// POST /api/search/ask {"q", "channel_id"?, "group_id"?} — AI answer mode:
/// distill the question to keywords, retrieve the best-matching messages via
/// the FTS index, and have Claude write a short answer citing them as [1],
/// [2], …. `sources` come back in citation order ([1] = sources[0]). Needs
/// ANTHROPIC_API_KEY in the server env; `/api/me` advertises it as
/// `search_ai` so clients can hide the control.
async fn search_ask(
    State(state): State<AppState>,
    Query(q): Query<HashMap<String, String>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(payload): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers, &q)?;
    let scope_user = (!user.instance_admin).then(|| user.username.clone());
    // Externally billed like the voice endpoints, so share their backstop.
    if !state.upload_limiter.allow(&rate_key(&peer)) {
        return Err(err(StatusCode::TOO_MANY_REQUESTS, "Too many AI requests — slow down"));
    }
    let Some(key) = crate::ai::api_key() else {
        return Err(err(
            StatusCode::BAD_REQUEST,
            "AI answers need ANTHROPIC_API_KEY set on the server",
        ));
    };
    let question = payload["q"].as_str().unwrap_or("").trim().to_string();
    if question.is_empty() {
        return Err(err(StatusCode::BAD_REQUEST, "Question required"));
    }
    let channel_id = payload["channel_id"].as_str().filter(|s| !s.is_empty());
    let group_id = payload["group_id"].as_str().filter(|s| !s.is_empty());
    // Recall-oriented retrieval: any-term match, bm25 ranks denser hits up.
    let retrieval = crate::ai::retrieval_keywords(&question).unwrap_or_else(|| question.clone());
    let mut sources = state.hub.store.search_messages(
        &retrieval,
        true,
        channel_id,
        group_id,
        None,
        None,
        scope_user.as_deref(),
        false,
        crate::ai::CONTEXT_MESSAGES,
        0,
    );
    if user.instance_admin {
        let owned = state.hub.store.search_messages(&retrieval, true, channel_id, group_id, None, None,
            Some(&user.username), false, crate::ai::CONTEXT_MESSAGES, 0);
        for row in owned {
            if row["group_id"].as_str() == Some("") && !sources.iter().any(|x| x["id"] == row["id"]) { sources.push(row); }
        }
        sources.truncate(crate::ai::CONTEXT_MESSAGES);
    }
    if sources.is_empty() {
        return Ok(Json(json!({
            "answer": Value::Null,
            "sources": [],
            "detail": "No matching messages to answer from",
        })));
    }
    let model = crate::ai::model();
    let answer = {
        let (question, sources, model) = (question.clone(), sources.clone(), model.clone());
        tokio::task::spawn_blocking(move || crate::ai::answer(&key, &model, &question, &sources))
            .await
            .map_err(|_| err(StatusCode::INTERNAL_SERVER_ERROR, "answer task failed"))?
            .map_err(|e| err(StatusCode::BAD_GATEWAY, &format!("{e:#}")))?
    };
    Ok(Json(json!({"answer": answer, "model": model, "sources": sources})))
}

async fn post_message(
    State(state): State<AppState>,
    Path(channel_id): Path<String>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
    Json(payload): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers, &q)?;
    require_channel_postable(&state, &user, &channel_id)?;
    let text = payload["text"].as_str().unwrap_or("").trim().to_string();
    if text.is_empty() {
        return Err(err(StatusCode::BAD_REQUEST, "Message text required"));
    }
    if text.chars().count() > MAX_MESSAGE_CHARS {
        return Err(err(StatusCode::BAD_REQUEST, "Message too long"));
    }
    let thread_id = resolve_thread(&state, &channel_id, payload["thread_id"].as_i64())?;
    let timezone = client_timezone(payload["timezone"].as_str().unwrap_or(""));
    let reply_in_thread = payload["reply_in_thread"].as_bool().unwrap_or(false);
    let message = state.hub.post_user_message_opts(
        &channel_id,
        &text,
        &user.username,
        Some(&user.display_name),
        thread_id,
        vec![],
        false,
        timezone.as_deref(),
        reply_in_thread,
    );
    Ok(Json(message))
}

/// Normalize a client-supplied IANA timezone: opaque to us beyond a sanity
/// length cap (it only ever reaches agents, never the UI).
fn client_timezone(raw: &str) -> Option<String> {
    let tz = raw.trim();
    if tz.is_empty() || tz.chars().count() > 64 {
        return None;
    }
    Some(tz.to_string())
}

async fn post_message_upload(
    State(state): State<AppState>,
    Path(channel_id): Path<String>,
    Query(q): Query<HashMap<String, String>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    mut multipart: Multipart,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers, &q)?;
    if !state.upload_limiter.allow(&rate_key(&peer)) {
        return Err(err(StatusCode::TOO_MANY_REQUESTS, "Too many uploads — slow down"));
    }
    require_channel_postable(&state, &user, &channel_id)?;
    let config = state.config.snapshot();
    let mut text = String::new();
    let mut thread_id: Option<i64> = None;
    let mut timezone: Option<String> = None;
    let mut reply_in_thread = false;
    let mut attachments: Vec<NewAttachment> = Vec::new();
    let mut uploaded_bytes = 0usize;
    let request_max_bytes = upload_request_max_bytes(&config);
    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|_| err(StatusCode::BAD_REQUEST, "Invalid upload"))?
    {
        match field.name().unwrap_or("") {
            "text" => text = field.text().await.unwrap_or_default().trim().to_string(),
            "thread_id" => {
                let raw = field.text().await.unwrap_or_default();
                if !raw.is_empty() {
                    thread_id = Some(
                        raw.parse()
                            .map_err(|_| err(StatusCode::BAD_REQUEST, "Invalid thread_id"))?,
                    );
                }
            }
            "timezone" => timezone = client_timezone(&field.text().await.unwrap_or_default()),
            "reply_in_thread" => {
                reply_in_thread = field.text().await.unwrap_or_default().trim() == "true";
            }
            "files" => {
                if attachments.len() >= MAX_FILES_PER_MESSAGE {
                    return Err(err(StatusCode::BAD_REQUEST, "Too many files (max 5 per message)"));
                }
                let filename = safe_filename(field.file_name().unwrap_or("file"));
                let declared = field.content_type().unwrap_or("").to_string();
                let mut field = field;
                let mut data = Vec::new();
                while let Some(chunk) = field.chunk().await
                    .map_err(|_| err(StatusCode::BAD_REQUEST, "Upload read failed"))? {
                    uploaded_bytes = uploaded_bytes.saturating_add(chunk.len());
                    if uploaded_bytes > request_max_bytes {
                        return Err(err(StatusCode::BAD_REQUEST, "Attachments too large for one message"));
                    }
                    data.extend_from_slice(&chunk);
                    if data.len() >= 12 && data.len() > attachment_max_bytes(&data, &declared, &config) {
                        return Err(err(StatusCode::BAD_REQUEST, upload_too_large_message(&data, &declared)));
                    }
                }
                if data.is_empty() {
                    return Err(err(StatusCode::BAD_REQUEST, "Empty file upload"));
                }
                if data.len() > attachment_max_bytes(&data, &declared, &config) {
                    return Err(err(StatusCode::BAD_REQUEST, upload_too_large_message(&data, &declared)));
                }
                attachments.push(NewAttachment {
                    filename,
                    mime: attachment_mime(&data, &declared),
                    data,
                });
            }
            _ => {}
        }
    }
    if text.is_empty() && attachments.is_empty() {
        return Err(err(StatusCode::BAD_REQUEST, "Message text required"));
    }
    let thread_id = resolve_thread(&state, &channel_id, thread_id)?;
    let hub = Arc::clone(&state.hub);
    let username = user.username.clone();
    let display_name = user.display_name.clone();
    let message = tokio::task::spawn_blocking(move || hub.post_user_message_opts(
        &channel_id, &text, &username, Some(&display_name), thread_id, attachments,
        false, timezone.as_deref(), reply_in_thread,
    )).await.map_err(|_| err(StatusCode::INTERNAL_SERVER_ERROR, "Message write failed"))?;
    Ok(Json(message))
}

/// Voice input: transcribe an uploaded recording and post the transcript as a
/// normal user message (the audio itself is not stored). `live=true` marks a
/// hands-free live-voice turn: the fan-out tells member agents to answer in
/// spoken prose because the reply will be read aloud.
async fn post_voice_message(
    State(state): State<AppState>,
    Path(channel_id): Path<String>,
    Query(q): Query<HashMap<String, String>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    mut multipart: Multipart,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers, &q)?;
    if !state.upload_limiter.allow(&rate_key(&peer)) {
        return Err(err(StatusCode::TOO_MANY_REQUESTS, "Too many uploads — slow down"));
    }
    require_channel_postable(&state, &user, &channel_id)?;
    let Some(key) = crate::voice::api_key() else {
        return Err(err(
            StatusCode::BAD_REQUEST,
            "Voice input needs OPENAI_API_KEY on the server (speech-to-text is not configured)",
        ));
    };
    let mut audio: Vec<u8> = Vec::new();
    let mut filename = String::new();
    let mut thread_id: Option<i64> = None;
    let mut live = false;
    let mut mentions = String::new();
    let mut timezone: Option<String> = None;
    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|_| err(StatusCode::BAD_REQUEST, "Invalid upload"))?
    {
        match field.name().unwrap_or("") {
            "file" => {
                filename = safe_filename(field.file_name().unwrap_or("voice-note.webm"));
                audio = field
                    .bytes()
                    .await
                    .map_err(|_| err(StatusCode::BAD_REQUEST, "Upload read failed"))?
                    .to_vec();
            }
            "thread_id" => {
                let raw = field.text().await.unwrap_or_default();
                if !raw.is_empty() {
                    thread_id = Some(
                        raw.parse()
                            .map_err(|_| err(StatusCode::BAD_REQUEST, "Invalid thread_id"))?,
                    );
                }
            }
            "live" => live = field.text().await.unwrap_or_default() == "true",
            "mentions" => mentions = field.text().await.unwrap_or_default(),
            "timezone" => timezone = client_timezone(&field.text().await.unwrap_or_default()),
            _ => {}
        }
    }
    if audio.is_empty() {
        return Err(err(StatusCode::BAD_REQUEST, "Empty audio upload"));
    }
    if audio.len() > MAX_VOICE_BYTES {
        return Err(err(StatusCode::BAD_REQUEST, "Voice recording too large"));
    }
    let thread_id = resolve_thread(&state, &channel_id, thread_id)?;
    let text = tokio::task::spawn_blocking(move || crate::voice::transcribe(&key, &audio, &filename))
        .await
        .map_err(|_| err(StatusCode::INTERNAL_SERVER_ERROR, "Transcription task failed"))?
        .map_err(|e| {
            tracing::error!("voice transcription failed: {e}");
            err(StatusCode::BAD_GATEWAY, "Transcription failed — try again")
        })?;
    if text.is_empty() {
        return Err(err(
            StatusCode::BAD_REQUEST,
            "Couldn't hear anything in that recording",
        ));
    }
    // The composer's "talk to" selection rides along as a `mentions` field so
    // voice turns address agents the same way typed messages do ("@a, @b, …" —
    // the transcript alone never contains routable @mentions).
    let text = match mention_prefix(&mentions) {
        Some(prefix) => format!("{prefix}, {text}"),
        None => text,
    };
    let message = state.hub.post_user_message_opts(
        &channel_id,
        &text,
        &user.username,
        Some(&user.display_name),
        thread_id,
        vec![],
        live,
        timezone.as_deref(),
        false,
    );
    Ok(Json(message))
}

/// Normalize a client-supplied `mentions` field into a clean "@a, @b" prefix.
/// Only mention tokens survive (anything else in the field is dropped), so a
/// client can't smuggle arbitrary text in front of a transcript.
fn mention_prefix(raw: &str) -> Option<String> {
    let raw: String = raw.chars().take(500).collect();
    let tokens = crate::hub::mention_tokens(&raw);
    if tokens.is_empty() {
        return None;
    }
    Some(tokens.iter().map(|t| format!("@{t}")).collect::<Vec<_>>().join(", "))
}

/// Synthesize a message as speech for client playback (speak-aloud and live
/// voice). MP3 because Safari's `<audio>` can't decode Opus.
async fn message_speech(
    State(state): State<AppState>,
    Path(message_id): Path<i64>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let user = require_user(&state, &headers, &q)?;
    let message = require_message_visible(&state, &user, message_id)?;
    let Some(key) = crate::voice::api_key() else {
        return Err(err(
            StatusCode::BAD_REQUEST,
            "Spoken replies need OPENAI_API_KEY on the server (text-to-speech is not configured)",
        ));
    };
    let cached = {
        let mut cache = state.speech_cache.lock().unwrap();
        match cache.iter().position(|(id, _)| *id == message_id) {
            Some(i) => {
                let entry = cache.remove(i);
                let audio = entry.1.clone();
                cache.push(entry); // bump to most-recently-used
                Some(audio)
            }
            None => None,
        }
    };
    let audio = match cached {
        Some(audio) => audio,
        None => {
            let text = message["text"].as_str().unwrap_or_default().to_string();
            if crate::voice::clip_for_tts(&text).is_empty() {
                return Err(err(StatusCode::BAD_REQUEST, "Nothing to speak"));
            }
            let audio = tokio::task::spawn_blocking(move || crate::voice::synthesize(&key, &text))
                .await
                .map_err(|_| err(StatusCode::INTERNAL_SERVER_ERROR, "Speech task failed"))?
                .map_err(|e| {
                    tracing::error!("speech synthesis failed: {e}");
                    err(StatusCode::BAD_GATEWAY, "Speech synthesis failed — try again")
                })?;
            let mut cache = state.speech_cache.lock().unwrap();
            cache.retain(|(id, _)| *id != message_id);
            cache.push((message_id, audio.clone()));
            if cache.len() > SPEECH_CACHE_MAX {
                cache.remove(0);
            }
            audio
        }
    };
    let mut resp_headers = HeaderMap::new();
    resp_headers.insert("content-type", "audio/mpeg".parse().unwrap());
    Ok((resp_headers, audio).into_response())
}

async fn get_file(
    State(state): State<AppState>,
    Path(file_id): Path<String>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let user = require_user(&state, &headers, &q)?;
    let meta = state
        .hub
        .store
        .file(&file_id)
        .ok_or_else(|| err(StatusCode::NOT_FOUND, "Unknown file"))?;
    require_channel_member(&state, &user, meta["channel_id"].as_str().unwrap_or_default())?;
    stream_file(&state, &file_id, &meta, &headers).await
}

async fn get_agent_file(
    State(state): State<AppState>,
    Path(file_id): Path<String>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let token = bearer(&headers)
        .ok_or_else(|| err(StatusCode::UNAUTHORIZED, "Pairing token required"))?;
    if state.config.valid_pairing_token(&token).is_none() {
        return Err(err(StatusCode::UNAUTHORIZED, "Invalid pairing token"));
    }
    let agent_id = q.get("agent_id").map(String::as_str).unwrap_or_default();
    if agent_id.is_empty() || !state.hub.pairing_token_owns_agent(&token, agent_id) {
        return Err(err(StatusCode::FORBIDDEN, "Pairing token does not own this agent"));
    }
    let meta = state
        .hub
        .store
        .file(&file_id)
        .ok_or_else(|| err(StatusCode::NOT_FOUND, "Unknown file"))?;
    let channel_id = meta["channel_id"].as_str().unwrap_or_default();
    if !state.hub.store.agent_in_channel(agent_id, channel_id)
        || !state.hub.store.agent_dm_route_allowed(channel_id, agent_id)
    {
        return Err(err(StatusCode::FORBIDDEN, "Agent is not a member of this channel"));
    }
    stream_file(&state, &file_id, &meta, &headers).await
}

async fn stream_file(
    state: &AppState,
    file_id: &str,
    meta: &Value,
    headers: &HeaderMap,
) -> Result<Response, ApiError> {
    let path = state.hub.store.file_path(file_id);
    let mut file = tokio::fs::File::open(&path).await
        .map_err(|_| err(StatusCode::NOT_FOUND, "File content missing"))?;
    let size = file.metadata().await
        .map_err(|_| err(StatusCode::NOT_FOUND, "File content missing"))?.len();
    let mime = meta["mime"].as_str().filter(|m| !m.is_empty()).unwrap_or("application/octet-stream");
    let mut resp_headers = HeaderMap::new();
    resp_headers.insert("content-type", mime.parse().unwrap());
    resp_headers.insert("accept-ranges", "bytes".parse().unwrap());
    resp_headers.insert("x-content-type-options", "nosniff".parse().unwrap());
    if !mime.starts_with("image/") && !inline_video_mime(mime) {
        let filename = meta["filename"].as_str().unwrap_or("file");
        resp_headers.insert(
            "content-disposition",
            format!("attachment; filename=\"{filename}\"").parse().unwrap(),
        );
    }
    let range = headers.get("range").and_then(|v| v.to_str().ok());
    let (status, start, length) = match range {
        Some(raw) => match byte_range(raw, size) {
          Some(Ok((start, end))) => {
            let length = end - start + 1;
            resp_headers.insert("content-range", format!("bytes {start}-{end}/{size}").parse().unwrap());
            (StatusCode::PARTIAL_CONTENT, start, length)
          }
          Some(Err(())) => {
            resp_headers.insert("content-range", format!("bytes */{size}").parse().unwrap());
            resp_headers.insert("content-length", "0".parse().unwrap());
            return Ok((StatusCode::RANGE_NOT_SATISFIABLE, resp_headers, Body::empty()).into_response());
          }
          None => (StatusCode::OK, 0, size),
        },
        None => (StatusCode::OK, 0, size),
    };
    file.seek(SeekFrom::Start(start)).await
        .map_err(|_| err(StatusCode::INTERNAL_SERVER_ERROR, "File seek failed"))?;
    resp_headers.insert("content-length", length.to_string().parse().unwrap());
    let body = Body::from_stream(ReaderStream::with_capacity(file.take(length), 64 * 1024));
    Ok((status, resp_headers, body).into_response())
}

async fn mark_read(
    State(state): State<AppState>,
    Path(channel_id): Path<String>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
    Json(payload): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers, &q)?;
    require_channel_member(&state, &user, &channel_id)?;
    let last = state
        .hub
        .mark_read(&user.username, &channel_id, payload["last_read_id"].as_i64());
    Ok(Json(json!({"ok": true, "last_read_id": last})))
}

/// Single message fetch — lets clients open a thread whose root isn't in
/// their loaded window (threads inbox, old pins, deep links).
async fn get_message(
    State(state): State<AppState>,
    Path(message_id): Path<i64>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers, &q)?;
    let mut message = require_message_visible(&state, &user, message_id)?;
    if message["thread_id"].is_null() {
        message["reply_count"] = json!(state.hub.store.thread_size(message_id));
    }
    Ok(Json(message))
}

async fn select_message_option(
    State(state): State<AppState>,
    Path(message_id): Path<i64>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
    Json(payload): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers, &q)?;
    require_message_visible(&state, &user, message_id)?;
    let option_id = payload["option_id"].as_str().unwrap_or("").trim().to_string();
    if option_id.is_empty() {
        return Err(err(StatusCode::BAD_REQUEST, "option_id required"));
    }
    // SQLite write + fan-out: run on the blocking pool so a stalled commit
    // (slow volume fsync) can't tie up the runtime workers and wedge every
    // other request — this exact path froze production once.
    let hub = Arc::clone(&state.hub);
    let username = user.username.clone();
    let result =
        tokio::task::spawn_blocking(move || hub.select_option(message_id, &option_id, &username))
            .await
            .map_err(|_| err(StatusCode::INTERNAL_SERVER_ERROR, "select task failed"))?;
    match result {
        Ok(message) => Ok(Json(message)),
        Err("Message not found") => Err(err(StatusCode::NOT_FOUND, "Unknown message")),
        Err(msg) => Err(err(StatusCode::CONFLICT, msg)),
    }
}

/// Persist one member's edit to a message's interactive form (a checkbox
/// toggle, or an input value the member confirmed). The update fans out to
/// every client as a `message_update`; the authoring agent hears nothing
/// until a button is pressed.
async fn update_message_form_state(
    State(state): State<AppState>,
    Path(message_id): Path<i64>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
    Json(payload): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers, &q)?;
    require_message_visible(&state, &user, message_id)?;
    let field_id = payload["field_id"].as_str().unwrap_or("").trim().to_string();
    if field_id.is_empty() {
        return Err(err(StatusCode::BAD_REQUEST, "field_id required"));
    }
    let value = payload.get("value").cloned().unwrap_or(Value::Null);
    // See select_message_option: keep the store write off the runtime threads.
    let hub = Arc::clone(&state.hub);
    let result = tokio::task::spawn_blocking(move || {
        hub.update_form_field(message_id, &field_id, &value)
    })
    .await
    .map_err(|_| err(StatusCode::INTERNAL_SERVER_ERROR, "form task failed"))?;
    match result {
        Ok(message) => Ok(Json(message)),
        Err("Message not found") => Err(err(StatusCode::NOT_FOUND, "Unknown message")),
        Err(msg @ "Form already submitted") => Err(err(StatusCode::CONFLICT, msg)),
        Err(msg) => Err(err(StatusCode::BAD_REQUEST, msg)),
    }
}

/// Press one of a form's buttons: locks the form one-shot (the race loser
/// gets a 409) and forwards the submission to the authoring agent.
async fn submit_message_form(
    State(state): State<AppState>,
    Path(message_id): Path<i64>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
    Json(payload): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers, &q)?;
    require_message_visible(&state, &user, message_id)?;
    let button_id = payload["button_id"].as_str().unwrap_or("").trim().to_string();
    if button_id.is_empty() {
        return Err(err(StatusCode::BAD_REQUEST, "button_id required"));
    }
    // See select_message_option: keep the store write off the runtime threads.
    let hub = Arc::clone(&state.hub);
    let username = user.username.clone();
    let result =
        tokio::task::spawn_blocking(move || hub.submit_form(message_id, &button_id, &username))
            .await
            .map_err(|_| err(StatusCode::INTERNAL_SERVER_ERROR, "submit task failed"))?;
    match result {
        Ok(message) => Ok(Json(message)),
        Err("Message not found") => Err(err(StatusCode::NOT_FOUND, "Unknown message")),
        Err(msg @ "Form already submitted") => Err(err(StatusCode::CONFLICT, msg)),
        Err(msg) => Err(err(StatusCode::BAD_REQUEST, msg)),
    }
}

/// Threads inbox: every thread the user participates in, newest first.
async fn list_threads(
    State(state): State<AppState>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers, &q)?;
    let limit: usize = q
        .get("limit")
        .and_then(|s| s.parse().ok())
        .unwrap_or(100)
        .clamp(1, 500);
    Ok(Json(json!({"threads": state.hub.store.my_threads(&user.username, limit)})))
}

/// Give a thread a display alias (or clear it with an empty string) so the
/// inbox/sidebar show a chosen name instead of the root message's first line.
/// Any member who can see the channel may rename it; the change is broadcast
/// so other viewers update live.
async fn update_thread(
    State(state): State<AppState>,
    Path(thread_id): Path<i64>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
    Json(payload): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers, &q)?;
    let root = state
        .hub
        .store
        .message(thread_id)
        .filter(|m| m["thread_id"].is_null())
        .ok_or_else(|| err(StatusCode::NOT_FOUND, "Unknown thread"))?;
    require_channel_member(&state, &user, root["channel_id"].as_str().unwrap_or_default())?;
    // Empty/whitespace clears the alias back to the first message; cap the
    // length at the 140 chars the UIs already truncate snippets to.
    let alias: Option<String> = payload
        .get("alias")
        .and_then(Value::as_str)
        .map(|a| a.trim().chars().take(140).collect::<String>())
        .filter(|a| !a.is_empty());
    let updated = state
        .hub
        .store
        .rename_thread(thread_id, alias.as_deref())
        .ok_or_else(|| err(StatusCode::NOT_FOUND, "Unknown thread"))?;
    let channel_id = root["channel_id"].as_str().unwrap_or_default().to_string();
    state.hub.post_transient(
        &channel_id,
        json!({
            "type": "thread_renamed",
            "thread_id": thread_id,
            "channel_id": channel_id,
            "alias": updated["alias"].clone(),
        }),
    );
    Ok(Json(updated))
}

async fn mark_thread_read(
    State(state): State<AppState>,
    Path(thread_id): Path<i64>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
    Json(payload): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers, &q)?;
    let root = state
        .hub
        .store
        .message(thread_id)
        .filter(|m| m["thread_id"].is_null())
        .ok_or_else(|| err(StatusCode::NOT_FOUND, "Unknown thread"))?;
    require_channel_member(&state, &user, root["channel_id"].as_str().unwrap_or_default())?;
    let last = state
        .hub
        .mark_thread_read(&user.username, thread_id, payload["last_read_id"].as_i64());
    Ok(Json(json!({"ok": true, "last_read_id": last})))
}

/// Dismiss a thread from the caller's inbox/sidebar. The messages stay in
/// the channel — this only stops the row from coming back in /api/threads.
async fn hide_thread(
    State(state): State<AppState>,
    Path(thread_id): Path<i64>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers, &q)?;
    let root = state
        .hub
        .store
        .message(thread_id)
        .filter(|m| m["thread_id"].is_null())
        .ok_or_else(|| err(StatusCode::NOT_FOUND, "Unknown thread"))?;
    require_channel_member(&state, &user, root["channel_id"].as_str().unwrap_or_default())?;
    state.hub.store.hide_thread(&user.username, thread_id);
    Ok(Json(json!({"ok": true})))
}

async fn unhide_thread(
    State(state): State<AppState>,
    Path(thread_id): Path<i64>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers, &q)?;
    Ok(Json(json!({"ok": state.hub.store.unhide_thread(&user.username, thread_id)})))
}

async fn list_stars(
    State(state): State<AppState>,
    Path(channel_id): Path<String>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers, &q)?;
    require_channel_member(&state, &user, &channel_id)?;
    Ok(Json(json!({"stars": state.hub.store.user_stars(&user.username, &channel_id)})))
}

async fn star_message(
    State(state): State<AppState>,
    Path((channel_id, message_id)): Path<(String, i64)>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers, &q)?;
    require_channel_member(&state, &user, &channel_id)?;
    let message = state
        .hub
        .store
        .message(message_id)
        .filter(|m| m["channel_id"] == channel_id.as_str())
        .ok_or_else(|| err(StatusCode::NOT_FOUND, "Unknown message"))?;
    let _ = message;
    state.hub.store.star_message(&user.username, &channel_id, message_id);
    Ok(Json(json!({"ok": true})))
}

async fn unstar_message(
    State(state): State<AppState>,
    Path((channel_id, message_id)): Path<(String, i64)>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers, &q)?;
    require_channel_member(&state, &user, &channel_id)?;
    Ok(Json(json!({"ok": state.hub.store.unstar_message(&user.username, message_id)})))
}

async fn list_pins(
    State(state): State<AppState>,
    Path(channel_id): Path<String>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers, &q)?;
    require_channel_member(&state, &user, &channel_id)?;
    Ok(Json(json!({"pins": state.hub.store.channel_pins(&channel_id)})))
}

async fn pin_message(
    State(state): State<AppState>,
    Path((channel_id, message_id)): Path<(String, i64)>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers, &q)?;
    require_channel_member(&state, &user, &channel_id)?;
    let message = state
        .hub
        .store
        .message(message_id)
        .filter(|m| m["channel_id"] == channel_id.as_str())
        .ok_or_else(|| err(StatusCode::NOT_FOUND, "Unknown message"))?;
    if !message["thread_id"].is_null() {
        return Err(err(
            StatusCode::BAD_REQUEST,
            "Only top-level messages (thread roots) can be pinned",
        ));
    }
    if state.hub.store.pin_count(&channel_id) >= MAX_PINS_PER_CHANNEL {
        return Err(err(StatusCode::BAD_REQUEST, "Pin limit reached (25) — unpin something first"));
    }
    if state.hub.store.pin_message(&channel_id, message_id, Some(&user.username)) {
        let pin = state
            .hub
            .store
            .channel_pins(&channel_id)
            .into_iter()
            .find(|x| x["id"] == message_id);
        state.hub.post_transient(
            &channel_id,
            json!({"type": "pin", "channel_id": channel_id, "pinned": true, "pin": pin}),
        );
    }
    Ok(Json(json!({"ok": true})))
}

async fn unpin_message(
    State(state): State<AppState>,
    Path((channel_id, message_id)): Path<(String, i64)>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers, &q)?;
    require_channel_member(&state, &user, &channel_id)?;
    if state.hub.store.unpin_message(&channel_id, message_id) {
        state.hub.post_transient(
            &channel_id,
            json!({"type": "pin", "channel_id": channel_id, "pinned": false, "message_id": message_id}),
        );
    }
    Ok(Json(json!({"ok": true})))
}

/* ---------- emoji reactions ---------- */

/// Reactions come from clients as a raw pathname segment; requiring every
/// char to be non-ASCII rules out markup/script metacharacters wholesale
/// (real emoji — including ZWJ sequences and variation selectors — never
/// contain ASCII) while staying agnostic to the clients' curated sets.
fn valid_reaction_emoji(emoji: &str) -> bool {
    !emoji.is_empty() && emoji.len() <= 32 && emoji.chars().all(|c| !c.is_ascii())
}

/// Reloads the message (reactions freshly aggregated), broadcasts it as a
/// `message_update` when something changed — both clients already merge that
/// event — and returns it so the caller can update its cache immediately.
fn reaction_result(
    state: &AppState,
    channel_id: &str,
    message_id: i64,
    changed: bool,
) -> Result<Json<Value>, ApiError> {
    let message = state
        .hub
        .store
        .message(message_id)
        .ok_or_else(|| err(StatusCode::NOT_FOUND, "Unknown message"))?;
    if changed {
        state.hub.post_transient(
            channel_id,
            json!({"type": "message_update", "message": message}),
        );
    }
    Ok(Json(message))
}

async fn add_reaction(
    State(state): State<AppState>,
    Path((channel_id, message_id, emoji)): Path<(String, i64, String)>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers, &q)?;
    require_channel_member(&state, &user, &channel_id)?;
    let message = state
        .hub
        .store
        .message(message_id)
        .filter(|m| m["channel_id"] == channel_id.as_str())
        .ok_or_else(|| err(StatusCode::NOT_FOUND, "Unknown message"))?;
    if !valid_reaction_emoji(&emoji) {
        return Err(err(StatusCode::BAD_REQUEST, "Not a valid reaction emoji"));
    }
    let groups = message["reactions"].as_array().cloned().unwrap_or_default();
    let already = groups.iter().any(|r| r["emoji"] == emoji.as_str());
    if !already && groups.len() >= MAX_REACTION_KINDS_PER_MESSAGE {
        return Err(err(
            StatusCode::BAD_REQUEST,
            "Reaction limit reached for this message",
        ));
    }
    let changed = state
        .hub
        .store
        .add_reaction(&user.username, &channel_id, message_id, &emoji);
    reaction_result(&state, &channel_id, message_id, changed)
}

async fn remove_reaction(
    State(state): State<AppState>,
    Path((channel_id, message_id, emoji)): Path<(String, i64, String)>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers, &q)?;
    require_channel_member(&state, &user, &channel_id)?;
    state
        .hub
        .store
        .message(message_id)
        .filter(|m| m["channel_id"] == channel_id.as_str())
        .ok_or_else(|| err(StatusCode::NOT_FOUND, "Unknown message"))?;
    let changed = state
        .hub
        .store
        .remove_reaction(&user.username, message_id, &emoji);
    reaction_result(&state, &channel_id, message_id, changed)
}

/// Delete a message: the sender, or any admin of the channel's group
/// (instance admins included, via [`require_group_admin`]). A thread root
/// takes its replies with it. Clients hear about it as a `message_delete`
/// transient — `thread_id` tells them which list (and reply count) to fix.
async fn delete_message(
    State(state): State<AppState>,
    Path((channel_id, message_id)): Path<(String, i64)>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers, &q)?;
    let channel = require_channel_member(&state, &user, &channel_id)?;
    let message = state
        .hub
        .store
        .message(message_id)
        .filter(|m| m["channel_id"] == channel_id.as_str())
        .ok_or_else(|| err(StatusCode::NOT_FOUND, "Unknown message"))?;
    let mine = message["author_type"] == "user" && message["author_id"] == user.username.as_str();
    if !mine {
        require_group_admin(&state, &user, channel["group_id"].as_str().unwrap_or_default())
            .map_err(|_| {
                err(
                    StatusCode::FORBIDDEN,
                    "Only the sender or a group admin can delete a message",
                )
            })?;
    }
    state.hub.store.delete_message(message_id);
    state.hub.post_transient(
        &channel_id,
        json!({
            "type": "message_delete",
            "channel_id": channel_id,
            "message_id": message_id,
            "thread_id": message["thread_id"],
        }),
    );
    Ok(Json(json!({"ok": true})))
}

/// Edit a human author's own message without replaying it to agents. Edits
/// deliberately do not recompute mentions or unfurls: mentions cannot be
/// retracted by the current schema, and an edit must not summon agents or
/// create a second round of replies. UI clients receive only message_update.
async fn edit_message(
    State(state): State<AppState>,
    Path((channel_id, message_id)): Path<(String, i64)>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
    Json(payload): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers, &q)?;
    require_channel_member(&state, &user, &channel_id)?;
    let existing = state
        .hub
        .store
        .message(message_id)
        .filter(|m| m["channel_id"] == channel_id.as_str())
        .ok_or_else(|| err(StatusCode::NOT_FOUND, "Unknown message"))?;
    if existing["author_type"] != "user" || existing["author_id"] != user.username.as_str() {
        return Err(err(
            StatusCode::FORBIDDEN,
            "Only the sender can edit a message",
        ));
    }
    let text = payload["text"].as_str().unwrap_or("").trim().to_string();
    if text.is_empty() {
        return Err(err(StatusCode::BAD_REQUEST, "Message text required"));
    }
    if text.chars().count() > MAX_MESSAGE_CHARS {
        return Err(err(StatusCode::BAD_REQUEST, "Message too long"));
    }
    let updated = state.hub.store.update_message_text(message_id, &text).map_err(|e| {
        tracing::error!(message_id, "message edit failed: {e}");
        err(StatusCode::INTERNAL_SERVER_ERROR, "Failed to edit message")
    })?;
    let (message, changed) =
        updated.ok_or_else(|| err(StatusCode::NOT_FOUND, "Unknown message"))?;
    if changed {
        state.hub.post_transient(
            &channel_id,
            json!({"type": "message_update", "message": message}),
        );
    }
    Ok(Json(message))
}

async fn channel_agents(
    State(state): State<AppState>,
    Path(channel_id): Path<String>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers, &q)?;
    require_channel_member(&state, &user, &channel_id)?;
    Ok(Json(json!({"agents": state.hub.channel_agents(&channel_id)})))
}

async fn channel_activity(
    State(state): State<AppState>,
    Path(channel_id): Path<String>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers, &q)?;
    require_channel_member(&state, &user, &channel_id)?;
    Ok(Json(state.hub.channel_activity(&channel_id)))
}

async fn list_agent_dms(State(state): State<AppState>, Query(q): Query<HashMap<String,String>>, headers: HeaderMap) -> Result<Json<Value>,ApiError> {
    let user = require_user(&state,&headers,&q)?; let live = state.hub.live_agent_ids();
    let agents = state.hub.store.known_agents().into_iter().map(|a| { let id=a["id"].as_str().unwrap_or_default(); let p=state.hub.store.agent_dm_policy(id);
        json!({"id":id,"name":a["name"],"live":live.iter().any(|x|x==id),"can_dm":state.hub.store.user_can_start_agent_dm(&user.username,id),"is_public":p["is_public"]}) }).collect::<Vec<_>>();
    Ok(Json(json!({"conversations":state.hub.store.agent_dms_for_user(&user.username),"agents":agents})))
}

async fn open_agent_dm(State(state): State<AppState>, Path(agent_id): Path<String>, Query(q): Query<HashMap<String,String>>, headers: HeaderMap) -> Result<Json<Value>,ApiError> {
    let user=require_user(&state,&headers,&q)?;
    if !state.hub.store.user_can_start_agent_dm(&user.username,&agent_id) { return Err(err(StatusCode::FORBIDDEN,"You do not have access to DM this agent")); }
    let agent=state.hub.store.agent(&agent_id).ok_or_else(||err(StatusCode::NOT_FOUND,"Unknown agent"))?;
    Ok(Json(state.hub.store.open_agent_dm(&user.username,&agent_id,agent["name"].as_str().unwrap_or(&agent_id))))
}

async fn get_agent_dm_policy(State(state): State<AppState>, Path(agent_id): Path<String>, Query(q): Query<HashMap<String,String>>, headers: HeaderMap) -> Result<Json<Value>,ApiError> {
    let user=require_user(&state,&headers,&q)?; require_instance_admin(&user)?;
    state.hub.store.agent(&agent_id).ok_or_else(||err(StatusCode::NOT_FOUND,"Unknown agent"))?;
    Ok(Json(state.hub.store.agent_dm_policy(&agent_id)))
}

async fn update_agent_dm_policy(State(state): State<AppState>, Path(agent_id): Path<String>, Query(q): Query<HashMap<String,String>>, headers: HeaderMap, Json(payload): Json<Value>) -> Result<Json<Value>,ApiError> {
    let user=require_user(&state,&headers,&q)?; require_instance_admin(&user)?;
    state.hub.store.agent(&agent_id).ok_or_else(||err(StatusCode::NOT_FOUND,"Unknown agent"))?;
    let grants=payload["grants"].as_array().ok_or_else(||err(StatusCode::BAD_REQUEST,"grants must be an array of usernames"))?.iter().filter_map(Value::as_str).map(str::to_string).collect::<Vec<_>>();
    state.hub.store.set_agent_dm_policy(&agent_id,payload["is_public"].as_bool().unwrap_or(false),&grants);
    Ok(Json(state.hub.store.agent_dm_policy(&agent_id)))
}

async fn list_agent_sources(
    State(state): State<AppState>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers, &q)?;
    require_instance_admin(&user)?;
    let live = state.hub.live_agent_ids();
    let agents = state.hub.store.known_agents();
    let snapshot = state.config.snapshot();
    let make_agents = |source: &str, legacy: Option<&str>| {
        agents
            .iter()
            .filter(|agent| {
                let seen = agent["source"].as_str().unwrap_or_default();
                seen == source || legacy.is_some_and(|name| seen == format!("pairing:{name}"))
            })
            .map(|agent| {
                let id = agent["id"].as_str().unwrap_or_default();
                json!({
                    "id": id,
                    "name": agent["name"],
                    "live": live.iter().any(|live_id| live_id == id),
                    "last_seen": agent["last_seen"],
                })
            })
            .collect::<Vec<_>>()
    };
    let mut sources = snapshot
        .connections
        .iter()
        .map(|connection| {
            json!({
                "kind": "pantheo",
                "id": connection.name,
                "name": connection.name,
                "agents": make_agents(&connection.name, None),
            })
        })
        .collect::<Vec<_>>();
    sources.extend(snapshot.pairing_tokens.iter().map(|pairing| {
        let source = format!("pairing:{}", pairing.id);
        let unique_legacy_name = (snapshot
            .pairing_tokens
            .iter()
            .filter(|other| other.name == pairing.name)
            .count()
            == 1)
            .then_some(pairing.name.as_str());
        json!({
            "kind": "pairing",
            "id": pairing.id,
            "name": pairing.name,
            "agents": make_agents(&source, unique_legacy_name),
        })
    }));
    Ok(Json(json!({"sources": sources})))
}

async fn available_agents(
    State(state): State<AppState>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    require_user(&state, &headers, &q)?;
    let live = state.hub.live_agent_ids();
    let agents: Vec<Value> = state
        .hub
        .store
        .known_agents()
        .into_iter()
        .map(|mut a| {
            let id = a["id"].as_str().unwrap_or_default().to_string();
            a["live"] = json!(live.contains(&id));
            a["avatar"] = agent_avatar_path(&a);
            a
        })
        .collect();
    Ok(Json(json!({"agents": agents})))
}

/// The same-origin proxy path for an agent's picture (the browser can't reach
/// the agent's home instance directly), or null when it has none. ?v= busts
/// caches when the picture changes upstream.
fn agent_avatar_path(agent: &Value) -> Value {
    if !agent["has_avatar"].as_bool().unwrap_or(false) {
        return Value::Null;
    }
    json!(format!(
        "/api/agents/{}/avatar?v={}",
        agent["id"].as_str().unwrap_or_default(),
        agent["avatar_v"].as_i64().unwrap_or(0)
    ))
}

fn avatar_mime(data: &[u8]) -> Option<&'static str> {
    if data.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if data.starts_with(b"\xff\xd8\xff") {
        Some("image/jpeg")
    } else if data.starts_with(b"GIF87a") || data.starts_with(b"GIF89a") {
        Some("image/gif")
    } else if data.len() >= 12 && &data[..4] == b"RIFF" && &data[8..12] == b"WEBP" {
        Some("image/webp")
    } else {
        None
    }
}

fn dial_in_avatar_path(data_dir: &std::path::Path, agent_id: &str) -> std::path::PathBuf {
    let digest = Sha256::digest(agent_id.as_bytes());
    let name = digest.iter().map(|b| format!("{b:02x}")).collect::<String>();
    data_dir.join("agent_avatars").join(name)
}

/// Accept an avatar carried by an authenticated dial-in hello. Paths are
/// never accepted from the peer: the bytes cross the socket because the
/// bridge and server commonly run on different machines.
fn store_dial_in_avatar(state: &AppState, agent_id: &str, avatar: &Value) -> Option<i64> {
    let encoded = avatar["data"].as_str()?;
    // Reject obviously oversized input before allocating for base64 decode.
    if encoded.len() > (MAX_AGENT_AVATAR_BYTES * 4 / 3) + 8 {
        return None;
    }
    let data = base64::engine::general_purpose::STANDARD.decode(encoded).ok()?;
    if data.is_empty() || data.len() > MAX_AGENT_AVATAR_BYTES || avatar_mime(&data).is_none() {
        return None;
    }
    let digest = Sha256::digest(&data);
    let version = i64::from_be_bytes(digest[..8].try_into().ok()?) & i64::MAX;
    let path = dial_in_avatar_path(&state.data_dir, agent_id);
    std::fs::create_dir_all(path.parent()?).ok()?;
    let tmp = path.with_extension(format!("tmp-{}", new_token()));
    std::fs::write(&tmp, &data).ok()?;
    if std::fs::rename(&tmp, &path).is_err() {
        std::fs::remove_file(&tmp).ok();
        return None;
    }
    Some(version)
}

/// Ceiling on proxied avatar bytes (Pantheo caps uploads at 2 MB).
const MAX_AVATAR_BYTES: u64 = 4 * 1024 * 1024;

/// Derive a Pantheo instance's HTTP(S) base from its dial-out websocket URL:
/// `wss://host[:port][/prefix]/agora/connect` → `https://host[:port][/prefix]`.
fn pantheo_http_base(ws_url: &str) -> Option<String> {
    let trimmed = ws_url.trim().trim_end_matches('/');
    let base = trimmed.strip_suffix("/agora/connect")?;
    if let Some(rest) = base.strip_prefix("wss://") {
        Some(format!("https://{rest}"))
    } else if let Some(rest) = base.strip_prefix("ws://") {
        Some(format!("http://{rest}"))
    } else if base.starts_with("https://") || base.starts_with("http://") {
        Some(base.to_string())
    } else {
        None
    }
}

/// Blocking GET of the avatar bytes from the agent's home instance
/// (call via `spawn_blocking`).
fn fetch_avatar(url: &str, token: &str) -> anyhow::Result<(String, Vec<u8>)> {
    use std::io::Read;

    let response = ureq::get(url)
        .timeout(Duration::from_secs(10))
        .set("Authorization", &format!("Bearer {token}"))
        .call()
        .map_err(|e| anyhow::anyhow!("avatar fetch failed: {e}"))?;
    let mime = response.content_type().to_string();
    let mut data = Vec::new();
    response.into_reader().take(MAX_AVATAR_BYTES).read_to_end(&mut data)?;
    anyhow::ensure!(!data.is_empty(), "empty avatar response");
    Ok((mime, data))
}

/// Proxy an agent's profile picture from its home instance. The browser can't
/// fetch it directly — the instance may be private and the connection token
/// must never reach the client — but the connection that carried the agent
/// knows both the origin and the token. Misses return 404 so the UI's onerror
/// handler falls back to the robot emoji.
async fn agent_avatar(
    State(state): State<AppState>,
    Path(agent_id): Path<String>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    require_user(&state, &headers, &q)?;
    let agent = state
        .hub
        .store
        .agent(&agent_id)
        .ok_or_else(|| err(StatusCode::NOT_FOUND, "Unknown agent"))?;
    if !agent["has_avatar"].as_bool().unwrap_or(false) {
        return Err(err(StatusCode::NOT_FOUND, "No profile picture"));
    }
    let source = agent["source"].as_str().unwrap_or_default().to_string();
    if source.starts_with("pairing:") {
        let path = dial_in_avatar_path(&state.data_dir, &agent_id);
        let data = tokio::fs::read(path)
            .await
            .map_err(|_| err(StatusCode::NOT_FOUND, "No profile picture"))?;
        let mime = avatar_mime(&data)
            .ok_or_else(|| err(StatusCode::NOT_FOUND, "No profile picture"))?;
        let mut resp_headers = HeaderMap::new();
        resp_headers.insert("content-type", mime.parse().unwrap());
        resp_headers.insert("cache-control", "private, max-age=86400".parse().unwrap());
        return Ok((resp_headers, data).into_response());
    }
    let conn = state
        .config
        .snapshot()
        .connections
        .into_iter()
        .find(|c| c.name == source)
        .ok_or_else(|| err(StatusCode::NOT_FOUND, "Agent's connection is not configured"))?;
    let base = pantheo_http_base(&conn.url)
        .ok_or_else(|| err(StatusCode::NOT_FOUND, "No HTTP address for the agent's instance"))?;
    let url = format!("{base}/admin/api/agents/{agent_id}/avatar");
    let (mime, data) = tokio::task::spawn_blocking(move || fetch_avatar(&url, &conn.token))
        .await
        .map_err(|_| err(StatusCode::BAD_GATEWAY, "Avatar fetch failed"))?
        .map_err(|e| {
            tracing::debug!("avatar proxy for {agent_id}: {e}");
            err(StatusCode::NOT_FOUND, "No profile picture")
        })?;
    let mut resp_headers = HeaderMap::new();
    resp_headers.insert(
        "content-type",
        mime.parse()
            .unwrap_or_else(|_| "application/octet-stream".parse().unwrap()),
    );
    // The URL carries a version stamp (?v=), so long client caching is safe.
    resp_headers.insert("cache-control", "private, max-age=86400".parse().unwrap());
    Ok((resp_headers, data).into_response())
}

async fn forget_agent(
    State(state): State<AppState>,
    Path(agent_id): Path<String>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers, &q)?;
    require_instance_admin(&user)?;
    if state.hub.live_agent_ids().contains(&agent_id) {
        return Err(err(StatusCode::BAD_REQUEST, "Agent is currently connected"));
    }
    Ok(Json(json!({"ok": state.hub.store.remove_agent(&agent_id)})))
}

// ------------------------------------------------------------- connections

async fn list_connections(
    State(state): State<AppState>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers, &q)?;
    require_instance_admin(&user)?;
    let status: HashMap<String, Value> = state
        .connections
        .status()
        .into_iter()
        .map(|s| (s.name.clone(), serde_json::to_value(&s).unwrap_or(Value::Null)))
        .collect();
    let conns: Vec<Value> = state
        .config
        .snapshot()
        .connections
        .iter()
        .map(|c| {
            json!({
                "name": c.name, "url": c.url, "enabled": c.enabled,
                "status": status.get(&c.name).cloned().unwrap_or(Value::Null),
            })
        })
        .collect();
    Ok(Json(json!({
        "connections": conns,
        "instance": {
            "id": state.config.instance_id(),
            "name": state.config.instance_name(),
        },
    })))
}

/// Rename this app's declared identity. Linked endpoints learn the new name
/// through a reconnect (`identify` rides the handshake), so restart the loops.
async fn update_instance(
    State(state): State<AppState>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
    Json(payload): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers, &q)?;
    require_instance_admin(&user)?;
    let name = payload["name"].as_str().unwrap_or("").trim().to_string();
    if name.is_empty() {
        return Err(err(StatusCode::BAD_REQUEST, "name required"));
    }
    state.config.update(|c| c.instance_name = name);
    state.connections.restart();
    Ok(Json(json!({"ok": true})))
}

// -------------------------------------------------------- export / import

async fn export_data(
    State(state): State<AppState>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let user = require_user(&state, &headers, &q)?;
    require_instance_admin(&user)?;
    let store = Arc::clone(&state.hub.store);
    let (id, name) = (state.config.instance_id(), state.config.instance_name());
    let bytes = tokio::task::spawn_blocking(move || crate::migrate::export_archive(&store, &id, &name))
        .await
        .map_err(|_| err(StatusCode::INTERNAL_SERVER_ERROR, "export task failed"))?
        .map_err(|e| err(StatusCode::INTERNAL_SERVER_ERROR, &format!("export failed: {e}")))?;
    let filename = format!("agora-export-{}.tar.gz", crate::store::now() as u64);
    Ok((
        [
            ("content-type", "application/gzip".to_string()),
            (
                "content-disposition",
                format!("attachment; filename=\"{filename}\""),
            ),
        ],
        bytes,
    )
        .into_response())
}

async fn import_data(
    State(state): State<AppState>,
    Query(q): Query<HashMap<String, String>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    mut multipart: Multipart,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers, &q)?;
    require_instance_admin(&user)?;
    if !state.upload_limiter.allow(&rate_key(&peer)) {
        return Err(err(StatusCode::TOO_MANY_REQUESTS, "Too many uploads — slow down"));
    }
    let replace = matches!(
        q.get("replace").map(String::as_str),
        Some("1" | "true" | "yes")
    );
    if !replace && !state.hub.store.list_groups().is_empty() {
        return Err(err(
            StatusCode::CONFLICT,
            "This Agora already has data; pass ?replace=true to overwrite it",
        ));
    }
    let mut archive: Option<Vec<u8>> = None;
    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|_| err(StatusCode::BAD_REQUEST, "Invalid upload"))?
    {
        if field.name().unwrap_or("") == "archive" {
            archive = Some(
                field
                    .bytes()
                    .await
                    .map_err(|_| err(StatusCode::BAD_REQUEST, "Upload interrupted"))?
                    .to_vec(),
            );
        }
    }
    let archive = archive.ok_or_else(|| err(StatusCode::BAD_REQUEST, "archive field required"))?;
    let data_dir = state.data_dir.clone();
    let manifest = tokio::task::spawn_blocking(move || crate::migrate::stage_import(&data_dir, &archive))
        .await
        .map_err(|_| err(StatusCode::INTERNAL_SERVER_ERROR, "import task failed"))?
        .map_err(|e| err(StatusCode::BAD_REQUEST, &format!("invalid archive: {e}")))?;

    // Give the response time to flush, then restart: the desktop shell
    // relaunches itself; the headless server exits 0 for its supervisor.
    let hook = Arc::clone(&state.restart_handler);
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(600));
        if let Some(restart) = hook.lock().unwrap().as_ref() {
            restart();
        }
        std::process::exit(0);
    });
    Ok(Json(json!({
        "staged": true,
        "manifest": manifest,
        "detail": "Import staged; restarting to apply it.",
    })))
}

async fn add_connection(
    State(state): State<AppState>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
    Json(payload): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers, &q)?;
    require_instance_admin(&user)?;
    let name = payload["name"].as_str().unwrap_or("").trim().to_string();
    let url = payload["url"].as_str().unwrap_or("").trim().to_string();
    let token = payload["token"].as_str().unwrap_or("").trim().to_string();
    if name.is_empty() || url.is_empty() {
        return Err(err(StatusCode::BAD_REQUEST, "name and url required"));
    }
    if !url.starts_with("ws://") && !url.starts_with("wss://") {
        return Err(err(StatusCode::BAD_REQUEST, "url must be ws:// or wss://"));
    }
    let exists = state
        .config
        .snapshot()
        .connections
        .iter()
        .any(|c| c.name == name);
    if exists {
        return Err(err(StatusCode::BAD_REQUEST, "A connection with that name exists"));
    }
    state.config.update(|c| {
        c.connections.push(Connection {
            name,
            url,
            token,
            enabled: true,
        })
    });
    state.connections.sync();
    Ok(Json(json!({"ok": true})))
}

async fn update_connection(
    State(state): State<AppState>,
    Path(name): Path<String>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
    Json(payload): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers, &q)?;
    require_instance_admin(&user)?;
    let mut found = false;
    state.config.update(|c| {
        for conn in &mut c.connections {
            if conn.name == name {
                found = true;
                if let Some(url) = payload["url"].as_str() {
                    conn.url = url.trim().to_string();
                }
                if let Some(token) = payload["token"].as_str() {
                    if !token.is_empty() {
                        conn.token = token.trim().to_string();
                    }
                }
                if let Some(enabled) = payload["enabled"].as_bool() {
                    conn.enabled = enabled;
                }
            }
        }
    });
    if !found {
        return Err(err(StatusCode::NOT_FOUND, "Unknown connection"));
    }
    state.connections.sync();
    Ok(Json(json!({"ok": true})))
}

async fn remove_connection(
    State(state): State<AppState>,
    Path(name): Path<String>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers, &q)?;
    require_instance_admin(&user)?;
    state.config.update(|c| c.connections.retain(|x| x.name != name));
    state.connections.sync();
    Ok(Json(json!({"ok": true})))
}

#[derive(serde::Serialize)]
struct PairingAgentStatus<'a> {
    id: &'a str,
    name: &'a str,
}

#[derive(serde::Serialize)]
struct PairingTokenStatus<'a> {
    #[serde(flatten)]
    token: &'a PairingToken,
    connected: bool,
    agents: Vec<PairingAgentStatus<'a>>,
}

async fn list_pairing(
    State(state): State<AppState>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers, &q)?;
    require_instance_admin(&user)?;
    // Live status rides on the response only — the config on disk keeps
    // just the token itself.
    let live = state.hub.pairing_status();
    let snapshot = state.config.snapshot();
    let tokens: Vec<PairingTokenStatus<'_>> = snapshot
        .pairing_tokens
        .iter()
        .map(|t| {
            let agents = live.get(&t.token);
            PairingTokenStatus {
                token: t,
                connected: agents.is_some(),
                agents: agents
                    .into_iter()
                    .flatten()
                    .map(|(id, name)| PairingAgentStatus { id, name })
                    .collect(),
            }
        })
        .collect();
    Ok(Json(json!({"tokens": tokens})))
}

async fn create_pairing(
    State(state): State<AppState>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
    Json(payload): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers, &q)?;
    require_instance_admin(&user)?;
    let name = payload["name"]
        .as_str()
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .unwrap_or("agent")
        .to_string();
    let kind = payload["kind"]
        .as_str()
        .map(str::trim)
        .filter(|kind| matches!(*kind, "claw" | "hermes" | "codex" | "cursor" | "claude"))
        .map(str::to_string);
    let token = new_token();
    state.config.update(|c| {
        c.pairing_tokens.push(PairingToken {
            id: new_token(),
            token: token.clone(),
            name,
            kind,
            created_at: now(),
        })
    });
    Ok(Json(json!({"token": token})))
}

async fn revoke_pairing(
    State(state): State<AppState>,
    Path(token): Path<String>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers, &q)?;
    require_instance_admin(&user)?;
    state.config.update(|c| c.pairing_tokens.retain(|t| t.token != token));
    state.hub.close_pairing_conns(&token);
    Ok(Json(json!({"ok": true})))
}

// ----------------------------------------------------------- push tokens

/// Expo push tokens look like `ExponentPushToken[...]` (legacy: `ExpoPushToken[...]`).
fn valid_expo_push_token(token: &str) -> bool {
    let t = token.trim();
    (t.starts_with("ExponentPushToken[") || t.starts_with("ExpoPushToken[")) && t.ends_with(']')
}

async fn register_push_token(
    State(state): State<AppState>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
    Json(payload): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let user = require_user(&state, &headers, &q)?;
    let token = payload["token"].as_str().unwrap_or("").trim().to_string();
    if !valid_expo_push_token(&token) {
        return Err(err(StatusCode::BAD_REQUEST, "Invalid Expo push token"));
    }
    let platform = payload["platform"].as_str().unwrap_or("").trim().to_string();
    state.hub.store.upsert_push_token(&user.username, &token, &platform);
    Ok(Json(json!({"ok": true})))
}

async fn unregister_push_token(
    State(state): State<AppState>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
    Json(payload): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    require_user(&state, &headers, &q)?;
    let token = payload["token"].as_str().unwrap_or("").trim().to_string();
    if token.is_empty() {
        return Err(err(StatusCode::BAD_REQUEST, "token required"));
    }
    state.hub.store.delete_push_token(&token);
    Ok(Json(json!({"ok": true})))
}

// --------------------------------------------------------------- sign-in

/// Resolve a provider-verified email to a workspace account and mint its
/// session. Existing user → sign in (unless disabled). No user but a pending
/// invite, a valid invite-link token, or a spot on the config allowlists
/// (the pre-account gate) → the account is created on first sign-in.
/// Anything else is rejected — possession of a Google/Apple account grants
/// nothing by itself.
/// Does `entry` (an allowlist item, trimmed + lowercased) admit `email`?
/// `*` is open sign-up, `*@domain` admits a whole domain, anything else is
/// an exact match.
fn allowlist_entry_matches(entry: &str, email: &str) -> bool {
    if entry == "*" {
        return true;
    }
    if let Some(domain) = entry.strip_prefix("*@") {
        return email.split('@').nth(1) == Some(domain);
    }
    entry == email
}

fn signin_session_for_email(
    state: &AppState,
    email: &str,
    link_token: Option<&str>,
) -> Result<String, &'static str> {
    let store = &state.hub.store;
    if let Some(user) = store.user_by_email(email) {
        if user["disabled"].as_bool().unwrap_or(false) {
            return Err("disabled");
        }
        let username = user["username"].as_str().unwrap_or_default();
        let version = user["session_version"].as_i64().unwrap_or(1);
        return Ok(crate::auth::mint_session(username, version, &state.config.session_secret()));
    }
    let invite = store.pending_invite(email);
    let link = link_token.and_then(|t| store.valid_invite_link(t));
    let allowlisted = {
        let snap = state.config.snapshot();
        let email = email.trim().to_lowercase();
        snap.google_allowed_emails
            .iter()
            .chain(snap.apple_allowed_emails.iter())
            .any(|e| allowlist_entry_matches(&e.trim().to_lowercase(), &email))
    };
    if invite.is_none() && link.is_none() && !allowlisted {
        return Err("no_access");
    }
    let base = email.split('@').next().unwrap_or("user");
    let username = store.unique_username(base);
    // An email invite's role wins over a link's (it names this person).
    let role = invite
        .as_ref()
        .or(link.as_ref())
        .and_then(|i| i["instance_role"].as_str().map(str::to_string))
        .unwrap_or_else(|| "member".to_string());
    if invite.is_none() && !allowlisted {
        // Admission rests on the link alone: consume it *before* creating
        // the account. The UPDATE's guard is atomic, so a raced second
        // sign-in on the same link loses and is rejected here.
        if !store.use_invite_link(link_token.unwrap_or(""), &username) {
            return Err("no_access");
        }
    }
    let user = store
        .create_user(&username, base, Some(email), &role)
        .ok_or("no_access")?;
    if invite.is_some() {
        store.accept_invite(email);
    }
    tracing::info!("{email} joined as {username} ({role})");
    let version = user["session_version"].as_i64().unwrap_or(1);
    Ok(crate::auth::mint_session(&username, version, &state.config.session_secret()))
}

// ----------------------------------------------------------- google sign-in

/// Short-lived CSRF cookie binding a Google round-trip to the browser that
/// started it; scoped to the auth routes.
const OAUTH_STATE_COOKIE: &str = "agora_oauth_state";
const OAUTH_STATE_MAX_AGE: u32 = 600;

fn cookie_value(headers: &HeaderMap, name: &str) -> Option<String> {
    headers
        .get("cookie")?
        .to_str()
        .ok()?
        .split(';')
        .find_map(|pair| {
            let (k, v) = pair.trim().split_once('=')?;
            (k == name).then(|| v.to_string())
        })
}

/// The Google callback URL: `public_url` wins (deterministic behind a proxy);
/// otherwise derive it from the inbound request's Host header.
fn oauth_redirect_uri(state: &AppState, headers: &HeaderMap) -> String {
    let base = state.config.public_url();
    let base = if base.is_empty() {
        let host = headers
            .get("host")
            .and_then(|h| h.to_str().ok())
            .unwrap_or("localhost");
        let scheme = headers
            .get("x-forwarded-proto")
            .and_then(|h| h.to_str().ok())
            .unwrap_or("http");
        format!("{scheme}://{host}")
    } else {
        base
    };
    format!("{base}/api/auth/google/callback")
}

fn set_state_cookie(secure: bool, state: &str, max_age: u32) -> String {
    format!(
        "{OAUTH_STATE_COOKIE}={state}; Max-Age={max_age}; Path=/api/auth; HttpOnly; SameSite=Lax{}",
        if secure { "; Secure" } else { "" }
    )
}

fn redirect_with_cookie(url: &str, cookie: String) -> Response {
    (
        StatusCode::FOUND,
        [("location", url.to_string()), ("set-cookie", cookie)],
    )
        .into_response()
}

/// Which sign-in methods this instance offers; the login surfaces (web auth
/// gate, desktop connect page, mobile connect screen) probe this before
/// showing a Google button. Unauthenticated by design — it only reveals
/// whether the button exists.
async fn auth_config(State(state): State<AppState>) -> Json<Value> {
    Json(json!({
        "google": {"enabled": state.config.google().is_some()},
        "apple": {"enabled": state.config.apple().is_some()},
        "admin": {"enabled": state.config.admin_login_enabled()},
    }))
}

/// Step 1: bounce the browser to Google's consent screen. `?next=` says where
/// the callback should deliver the session token — the web UI by default, or
/// an allowlisted client target (desktop loopback listener / mobile deep link).
async fn google_start(
    State(state): State<AppState>,
    Query(q): Query<HashMap<String, String>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> Response {
    if !state.auth_limiter.allow(&rate_key(&peer)) {
        return err(StatusCode::TOO_MANY_REQUESTS, "Too many sign-in attempts — slow down")
            .into_response();
    }
    let Some(gc) = state.config.google() else {
        return err(StatusCode::NOT_FOUND, "Google sign-in is not enabled").into_response();
    };
    let next = q.get("next").cloned().unwrap_or_else(|| "/".to_string());
    if next != "/" && !crate::auth::allowed_next(&next) {
        return err(StatusCode::BAD_REQUEST, "next target is not allowed").into_response();
    }
    // An invite-link token rides through the OAuth round-trip in the state;
    // it is validated at redeem time, after the email is verified.
    let invite = q.get("invite").map(String::as_str).unwrap_or("");
    let oauth_state = crate::auth::encode_state(&next, invite);
    let redirect_uri = oauth_redirect_uri(&state, &headers);
    // `?select_account=1` lets a client force the account chooser (e.g. a
    // retry after the allowlist rejected the silently-reused account).
    let select_account = q.get("select_account").map(String::as_str) == Some("1");
    let url = crate::auth::build_consent_url(&gc, &redirect_uri, &oauth_state, select_account);
    let secure = redirect_uri.starts_with("https://");
    redirect_with_cookie(&url, set_state_cookie(secure, &oauth_state, OAUTH_STATE_MAX_AGE))
}

/// Step 2: Google bounced back. Verify CSRF state, exchange the code for an
/// id_token over the TLS back-channel, check its claims + the email
/// allowlist, then deliver a freshly minted session token to `next`.
async fn google_callback(
    State(state): State<AppState>,
    Query(q): Query<HashMap<String, String>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> Response {
    if !state.auth_limiter.allow(&rate_key(&peer)) {
        return err(StatusCode::TOO_MANY_REQUESTS, "Too many sign-in attempts — slow down")
            .into_response();
    }
    let state_param = q.get("state").cloned().unwrap_or_default();
    let next = crate::auth::next_from_state(&state_param);
    let secure = oauth_redirect_uri(&state, &headers).starts_with("https://");

    // Failures land where the flow started: the web UI reads the fragment,
    // client listeners read ?error=.
    let land_err = |reason: &str| -> Response {
        let url = match &next {
            Some(n) if n != "/" => format!(
                "{n}{}error={}",
                if n.contains('?') { "&" } else { "?" },
                crate::auth::urlencode(reason)
            ),
            _ => format!("/#auth_error={}", crate::auth::urlencode(reason)),
        };
        redirect_with_cookie(&url, set_state_cookie(secure, "", 0))
    };

    let Some(gc) = state.config.google() else {
        return land_err("google_disabled");
    };
    if let Some(e) = q.get("error") {
        // Google-side refusal, e.g. access_denied from an unconsenting user.
        tracing::warn!("google sign-in returned error={e}");
        return land_err(&format!("google_{e}"));
    }
    let code = q.get("code").cloned().unwrap_or_default();
    if code.is_empty() {
        return land_err("no_code");
    }
    let cookie = cookie_value(&headers, OAUTH_STATE_COOKIE).unwrap_or_default();
    if cookie.is_empty() || !crate::auth::state_matches(&cookie, &state_param) {
        tracing::warn!("google sign-in: CSRF state mismatch");
        return land_err("state");
    }
    let redirect_uri = oauth_redirect_uri(&state, &headers);
    let exchange = {
        let gc = gc.clone();
        tokio::task::spawn_blocking(move || {
            crate::auth::exchange_code(&gc, &code, &redirect_uri)
        })
        .await
    };
    let email = match exchange {
        Ok(Ok(tokens)) => {
            let id_token = tokens["id_token"].as_str().unwrap_or_default();
            match crate::auth::decode_id_token(id_token, &gc) {
                Ok(email) => email,
                Err(e) => {
                    tracing::warn!("google sign-in: id_token rejected: {e}");
                    return land_err(if e.to_string().contains("allowlist") {
                        "no_access"
                    } else {
                        "token"
                    });
                }
            }
        }
        _ => {
            tracing::warn!("google sign-in: token exchange failed");
            return land_err("token");
        }
    };
    let invite = crate::auth::invite_from_state(&state_param);
    let session = match signin_session_for_email(&state, &email, invite.as_deref()) {
        Ok(session) => session,
        Err(reason) => {
            tracing::warn!("google sign-in: {email} rejected: {reason}");
            return land_err(if reason == "disabled" { "disabled" } else { "no_access" });
        }
    };
    tracing::info!("google sign-in: {email} accepted");
    let url = match &next {
        Some(n) if n != "/" => format!(
            "{n}{}token={}",
            if n.contains('?') { "&" } else { "?" },
            crate::auth::urlencode(&session)
        ),
        _ => format!("/#agora_session={}", crate::auth::urlencode(&session)),
    };
    redirect_with_cookie(&url, set_state_cookie(secure, "", 0))
}

// -------------------------------------------------------- sign in with apple

/// Native Sign in with Apple: the iOS app runs Apple's system sheet and posts
/// the resulting identity token here. Verification (JWKS signature, issuer,
/// bundle-id audience, email allowlist) lives in `auth::verify_apple_token`;
/// success mints the same session a Google sign-in would.
async fn apple_signin(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    if !state.auth_limiter.allow(&rate_key(&peer)) {
        return Err(err(StatusCode::TOO_MANY_REQUESTS, "Too many sign-in attempts — slow down"));
    }
    let Some(ac) = state.config.apple() else {
        return Err(err(StatusCode::NOT_FOUND, "Apple sign-in is not enabled"));
    };
    let identity_token = body["identity_token"].as_str().unwrap_or_default().to_string();
    if identity_token.is_empty() {
        return Err(err(StatusCode::BAD_REQUEST, "identity_token is required"));
    }
    // Native clients pass an invite-link token alongside the identity token.
    let invite = body["invite_token"].as_str().map(str::to_string);
    let verified = tokio::task::spawn_blocking(move || {
        crate::auth::verify_apple_token(&identity_token, &ac)
    })
    .await;
    match verified {
        Ok(Ok(email)) => match signin_session_for_email(&state, &email, invite.as_deref()) {
            Ok(session) => {
                tracing::info!("apple sign-in: {email} accepted");
                Ok(Json(json!({"token": session})))
            }
            Err(reason) => {
                tracing::warn!("apple sign-in: {email} rejected ({reason})");
                Err(err(
                    StatusCode::UNAUTHORIZED,
                    "That Apple account isn't allowed on this instance",
                ))
            }
        },
        Ok(Err(e)) => {
            tracing::warn!("apple sign-in: identity token rejected: {e}");
            let detail = if e.to_string().contains("allowlist") {
                "That Apple account isn't allowed on this instance"
            } else {
                "Apple sign-in failed"
            };
            Err(err(StatusCode::UNAUTHORIZED, detail))
        }
        Err(_) => Err(err(StatusCode::INTERNAL_SERVER_ERROR, "Apple sign-in failed")),
    }
}

// ------------------------------------------------------------- websockets

/// Drain outbound frames onto a split websocket sink on a dedicated task.
///
/// Both socket handlers below keep this writer *off* their read loop. A send
/// can block for a while — a large fan-out frame, a slow client — and the read
/// loop is what answers the peer's keepalive pings. If a send parked the read
/// loop, pong replies would stall long enough for a healthy peer to declare the
/// link dead and reconnect (the timeout churn we're fixing). Returns when the
/// outbound channel closes or a send fails; the caller then tears the socket
/// down.
async fn pump_ws_writer(
    mut sink: SplitSink<WebSocket, WsMessage>,
    mut rx: UnboundedReceiver<Value>,
) {
    while let Some(v) = rx.recv().await {
        if sink
            .send(WsMessage::Text(v.to_string().into()))
            .await
            .is_err()
        {
            break;
        }
    }
}

async fn ui_ws(
    State(state): State<AppState>,
    Query(q): Query<HashMap<String, String>>,
    ws: WebSocketUpgrade,
) -> Response {
    // Browsers can't set headers on a websocket, so auth rides on ?token=.
    let token = q.get("token").cloned().unwrap_or_default();
    let Some(user) = authed_user(&state, &token) else {
        return (StatusCode::UNAUTHORIZED, "bad token").into_response();
    };
    ws.on_upgrade(move |socket| handle_ui_socket(state, user, socket))
}

async fn handle_ui_socket(state: AppState, user: AuthedUser, socket: WebSocket) {
    let (sink, mut stream) = socket.split();
    let (tx, rx) = unbounded_channel::<Value>();
    // Real identity, privileged only for the operator: the hub's per-channel
    // visibility filtering applies to everyone else.
    let socket_id = state
        .hub
        .attach_socket(&user.username, user.instance_admin, tx);
    let mut writer = tokio::spawn(pump_ws_writer(sink, rx));
    loop {
        tokio::select! {
            // Writer stopped (send failed / channel closed): tear the reader down.
            _ = &mut writer => break,
            incoming = stream.next() => {
                match incoming {
                    // Inbound frames are ignored (clients post via REST);
                    // receiving keeps the connection alive and surfaces closes.
                    Some(Ok(WsMessage::Close(_))) | None => break,
                    Some(Ok(_)) => {}
                    Some(Err(_)) => break,
                }
            }
        }
    }
    writer.abort();
    state.hub.detach_socket(socket_id);
}

async fn agent_ws(
    State(state): State<AppState>,
    Query(q): Query<HashMap<String, String>>,
    ws: WebSocketUpgrade,
) -> Response {
    let token = q.get("token").cloned().unwrap_or_default();
    let Some(source_id) = state.config.valid_pairing_id(&token) else {
        return (StatusCode::UNAUTHORIZED, "bad pairing token").into_response();
    };
    let per_file = state.config.snapshot().max_file_mb as usize * 1024 * 1024;
    let wire_limit = agent_wire_limit(per_file);
    let upload_key = format!("agent:{source_id}");
    ws.max_frame_size(wire_limit)
        .max_message_size(wire_limit)
        .on_upgrade(move |socket| handle_agent_socket(state, socket, source_id, token, upload_key))
}

fn register_pairing_socket(
    state: &AppState,
    conn_id: u64,
    token: &str,
) -> Option<Arc<tokio::sync::Notify>> {
    let close = state.hub.register_pairing_conn(conn_id, token);
    // Revoke may have landed after the upgrade check but before registration.
    // Re-check only after close_pairing_conns can see this connection.
    if state.config.valid_pairing_token(token).is_none() {
        state.hub.unregister_connection(conn_id);
        return None;
    }
    Some(close)
}

/// Dial-in bridge: the agent speaks first with `hello {agents: [...]}`,
/// then the same frame protocol as an outbound connection.
async fn handle_agent_socket(
    state: AppState, socket: WebSocket, source_id: String, token: String, upload_key: String,
) {
    let (sink, mut stream) = socket.split();
    let (tx, rx) = unbounded_channel::<Value>();
    let conn_id = state.hub.next_conn_id();
    let Some(close) = register_pairing_socket(&state, conn_id, &token) else {
        return;
    };
    let mut registered = false;
    let mut writer = tokio::spawn(pump_ws_writer(sink, rx));
    loop {
        tokio::select! {
            _ = close.notified() => break,
            // Writer stopped (send failed / channel closed): tear the reader down.
            _ = &mut writer => break,
            incoming = stream.next() => {
                match incoming {
                    Some(Ok(WsMessage::Text(text))) => {
                        let Ok(frame) = serde_json::from_str::<Value>(&text) else { continue };
                        if frame["type"] == "hello" {
                            for a in frame["agents"].as_array().cloned().unwrap_or_default() {
                                let Some(id) = a["id"].as_str() else { continue };
                                let avatar_v = store_dial_in_avatar(&state, id, &a["avatar"]);
                                state.hub.register_agent(AgentHandle {
                                    agent_id: id.to_string(),
                                    agent_name: a["name"].as_str().unwrap_or(id).to_string(),
                                    requires_mention: a["requires_mention"].as_bool().unwrap_or(false),
                                    wants_context_feed: a["wants_context_feed"].as_bool().unwrap_or(false),
                                    has_avatar: avatar_v.is_some(),
                                    avatar_v: avatar_v.unwrap_or(0),
                                    source: format!("pairing:{source_id}"),
                                    conn_id,
                                    tx: tx.clone(),
                                });
                                registered = true;
                            }
                        } else if registered {
                            let has_attachments = frame["type"] == "post"
                                && frame["attachments"].as_array().is_some_and(|a| !a.is_empty());
                            let agent_id = frame["agent_id"].as_str().unwrap_or_default();
                            if has_attachments && !state.upload_limiter.allow(&upload_key) {
                                let _ = tx.send(json!({
                                    "type": "error", "frame_type": "post", "agent_id": agent_id,
                                    "request_id": frame["request_id"], "error": "too many uploads — slow down",
                                    "channel_id": frame["channel_id"], "thread_id": frame["thread_id"].as_i64(),
                                }));
                            } else {
                                state.hub.handle_agent_frame_from(conn_id, &frame);
                            }
                        }
                    }
                    Some(Ok(WsMessage::Close(_))) | None => break,
                    Some(Ok(_)) => {}
                    Some(Err(_)) => break,
                }
            }
        }
    }
    writer.abort();
    state.hub.unregister_connection(conn_id);
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::{to_bytes, Body};
    use axum::http::Request;
    use tower::ServiceExt;

    fn test_state() -> (AppState, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let config = Arc::new(Config::load(dir.path()).unwrap());
        let hub = Arc::new(Hub::new(Arc::new(crate::store::Store::open_in_memory().unwrap())));
        let connections = ConnectionManager::new(Arc::clone(&hub), Arc::clone(&config));
        let (auth_limiter, upload_limiter) = AppState::default_limiters();
        let state = AppState {
            hub,
            config,
            connections,
            ui_dir: None,
            data_dir: dir.path().to_path_buf(),
            restart_handler: Arc::new(std::sync::Mutex::new(None)),
            speech_cache: Arc::new(std::sync::Mutex::new(Vec::new())),
            auth_limiter,
            upload_limiter,
        };
        (state, dir)
    }

    #[tokio::test]
    async fn conversation_paths_serve_spa_without_masking_missing_routes() {
        let (mut state, dir) = test_state();
        let ui = dir.path().join("ui");
        std::fs::create_dir(&ui).unwrap();
        std::fs::write(ui.join("index.html"), b"<main>agora spa</main>").unwrap();
        state.ui_dir = Some(ui);
        let app = router(state);

        for path in ["/g/team/c/general/t/42", "/threads"] {
            let deep = app
                .clone()
                .oneshot(Request::get(path).body(Body::empty()).unwrap())
                .await
                .unwrap();
            assert_eq!(deep.status(), StatusCode::OK, "{path}");
            let body = to_bytes(deep.into_body(), 1024).await.unwrap();
            assert_eq!(&body[..], b"<main>agora spa</main>");
        }

        for path in ["/api/not-a-route", "/assets/not-a-real-file.js"] {
            let missing = app
                .clone()
                .oneshot(Request::get(path).body(Body::empty()).unwrap())
                .await
                .unwrap();
            assert_eq!(missing.status(), StatusCode::NOT_FOUND, "{path}");
        }
    }

    #[tokio::test]
    async fn auth_config_advertises_admin_login_visibility() {
        let (state, _dir) = test_state();
        assert_eq!(auth_config(State(state.clone())).await.0["admin"]["enabled"], true);
        state.config.update(|c| c.admin_login_enabled = false);
        assert_eq!(auth_config(State(state)).await.0["admin"]["enabled"], false);
    }

    #[test]
    fn authed_user_resolves_admin_key_and_user_sessions() {
        let (state, _dir) = test_state();
        let store = &state.hub.store;

        // The admin key is the operator: instance admin, config username.
        let admin = authed_user(&state, &state.config.admin_key()).unwrap();
        assert!(admin.instance_admin);
        assert_eq!(admin.username, state.config.username());
        assert!(authed_user(&state, "garbage").is_none());

        // A member session resolves to that user, without admin powers.
        let user = store.create_user("ana", "Ana", Some("ana@x.io"), "member").unwrap();
        let v = user["session_version"].as_i64().unwrap();
        let token = crate::auth::mint_session("ana", v, &state.config.session_secret());
        let ana = authed_user(&state, &token).unwrap();
        assert_eq!(ana.username, "ana");
        assert_eq!(ana.display_name, "Ana");
        assert!(!ana.instance_admin);

        // An instance_role=admin user is an instance admin.
        let boss = store.create_user("boss", "", Some("boss@x.io"), "admin").unwrap();
        let bt = crate::auth::mint_session(
            "boss",
            boss["session_version"].as_i64().unwrap(),
            &state.config.session_secret(),
        );
        assert!(authed_user(&state, &bt).unwrap().instance_admin);

        // Bumping the session version revokes outstanding tokens…
        store.bump_session_version("ana");
        assert!(authed_user(&state, &token).is_none());
        // …and disabling the account blocks even a fresh one.
        let v2 = store.user("ana").unwrap()["session_version"].as_i64().unwrap();
        let fresh = crate::auth::mint_session("ana", v2, &state.config.session_secret());
        assert!(authed_user(&state, &fresh).is_some());
        store.set_user_disabled("ana", true);
        assert!(authed_user(&state, &fresh).is_none());
    }

    #[test]
    fn signin_maps_emails_to_accounts_invites_and_allowlist() {
        let (state, _dir) = test_state();
        let store = &state.hub.store;

        // Unknown email: rejected outright.
        assert_eq!(signin_session_for_email(&state, "rando@x.io", None), Err("no_access"));

        // Existing account: signs in as that user.
        store.create_user("ana", "Ana", Some("ana@x.io"), "member").unwrap();
        let token = signin_session_for_email(&state, "ana@x.io", None).unwrap();
        assert_eq!(authed_user(&state, &token).unwrap().username, "ana");

        // Disabled account: rejected.
        store.set_user_disabled("ana", true);
        assert_eq!(signin_session_for_email(&state, "ana@x.io", None), Err("disabled"));

        // Pending invite: first sign-in creates the account with the invited
        // role and consumes the invite.
        store.create_invite("bob@x.io", Some("ana"), "admin").unwrap();
        let token = signin_session_for_email(&state, "bob@x.io", None).unwrap();
        let bob = authed_user(&state, &token).unwrap();
        assert_eq!(bob.username, "bob");
        assert!(bob.instance_admin);
        assert!(store.pending_invite("bob@x.io").is_none());
        // Signing in again reuses the account rather than minting another.
        let again = signin_session_for_email(&state, "bob@x.io", None).unwrap();
        assert_eq!(authed_user(&state, &again).unwrap().username, "bob");

        // Config allowlist (the pre-account gate) still admits, as a member.
        state.config.update(|c| c.google_allowed_emails = vec!["carol@x.io".into()]);
        let token = signin_session_for_email(&state, "carol@x.io", None).unwrap();
        let carol = authed_user(&state, &token).unwrap();
        assert_eq!(carol.username, "carol");
        assert!(!carol.instance_admin);

        // A `*@domain` entry admits that whole domain and nothing else.
        state.config.update(|c| {
            c.google_allowed_emails = Vec::new();
            c.apple_allowed_emails = vec!["*@x.io".into()];
        });
        let token = signin_session_for_email(&state, "dave@x.io", None).unwrap();
        assert_eq!(authed_user(&state, &token).unwrap().username, "dave");
        assert_eq!(signin_session_for_email(&state, "dave@y.io", None), Err("no_access"));

        // A bare `*` is open sign-up: any verified email gets a member account.
        state.config.update(|c| c.apple_allowed_emails = vec!["*".into()]);
        let token = signin_session_for_email(&state, "erin@anywhere.dev", None).unwrap();
        let erin = authed_user(&state, &token).unwrap();
        assert_eq!(erin.username, "erin");
        assert!(!erin.instance_admin);
    }

    #[test]
    fn authz_helpers_enforce_the_role_matrix() {
        let (state, _dir) = test_state();
        let store = &state.hub.store;
        store.create_user("ana", "", None, "member").unwrap();
        store.create_user("mal", "", None, "member").unwrap();
        let g = store.create_group("Team", "", Some("ana"));
        let gid = g["id"].as_str().unwrap();
        // create_group's auto-admin membership is added by the handler; do it
        // here the same way.
        store.add_member(gid, "user", "ana", "admin", None);
        let c = store.create_channel(gid, "general", "");
        let cid = c["id"].as_str().unwrap();

        let ana = AuthedUser {
            username: "ana".into(),
            display_name: "ana".into(),
            instance_admin: false,
        };
        let mal = AuthedUser {
            username: "mal".into(),
            display_name: "mal".into(),
            instance_admin: false,
        };
        let op = AuthedUser {
            username: "op".into(),
            display_name: "op".into(),
            instance_admin: true,
        };

        // Group admin (creator) passes everything for the group.
        assert!(require_member(&state, &ana, gid).is_ok());
        assert!(require_group_admin(&state, &ana, gid).is_ok());
        assert!(require_channel_member(&state, &ana, cid).is_ok());
        // Non-member: 403 across the board.
        assert!(require_member(&state, &mal, gid).is_err());
        assert!(require_group_admin(&state, &mal, gid).is_err());
        assert!(require_channel_member(&state, &mal, cid).is_err());
        assert!(require_instance_admin(&mal).is_err());
        // Plain member: sees, but doesn't administer.
        store.add_member(gid, "user", "mal", "member", None);
        assert!(require_member(&state, &mal, gid).is_ok());
        assert!(require_group_admin(&state, &mal, gid).is_err());
        // The operator bypasses membership entirely.
        assert!(require_member(&state, &op, gid).is_ok());
        assert!(require_group_admin(&state, &op, gid).is_ok());
        assert!(require_instance_admin(&op).is_ok());

        // Message visibility follows the channel's group.
        let m = state.hub.post_user_message(cid, "hello", "ana", None, None, vec![]);
        let mid = m["id"].as_i64().unwrap();
        assert!(require_message_visible(&state, &mal, mid).is_ok());
        store.remove_member(gid, "user", "mal", None);
        assert!(require_message_visible(&state, &mal, mid).is_err());
    }

    #[test]
    fn agent_dm_is_owner_only_even_for_instance_admin_and_revokes_to_read_only() {
        let (state, _dir) = test_state(); let store=&state.hub.store;
        store.create_user("alice","Alice",None,"member").unwrap();
        store.create_user("operator","Operator",None,"admin").unwrap();
        store.upsert_agent("codex","Codex","test",true,false,1);
        store.set_agent_dm_policy("codex",false,&["alice".into()]);
        let dm=store.open_agent_dm("alice","codex","Codex"); let cid=dm["id"].as_str().unwrap();
        let alice=AuthedUser{username:"alice".into(),display_name:"Alice".into(),instance_admin:false};
        let operator=AuthedUser{username:"operator".into(),display_name:"Operator".into(),instance_admin:true};
        assert!(require_channel_member(&state,&alice,cid).is_ok());
        assert!(require_channel_postable(&state,&alice,cid).is_ok());
        assert!(require_channel_member(&state,&operator,cid).is_err());
        store.set_agent_dm_policy("codex",false,&[]);
        assert!(require_channel_member(&state,&alice,cid).is_ok());
        assert!(require_channel_postable(&state,&alice,cid).is_err());
    }

    #[tokio::test]
    async fn direct_messages_group_is_always_last() {
        let (state, _dir) = test_state();
        let store = &state.hub.store;
        store.create_user("alice", "Alice", None, "member").unwrap();
        store.create_group("First", "", Some("alice"));
        store.create_group("Second", "", Some("alice"));
        store.upsert_agent("codex", "Codex", "test", true, false, 1);
        store.set_agent_dm_policy("codex", false, &["alice".into()]);
        let response = list_groups(
            State(state.clone()), Query(HashMap::new()), session_headers(&state, "alice"),
        ).await.unwrap().0;
        let groups = response["groups"].as_array().unwrap();
        assert_eq!(groups.len(), 3);
        assert_eq!(groups.last().unwrap()["id"], "__dms");
    }

    #[test]
    fn expo_push_token_shape() {
        assert!(valid_expo_push_token("ExponentPushToken[xxxxxx]"));
        assert!(valid_expo_push_token("ExpoPushToken[legacy]"));
        assert!(!valid_expo_push_token(""));
        assert!(!valid_expo_push_token("not-a-token"));
        assert!(!valid_expo_push_token("ExponentPushToken[no-close"));
    }

    #[test]
    fn mention_prefix_normalizes_and_rejects_smuggled_text() {
        assert_eq!(mention_prefix("@claude"), Some("@claude".into()));
        assert_eq!(mention_prefix("@a, @b"), Some("@a, @b".into()));
        // Slugs keep word chars / dots / dashes; case folds like typed mentions.
        assert_eq!(mention_prefix("@Kite-Bot"), Some("@kite-bot".into()));
        // Non-mention text is dropped, not prepended.
        assert_eq!(mention_prefix("ignore this @claude do that"), Some("@claude".into()));
        assert_eq!(mention_prefix("no mentions here"), None);
        assert_eq!(mention_prefix(""), None);
    }

    #[test]
    fn agent_avatar_path_maps_flag_to_proxy_url() {
        let with = json!({"id": "mimir", "has_avatar": true, "avatar_v": 1234});
        assert_eq!(agent_avatar_path(&with), json!("/api/agents/mimir/avatar?v=1234"));
        let without = json!({"id": "mimir", "has_avatar": false, "avatar_v": 0});
        assert_eq!(agent_avatar_path(&without), Value::Null);
        // Third-party bots that never sent the field stay on the emoji.
        let legacy = json!({"id": "claw-1"});
        assert_eq!(agent_avatar_path(&legacy), Value::Null);
    }

    #[test]
    fn stores_valid_dial_in_avatar_under_hashed_name() {
        let (state, _dir) = test_state();
        let png = b"\x89PNG\r\n\x1a\nsmall-test-image";
        let payload = json!({
            "mime": "image/png",
            "data": base64::engine::general_purpose::STANDARD.encode(png),
        });
        let version = store_dial_in_avatar(&state, "../unsafe-agent", &payload);
        assert!(version.is_some());
        let path = dial_in_avatar_path(&state.data_dir, "../unsafe-agent");
        assert_eq!(std::fs::read(path).unwrap(), png);
    }

    #[test]
    fn rejects_invalid_or_oversized_dial_in_avatar() {
        let (state, _dir) = test_state();
        assert_eq!(
            store_dial_in_avatar(
                &state,
                "bot",
                &json!({"mime": "image/png", "data": "not base64!"})
            ),
            None
        );
        let oversized = "A".repeat((MAX_AGENT_AVATAR_BYTES * 4 / 3) + 9);
        assert_eq!(
            store_dial_in_avatar(
                &state,
                "bot",
                &json!({"mime": "image/png", "data": oversized})
            ),
            None
        );
    }

    #[test]
    fn pantheo_http_base_derives_from_connect_url() {
        assert_eq!(
            pantheo_http_base("wss://x.example:8765/agora/connect"),
            Some("https://x.example:8765".into())
        );
        assert_eq!(
            pantheo_http_base("ws://localhost:8765/agora/connect/"),
            Some("http://localhost:8765".into())
        );
        assert_eq!(
            pantheo_http_base("wss://host/prefix/agora/connect"),
            Some("https://host/prefix".into())
        );
        // Not a connect URL, or not a websocket/http scheme.
        assert_eq!(pantheo_http_base("wss://host/other"), None);
        assert_eq!(pantheo_http_base("ftp://host/agora/connect"), None);
    }

    #[test]
    fn video_mime_and_limits_require_verified_container_bytes() {
        assert_eq!(sniff_video_mime(b"\0\0\0\x18ftypisomrest"), Some("video/mp4"));
        assert_eq!(sniff_video_mime(b"\0\0\0\x18ftypqt  rest"), Some("video/quicktime"));
        assert_eq!(sniff_video_mime(b"\x1a\x45\xdf\xa3\x42\x82\x84webm"), Some("video/webm"));
        assert_eq!(sniff_video_mime(b"\x1a\x45\xdf\xa3\x42\x82\x88matroska"), None);
        let mut late_marker = b"\x1a\x45\xdf\xa3".to_vec();
        late_marker.extend_from_slice(&[0; 64]);
        late_marker.extend_from_slice(b"\x42\x82\x84webm");
        assert_eq!(sniff_video_mime(&late_marker), None);
        let config = crate::config::ConfigData::default();
        assert_eq!(attachment_max_bytes(b"\0\0\0\x18ftypisomrest", "video/mp4", &config), 100 * 1024 * 1024);
        assert_eq!(attachment_max_bytes(b"zip pretending to be video", "video/mp4", &config), 10 * 1024 * 1024);
        assert_eq!(attachment_max_bytes(b"\0\0\0\x18ftypisomrest", "audio/mp4", &config), 10 * 1024 * 1024);
        assert_eq!(attachment_mime(b"\0\0\0\x18ftypisomrest", "audio/mp4"), "audio/mp4");
        assert_eq!(attachment_mime(b"\x1a\x45\xdf\xa3\x42\x82\x84webm", "audio/webm"), "audio/webm");
        assert_eq!(upload_request_max_bytes(&config), 140 * 1024 * 1024);
        assert_eq!(voice_request_max_bytes(), 16 * 1024 * 1024);
        let mut smaller_video = config.clone();
        smaller_video.max_file_mb = 10;
        smaller_video.max_video_mb = 5;
        assert_eq!(upload_request_max_bytes(&smaller_video), 50 * 1024 * 1024);
        smaller_video.max_video_mb = 0;
        assert_eq!(attachment_max_bytes(b"\0\0\0\x18ftypisomrest", "video/mp4", &smaller_video), 10 * 1024 * 1024);
        assert!(inline_video_mime("video/mp4"));
        assert!(!inline_video_mime("video/x-matroska"));
    }

    #[test]
    fn parses_bounded_video_byte_ranges() {
        assert_eq!(byte_range("bytes=10-19", 100), Some(Ok((10, 19))));
        assert_eq!(byte_range("bytes=90-", 100), Some(Ok((90, 99))));
        assert_eq!(byte_range("bytes=90-999", 100), Some(Ok((90, 99))));
        assert_eq!(byte_range("bytes=-10", 100), Some(Ok((90, 99))));
        assert_eq!(byte_range("bytes=-999", 100), Some(Ok((0, 99))));
        assert_eq!(byte_range("bytes=100-", 100), Some(Err(())));
        assert_eq!(byte_range("bytes=-0", 100), Some(Err(())));
        assert_eq!(byte_range("bytes=0-0,5-9", 100), None);
        assert_eq!(byte_range("items=0-10", 100), None);
        assert_eq!(byte_range("bytes=0-0", 0), Some(Err(())));
        assert_eq!(byte_range(" bytes=0-1", 100), None);
    }

    #[tokio::test]
    async fn file_endpoint_streams_video_ranges_and_rejects_unsatisfiable_ranges() {
        let (state, _dir) = test_state();
        let store = &state.hub.store;
        store.create_user("ana", "Ana", None, "member").unwrap();
        let group = store.create_group("Media", "", Some("ana"));
        let channel = store.create_channel(group["id"].as_str().unwrap(), "video", "");
        let message = store.add_message(
            channel["id"].as_str().unwrap(), "clip", "user", "ana", None, None,
            &[NewAttachment { filename: "clip.mp4".into(), mime: "video/mp4".into(), data: b"0123456789".to_vec() }],
        );
        let file_id = message["attachments"][0]["id"].as_str().unwrap().to_string();
        let mut headers = session_headers(&state, "ana");
        headers.insert("range", "bytes=2-5".parse().unwrap());
        let response = get_file(
            State(state.clone()), Path(file_id.clone()), Query(HashMap::new()), headers,
        ).await.unwrap();
        assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(response.headers()["content-range"], "bytes 2-5/10");
        assert_eq!(response.headers()["content-length"], "4");
        assert_eq!(response.headers()["accept-ranges"], "bytes");
        assert_eq!(response.headers()["x-content-type-options"], "nosniff");
        assert!(response.headers().get("content-disposition").is_none());
        assert_eq!(axum::body::to_bytes(response.into_body(), 16).await.unwrap(), "2345");

        let mut headers = session_headers(&state, "ana");
        headers.insert("range", "bytes=10-".parse().unwrap());
        let response = get_file(State(state), Path(file_id), Query(HashMap::new()), headers)
            .await.unwrap();
        assert_eq!(response.status(), StatusCode::RANGE_NOT_SATISFIABLE);
        assert_eq!(response.headers()["content-range"], "bytes */10");
    }

    #[tokio::test]
    async fn agent_file_download_is_bound_to_the_exact_live_pairing_token() {
        let (state, _dir) = test_state();
        state.config.update(|config| {
            config.pairing_tokens.push(PairingToken {
                id: "pair-a".into(),
                token: "token-a".into(), name: "duplicate".into(), kind: None, created_at: now(),
            });
            config.pairing_tokens.push(PairingToken {
                id: "pair-b".into(),
                token: "token-b".into(), name: "duplicate".into(), kind: None, created_at: now(),
            });
        });
        let group = state.hub.store.create_group("Media", "", None);
        let group_id = group["id"].as_str().unwrap();
        let channel = state.hub.store.create_channel(group_id, "files", "");
        let channel_id = channel["id"].as_str().unwrap();
        state.hub.store.add_member(group_id, "agent", "bot-a", "member", None);
        let message = state.hub.store.add_message(
            channel_id, "clip", "user", "ana", None, None,
            &[NewAttachment {
                filename: "clip.bin".into(), mime: "application/octet-stream".into(),
                data: b"download me".to_vec(),
            }],
        );
        let file_id = message["attachments"][0]["id"].as_str().unwrap().to_string();
        let (tx, _rx) = unbounded_channel();
        let conn_a = state.hub.next_conn_id();
        state.hub.register_pairing_conn(conn_a, "token-a");
        state.hub.register_agent(AgentHandle {
            agent_id: "bot-a".into(), agent_name: "Bot A".into(), requires_mention: false,
            wants_context_feed: false, has_avatar: false, avatar_v: 0,
            source: "pairing:duplicate".into(), conn_id: conn_a, tx,
        });
        let conn_b = state.hub.next_conn_id();
        state.hub.register_pairing_conn(conn_b, "token-b");

        let query = Query(HashMap::from([("agent_id".into(), "bot-a".into())]));
        let missing_auth = get_agent_file(
            State(state.clone()), Path(file_id.clone()), query.clone(), HeaderMap::new(),
        ).await.unwrap_err();
        assert_eq!(missing_auth.0, StatusCode::UNAUTHORIZED);
        let query_token = Query(HashMap::from([
            ("agent_id".into(), "bot-a".into()),
            ("token".into(), "token-a".into()),
        ]));
        let query_auth = get_agent_file(
            State(state.clone()), Path(file_id.clone()), query_token, HeaderMap::new(),
        ).await.unwrap_err();
        assert_eq!(query_auth.0, StatusCode::UNAUTHORIZED);

        state.hub.store.add_member(group_id, "agent", "outbound", "member", None);
        let (outbound_tx, _outbound_rx) = unbounded_channel();
        state.hub.register_agent(AgentHandle {
            agent_id: "outbound".into(), agent_name: "Outbound".into(),
            requires_mention: false, wants_context_feed: false, has_avatar: false,
            avatar_v: 0, source: "remote".into(), conn_id: state.hub.next_conn_id(),
            tx: outbound_tx,
        });
        let mut owner_headers = HeaderMap::new();
        owner_headers.insert("authorization", "Bearer token-a".parse().unwrap());
        let outbound_denied = get_agent_file(
            State(state.clone()), Path(file_id.clone()),
            Query(HashMap::from([("agent_id".into(), "outbound".into())])), owner_headers,
        ).await.unwrap_err();
        assert_eq!(outbound_denied.0, StatusCode::FORBIDDEN);

        let gone_conn = state.hub.next_conn_id();
        state.hub.register_pairing_conn(gone_conn, "token-a");
        let (gone_tx, _gone_rx) = unbounded_channel();
        state.hub.register_agent(AgentHandle {
            agent_id: "gone".into(), agent_name: "Gone".into(), requires_mention: false,
            wants_context_feed: false, has_avatar: false, avatar_v: 0,
            source: "pairing:duplicate".into(), conn_id: gone_conn, tx: gone_tx,
        });
        state.hub.unregister_connection(gone_conn);
        let mut owner_headers = HeaderMap::new();
        owner_headers.insert("authorization", "Bearer token-a".parse().unwrap());
        let gone_denied = get_agent_file(
            State(state.clone()), Path(file_id.clone()),
            Query(HashMap::from([("agent_id".into(), "gone".into())])), owner_headers,
        ).await.unwrap_err();
        assert_eq!(gone_denied.0, StatusCode::FORBIDDEN);

        let mut wrong_headers = HeaderMap::new();
        wrong_headers.insert("authorization", "Bearer token-b".parse().unwrap());
        let error = get_agent_file(
            State(state.clone()), Path(file_id.clone()), query.clone(), wrong_headers,
        ).await.unwrap_err();
        assert_eq!(error.0, StatusCode::FORBIDDEN);

        let mut owner_headers = HeaderMap::new();
        owner_headers.insert("authorization", "Bearer token-a".parse().unwrap());
        let response = get_agent_file(
            State(state.clone()), Path(file_id.clone()), query.clone(), owner_headers,
        )
            .await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(to_bytes(response.into_body(), 64).await.unwrap(), "download me");

        state.hub.store.remove_member(group_id, "agent", "bot-a", None);
        let mut owner_headers = HeaderMap::new();
        owner_headers.insert("authorization", "Bearer token-a".parse().unwrap());
        let denied = get_agent_file(State(state), Path(file_id), query, owner_headers)
            .await.unwrap_err();
        assert_eq!(denied.0, StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn message_upload_rejects_bodies_above_the_aggregate_budget() {
        let (state, _dir) = test_state();
        state.config.update(|config| {
            config.max_file_mb = 1;
            config.max_video_mb = 2;
        });
        let group = state.hub.store.create_group("Media", "", None);
        let channel = state.hub.store.create_channel(group["id"].as_str().unwrap(), "video", "");
        let boundary = "agora-video-budget";
        let mut body = Vec::new();
        for index in 0..4 {
            body.extend_from_slice(format!("--{boundary}\r\nContent-Disposition: form-data; name=\"files\"; filename=\"{index}.mp4\"\r\nContent-Type: video/mp4\r\n\r\n").as_bytes());
            body.extend_from_slice(b"\0\0\0\x18ftypisom");
            body.resize(body.len() + (1600 * 1024) - 12, 0);
            body.extend_from_slice(b"\r\n");
        }
        body.extend_from_slice(format!("--{boundary}--\r\n").as_bytes());
        let token = state.config.snapshot().admin_key;
        let response = router(state)
            .oneshot(Request::post(format!("/api/channels/{}/messages/upload", channel["id"].as_str().unwrap()))
                .header("authorization", format!("Bearer {token}"))
                .header("content-type", format!("multipart/form-data; boundary={boundary}"))
                .extension(ConnectInfo("127.0.0.1:12345".parse::<SocketAddr>().unwrap()))
                .body(Body::from(body)).unwrap())
            .await.unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        let body = to_bytes(response.into_body(), 1024).await.unwrap();
        assert!(String::from_utf8_lossy(&body).contains("Attachments too large for one message"));
    }

    #[tokio::test]
    async fn message_upload_accepts_recognized_video_above_the_regular_file_cap() {
        let (state, _dir) = test_state();
        state.config.update(|config| { config.max_file_mb = 1; config.max_video_mb = 2; });
        let group = state.hub.store.create_group("Media", "", None);
        let channel = state.hub.store.create_channel(group["id"].as_str().unwrap(), "video", "");
        let boundary = "agora-valid-video";
        let mut body = format!("--{boundary}\r\nContent-Disposition: form-data; name=\"files\"; filename=\"clip.mp4\"\r\nContent-Type: video/mp4\r\n\r\n").into_bytes();
        body.extend_from_slice(b"\0\0\0\x18ftypisom");
        body.resize(body.len() + (1500 * 1024) - 12, 0);
        body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
        let token = state.config.snapshot().admin_key;
        let response = router(state).oneshot(Request::post(format!("/api/channels/{}/messages/upload", channel["id"].as_str().unwrap()))
            .header("authorization", format!("Bearer {token}"))
            .header("content-type", format!("multipart/form-data; boundary={boundary}"))
            .extension(ConnectInfo("127.0.0.1:12345".parse::<SocketAddr>().unwrap()))
            .body(Body::from(body)).unwrap()).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
    }

    /// Auth headers for a freshly minted session of `username`.
    fn session_headers(state: &AppState, username: &str) -> HeaderMap {
        let v = state.hub.store.user(username).unwrap()["session_version"]
            .as_i64()
            .unwrap();
        let token = crate::auth::mint_session(username, v, &state.config.session_secret());
        let mut h = HeaderMap::new();
        h.insert("authorization", format!("Bearer {token}").parse().unwrap());
        h
    }

    #[tokio::test]
    async fn template_crud_is_personal_and_admin_key_compatible() {
        let (state, _dir) = test_state();
        state.hub.store.create_user("ana", "Ana", None, "member").unwrap();
        state.hub.store.create_user("mal", "Mal", None, "member").unwrap();
        let group = state.hub.store.create_group("Team", "", Some("ana"));
        let gid = group["id"].as_str().unwrap().to_string();
        state.hub.store.add_member(&gid, "user", "ana", "member", None);
        let q = || Query(HashMap::new());

        assert_eq!(
            list_templates(
                State(state.clone()),
                Path("missing-group".into()),
                q(),
                session_headers(&state, "ana"),
            ).await.unwrap_err().0,
            StatusCode::NOT_FOUND
        );

        let created = create_template(
            State(state.clone()),
            Path(gid.clone()),
            q(),
            session_headers(&state, "ana"),
            Json(json!({"label": "Standup", "text": "Yesterday…"})),
        )
        .await
        .unwrap()
        .0;
        assert_eq!(created["label"], "Standup");
        let template_id = created["id"].as_str().unwrap().to_string();

        let listed = list_templates(
            State(state.clone()),
            Path(gid.clone()),
            q(),
            session_headers(&state, "ana"),
        )
        .await
        .unwrap()
        .0;
        assert_eq!(listed["templates"].as_array().unwrap().len(), 1);

        // A non-member cannot read the group's templates at all, and cannot
        // reach Ana's row by id even though it knows the id.
        assert_eq!(
            list_templates(State(state.clone()), Path(gid.clone()), q(), session_headers(&state, "mal"))
                .await
                .unwrap_err()
                .0,
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            create_template(
                State(state.clone()), Path(gid.clone()), q(), session_headers(&state, "mal"),
                Json(json!({"text": "not mine"})),
            ).await.unwrap_err().0,
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            delete_template(
                State(state.clone()), Path((gid.clone(), template_id.clone())), q(),
                session_headers(&state, "mal"),
            ).await.unwrap_err().0,
            StatusCode::FORBIDDEN
        );
        state.hub.store.add_member(&gid, "user", "mal", "member", None);
        assert_eq!(
            update_template(
                State(state.clone()),
                Path((gid.clone(), template_id.clone())),
                q(),
                session_headers(&state, "mal"),
                Json(json!({"text": "stolen"})),
            )
            .await
            .unwrap_err()
            .0,
            StatusCode::NOT_FOUND
        );
        assert!(
            list_templates(State(state.clone()), Path(gid.clone()), q(), session_headers(&state, "mal"))
                .await
                .unwrap()
                .0["templates"]
                .as_array()
                .unwrap()
                .is_empty()
        );

        // The operator credential resolves to an instance admin, as everywhere.
        let mut admin = HeaderMap::new();
        admin.insert(
            "authorization",
            format!("Bearer {}", state.config.admin_key()).parse().unwrap(),
        );
        assert!(list_templates(State(state.clone()), Path(gid.clone()), q(), admin).await.is_ok());

        // Malformed JSON values degrade to a client error instead of panicking
        // when the handler fills in an omitted label.
        let malformed = update_template(
            State(state.clone()),
            Path((gid.clone(), template_id.clone())),
            q(),
            session_headers(&state, "ana"),
            Json(json!([])),
        )
        .await;
        assert_eq!(malformed.unwrap_err().0, StatusCode::BAD_REQUEST);

        // The owner can edit and delete; a second delete is a miss.
        let updated = update_template(
            State(state.clone()),
            Path((gid.clone(), template_id.clone())),
            q(),
            session_headers(&state, "ana"),
            Json(json!({"text": "Today…"})),
        )
        .await
        .unwrap()
        .0;
        assert_eq!(updated["text"], "Today…");
        // PATCH without label preserves the deliberately chosen label.
        assert_eq!(updated["label"], "Standup");
        let updated = update_template(
            State(state.clone()),
            Path((gid.clone(), template_id.clone())),
            q(),
            session_headers(&state, "ana"),
            Json(json!({"label": null, "text": "Tomorrow…"})),
        )
        .await
        .unwrap()
        .0;
        assert_eq!(updated["label"], "Standup");
        assert!(delete_template(
            State(state.clone()),
            Path((gid.clone(), template_id.clone())),
            q(),
            session_headers(&state, "ana"),
        )
        .await
        .is_ok());
        assert_eq!(
            delete_template(
                State(state.clone()),
                Path((gid, template_id)),
                q(),
                session_headers(&state, "ana"),
            )
            .await
            .unwrap_err()
            .0,
            StatusCode::NOT_FOUND
        );
    }

    #[tokio::test]
    async fn template_writes_validate_text_label_and_the_per_group_cap() {
        let (state, _dir) = test_state();
        state.hub.store.create_user("ana", "Ana", None, "member").unwrap();
        let group = state.hub.store.create_group("Team", "", Some("ana"));
        let gid = group["id"].as_str().unwrap().to_string();
        state.hub.store.add_member(&gid, "user", "ana", "member", None);
        let q = || Query(HashMap::new());
        let create = |payload: Value| {
            create_template(
                State(state.clone()),
                Path(gid.clone()),
                q(),
                session_headers(&state, "ana"),
                Json(payload),
            )
        };

        assert_eq!(
            create(json!({"text": "   "})).await.unwrap_err().0,
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            create(json!({"text": "x".repeat(MAX_MESSAGE_CHARS + 1)})).await.unwrap_err().0,
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            create(json!({"label": "l".repeat(MAX_TEMPLATE_LABEL_CHARS + 1), "text": "ok"}))
                .await
                .unwrap_err()
                .0,
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            template_fields(&json!({"text": "\n  \nStatus update…"})).unwrap().0,
            "Status update…"
        );

        for i in 0..MAX_TEMPLATES_PER_GROUP {
            assert!(create(json!({"text": format!("draft {i}")})).await.is_ok());
        }
        assert_eq!(
            create(json!({"text": "one too many"})).await.unwrap_err().0,
            StatusCode::CONFLICT
        );
        // Validation still precedes the cap, so a bad payload is a 400.
        assert_eq!(
            create(json!({"text": ""})).await.unwrap_err().0,
            StatusCode::BAD_REQUEST
        );
    }

    #[tokio::test]
    async fn pairing_list_reports_live_agents_and_revoke_closes_the_socket() {
        let (state, _dir) = test_state();
        state
            .hub
            .store
            .create_user("boss", "Boss", None, "admin")
            .unwrap();
        state.config.update(|c| {
            c.pairing_tokens.push(PairingToken {
                id: "pair-a".into(),
                token: "tok-a".into(),
                name: "duplicate".into(),
                kind: Some("codex".into()),
                created_at: 123.0,
            });
            c.pairing_tokens.push(PairingToken {
                id: "pair-b".into(),
                token: "tok-b".into(),
                name: "duplicate".into(),
                kind: None,
                created_at: 456.0,
            });
        });
        let headers = session_headers(&state, "boss");
        let q = || Query(HashMap::new());

        let initial = list_pairing(State(state.clone()), q(), headers.clone())
            .await
            .unwrap()
            .0;
        assert_eq!(
            initial["tokens"][0],
            json!({
                "id": "pair-a",
                "token": "tok-a",
                "name": "duplicate",
                "kind": "codex",
                "created_at": 123.0,
                "connected": false,
                "agents": [],
            })
        );

        let conn_id = state.hub.next_conn_id();
        let close = state.hub.register_pairing_conn(conn_id, "tok-a");
        let connected = list_pairing(State(state.clone()), q(), headers.clone())
            .await
            .unwrap()
            .0;
        assert_eq!(connected["tokens"][0]["connected"], true);
        assert_eq!(connected["tokens"][0]["agents"], json!([]));
        assert_eq!(connected["tokens"][1]["connected"], false);

        let (tx, _rx) = unbounded_channel();
        state.hub.register_agent(AgentHandle {
            agent_id: "bridge-agent".into(),
            agent_name: "Bridge Agent".into(),
            requires_mention: false,
            wants_context_feed: false,
            has_avatar: false,
            avatar_v: 0,
            source: "pairing:duplicate".into(),
            conn_id,
            tx,
        });
        let with_agent = list_pairing(State(state.clone()), q(), headers.clone())
            .await
            .unwrap()
            .0;
        assert_eq!(
            with_agent["tokens"][0]["agents"],
            json!([{"id": "bridge-agent", "name": "Bridge Agent"}])
        );
        assert_eq!(with_agent["tokens"][1]["agents"], json!([]));

        let _ = revoke_pairing(
            State(state.clone()),
            Path("tok-a".into()),
            q(),
            headers.clone(),
        )
        .await
        .unwrap();
        assert!(
            tokio::time::timeout(Duration::from_millis(20), close.notified())
                .await
                .is_ok()
        );
        state.hub.unregister_connection(conn_id);

        // Simulate an upgrade that passed its first token check immediately
        // before revoke but did not register in the hub until afterward.
        let late_conn = state.hub.next_conn_id();
        assert!(register_pairing_socket(&state, late_conn, "tok-a").is_none());
        assert!(!state.hub.pairing_status().contains_key("tok-a"));

        let revoked = list_pairing(State(state), q(), headers).await.unwrap().0;
        assert_eq!(revoked["tokens"].as_array().unwrap().len(), 1);
        assert_eq!(revoked["tokens"][0]["token"], "tok-b");
    }

    #[tokio::test]
    async fn admin_source_roster_is_transport_scoped_and_keeps_offline_agents() {
        let (state,_dir)=test_state();
        state.hub.store.create_user("boss","Boss",None,"admin").unwrap();
        state.hub.store.create_user("ana","Ana",None,"member").unwrap();
        state.config.update(|c| {
            c.connections.push(Connection{name:"Home".into(),url:"wss://example.test/agora/connect".into(),token:"remote".into(),enabled:true});
            c.pairing_tokens.push(PairingToken{id:"pair-a".into(),token:"secret-a".into(),name:"duplicate".into(),kind:None,created_at:1.0});
            c.pairing_tokens.push(PairingToken{id:"pair-b".into(),token:"secret-b".into(),name:"duplicate".into(),kind:None,created_at:2.0});
        });
        state.hub.store.upsert_agent("research","Research","Home",false,false,0);
        state.hub.store.upsert_agent("codex","Codex","pairing:pair-a",false,false,0);
        state.hub.store.upsert_agent("legacy","Legacy","pairing:duplicate",false,false,0);
        let roster=list_agent_sources(State(state.clone()),Query(HashMap::new()),session_headers(&state,"boss")).await.unwrap().0;
        assert_eq!(roster["sources"][0]["agents"][0]["id"],"research");
        assert_eq!(roster["sources"][1]["agents"][0]["id"],"codex");
        assert!(roster["sources"][2]["agents"].as_array().unwrap().is_empty());
        assert!(!roster.to_string().contains("secret-a"));
        assert!(list_agent_sources(State(state.clone()),Query(HashMap::new()),session_headers(&state,"ana")).await.is_err());
    }

    #[tokio::test]
    async fn pairing_creation_persists_a_known_agent_kind_only() {
        let (state, _dir) = test_state();
        state
            .hub
            .store
            .create_user("boss", "Boss", None, "admin")
            .unwrap();
        let headers = session_headers(&state, "boss");

        let _ = create_pairing(
            State(state.clone()),
            Query(HashMap::new()),
            headers.clone(),
            Json(json!({"name": "Desk Codex", "kind": "codex"})),
        )
        .await
        .unwrap();
        let _ = create_pairing(
            State(state.clone()),
            Query(HashMap::new()),
            headers.clone(),
            Json(json!({"name": "Custom", "kind": "untrusted-value"})),
        )
        .await
        .unwrap();
        let _ = create_pairing(
            State(state.clone()),
            Query(HashMap::new()),
            headers,
            Json(json!({"name": "   "})),
        )
        .await
        .unwrap();

        let snapshot = state.config.snapshot();
        assert_eq!(snapshot.pairing_tokens[0].kind.as_deref(), Some("codex"));
        assert!(snapshot.pairing_tokens[1].kind.is_none());
        assert_eq!(snapshot.pairing_tokens[2].name, "agent");
    }

    #[tokio::test]
    async fn revoking_pairing_token_closes_the_real_agent_socket() {
        let (state, _dir) = test_state();
        state
            .hub
            .store
            .create_user("boss", "Boss", None, "admin")
            .unwrap();
        state.config.update(|c| {
            c.pairing_tokens.push(PairingToken {
                id: "pair-socket".into(),
                token: "socket-token".into(),
                name: "socket-test".into(),
                kind: None,
                created_at: 123.0,
            });
        });

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let service = router(state.clone()).into_make_service_with_connect_info::<SocketAddr>();
        let server = tokio::spawn(async move {
            axum::serve(listener, service).await.unwrap();
        });

        let url = format!("ws://{addr}/agent/ws?token=socket-token");
        let (mut socket, _) = tokio_tungstenite::connect_async(url).await.unwrap();
        socket
            .send(tokio_tungstenite::tungstenite::Message::Text(
                json!({
                    "type": "hello",
                    "agents": [{"id": "socket-agent", "name": "Socket Agent"}],
                })
                .to_string()
                .into(),
            ))
            .await
            .unwrap();

        tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                let status = state.hub.pairing_status();
                if status
                    .get("socket-token")
                    .is_some_and(|agents| agents.iter().any(|(id, _)| id == "socket-agent"))
                {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("agent hello should register");

        let _ = revoke_pairing(
            State(state.clone()),
            Path("socket-token".into()),
            Query(HashMap::new()),
            session_headers(&state, "boss"),
        )
        .await
        .unwrap();

        tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                match socket.next().await {
                    Some(Ok(tokio_tungstenite::tungstenite::Message::Ping(_))) => continue,
                    Some(Ok(tokio_tungstenite::tungstenite::Message::Pong(_))) => continue,
                    Some(Ok(tokio_tungstenite::tungstenite::Message::Close(_)))
                    | Some(Err(_))
                    | None => break,
                    Some(Ok(_)) => {}
                }
            }
        })
        .await
        .expect("revoked socket should close");

        tokio::time::timeout(Duration::from_secs(1), async {
            while state.hub.pairing_status().contains_key("socket-token") {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("closed socket should unregister");
        server.abort();
    }

    #[tokio::test]
    async fn reactions_toggle_validate_and_gate_membership() {
        let (state, _dir) = test_state();
        let store = &state.hub.store;
        store.create_user("ana", "", None, "member").unwrap();
        store.create_user("mal", "", None, "member").unwrap();
        let g = store.create_group("Team", "", Some("ana"));
        let gid = g["id"].as_str().unwrap();
        store.add_member(gid, "user", "ana", "admin", None);
        let c = store.create_channel(gid, "general", "");
        let cid = c["id"].as_str().unwrap().to_string();
        let m = store.add_message(&cid, "hello", "user", "ana", None, None, &[]);
        let mid = m["id"].as_i64().unwrap();
        let ana = session_headers(&state, "ana");
        let q = || Query(HashMap::new());

        // PUT adds and returns the updated message payload.
        let res = add_reaction(
            State(state.clone()),
            Path((cid.clone(), mid, "👍".to_string())),
            q(),
            ana.clone(),
        )
        .await
        .unwrap();
        assert_eq!(res.0["reactions"][0]["users"], json!(["ana"]));
        assert_eq!(res.0["reactions"][0]["reactors"], json!([
            {"type": "user", "id": "ana", "name": "ana"}
        ]));

        // Duplicate PUT is a no-op but still succeeds with the same payload.
        let res = add_reaction(
            State(state.clone()),
            Path((cid.clone(), mid, "👍".to_string())),
            q(),
            ana.clone(),
        )
        .await
        .unwrap();
        assert_eq!(res.0["reactions"][0]["users"], json!(["ana"]));

        // ASCII (markup-capable) "emoji" are rejected.
        let bad = add_reaction(
            State(state.clone()),
            Path((cid.clone(), mid, "<img>".to_string())),
            q(),
            ana.clone(),
        )
        .await;
        assert!(bad.is_err());

        // Non-members can't react.
        let mal = session_headers(&state, "mal");
        let denied = add_reaction(
            State(state.clone()),
            Path((cid.clone(), mid, "👍".to_string())),
            q(),
            mal,
        )
        .await;
        assert!(denied.is_err());

        // DELETE removes and the payload reflects it.
        let res = remove_reaction(
            State(state.clone()),
            Path((cid.clone(), mid, "👍".to_string())),
            q(),
            ana,
        )
        .await
        .unwrap();
        assert_eq!(res.0["reactions"], json!([]));
    }

    #[tokio::test]
    async fn delete_message_allows_sender_and_admins_only() {
        let (state, _dir) = test_state();
        let store = &state.hub.store;
        store.create_user("boss", "", None, "member").unwrap();
        store.create_user("ana", "", None, "member").unwrap();
        store.create_user("mal", "", None, "member").unwrap();
        let g = store.create_group("Team", "", Some("boss"));
        let gid = g["id"].as_str().unwrap();
        store.add_member(gid, "user", "boss", "admin", None);
        store.add_member(gid, "user", "ana", "member", None);
        store.add_member(gid, "user", "mal", "member", None);
        let c = store.create_channel(gid, "general", "");
        let cid = c["id"].as_str().unwrap().to_string();
        let q = || Query(HashMap::new());
        let mid = |m: &Value| m["id"].as_i64().unwrap();

        // The sender deletes their own message.
        let own = store.add_message(&cid, "oops", "user", "ana", None, None, &[]);
        delete_message(
            State(state.clone()),
            Path((cid.clone(), mid(&own))),
            q(),
            session_headers(&state, "ana"),
        )
        .await
        .unwrap();
        assert!(store.message(mid(&own)).is_none());

        // Another plain member can't delete someone else's message…
        let root = store.add_message(&cid, "root", "user", "ana", None, None, &[]);
        let denied = delete_message(
            State(state.clone()),
            Path((cid.clone(), mid(&root))),
            q(),
            session_headers(&state, "mal"),
        )
        .await;
        assert!(denied.is_err());
        assert!(store.message(mid(&root)).is_some());

        // …but a group admin can, and the root's replies go with it.
        let reply =
            store.add_message(&cid, "reply", "agent", "bot", Some("Bot"), Some(mid(&root)), &[]);
        delete_message(
            State(state.clone()),
            Path((cid.clone(), mid(&root))),
            q(),
            session_headers(&state, "boss"),
        )
        .await
        .unwrap();
        assert!(store.message(mid(&root)).is_none());
        assert!(store.message(mid(&reply)).is_none());

        // Wrong channel id: 404, nothing deleted.
        let other = store.create_channel(gid, "random", "");
        let stray = store.add_message(&cid, "keep", "user", "ana", None, None, &[]);
        let missed = delete_message(
            State(state.clone()),
            Path((other["id"].as_str().unwrap().to_string(), mid(&stray))),
            q(),
            session_headers(&state, "ana"),
        )
        .await;
        assert!(missed.is_err());
        assert!(store.message(mid(&stray)).is_some());
    }

    #[tokio::test]
    async fn attachment_browser_gates_membership_and_agent_file_deletion() {
        let (state, _dir) = test_state();
        let store = &state.hub.store;
        for user in ["boss", "ana", "mal"] {
            store.create_user(user, "", None, "member").unwrap();
        }
        store.create_user("outsider", "", None, "member").unwrap();
        let g = store.create_group("Team", "", Some("boss"));
        let gid = g["id"].as_str().unwrap();
        store.add_member(gid, "user", "boss", "admin", None);
        store.add_member(gid, "user", "ana", "member", None);
        store.add_member(gid, "user", "mal", "member", None);
        let c = store.create_channel(gid, "general", "");
        let cid = c["id"].as_str().unwrap().to_string();
        let attachment = || crate::store::NewAttachment {
            filename: "note.txt".into(), mime: "text/plain".into(), data: b"bytes".to_vec(),
        };
        let own = store.add_message(&cid, "", "user", "ana", None, None, &[attachment()]);
        let agent = store.add_message(&cid, "agent file", "agent", "bot", Some("Bot"), None, &[attachment()]);
        let own_file = own["attachments"][0]["id"].as_str().unwrap().to_string();
        let agent_file = agent["attachments"][0]["id"].as_str().unwrap().to_string();
        let q = || Query(HashMap::new());

        let listed = list_attachments(
            State(state.clone()), Path(cid.clone()), q(), session_headers(&state, "ana"),
        ).await.unwrap();
        assert_eq!(listed.0["items"].as_array().unwrap().len(), 2);
        assert!(list_attachments(
            State(state.clone()), Path(cid.clone()), q(), session_headers(&state, "outsider"),
        ).await.is_err());

        // A plain member cannot delete an agent-authored attachment.
        assert!(delete_attachment(
            State(state.clone()), Path((cid.clone(), agent_file.clone())), q(),
            session_headers(&state, "ana"),
        ).await.is_err());
        // Nor can a non-member delete even a user-authored attachment.
        assert!(delete_attachment(
            State(state.clone()), Path((cid.clone(), own_file.clone())), q(),
            session_headers(&state, "outsider"),
        ).await.is_err());

        // The sender may remove their own file; the empty message survives.
        let updated = delete_attachment(
            State(state.clone()), Path((cid.clone(), own_file)), q(), session_headers(&state, "ana"),
        ).await.unwrap();
        assert_eq!(updated.0["id"], own["id"]);
        assert_eq!(updated.0["attachments"], json!([]));
        assert!(store.message(own["id"].as_i64().unwrap()).is_some());

        // A group admin may remove an agent-authored file.
        let _ = delete_attachment(
            State(state.clone()), Path((cid, agent_file)), q(), session_headers(&state, "boss"),
        ).await.unwrap();
        assert_eq!(store.message(agent["id"].as_i64().unwrap()).unwrap()["attachments"], json!([]));
    }

    #[tokio::test]
    async fn edit_message_is_author_only_and_never_reaches_agents() {
        use crate::hub::AgentHandle;
        use tokio::sync::mpsc::unbounded_channel;

        let (state, _dir) = test_state();
        let store = &state.hub.store;
        for (id, role) in [("ana", "member"), ("boss", "admin"), ("mal", "member")] {
            store.create_user(id, "", None, role).unwrap();
        }
        let g = store.create_group("Team", "", Some("boss"));
        let gid = g["id"].as_str().unwrap();
        for (id, role) in [("ana", "member"), ("boss", "admin"), ("mal", "member")] {
            store.add_member(gid, "user", id, role, None);
        }
        store.add_member(gid, "agent", "bot", "member", None);
        let c = store.create_channel(gid, "general", "");
        let cid = c["id"].as_str().unwrap().to_string();
        let (tx, mut rx) = unbounded_channel();
        state.hub.register_agent(AgentHandle {
            agent_id: "bot".into(), agent_name: "Bot".into(), requires_mention: false,
            wants_context_feed: false, has_avatar: false, avatar_v: 0,
            source: "test".into(), conn_id: state.hub.next_conn_id(), tx,
        });
        let own = store.add_message(&cid, "old searchable phrase", "user", "ana", None, None, &[]);
        let mid = own["id"].as_i64().unwrap();
        store.update_message_meta(mid, &json!({"unfurls": [
            {"url": "https://keep.example", "title": "Keep"},
            {"url": "https://spoof.example", "title": "Spoof"}
        ]}));
        let (ui_tx, mut ui_rx) = unbounded_channel();
        state.hub.attach_socket("ana", false, ui_tx);
        let q = || Query(HashMap::new());

        let edited = edit_message(
            State(state.clone()), Path((cid.clone(), mid)), q(),
            session_headers(&state, "ana"),
            Json(json!({"text": "new @mal phrase https://keep.example"})),
        ).await.unwrap().0;
        assert_eq!(edited["text"], "new @mal phrase https://keep.example");
        assert!(edited["meta"]["edited_at"].as_f64().is_some());
        assert_eq!(edited["meta"]["unfurls"], json!([
            {"url": "https://keep.example", "title": "Keep"}
        ]));
        assert!(rx.try_recv().is_err(), "an edit must not be fanned out to agents");
        let update = ui_rx.try_recv().expect("changed edits must reach UI sockets");
        assert_eq!(update["type"], "message_update");
        assert_eq!(update["message"]["id"], mid);
        assert_eq!(store.unread_counts("mal", std::slice::from_ref(&cid))[&cid]["mentions"], 0,
            "mentions added by an edit must not create mention rows");

        // Saving identical trimmed text is a no-op and keeps the first stamp.
        let stamp = edited["meta"]["edited_at"].clone();
        let same = edit_message(
            State(state.clone()), Path((cid.clone(), mid)), q(),
            session_headers(&state, "ana"),
            Json(json!({"text": "  new @mal phrase https://keep.example  "})),
        ).await.unwrap().0;
        assert_eq!(same["meta"]["edited_at"], stamp);
        assert!(ui_rx.try_recv().is_err(), "no-op edits must not broadcast");

        // Neither another member nor a group admin may rewrite the author.
        for username in ["mal", "boss"] {
            assert!(edit_message(
                State(state.clone()), Path((cid.clone(), mid)), q(),
                session_headers(&state, username), Json(json!({"text": "hijack"})),
            ).await.is_err());
        }
        for bad_text in ["   ".to_string(), "x".repeat(MAX_MESSAGE_CHARS + 1)] {
            assert!(edit_message(
                State(state.clone()), Path((cid.clone(), mid)), q(),
                session_headers(&state, "ana"), Json(json!({"text": bad_text})),
            ).await.is_err());
        }
        let other = store.create_channel(gid, "other", "");
        assert!(edit_message(
            State(state.clone()),
            Path((other["id"].as_str().unwrap().to_string(), mid)), q(),
            session_headers(&state, "ana"), Json(json!({"text": "wrong channel"})),
        ).await.is_err());
        let agent = store.add_message(&cid, "agent text", "agent", "bot", None, None, &[]);
        assert!(edit_message(
            State(state.clone()), Path((cid.clone(), agent["id"].as_i64().unwrap())), q(),
            session_headers(&state, "boss"), Json(json!({"text": "rewrite"})),
        ).await.is_err());

        assert!(store.search_messages("new", false, Some(&cid), None, None, None, None, false, 10, 0)
            .iter().any(|m| m["id"] == mid));
        assert!(store.search_messages("old", false, Some(&cid), None, None, None, None, false, 10, 0)
            .iter().all(|m| m["id"] != mid));
    }

    #[tokio::test]
    async fn form_endpoints_gate_membership_and_lock_one_shot() {
        let (state, _dir) = test_state();
        let store = &state.hub.store;
        store.create_user("ana", "", None, "member").unwrap();
        store.create_user("mal", "", None, "member").unwrap();
        let g = store.create_group("Team", "", Some("ana"));
        let gid = g["id"].as_str().unwrap();
        store.add_member(gid, "user", "ana", "admin", None);
        let c = store.create_channel(gid, "general", "");
        let cid = c["id"].as_str().unwrap().to_string();
        let m = state.hub.post_agent_message_with_options(
            "bot-a",
            "Bot A",
            &cid,
            "Log your day",
            None,
            None,
            None,
            None,
            None,
            Some(&json!({
                "fields": [
                    {"id": "breakfast", "kind": "input", "label": "Breakfast"},
                    {"id": "ran_5k", "kind": "checkbox", "label": "Ran 5k"},
                ],
                "buttons": [{"id": "log", "label": "Log it", "style": "primary"}],
            })),
            Some("daily-1"),
            None,
            vec![],
        );
        let mid = m["id"].as_i64().unwrap();
        let q = || Query(HashMap::new());

        // Non-members can't touch the form.
        let denied = update_message_form_state(
            State(state.clone()),
            Path(mid),
            q(),
            session_headers(&state, "mal"),
            Json(json!({"field_id": "ran_5k", "value": true})),
        )
        .await;
        assert!(denied.is_err());

        // A member's edits persist; bad fields/types are 400s.
        let ana = session_headers(&state, "ana");
        let res = update_message_form_state(
            State(state.clone()),
            Path(mid),
            q(),
            ana.clone(),
            Json(json!({"field_id": "breakfast", "value": "eggs"})),
        )
        .await
        .unwrap();
        assert_eq!(res.0["meta"]["form_state"]["breakfast"], "eggs");
        let bad = update_message_form_state(
            State(state.clone()),
            Path(mid),
            q(),
            ana.clone(),
            Json(json!({"field_id": "nope", "value": "x"})),
        )
        .await;
        assert_eq!(bad.unwrap_err().0, StatusCode::BAD_REQUEST);
        let bad = update_message_form_state(
            State(state.clone()),
            Path(mid),
            q(),
            ana.clone(),
            Json(json!({"field_id": "ran_5k", "value": "not-a-bool"})),
        )
        .await;
        assert_eq!(bad.unwrap_err().0, StatusCode::BAD_REQUEST);

        // Submit locks the form with a snapshot of the state…
        let res = submit_message_form(
            State(state.clone()),
            Path(mid),
            q(),
            ana.clone(),
            Json(json!({"button_id": "log"})),
        )
        .await
        .unwrap();
        assert_eq!(res.0["meta"]["form_submitted"]["by"], "ana");
        assert_eq!(res.0["meta"]["form_submitted"]["values"]["breakfast"], "eggs");

        // …and everything after the lock is a 409.
        let locked = submit_message_form(
            State(state.clone()),
            Path(mid),
            q(),
            ana.clone(),
            Json(json!({"button_id": "log"})),
        )
        .await;
        assert_eq!(locked.unwrap_err().0, StatusCode::CONFLICT);
        let locked = update_message_form_state(
            State(state.clone()),
            Path(mid),
            q(),
            ana,
            Json(json!({"field_id": "breakfast", "value": "toast"})),
        )
        .await;
        assert_eq!(locked.unwrap_err().0, StatusCode::CONFLICT);
    }

    #[tokio::test]
    async fn hide_and_reorder_are_per_user_rename_stays_admin() {
        let (state, _dir) = test_state();
        let store = &state.hub.store;
        store.create_user("boss", "", None, "member").unwrap();
        store.create_user("ana", "", None, "member").unwrap();
        let g = store.create_group("Team", "", Some("boss"));
        let gid = g["id"].as_str().unwrap().to_string();
        store.add_member(&gid, "user", "ana", "member", None);
        let c = store.create_channel(&gid, "general", "");
        let cid = c["id"].as_str().unwrap().to_string();
        let boss = session_headers(&state, "boss");
        let ana = session_headers(&state, "ana");
        let q = || Query(HashMap::new());

        // A plain member hides the group — for themselves only.
        let res = update_group(
            State(state.clone()),
            Path(gid.clone()),
            q(),
            ana.clone(),
            Json(json!({"hidden": true})),
        )
        .await
        .unwrap();
        assert_eq!(res.0["hidden"], true);
        let mine = list_groups(State(state.clone()), q(), ana.clone()).await.unwrap();
        assert_eq!(mine.0["groups"][0]["hidden"], true);
        let theirs = list_groups(State(state.clone()), q(), boss.clone()).await.unwrap();
        assert_eq!(theirs.0["groups"][0]["hidden"], false);

        // Channel hide: same story, and the admin's view keeps it visible.
        let res = update_channel(
            State(state.clone()),
            Path((gid.clone(), cid.clone())),
            q(),
            ana.clone(),
            Json(json!({"hidden": true})),
        )
        .await
        .unwrap();
        assert_eq!(res.0["hidden"], true);
        let theirs = list_groups(State(state.clone()), q(), boss.clone()).await.unwrap();
        assert_eq!(theirs.0["groups"][0]["channels"][0]["hidden"], false);

        // Renaming edits the shared channel: members are refused.
        let refused = update_channel(
            State(state.clone()),
            Path((gid.clone(), cid.clone())),
            q(),
            ana.clone(),
            Json(json!({"name": "hijacked"})),
        )
        .await;
        assert!(refused.is_err());

        // Reordering writes the caller's own positions.
        let c2 = store.create_channel(&gid, "alpha", "");
        let c2id = c2["id"].as_str().unwrap().to_string();
        let _ = reorder_channels(
            State(state.clone()),
            Path(gid.clone()),
            q(),
            ana.clone(),
            Json(json!({"ids": [c2id.clone(), cid.clone()]})),
        )
        .await
        .unwrap();
        let mine = list_groups(State(state.clone()), q(), ana.clone()).await.unwrap();
        assert_eq!(mine.0["groups"][0]["channels"][0]["id"], c2id.as_str());
        // The admin keeps the store's (creation) order.
        let theirs = list_groups(State(state.clone()), q(), boss).await.unwrap();
        assert_eq!(theirs.0["groups"][0]["channels"][0]["id"], cid.as_str());
    }

    #[tokio::test]
    async fn public_group_opens_to_all_and_toggle_stays_admin_only() {
        let (state, _dir) = test_state();
        let store = &state.hub.store;
        store.create_user("boss", "", None, "member").unwrap();
        store.create_user("rex", "", None, "member").unwrap();
        let g = store.create_group("Team", "", Some("boss")); // boss = group admin
        let gid = g["id"].as_str().unwrap().to_string();
        let c = store.create_channel(&gid, "general", "");
        let cid = c["id"].as_str().unwrap().to_string();
        store.add_message(&cid, "hello", "user", "boss", None, None, &[]);
        let boss = session_headers(&state, "boss");
        let rex = session_headers(&state, "rex"); // no membership anywhere
        let q = || Query(HashMap::new());

        // Outsider: the group is invisible and unreachable.
        let mine = list_groups(State(state.clone()), q(), rex.clone()).await.unwrap();
        assert!(mine.0["groups"].as_array().unwrap().is_empty());
        let denied =
            list_messages(State(state.clone()), Path(cid.clone()), q(), rex.clone()).await;
        assert_eq!(denied.unwrap_err().0, StatusCode::FORBIDDEN);
        // ... and they certainly can't open it up themselves.
        let denied = update_group(
            State(state.clone()),
            Path(gid.clone()),
            q(),
            rex.clone(),
            Json(json!({"is_public": true})),
        )
        .await;
        assert_eq!(denied.unwrap_err().0, StatusCode::FORBIDDEN);

        // The group admin flips it public.
        let res = update_group(
            State(state.clone()),
            Path(gid.clone()),
            q(),
            boss.clone(),
            Json(json!({"is_public": true})),
        )
        .await
        .unwrap();
        assert_eq!(res.0["is_public"], true);

        // Outsider now sees it as a plain member: list, read, post.
        let mine = list_groups(State(state.clone()), q(), rex.clone()).await.unwrap();
        assert_eq!(mine.0["groups"][0]["id"], gid.as_str());
        assert_eq!(mine.0["groups"][0]["role"], "member");
        let msgs = list_messages(State(state.clone()), Path(cid.clone()), q(), rex.clone())
            .await
            .unwrap();
        assert_eq!(msgs.0["messages"].as_array().unwrap().len(), 1);
        let posted = post_message(
            State(state.clone()),
            Path(cid.clone()),
            q(),
            rex.clone(),
            Json(json!({"text": "hi from outside"})),
        )
        .await
        .unwrap();
        assert_eq!(posted.0["text"], "hi from outside");

        // Member-level access doesn't grant the toggle: still admin-only.
        let denied = update_group(
            State(state.clone()),
            Path(gid.clone()),
            q(),
            rex.clone(),
            Json(json!({"is_public": false})),
        )
        .await;
        assert_eq!(denied.unwrap_err().0, StatusCode::FORBIDDEN);

        // Admin closes it again; the outsider is back out.
        let res = update_group(
            State(state.clone()),
            Path(gid.clone()),
            q(),
            boss,
            Json(json!({"is_public": false})),
        )
        .await
        .unwrap();
        assert_eq!(res.0["is_public"], false);
        let mine = list_groups(State(state.clone()), q(), rex).await.unwrap();
        assert!(mine.0["groups"].as_array().unwrap().is_empty());
    }

    #[tokio::test]
    async fn me_advertises_the_upload_limit() {
        let (state, _dir) = test_state();
        state.hub.store.create_user("ana", "Ana", None, "member").unwrap();

        let res = me(
            State(state.clone()),
            Query(HashMap::new()),
            session_headers(&state, "ana"),
        )
        .await
        .unwrap();

        assert_eq!(
            res.0["max_file_mb"],
            state.config.snapshot().max_file_mb,
        );
        assert_eq!(res.0["max_video_mb"], state.config.snapshot().max_video_mb);
    }

    #[tokio::test]
    async fn update_me_renames_self_and_cannot_escalate() {
        let (state, _dir) = test_state();
        let store = &state.hub.store;
        store.create_user("ana", "Ana", None, "member").unwrap();
        let ana = session_headers(&state, "ana");
        let q = || Query(HashMap::new());

        let res = update_me(
            State(state.clone()),
            q(),
            ana.clone(),
            // Smuggled admin fields must be ignored — only display_name is
            // self-service.
            Json(json!({"display_name": "  Ana Banana  ", "instance_role": "admin", "disabled": false})),
        )
        .await
        .unwrap();
        assert_eq!(res.0["display_name"], "Ana Banana");
        let row = store.user("ana").unwrap();
        assert_eq!(row["display_name"], "Ana Banana");
        assert_eq!(row["instance_role"], "member");

        // Blank clears back to the username.
        let res = update_me(State(state.clone()), q(), ana, Json(json!({"display_name": ""})))
            .await
            .unwrap();
        assert_eq!(res.0["display_name"], "ana");
        assert_eq!(store.user("ana").unwrap()["display_name"], "");
    }

    #[test]
    fn signin_accepts_a_valid_link_token_once() {
        let (state, _dir) = test_state();
        let store = &state.hub.store;

        let link = store.create_invite_link(Some("boss"), "member", 3600.0);
        let token = link["token"].as_str().unwrap().to_string();

        // Without the token the email is a stranger.
        assert_eq!(signin_session_for_email(&state, "dave@x.io", None), Err("no_access"));
        // With it, the account is created with the link's role and the link
        // is consumed.
        let session = signin_session_for_email(&state, "dave@x.io", Some(&token)).unwrap();
        let dave = authed_user(&state, &session).unwrap();
        assert_eq!(dave.username, "dave");
        assert!(!dave.instance_admin);
        assert_eq!(store.invite_link(&token).unwrap()["used_by"], "dave");

        // Single-use: the next stranger is turned away…
        assert_eq!(
            signin_session_for_email(&state, "eve@x.io", Some(&token)),
            Err("no_access")
        );
        // …but the admitted user keeps signing in without it.
        assert!(signin_session_for_email(&state, "dave@x.io", None).is_ok());

        // Expired links admit nobody.
        let stale = store.create_invite_link(None, "member", -1.0);
        let stale_token = stale["token"].as_str().unwrap();
        assert_eq!(
            signin_session_for_email(&state, "late@x.io", Some(stale_token)),
            Err("no_access")
        );
    }
}
