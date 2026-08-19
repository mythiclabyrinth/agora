//! agora-core: the embeddable Agora hub.
//!
//! One crate, two consumers: the Tauri desktop app embeds it in-process, and
//! `agora-server` runs it headless (for a VPS, so mobile clients can reach
//! agents 24/7). Everything — store, hub, HTTP/WS API, outbound connections,
//! bundled UI — lives behind [`run`].

pub mod ai;
pub mod artifacts;
mod attachments;
pub mod auth;
pub mod codex_oauth;
pub mod config;
pub mod connections;
pub mod hub;
pub mod migrate;
pub mod push;
pub mod server;
pub mod sources;
pub mod store;
pub mod unfurl;
pub mod voice;

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;

pub struct App {
    pub state: server::AppState,
    pub addr: SocketAddr,
}

/// Multi-user boot migration: a database without accounts gets one for the
/// configured (formerly single) username, as instance admin, keyed to the
/// first allowlisted sign-in email when there is one. All existing state
/// (memberships, reads, stars, authored messages) is already keyed by that
/// username, so it carries over untouched.
pub fn bootstrap_admin_user(config: &config::Config, store: &store::Store) {
    let username = config.username();
    if store.list_users().is_empty() {
        let snapshot = config.snapshot();
        let email = snapshot
            .google_allowed_emails
            .iter()
            .chain(snapshot.apple_allowed_emails.iter())
            .map(|e| e.trim().to_lowercase())
            // Wildcard entries (`*`, `*@domain`) open sign-up but name nobody
            // in particular — they can't be the admin's account email.
            .find(|e| !e.is_empty() && !e.contains('*'));
        store.create_user(&username, &username, email.as_deref(), "admin");
        // Device tokens registered before accounts existed belonged to the one
        // user this instance had — keep their pushes flowing under the new owner.
        store.claim_unowned_push_tokens(&username);
        tracing::info!("bootstrapped instance admin account '{username}'");
    }
    // Sidebar hidden/order used to be instance-global columns; copy them to
    // the migrated admin's personal prefs once, so their sidebar is unchanged.
    // (No-op after the first boot, and for accounts created post-migration.)
    if store.user(&username).is_some() {
        store.seed_prefs_from_globals(&username);
    }
}

