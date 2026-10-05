//! Remote-mode notifications: a background task that keeps its own socket to
//! the remote server's `/ws` and surfaces agent messages as native banners.
//!
//! In embedded mode the in-process hub already notifies (see `maybe_notify`
//! in agora-core); a remote server has no such hook into this process, so
//! this task mirrors the hub's rules — agent-authored messages only, skipped
//! while the window is focused, throttled per channel, "Author — Group /
//! #channel" titles — from the client side of the wire.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use agora_core::hub::ReadNotifyEvent;
use futures_util::StreamExt;
use serde_json::Value;

/// Matches the hub's NOTIFY_THROTTLE: bursts in one channel collapse.
const THROTTLE: Duration = Duration::from_secs(5);

/// Matches the hub's NOTIFY_BODY_MAX_CHARS.
const BODY_MAX_CHARS: usize = 180;

const BACKOFF_MIN: Duration = Duration::from_secs(1);
const BACKOFF_MAX: Duration = Duration::from_secs(30);

/// Window focus, written by the shell's window-event handler. Mirrors the
/// embedded hub's `ui_active` flag: focused means the user sees messages
/// land, so no banner.
pub static UI_FOCUSED: AtomicBool = AtomicBool::new(true);

/// Platform delivery (macOS UNUserNotificationCenter or the Tauri plugin);
/// the shell hands one in so this module stays platform-agnostic.
pub type Deliver = Arc<dyn Fn(Notification) + Send + Sync>;
pub type Clear = Arc<dyn Fn(ReadNotifyEvent) + Send + Sync>;

#[derive(Clone)]
pub struct Notification {
    pub channel_id: String,
    pub thread_id: Option<i64>,
    pub message_id: i64,
    pub title: String,
    pub body: String,
}

/// The pure notify decision for one WS frame: agent messages only, never
/// while focused. `place` is the cached "Group / #channel" label, when known.
fn notification_for(frame: &Value, focused: bool, place: Option<&str>) -> Option<Notification> {
    if focused || frame["type"] != "message" {
        return None;
    }
    let message = &frame["message"];
    if message["author_type"] != "agent" {
        return None;
    }
    let channel_id = message["channel_id"].as_str().unwrap_or_default();
    if channel_id.is_empty() {
        return None;
    }
    let author = message["author_name"]
        .as_str()
        .or(message["author_id"].as_str())
        .unwrap_or("?");
    let title = match place {
        Some(p) => format!("{author} — {p}"),
        None => author.to_string(),
    };
    let text = message["text"].as_str().unwrap_or_default();
    let mut body: String = text.chars().take(BODY_MAX_CHARS).collect();
    if body.is_empty() {
        body = "New message".to_string();
    } else if text.chars().count() > BODY_MAX_CHARS {
        body.push('…');
    }
    Some(Notification {
        channel_id: channel_id.to_string(),
        thread_id: message["thread_id"].as_i64(),
        message_id: message["id"].as_i64().unwrap_or_default(),
        title,
        body,
    })
}

fn read_event_for(frame: &Value) -> Option<ReadNotifyEvent> {
    match frame["type"].as_str()? {
        "read" => Some(ReadNotifyEvent {
            channel_id: frame["channel_id"].as_str()?.to_string(),
            thread_id: None,
            last_read_id: frame["last_read_id"].as_i64()?,
        }),
        "thread_read" => Some(ReadNotifyEvent {
            channel_id: frame["channel_id"].as_str()?.to_string(),
            thread_id: Some(frame["thread_id"].as_i64()?),
            last_read_id: frame["last_read_id"].as_i64()?,
        }),
        _ => None,
    }
}

/// Per-channel throttle; records the notification time when it passes.
fn passes_throttle(last: &mut HashMap<String, Instant>, channel_id: &str, now: Instant) -> bool {
    if let Some(at) = last.get(channel_id) {
        if now.duration_since(*at) < THROTTLE {
            return false;
        }
    }
    last.insert(channel_id.to_string(), now);
    true
}

