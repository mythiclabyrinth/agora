//! Outbound connections: the app dials a Pantheo (or protocol-compatible)
//! endpoint's `/agora/connect` websocket, receives a `hello` frame listing
//! the agents that instance offers, registers them with the hub, and then
//! relays protocol frames in both directions until the socket drops —
//! after which it reconnects with backoff.
//!
//! Dialing *out* is what lets the app reach remotely deployed agents from
//! behind NAT, and is the only direction a future mobile build can use.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::sync::mpsc::unbounded_channel;
use tokio_tungstenite::connect_async_with_config;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::header::AUTHORIZATION;
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;
use tokio_tungstenite::tungstenite::Message;

use crate::attachments::agent_wire_limit;
use crate::config::Config;
use crate::hub::{agent_bot_loop_limit, AgentHandle, Hub};

#[derive(Clone, serde::Serialize)]
pub struct ConnStatus {
    pub name: String,
    pub url: String,
    pub connected: bool,
    pub agents: Vec<Value>,
    pub last_error: Option<String>,
}

#[derive(Default)]
struct ManagerState {
    /// connection name -> abort handle for its run loop
    tasks: HashMap<String, tokio::task::AbortHandle>,
    status: HashMap<String, ConnStatus>,
}

pub struct ConnectionManager {
    hub: Arc<Hub>,
    config: Arc<Config>,
    state: Mutex<ManagerState>,
}

impl ConnectionManager {
    pub fn new(hub: Arc<Hub>, config: Arc<Config>) -> Arc<Self> {
        Arc::new(Self {
            hub,
            config,
            state: Mutex::new(ManagerState::default()),
        })
    }

    /// (Re)start run loops so they match the configured connection list.
    pub fn sync(self: &Arc<Self>) {
        let conns = self.config.snapshot().connections;
        let mut st = self.state.lock().unwrap();
        let wanted: Vec<String> = conns
            .iter()
            .filter(|c| c.enabled)
            .map(|c| c.name.clone())
            .collect();
        // Drop loops for removed/disabled connections.
        let stale: Vec<String> = st.tasks.keys().filter(|n| !wanted.contains(n)).cloned().collect();
        for name in stale {
            if let Some(handle) = st.tasks.remove(&name) {
                handle.abort();
            }
            st.status.remove(&name);
        }
        // Start loops for new ones.
        for conn in conns.into_iter().filter(|c| c.enabled) {
            if st.tasks.contains_key(&conn.name) {
                continue;
            }
            st.status.insert(
                conn.name.clone(),
                ConnStatus {
                    name: conn.name.clone(),
                    url: conn.url.clone(),
                    connected: false,
                    agents: Vec::new(),
                    last_error: None,
                },
            );
            let mgr = Arc::clone(self);
            let conn_name = conn.name.clone();
            let task = tokio::spawn(async move {
                mgr.run_loop(conn.name, conn.url, conn.token).await;
            });
            st.tasks.insert(conn_name, task.abort_handle());
        }
    }

    /// Drop every run loop and dial again — used when the app's declared
    /// identity changes so each endpoint re-learns it via a fresh `identify`.
    pub fn restart(self: &Arc<Self>) {
        {
            let mut st = self.state.lock().unwrap();
            for (_, handle) in st.tasks.drain() {
                handle.abort();
            }
            st.status.clear();
        }
        self.sync();
    }

    pub fn status(&self) -> Vec<ConnStatus> {
        self.state.lock().unwrap().status.values().cloned().collect()
    }

    fn set_status<F: FnOnce(&mut ConnStatus)>(&self, name: &str, f: F) {
        let mut st = self.state.lock().unwrap();
        if let Some(s) = st.status.get_mut(name) {
            f(s);
        }
    }

    async fn run_loop(self: Arc<Self>, name: String, url: String, token: String) {
        let mut backoff = Duration::from_secs(1);
        loop {
            match self.run_once(&name, &url, &token).await {
                Ok(()) => {
                    backoff = Duration::from_secs(1);
                    self.set_status(&name, |s| {
                        s.connected = false;
                        s.last_error = Some("disconnected".into());
                    });
                }
                Err(e) => {
                    self.set_status(&name, |s| {
                        s.connected = false;
                        s.last_error = Some(e.to_string());
                    });
                    tracing::debug!("connection {name}: {e}");
                }
            }
            tokio::time::sleep(backoff).await;
            backoff = (backoff * 2).min(Duration::from_secs(60));
        }
    }

