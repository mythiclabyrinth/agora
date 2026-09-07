//! Expo Push API client for mobile remote notifications.
//!
//! The headless server can't keep a phone's WebSocket alive once iOS suspends
//! the app, so agent messages fan out here to any registered Expo push tokens.
//! Expo relays to APNs/FCM; tickets that report `DeviceNotRegistered` tell us
//! to drop stale tokens from the store.

use serde_json::{json, Value};
use std::collections::HashMap;

const EXPO_PUSH_URL: &str = "https://exp.host/--/api/v2/push/send";

/// One notification destined for every registered device token.
#[derive(Clone, Debug)]
pub struct PushMessage {
    pub title: String,
    pub body: String,
    pub channel_id: String,
    pub thread_id: Option<i64>,
    pub message_id: i64,
    pub pending_interaction: bool,
    pub actions: Option<crate::notify_actions::Actions>,
}

impl PushMessage {
    pub fn conversation_key(&self) -> String {
        match self.thread_id {
            Some(thread_id) => format!("thread:{thread_id}"),
            None => format!("channel:{}", self.channel_id),
        }
    }
}

fn payload(message: &PushMessage, token: &str, context: Option<&str>) -> Value {
    let mut data = json!({
        "channel_id": message.channel_id,
        "message_id": message.message_id,
    });
    if let Some(tid) = message.thread_id {
        data["thread_id"] = json!(tid);
    }
    if message.pending_interaction {
        data["pending_interaction"] = json!(true);
    }
    let key = if message.pending_interaction {
        format!("msg:{}", message.message_id)
    } else { message.conversation_key() };
    let mut result = json!({
        "to": token,
        "title": message.title,
        "body": message.body,
        "data": data,
        "sound": "default",
        "collapseId": key,
        "tag": key,
    });
    if let (Some(actions), Some(context)) = (&message.actions, context) {
        let mut envelope = serde_json::to_value(actions).expect("notification actions serialize");
        envelope["context"] = json!(context);
        result["data"]["notification_actions"] = envelope;
        result["categoryId"] = json!(actions.category);
    }
    result
}

/// POST `message` to each `token` via Expo. Returns tokens Expo says are dead
/// so the caller can prune them. Best-effort: network failures return no
/// prunes (retry next message) rather than wiping the table.
pub fn send(message: &PushMessage, tokens: &[String], contexts: &HashMap<String, String>) -> Vec<String> {
    if tokens.is_empty() {
        return Vec::new();
    }
    let messages: Vec<Value> = tokens
        .iter()
        .map(|token| payload(message, token, contexts.get(token).map(String::as_str)))
        .collect();

    let response = match ureq::post(EXPO_PUSH_URL)
        .set("Content-Type", "application/json")
        .set("Accept", "application/json")
        .send_json(json!(messages))
    {
        Ok(r) => r,
        Err(e) => {
            tracing::warn!("expo push send failed: {e}");
            return Vec::new();
        }
    };

    let body: Value = match response.into_json() {
        Ok(v) => v,
        Err(e) => {
            tracing::warn!("expo push response decode failed: {e}");
            return Vec::new();
        }
    };

    dead_tokens_from_tickets(&body, tokens)
}

/// Pull `DeviceNotRegistered` tokens out of an Expo tickets response.
/// `tickets.data[i]` aligns with the request order of `tokens`.
pub fn dead_tokens_from_tickets(body: &Value, tokens: &[String]) -> Vec<String> {
    let Some(tickets) = body.get("data").and_then(|d| d.as_array()) else {
        return Vec::new();
    };
    let mut dead = Vec::new();
    for (i, ticket) in tickets.iter().enumerate() {
        if ticket.get("status").and_then(|s| s.as_str()) != Some("error") {
            continue;
        }
        let err = ticket
            .pointer("/details/error")
            .and_then(|e| e.as_str())
            .unwrap_or("");
        if err == "DeviceNotRegistered" {
            if let Some(token) = tokens.get(i) {
                dead.push(token.clone());
            }
        } else {
            tracing::warn!(
                "expo push ticket error: {}",
                ticket.get("message").and_then(|m| m.as_str()).unwrap_or(err)
            );
        }
    }
    dead
}

#[cfg(test)]
mod tests {
    use super::*;

    fn message(thread_id: Option<i64>) -> PushMessage {
        PushMessage {
            title: "Agent".into(),
            body: "Hello".into(),
            channel_id: "channel-1".into(),
            thread_id,
            message_id: 91,
            pending_interaction: false,
            actions: None,
        }
    }

    #[test]
    fn payload_replaces_notifications_per_conversation() {
        let thread = payload(&message(Some(42)), "ExponentPushToken[x]", None);
        assert_eq!(thread["collapseId"], "thread:42");
        assert_eq!(thread["tag"], "thread:42");
        assert_eq!(thread["data"]["thread_id"], 42);
        assert_eq!(thread["data"]["message_id"], 91);

        let channel = payload(&message(None), "ExponentPushToken[x]", None);
        assert_eq!(channel["collapseId"], "channel:channel-1");
        assert_eq!(channel["tag"], "channel:channel-1");
        assert!(channel["data"].get("thread_id").is_none());
    }

    #[test]
    fn pending_messages_do_not_replace_each_other_and_old_clients_get_no_actions() {
        let mut first = message(None);
        first.pending_interaction = true;
        first.actions = crate::notify_actions::for_meta(&json!({"options":[{"id":"ok","label":"Approve"}]}));
        let capable = payload(&first, "ExponentPushToken[x]", Some("device-context"));
        assert_eq!(capable["collapseId"], "msg:91");
        assert_eq!(capable["categoryId"], "agora.v1.approve.d0");
        assert_eq!(capable["data"]["notification_actions"]["context"], "device-context");
        let old = payload(&first, "ExponentPushToken[x]", None);
        assert!(old.get("categoryId").is_none());
        assert_eq!(old["data"]["pending_interaction"], true);
        first.message_id = 92;
        assert_eq!(payload(&first, "ExponentPushToken[x]", None)["collapseId"], "msg:92");
    }

    #[test]
    fn prunes_device_not_registered_by_index() {
        let tokens = vec![
            "ExponentPushToken[alive]".into(),
            "ExponentPushToken[dead]".into(),
        ];
        let body = json!({
            "data": [
                {"status": "ok", "id": "xxx"},
                {
                    "status": "error",
                    "message": "\"ExponentPushToken[dead]\" is not a registered push notification recipient",
                    "details": {"error": "DeviceNotRegistered"}
                }
            ]
        });
        assert_eq!(
            dead_tokens_from_tickets(&body, &tokens),
            vec!["ExponentPushToken[dead]".to_string()]
        );
    }

    #[test]
    fn ignores_other_errors_and_malformed_bodies() {
        let tokens = vec!["ExponentPushToken[a]".into()];
        let body = json!({
            "data": [{
                "status": "error",
                "message": "InvalidCredentials",
                "details": {"error": "InvalidCredentials"}
            }]
        });
        assert!(dead_tokens_from_tickets(&body, &tokens).is_empty());
        assert!(dead_tokens_from_tickets(&json!({}), &tokens).is_empty());
    }
}