/// channel_id -> "Group / #channel", from a `/api/groups` payload.
fn names_from_groups(body: &Value) -> HashMap<String, String> {
    let mut map = HashMap::new();
    for group in body["groups"].as_array().into_iter().flatten() {
        let gname = group["name"].as_str().unwrap_or("?");
        for channel in group["channels"].as_array().into_iter().flatten() {
            if let Some(id) = channel["id"].as_str() {
                let cname = channel["name"].as_str().unwrap_or("?");
                map.insert(id.to_string(), format!("{gname} / #{cname}"));
            }
        }
    }
    map
}

fn fetch_names(base: &str, token: &str) -> Option<HashMap<String, String>> {
    let response = ureq::get(&format!("{base}/api/groups"))
        .set("authorization", &format!("Bearer {token}"))
        .timeout(Duration::from_secs(10))
        .call()
        .ok()?;
    let body: Value = serde_json::from_str(&response.into_string().ok()?).ok()?;
    Some(names_from_groups(&body))
}

fn ws_url(base: &str, token: &str) -> String {
    let base = base.trim_end_matches('/');
    let ws_base = if let Some(rest) = base.strip_prefix("https://") {
        format!("wss://{rest}")
    } else if let Some(rest) = base.strip_prefix("http://") {
        format!("ws://{rest}")
    } else {
        format!("wss://{base}")
    };
    format!("{ws_base}/ws?token={token}")
}

/// Run until aborted: connect, notify on agent messages, reconnect with
/// backoff. Never touches the webview — banners only.
pub async fn run(deliver: Deliver, clear: Clear, base: String, token: String) {
    let mut backoff = BACKOFF_MIN;
    let mut last_notified: HashMap<String, Instant> = HashMap::new();
    // Lazily filled; refreshed once per unknown channel id (new channels).
    let mut names: HashMap<String, String> = HashMap::new();
    loop {
        match tokio_tungstenite::connect_async(ws_url(&base, &token)).await {
            Ok((mut stream, _)) => {
                tracing::info!("remote notifier connected");
                backoff = BACKOFF_MIN;
                while let Some(incoming) = stream.next().await {
                    let text = match incoming {
                        Ok(tokio_tungstenite::tungstenite::Message::Text(t)) => t,
                        Ok(_) => continue,
                        Err(_) => break,
                    };
                    let Ok(frame) = serde_json::from_str::<Value>(&text) else { continue };
                    on_frame(&frame, &deliver, &clear, &base, &token, &mut last_notified, &mut names)
                        .await;
                }
                tracing::info!("remote notifier disconnected");
            }
            Err(e) => tracing::debug!("remote notifier connect failed: {e}"),
        }
        tokio::time::sleep(backoff).await;
        backoff = (backoff * 2).min(BACKOFF_MAX);
    }
}