    /// Warn (or, under `require_tls`, refuse) when a connection would send the
    /// instance token and message traffic over plaintext to a remote host.
    /// Loopback is always allowed — there is no wire to sniff.
    fn guard_transport(&self, url: &str) -> anyhow::Result<()> {
        let lower = url.trim().to_ascii_lowercase();
        let plaintext = lower.starts_with("ws://") || lower.starts_with("http://");
        if !plaintext {
            return Ok(());
        }
        let host = lower
            .split_once("://")
            .map(|(_, rest)| rest)
            .unwrap_or("")
            .split(['/', ':', '?'])
            .next()
            .unwrap_or("");
        let is_loopback =
            host == "localhost" || host == "127.0.0.1" || host == "::1" || host.ends_with(".local");
        if is_loopback {
            return Ok(());
        }
        if self.config.snapshot().require_tls {
            anyhow::bail!("refusing plaintext connection to {host}: require_tls is on (use wss://)");
        }
        tracing::warn!(
            "connection dials plaintext {url}: the instance token and all traffic travel \
             unencrypted. Use wss:// (front the peer with TLS), or set require_tls to refuse this."
        );
        Ok(())
    }

    async fn run_once(&self, name: &str, url: &str, token: &str) -> anyhow::Result<()> {
        // Pass the instance token in the Authorization header, not the URL:
        // query strings leak into proxy/access logs, and this is a root-level
        // credential. The server still accepts a `?token=` fallback for older
        // peers, but we no longer emit one. (Refuse plaintext ws:// to a
        // non-loopback host when require_tls is on — see below.)
        self.guard_transport(url)?;
        let mut request = url.into_client_request()?;
        request
            .headers_mut()
            .insert(AUTHORIZATION, format!("Bearer {token}").parse()?);
        let per_file = self.config.snapshot().max_file_mb as usize * 1024 * 1024;
        let wire_limit = agent_wire_limit(per_file);
        let mut ws_config = WebSocketConfig::default();
        ws_config.max_message_size = Some(wire_limit);
        ws_config.max_frame_size = Some(wire_limit);
        let (ws, _) = connect_async_with_config(request, Some(ws_config), false).await?;
        let (mut sink, mut stream) = ws.split();

        // The other side speaks first: hello with its agent roster.
        let hello = loop {
            match stream.next().await {
                Some(Ok(Message::Text(text))) => {
                    let v: Value = serde_json::from_str(&text)?;
                    if v["type"] == "hello" {
                        break v;
                    }
                }
                Some(Ok(Message::Ping(_) | Message::Pong(_))) => continue,
                Some(Ok(_)) => continue,
                Some(Err(e)) => return Err(e.into()),
                None => anyhow::bail!("closed before hello"),
            }
        };

        // Declare who we are before any traffic: the other side uses this
        // stable id + display name to keep this app's chats apart from other
        // connected Agoras (sessions, bindings, targeted delivery).
        let ident = json!({
            "type": "identify",
            "agora_id": self.config.instance_id(),
            "agora_name": self.config.instance_name(),
        });
        sink.send(Message::Text(ident.to_string().into())).await?;

        let conn_id = self.hub.next_conn_id();
        let (tx, mut rx) = unbounded_channel::<Value>();
        let agents = hello["agents"].as_array().cloned().unwrap_or_default();
        for a in &agents {
            let Some(id) = a["id"].as_str() else { continue };
            self.hub.register_agent(AgentHandle {
                agent_id: id.to_string(),
                agent_name: a["name"].as_str().unwrap_or(id).to_string(),
                requires_mention: a["requires_mention"].as_bool().unwrap_or(false),
                bot_loop_limit: agent_bot_loop_limit(&a["bot_loop_limit"]),
                wants_context_feed: a["wants_context_feed"].as_bool().unwrap_or(false),
                has_avatar: a["has_avatar"].as_bool().unwrap_or(false),
                avatar_v: a["avatar_v"].as_i64().unwrap_or(0),
                source: name.to_string(),
                conn_id,
                tx: tx.clone(),
            });
            if let Some((accent, openai, groq)) = crate::config::parse_agent_hello_tts(a) {
                self.hub.store.update_agent_tts(id, &accent, &openai, &groq);
            }
        }
        self.set_status(name, |s| {
            s.connected = true;
            s.agents = agents.clone();
            s.last_error = None;
        });
        tracing::info!("connection {name}: linked, {} agent(s)", agents.len());

        // Writer task: owns the sink and is the *only* thing that touches it,
        // so a slow or large send never parks the read loop below — the loop
        // that answers the peer's keepalive pings. (It also drives our own 30s
        // keepalive ping, which for the same reason must not wait behind a
        // send.) A parked read loop would stall pongs long enough for the peer
        // to declare a healthy link dead and reconnect — the churn we're fixing.
        let mut writer = tokio::spawn(async move {
            let mut ping = tokio::time::interval(Duration::from_secs(30));
            loop {
                tokio::select! {
                    out = rx.recv() => {
                        match out {
                            Some(frame) => {
                                if sink.send(Message::Text(frame.to_string().into())).await.is_err() {
                                    break;
                                }
                            }
                            None => break,
                        }
                    }
                    _ = ping.tick() => {
                        if sink.send(Message::Ping(Vec::new().into())).await.is_err() {
                            break;
                        }
                    }
                }
            }
        });

        // Pump: socket -> hub (post/typing/progress). Outbound and keepalive
        // now live on the writer task above.
        let result = loop {
            tokio::select! {
                // Writer stopped (send failed / channel closed): treat as a
                // normal disconnect and let the outer loop reconnect.
                _ = &mut writer => break Ok(()),
                incoming = stream.next() => {
                    match incoming {
                        Some(Ok(Message::Text(text))) => {
                            if let Ok(frame) = serde_json::from_str::<Value>(&text) {
                                if frame["type"] == "hello" {
                                    // Roster refresh mid-connection.
                                    for a in frame["agents"].as_array().cloned().unwrap_or_default() {
                                        let Some(id) = a["id"].as_str() else { continue };
                                        self.hub.register_agent(AgentHandle {
                                            agent_id: id.to_string(),
                                            agent_name: a["name"].as_str().unwrap_or(id).to_string(),
                                            requires_mention: a["requires_mention"].as_bool().unwrap_or(false),
                                            bot_loop_limit: agent_bot_loop_limit(&a["bot_loop_limit"]),
                                            wants_context_feed: a["wants_context_feed"].as_bool().unwrap_or(false),
                                            has_avatar: a["has_avatar"].as_bool().unwrap_or(false),
                                            avatar_v: a["avatar_v"].as_i64().unwrap_or(0),
                                            source: name.to_string(),
                                            conn_id,
                                            tx: tx.clone(),
                                        });
                                        if let Some((accent, openai, groq)) =
                                            crate::config::parse_agent_hello_tts(&a)
                                        {
                                            self.hub.store.update_agent_tts(
                                                id, &accent, &openai, &groq,
                                            );
                                        }
                                    }
                                } else {
                                    // Operator-configured outbound peers are trusted and
                                    // deliberately bypass the public dial-in upload limiter.
                                    self.hub.handle_agent_frame_from(conn_id, &frame);
                                }
                            }
                        }
                        Some(Ok(Message::Close(_))) | None => break Ok(()),
                        Some(Ok(_)) => {}
                        Some(Err(e)) => break Err(e.into()),
                    }
                }
            }
        };
        writer.abort();
        self.hub.unregister_connection(conn_id);
        self.set_status(name, |s| {
            s.connected = false;
            s.agents = Vec::new();
        });
        result
    }
}

/// Build the `hello` frame an Agora endpoint sends after accepting a
/// connection (used by tests and by the dial-in handler documentation).
pub fn hello_frame(agents: &[Value]) -> Value {
    json!({"type": "hello", "agents": agents})
}