/// Build the full application state from a data dir and start serving.
/// Returns once the listener is bound; serving continues in the background.
pub async fn run(data_dir: PathBuf, ui_dir: Option<PathBuf>) -> anyhow::Result<App> {
    std::fs::create_dir_all(&data_dir)?;
    // Migration hooks run before anything opens the db: a staged import
    // replaces the current data, AGORA_IMPORT_URL seeds a fresh dir.
    migrate::apply_staged_import(&data_dir)?;
    migrate::seed_from_env(&data_dir)?;

    let config = Arc::new(config::Config::load(&data_dir)?);
    let snapshot = config.snapshot();
    let store = Arc::new(store::Store::open(&data_dir.join("agora.db"))?);
    bootstrap_admin_user(&config, &store);
    let hub = Arc::new(hub::Hub::new_with_attachment_limit(
        store,
        attachments::effective_agent_file_limit(
            snapshot.max_file_mb as usize * 1024 * 1024,
        ),
    ));
    // Link previews are fetched off the post path: posts queue their message
    // id here; the worker fetches behind SSRF guards and answers with a
    // `message_update` broadcast when metadata lands.
    hub.set_unfurler(unfurl::spawn_worker(Arc::clone(&hub)));
    let connections = connections::ConnectionManager::new(Arc::clone(&hub), Arc::clone(&config));
    connections.sync();

    let (auth_limiter, upload_limiter) = server::AppState::default_limiters();
    let state = server::AppState {
        hub,
        config,
        connections,
        ui_dir,
        data_dir,
        restart_handler: Arc::new(std::sync::Mutex::new(None)),
        speech_cache: Arc::new(std::sync::Mutex::new(Vec::new())),
        codex_oauth: Arc::new(std::sync::Mutex::new(None)),
        codex_models_cache: Arc::new(std::sync::Mutex::new(None)),
        codex_models_refresh_inflight: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        auth_limiter,
        upload_limiter,
    };
    let app = server::router(state.clone());
    let addr: SocketAddr = format!("{}:{}", snapshot.bind, snapshot.port).parse()?;
    let listener = match tokio::net::TcpListener::bind(addr).await {
        Ok(l) => l,
        // Configured port taken (another instance, or an unrelated app):
        // fall back to an ephemeral port instead of refusing to launch. The
        // UI navigates to the *bound* address, so everything still works;
        // only dial-in bridges pinned to the old port need the real one back.
        Err(e) if e.kind() == std::io::ErrorKind::AddrInUse => {
            tracing::warn!("port {} in use, falling back to an ephemeral port", snapshot.port);
            tokio::net::TcpListener::bind(format!("{}:0", snapshot.bind).parse::<SocketAddr>()?)
                .await?
        }
        Err(e) => return Err(e.into()),
    };
    let bound = listener.local_addr()?;
    // A non-loopback bind exposes the API (owner-token gated, but still) on the
    // network with no TLS of its own — it must sit behind a firewall and a TLS
    // reverse proxy. Loopback has no wire to sniff, so stay quiet there.
    if !bound.ip().is_loopback() {
        tracing::warn!(
            "Agora is bound to {bound} (not loopback): reachable off-host in cleartext. \
             Put it behind a firewall and a TLS reverse proxy (see docs/DEPLOYMENT.md)."
        );
    }
    tokio::spawn(async move {
        // ConnectInfo carries the client IP to the rate limiter; Option<_> in
        // the handlers keeps it working when a transport doesn't supply it.
        let service = app.into_make_service_with_connect_info::<SocketAddr>();
        if let Err(e) = axum::serve(listener, service).await {
            tracing::error!("server stopped: {e}");
        }
    });
    tracing::info!("Agora listening on http://{bound}");
    Ok(App { state, addr: bound })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bootstrap_creates_admin_once_and_keeps_existing_accounts() {
        let dir = tempfile::tempdir().unwrap();
        let config = config::Config::load(dir.path()).unwrap();
        config.update(|c| {
            c.google_allowed_emails = vec!["Me@Example.com".into()];
        });
        let store = store::Store::open_in_memory().unwrap();
        store.upsert_push_token("", "ExponentPushToken[old]", "ios");

        // Fresh database: the configured single user becomes the instance
        // admin, keyed to the (normalized) allowlisted email.
        bootstrap_admin_user(&config, &store);
        let users = store.list_users();
        assert_eq!(users.len(), 1);
        assert_eq!(users[0]["username"], config.username());
        assert_eq!(users[0]["instance_role"], "admin");
        assert_eq!(users[0]["email"], "me@example.com");
        // Pre-account device tokens now belong to the migrated admin: an
        // admin sees every channel, so their pushes keep flowing.
        assert_eq!(
            store.push_tokens_for_channel(
                store
                    .create_channel(
                        store.create_group("G", "", None)["id"].as_str().unwrap(),
                        "c",
                        ""
                    )["id"]
                    .as_str()
                    .unwrap(),
                None,
            ),
            vec!["ExponentPushToken[old]".to_string()]
        );

        // Idempotent: a database that has accounts is left alone.
        bootstrap_admin_user(&config, &store);
        assert_eq!(store.list_users().len(), 1);

        let populated = store::Store::open_in_memory().unwrap();
        populated.create_user("ana", "Ana", Some("ana@x.io"), "member").unwrap();
        bootstrap_admin_user(&config, &populated);
        assert_eq!(populated.list_users().len(), 1);
        assert_eq!(populated.list_users()[0]["username"], "ana");
    }

    #[test]
    fn bootstrap_skips_wildcard_allowlist_entries() {
        let dir = tempfile::tempdir().unwrap();
        let config = config::Config::load(dir.path()).unwrap();
        config.update(|c| {
            c.google_allowed_emails = vec!["*".into(), "*@example.com".into()];
        });
        let store = store::Store::open_in_memory().unwrap();
        bootstrap_admin_user(&config, &store);
        // Wildcards admit anyone but name nobody: the admin gets no email.
        assert_eq!(store.list_users()[0]["email"], serde_json::Value::Null);
    }
}