async fn on_frame(
    frame: &Value,
    deliver: &Deliver,
    clear: &Clear,
    base: &str,
    token: &str,
    last_notified: &mut HashMap<String, Instant>,
    names: &mut HashMap<String, String>,
) {
    if let Some(read) = read_event_for(frame) {
        clear(read);
        return;
    }
    let focused = UI_FOCUSED.load(Ordering::Relaxed);
    // Cheap pre-pass (no name yet) to decide whether a lookup is even needed.
    let Some(probe) = notification_for(frame, focused, None) else { return };
    if !passes_throttle(last_notified, &probe.channel_id, Instant::now()) {
        return;
    }
    if !names.contains_key(&probe.channel_id) {
        let (base, token) = (base.to_string(), token.to_string());
        if let Ok(Some(fresh)) =
            tokio::task::spawn_blocking(move || fetch_names(&base, &token)).await
        {
            *names = fresh;
        }
    }
    let place = names.get(&probe.channel_id).map(String::as_str);
    if let Some(n) = notification_for(frame, focused, place) {
        deliver(n);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn agent_frame(text: &str) -> Value {
        json!({"type": "message", "message": {
            "channel_id": "ch1", "author_type": "agent",
            "author_id": "bot", "author_name": "Bot", "text": text, "id": 9,
        }})
    }

    #[test]
    fn notifies_on_agent_message_when_unfocused() {
        let n = notification_for(&agent_frame("hi there"), false, Some("Home / #general"))
            .expect("should notify");
        assert_eq!(n.channel_id, "ch1");
        assert_eq!(n.title, "Bot — Home / #general");
        assert_eq!(n.body, "hi there");
        assert_eq!(n.message_id, 9);
    }

    #[test]
    fn parses_channel_and_thread_read_events() {
        let channel = read_event_for(&json!({
            "type": "read", "channel_id": "c1", "last_read_id": 8,
        })).unwrap();
        assert_eq!(channel.thread_id, None);
        assert_eq!(channel.last_read_id, 8);

        let thread = read_event_for(&json!({
            "type": "thread_read", "channel_id": "c1", "thread_id": 42,
            "last_read_id": 11,
        })).unwrap();
        assert_eq!(thread.thread_id, Some(42));
        assert_eq!(thread.last_read_id, 11);
    }

    #[test]
    fn skips_when_focused() {
        assert!(notification_for(&agent_frame("hi"), true, None).is_none());
    }

    #[test]
    fn skips_user_messages_and_non_message_frames() {
        let user = json!({"type": "message", "message": {
            "channel_id": "ch1", "author_type": "user", "author_id": "tom", "text": "hi",
        }});
        assert!(notification_for(&user, false, None).is_none());
        let typing = json!({"type": "typing", "channel_id": "ch1"});
        assert!(notification_for(&typing, false, None).is_none());
    }

    #[test]
    fn title_falls_back_to_author_without_place() {
        let n = notification_for(&agent_frame("hi"), false, None).unwrap();
        assert_eq!(n.title, "Bot");
    }

    #[test]
    fn body_is_clipped_and_empty_text_gets_placeholder() {
        let long = "x".repeat(BODY_MAX_CHARS + 50);
        let n = notification_for(&agent_frame(&long), false, None).unwrap();
        assert_eq!(n.body.chars().count(), BODY_MAX_CHARS + 1);
        assert!(n.body.ends_with('…'));
        let n = notification_for(&agent_frame(""), false, None).unwrap();
        assert_eq!(n.body, "New message");
    }

    #[test]
    fn throttle_collapses_bursts_per_channel() {
        let mut last = HashMap::new();
        let t0 = Instant::now();
        assert!(passes_throttle(&mut last, "ch1", t0));
        assert!(!passes_throttle(&mut last, "ch1", t0 + Duration::from_secs(1)));
        // A different channel is not throttled by ch1's banner.
        assert!(passes_throttle(&mut last, "ch2", t0 + Duration::from_secs(1)));
        assert!(passes_throttle(&mut last, "ch1", t0 + THROTTLE + Duration::from_secs(1)));
    }

    #[test]
    fn names_map_from_groups_payload() {
        let body = json!({"groups": [
            {"name": "Home", "channels": [
                {"id": "c1", "name": "general"},
                {"id": "c2", "name": "random"},
            ]},
            {"name": "Work", "channels": [{"id": "c3", "name": "standup"}]},
        ]});
        let names = names_from_groups(&body);
        assert_eq!(names["c1"], "Home / #general");
        assert_eq!(names["c3"], "Work / #standup");
    }

    #[test]
    fn ws_url_shapes() {
        assert_eq!(ws_url("https://a.example", "t"), "wss://a.example/ws?token=t");
        assert_eq!(ws_url("http://192.168.1.5:4470/", "t"), "ws://192.168.1.5:4470/ws?token=t");
    }
}
