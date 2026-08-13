//! Agora desktop: a Tauri shell that fronts either server.
//!
//! Two modes, chosen in `desktop.json` (see [`settings`]):
//! - **embedded** (default): boot agora-core in-process on loopback and point
//!   the window at it — identical to the headless deployment, so the UI code
//!   has exactly one environment.
//! - **remote**: skip the local hub entirely and point the window at a
//!   deployed agora-server (the bundled `connect.html` page validates the
//!   URL + admin key and flips modes).
//!
//! In embedded mode the hub must outlive the window: agents reply
//! asynchronously and their messages land in this process's database. So
//! closing the window only hides it (the app keeps running in the dock;
//! clicking the icon reopens it) and Cmd-Q is the real quit.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(target_os = "linux")]
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex, OnceLock};

use tauri::menu::{Menu, SubmenuBuilder};
use tauri::path::BaseDirectory;
#[cfg(target_os = "linux")]
use tauri::{
    menu::{MenuBuilder, MenuItemBuilder},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
};
use tauri::{AppHandle, Manager, Url, WebviewUrl, WebviewWindowBuilder, WindowEvent};
#[cfg(not(target_os = "macos"))]
use tauri_plugin_notification::NotificationExt;

mod google_login;
#[cfg(target_os = "macos")]
mod notify;
mod remote_notify;
mod settings;
#[cfg(feature = "updater")]
mod updater;

use settings::{DesktopSettings, Mode};

/// The public project website, reachable from the Server menu.
const WEBSITE_URL: &str = "https://agora.kite.space";

/// The embedded hub, once the core is up — the window-event handler flips
/// its ui_active flag so unseen messages notify only while unfocused.
static HUB: OnceLock<Arc<agora_core::hub::Hub>> = OnceLock::new();

/// The embedded server, booted at most once per process.
static EMBEDDED: tokio::sync::OnceCell<Embedded> = tokio::sync::OnceCell::const_new();

/// The remote-mode notifier task, if one is running. Replaced (old one
/// aborted) on every mode/settings change so at most one socket is live.
static REMOTE_NOTIFIER: Mutex<Option<tauri::async_runtime::JoinHandle<()>>> = Mutex::new(None);

/// The destination used to create or navigate the main window most recently.
/// Linux relaunch/tray recovery can rebuild a window that disappeared during
/// startup or was destroyed by the desktop environment.
static LAST_MAIN_URL: Mutex<Option<Url>> = Mutex::new(None);

/// Linux has no dock-reopen event. Only hide on close after the tray was
/// created successfully; otherwise closing must terminate the process so it
/// cannot become an unreachable background server.
#[cfg(target_os = "linux")]
static LINUX_TRAY_READY: AtomicBool = AtomicBool::new(false);

/// Explain the background lifecycle once, without notifying on every close.
#[cfg(target_os = "linux")]
static LINUX_TRAY_CLOSE_NOTIFIED: AtomicBool = AtomicBool::new(false);

struct Embedded {
    addr: std::net::SocketAddr,
    token: String,
}

impl Embedded {
    fn url(&self) -> Url {
        // A wildcard bind (0.0.0.0, set to let phones on the LAN in) is not a
        // routable destination — the webview must dial loopback instead.
        let mut addr = self.addr;
        if addr.ip().is_unspecified() {
            addr.set_ip(std::net::IpAddr::V4(std::net::Ipv4Addr::LOCALHOST));
        }
        format!("http://{}/?token={}", addr, self.token)
            .parse()
            .expect("valid loopback url")
    }
}

fn main() {
    // Load-bearing: GTK/WebKit initialization begins with the Tauri builder,
    // so the WSL renderer override must be configured before anything else.
    configure_wsl_webview();

    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .init();

    let builder = tauri::Builder::default();
    // Linux lacks macOS LaunchServices/Reopen. A second launch must focus the
    // hidden window instead of opening the database in another process.
    #[cfg(target_os = "linux")]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
        show_main(app)
    }));
    #[cfg(feature = "updater")]
    let builder = builder
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_dialog::init());
    builder
        .plugin(tauri_plugin_notification::init())
        // target="_blank" links in the UI open in the system browser instead
        // of dying inside the webview (see capabilities/remote.json).
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            get_server_settings,
            set_server_settings,
            connect_remote,
            open_current_server,
            google_sign_in,
            probe_server,
            forget_recent_server
        ])
        .menu(|handle| {
            let menu = Menu::default(handle)?;
            let server = SubmenuBuilder::new(handle, "Server")
                .text("server-settings", "Server Settings…")
                .separator()
                .text("sign-out", "Sign Out")
                .separator()
                .text("website", "Agora Website");
            // "Check for Updates…" follows the macOS (Sparkle) convention:
            // it lives in the app menu, right under "About Agora". Elsewhere
            // there is no app menu, so it rides in the Server submenu.
            #[cfg(all(feature = "updater", not(target_os = "macos")))]
            let updates_available = direct_updates_available();
            #[cfg(all(feature = "updater", not(target_os = "macos")))]
            let server = if updates_available {
                server
                    .separator()
                    .text("check-updates", "Check for Updates…")
            } else {
                server
            };
            menu.append(&server.build()?)?;
            #[cfg(all(feature = "updater", target_os = "macos"))]
            if let Some(tauri::menu::MenuItemKind::Submenu(app_menu)) = menu.items()?.first() {
                app_menu.insert(
                    &tauri::menu::MenuItem::with_id(
                        handle,
                        "check-updates",
                        "Check for Updates…",
                        true,
                        None::<&str>,
                    )?,
                    1,
                )?;
            }
            Ok(menu)
        })
        .on_menu_event(|app, event| match event.id().as_ref() {
            "server-settings" => open_main(app, connect_page_url(true)),
            "sign-out" => sign_out(app),
            "website" => {
                let _ = tauri_plugin_opener::open_url(WEBSITE_URL, None::<&str>);
            }
            #[cfg(feature = "updater")]
            "check-updates" => {
                let handle = app.clone();
                tauri::async_runtime::spawn(updater::check_from_menu(handle));
            }
            _ => {}
        })
        .on_window_event(|window, event| {
            match event {
                WindowEvent::Focused(focused) => {
                    remote_notify::UI_FOCUSED.store(*focused, Ordering::Relaxed);
                    if let Some(hub) = HUB.get() {
                        hub.set_ui_active(*focused);
                    }
                }
                // Close = hide: agents keep processing and replies keep
                // landing (and notifying) while the window is away.
                WindowEvent::CloseRequested { api, .. } => {
                    #[cfg(target_os = "linux")]
                    if !LINUX_TRAY_READY.load(Ordering::Relaxed) {
                        window.app_handle().exit(0);
                        return;
                    }
                    #[cfg(target_os = "linux")]
                    if !LINUX_TRAY_CLOSE_NOTIFIED.swap(true, Ordering::Relaxed) {
                        deliver_notification(
                            window.app_handle(),
                            "Agora is still running",
                            "Reopen it from the tray or launch Agora again. Use Quit Agora from the tray menu to stop it.",
                        );
                    }
                    api.prevent_close();
                    let _ = window.hide();
                    remote_notify::UI_FOCUSED.store(false, Ordering::Relaxed);
                    if let Some(hub) = HUB.get() {
                        hub.set_ui_active(false);
                    }
                }
                _ => {}
            }
        })
        .setup(|app| {
            // macOS banners require the modern UserNotifications framework,
            // which in turn requires a stably signed bundle (see notify.rs).
            // First launch pops the system "allow notifications?" prompt.
            #[cfg(target_os = "macos")]
            notify::request_authorization();
            #[cfg(target_os = "linux")]
            setup_linux_tray(app);
            let handle = app.handle().clone();
            let data_dir = app.path().app_data_dir()?;
            let desktop = settings::load(&data_dir);
            sync_remote_notifier(&handle, &desktop);
            // Background update check; quiet unless something was installed.
            #[cfg(feature = "updater")]
            {
                if direct_updates_available() {
                    let update_handle = app.handle().clone();
                    tauri::async_runtime::spawn(async move {
                        let notify_handle = update_handle.clone();
                        updater::check_on_startup(update_handle, move |title, body| {
                            deliver_notification(&notify_handle, title, body);
                        })
                        .await;
                    });
                }
            }
            tauri::async_runtime::spawn(async move {
                match desktop.mode {
                    // Remote: open the connect page; it validates the stored
                    // URL/token (via the connect_remote command) and navigates.
                    Mode::Remote => open_main(&handle, connect_page_url(false)),
                    Mode::Embedded => match ensure_embedded(&handle).await {
                        Ok(embedded) => open_main(&handle, embedded.url()),
                        Err(e) => {
                            tracing::error!("agora core failed to start: {e}");
                            handle.exit(1);
                        }
                    },
                }
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Agora")
        .run(|_app, event| match event {
            // Keep running with zero visible windows (background hub);
            // an explicit quit (Cmd-Q / dock menu) carries an exit code.
            tauri::RunEvent::ExitRequested { api, code, .. } => {
                if code.is_none() {
                    api.prevent_exit();
                }
            }
            // Dock icon click while hidden: bring the window back.
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Reopen { .. } => {
                if let Some(window) = _app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
            _ => {}
        });
}

/// AppImage is the only Linux package that the direct updater may replace.
/// Debian packages remain owned by dpkg and update through their distributor.
#[cfg(feature = "updater")]
fn direct_updates_available() -> bool {
    direct_updates_available_for(
        cfg!(target_os = "linux"),
        std::env::var_os("APPIMAGE").is_some(),
    )
}

#[cfg(feature = "updater")]
fn direct_updates_available_for(is_linux: bool, is_appimage: bool) -> bool {
    !is_linux || is_appimage
}

/// WSLg's WebKit renderer can open a blank window when DMA-BUF import is not
/// available. Respect an explicit user choice and otherwise select the stable
/// renderer before GTK/WebKit is initialized.
fn configure_wsl_webview() {
    #[cfg(target_os = "linux")]
    if should_disable_dmabuf_renderer(
        std::fs::read_to_string("/proc/sys/kernel/osrelease")
            .ok()
            .as_deref(),
        std::env::var_os("WSL_DISTRO_NAME").is_some()
            || std::env::var_os("WSL_INTEROP").is_some(),
        std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_some(),
    ) {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }
}

#[cfg(any(target_os = "linux", test))]
fn should_disable_dmabuf_renderer(
    osrelease: Option<&str>,
    wsl_environment: bool,
    already_configured: bool,
) -> bool {
    !already_configured
        && (wsl_environment
            || osrelease.is_some_and(|release| release.to_ascii_lowercase().contains("microsoft")))
}

#[cfg(target_os = "linux")]
fn setup_linux_tray(app: &mut tauri::App) {
    let show = MenuItemBuilder::with_id("tray-show", "Open Agora").build(app);
    let settings = MenuItemBuilder::with_id("tray-settings", "Server Settings…").build(app);
    let quit = MenuItemBuilder::with_id("tray-quit", "Quit Agora").build(app);
    let result = show
        .and_then(|show| settings.map(|settings| (show, settings)))
        .and_then(|(show, settings)| quit.map(|quit| (show, settings, quit)))
        .and_then(|(show, settings, quit)| {
            MenuBuilder::new(app)
                .items(&[&show, &settings, &quit])
                .build()
        })
        .and_then(|menu| {
            let mut tray = TrayIconBuilder::new()
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "tray-show" => show_main(app),
                    "tray-settings" => open_main(app, connect_page_url(true)),
                    "tray-quit" => app.exit(0),
                    _ => {}
                })
                // Current Linux backends do not reliably deliver left-click
                // events; the tray menu is the primary recovery path.
                .on_tray_icon_event(|tray, event| {
                    if matches!(
                        event,
                        TrayIconEvent::Click {
                            button: MouseButton::Left,
                            button_state: MouseButtonState::Up,
                            ..
                        }
                    ) {
                        show_main(tray.app_handle());
                    }
                });
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            } else {
                tracing::warn!("default window icon unavailable; tray may render without an icon");
            }
            tray.build(app).map(|_| ())
        });
    match result {
        Ok(()) => LINUX_TRAY_READY.store(true, Ordering::Relaxed),
        Err(e) => tracing::warn!("system tray unavailable; close will quit Agora: {e}"),
    }
}

#[cfg(target_os = "linux")]
fn show_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
        return;
    }
    let last_url = LAST_MAIN_URL.lock().unwrap().clone();
    if let Some(url) = last_url {
        open_main(app, url);
    } else {
        tracing::warn!("main window cannot be restored before its initial URL is available");
    }
}

// ------------------------------------------------------------ embedded core

/// Boot the embedded server exactly once and return its address + token.
async fn ensure_embedded(handle: &AppHandle) -> anyhow::Result<&'static Embedded> {
    let handle = handle.clone();
    EMBEDDED
        .get_or_try_init(|| async move {
            let data_dir = handle.path().app_data_dir()?;
            // Bundled UI: <bundle>/Resources/ui in a build (tauri copies
            // web/dist there); the repo's web/dist in dev (`npm run build`).
            let ui_dir = handle
                .path()
                .resolve("ui", BaseDirectory::Resource)
                .ok()
                .filter(|p| p.join("index.html").exists())
                .or_else(|| {
                    let dev =
                        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../web/dist");
                    dev.join("index.html").exists().then_some(dev)
                });
            let core = agora_core::run(data_dir, ui_dir).await?;
            // New messages landing while the window is unfocused (i.e.
            // unseen) surface as native notifications.
            let _ = HUB.set(Arc::clone(&core.state.hub));
            #[cfg(target_os = "macos")]
            core.state.hub.set_notifier(|ev| {
                notify::notify(&ev);
            });
            #[cfg(target_os = "macos")]
            core.state.hub.set_read_notifier(|ev| notify::clear_read(&ev));
            #[cfg(not(target_os = "macos"))]
            {
                let notify_handle = handle.clone();
                core.state.hub.set_notifier(move |ev| {
                    let result = notify_handle
                        .notification()
                        .builder()
                        .title(&ev.title)
                        .body(&ev.body)
                        .show();
                    if let Err(e) = result {
                        tracing::warn!("notification failed: {e}");
                    }
                });
            }
            // A staged data import restarts the app to apply it at boot.
            let restart_handle = handle.clone();
            *core.state.restart_handler.lock().unwrap() = Some(Box::new(move || {
                restart_handle.restart();
            }));
            Ok(Embedded {
                addr: core.addr,
                token: core.state.config.admin_key(),
            })
        })
        .await
}

// ----------------------------------------------------------------- commands

#[tauri::command]
fn get_server_settings(app: AppHandle) -> Result<DesktopSettings, String> {
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(settings::load(&data_dir))
}

/// Persist the chosen mode and navigate the window to it. Remote settings
/// are validated against the server before anything is saved.
#[tauri::command]
async fn set_server_settings(app: AppHandle, settings: DesktopSettings) -> Result<(), String> {
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    // The recent-servers list is owned by this side: re-merge it from disk so
    // the webview payload (which never carries it) can't clobber the history.
    let mut settings = settings;
    settings.recent = settings::load(&data_dir).recent;
    match settings.mode {
        Mode::Remote => {
            let url = settings
                .remote_url()
                .ok_or("Server URL and admin key are both required")?;
            validate_remote(&settings).await?;
            if let Some(base) = settings.url.clone() {
                settings.remember(&base);
            }
            settings::save(&data_dir, &settings).map_err(|e| e.to_string())?;
            open_main(&app, url.parse().map_err(|_| "Invalid server URL")?);
        }
        Mode::Embedded => {
            settings::save(&data_dir, &settings).map_err(|e| e.to_string())?;
            let embedded = ensure_embedded(&app)
                .await
                .map_err(|e| format!("embedded server failed to start: {e}"))?;
            open_main(&app, embedded.url());
        }
    }
    sync_remote_notifier(&app, &settings);
    Ok(())
}

/// Validate the stored remote settings and navigate to the server on
/// success. The connect page calls this on load in remote mode.
#[tauri::command]
async fn connect_remote(app: AppHandle) -> Result<(), String> {
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let mut stored = settings::load(&data_dir);
    let url = stored
        .remote_url()
        .ok_or("No remote server configured yet")?;
    validate_remote(&stored).await?;
    // Refresh the history too — installs that predate the recent list pick
    // up their current server on the first successful reconnect.
    if let Some(base) = stored.url.clone() {
        stored.remember(&base);
        if let Err(e) = settings::save(&data_dir, &stored) {
            tracing::warn!("failed to record recent server: {e}");
        }
    }
    open_main(&app, url.parse().map_err(|_| "Invalid server URL")?);
    sync_remote_notifier(&app, &stored);
    Ok(())
}

/// Leave the settings page without changing anything: navigate back to
/// whatever server the saved settings point at.
#[tauri::command]
async fn open_current_server(app: AppHandle) -> Result<(), String> {
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let stored = settings::load(&data_dir);
    match (stored.mode, stored.remote_url()) {
        (Mode::Remote, Some(url)) => {
            open_main(&app, url.parse().map_err(|_| "Invalid server URL")?);
        }
        _ => {
            let embedded = ensure_embedded(&app)
                .await
                .map_err(|e| format!("embedded server failed to start: {e}"))?;
            open_main(&app, embedded.url());
        }
    }
    sync_remote_notifier(&app, &stored);
    Ok(())
}

/// Menu sign-out. Remote mode: drop the stored session/admin key (the
/// server URL stays, so the connect page lands on its sign-in step) and stop
/// the notifier socket that was using it. Embedded mode has no credential to
/// drop — the local admin key *is* the server — so just open the picker.
fn sign_out(app: &AppHandle) {
    let Ok(data_dir) = app.path().app_data_dir() else {
        return;
    };
    let mut stored = settings::load(&data_dir);
    match stored.mode {
        Mode::Remote => {
            stored.token = None;
            if let Err(e) = settings::save(&data_dir, &stored) {
                tracing::warn!("sign-out failed to save settings: {e}");
                return;
            }
            sync_remote_notifier(app, &stored);
            open_main(app, connect_page_url(false));
        }
        Mode::Embedded => open_main(app, connect_page_url(true)),
    }
}

/// What sign-in methods a server offers. The connect page calls this before
/// showing its sign-in step (the webview can't fetch a remote origin itself —
/// CORS). Unreachable hosts are an Err; a reachable host that doesn't answer
/// the probe as expected still allows admin-key sign-in.
#[tauri::command]
async fn probe_server(url: String) -> Result<serde_json::Value, String> {
    let base = url.trim().trim_end_matches('/').to_string();
    if !base.starts_with("http://") && !base.starts_with("https://") {
        return Err("Server URL must start with http:// or https://".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let response = ureq::get(&format!("{base}/api/auth/config"))
            .timeout(std::time::Duration::from_secs(10))
            .call();
        match response {
            Ok(r) => {
                let config = r
                    .into_string()
                    .ok()
                    .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok());
                let google = config
                    .as_ref()
                    .is_some_and(|v| v["google"]["enabled"] == serde_json::Value::Bool(true));
                // Older servers omit admin and must keep the key form visible.
                let admin = config
                    .as_ref()
                    .and_then(|v| v["admin"]["enabled"].as_bool())
                    .unwrap_or(true);
                Ok(serde_json::json!({"google": google, "admin": admin}))
            }
            Err(ureq::Error::Status(_, _)) => {
                Ok(serde_json::json!({"google": false, "admin": true}))
            }
            Err(e) => Err(format!("Could not reach the server: {e}")),
        }
    })
    .await
    .map_err(|_| "probe task failed".to_string())?
}

/// Google sign-in against a remote server: run the loopback OAuth dance in
/// the system browser, then persist the returned session token exactly like
/// a pasted admin key (remote mode) and navigate to the server.
#[tauri::command]
async fn google_sign_in(
    app: AppHandle,
    url: String,
    select_account: Option<bool>,
) -> Result<(), String> {
    let base = url.trim().trim_end_matches('/').to_string();
    if !base.starts_with("http://") && !base.starts_with("https://") {
        return Err("Server URL must start with http:// or https://".into());
    }
    let token = google_login::run_flow(base.clone(), select_account.unwrap_or(false)).await?;
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let mut settings = DesktopSettings {
        mode: Mode::Remote,
        url: Some(base.clone()),
        token: Some(token),
        recent: settings::load(&data_dir).recent,
    };
    validate_remote(&settings).await?;
    settings.remember(&base);
    settings::save(&data_dir, &settings).map_err(|e| e.to_string())?;
    let url = settings.remote_url().ok_or("sign-in produced no session")?;
    open_main(&app, url.parse().map_err(|_| "Invalid server URL")?);
    sync_remote_notifier(&app, &settings);
    Ok(())
}

/// Remove one entry from the previously-joined-servers list and return the
/// updated list, so the connect page can re-render without a reload.
#[tauri::command]
fn forget_recent_server(app: AppHandle, url: String) -> Result<Vec<String>, String> {
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let mut stored = settings::load(&data_dir);
    stored.forget(&url);
    settings::save(&data_dir, &stored).map_err(|e| e.to_string())?;
    Ok(stored.recent)
}

/// GET /api/me with the admin key; distinguishes bad-token from unreachable.
async fn validate_remote(settings: &DesktopSettings) -> Result<(), String> {
    let base = settings
        .url
        .as_deref()
        .unwrap_or_default()
        .trim_end_matches('/')
        .to_string();
    if !base.starts_with("http://") && !base.starts_with("https://") {
        return Err("Server URL must start with http:// or https://".into());
    }
    let token = settings.token.clone().unwrap_or_default();
    tauri::async_runtime::spawn_blocking(move || {
        let response = ureq::get(&format!("{base}/api/me"))
            .set("authorization", &format!("Bearer {token}"))
            .timeout(std::time::Duration::from_secs(10))
            .call();
        match response {
            Ok(_) => Ok(()),
            Err(ureq::Error::Status(401, _)) => Err("The server rejected that admin key".into()),
            Err(ureq::Error::Status(code, _)) => Err(format!(
                "Server responded with HTTP {code} — is that an Agora server?"
            )),
            Err(e) => Err(format!("Could not reach the server: {e}")),
        }
    })
    .await
    .map_err(|_| "validation task failed".to_string())?
}

// ------------------------------------------------------------ notifications

/// Deliver a banner through the platform path (shared with embedded mode).
#[cfg_attr(target_os = "macos", allow(unused_variables))]
fn deliver_notification(handle: &AppHandle, title: &str, body: &str) {
    #[cfg(target_os = "macos")]
    notify::notify_untracked(title, body);
    #[cfg(not(target_os = "macos"))]
    {
        let result = handle
            .notification()
            .builder()
            .title(title)
            .body(body)
            .show();
        if let Err(e) = result {
            tracing::warn!("notification failed: {e}");
        }
    }
}

/// Reconcile the remote-notifier task with the given settings: the old task
/// (if any) is aborted, and a fresh one starts iff we're in remote mode with
/// a full URL + token. Embedded mode keeps using the in-process hub notifier.
fn sync_remote_notifier(_handle: &AppHandle, settings: &DesktopSettings) {
    let mut guard = REMOTE_NOTIFIER.lock().unwrap();
    if let Some(task) = guard.take() {
        task.abort();
    }
    if settings.mode != Mode::Remote || settings.remote_url().is_none() {
        return;
    }
    let (url, token) = (
        settings
            .url
            .clone()
            .unwrap_or_default()
            .trim_end_matches('/')
            .to_string(),
        settings.token.clone().unwrap_or_default(),
    );
    #[cfg(not(target_os = "macos"))]
    let notify_handle = _handle.clone();
    let deliver: remote_notify::Deliver = Arc::new(move |event| {
        #[cfg(target_os = "macos")]
        notify::notify(&agora_core::hub::NotifyEvent {
            channel_id: event.channel_id,
            thread_id: event.thread_id,
            message_id: event.message_id,
            title: event.title,
            body: event.body,
        });
        #[cfg(not(target_os = "macos"))]
        deliver_notification(&notify_handle, &event.title, &event.body);
    });
    let clear: remote_notify::Clear = Arc::new(move |event| {
        #[cfg(target_os = "macos")]
        notify::clear_read(&event);
        #[cfg(not(target_os = "macos"))]
        let _ = event;
    });
    *guard = Some(tauri::async_runtime::spawn(remote_notify::run(
        deliver, clear, url, token,
    )));
}

// ------------------------------------------------------------------- window

/// Navigate the main window (creating it if needed) to the given URL.
fn open_main(handle: &AppHandle, url: Url) {
    *LAST_MAIN_URL.lock().unwrap() = Some(url.clone());
    if let Some(window) = handle.get_webview_window("main") {
        let _ = window.navigate(url);
        let _ = window.show();
        let _ = window.set_focus();
        return;
    }
    let webview_url = match url.scheme() {
        "http" | "https" => WebviewUrl::External(url),
        _ => WebviewUrl::CustomProtocol(url),
    };
    let result = WebviewWindowBuilder::new(handle, "main", webview_url)
        .title("Agora")
        .inner_size(1240.0, 840.0)
        .min_inner_size(480.0, 400.0)
        // Tauri's native drag-drop handler swallows OS file drops before the
        // webview sees them; the UI relies on HTML5 ondrop, so turn it off.
        .disable_drag_drop_handler()
        .build();
    if let Err(e) = result {
        tracing::error!("window failed: {e}");
    }
}

/// The bundled connect page, on the platform's app protocol. `edit` skips
/// the auto-connect and goes straight to the form.
fn connect_page_url(edit: bool) -> Url {
    let base = if cfg!(any(target_os = "windows", target_os = "android")) {
        "http://tauri.localhost/connect.html"
    } else {
        "tauri://localhost/connect.html"
    };
    let full = if edit {
        format!("{base}?edit=1")
    } else {
        base.to_string()
    };
    full.parse().expect("valid app url")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wsl_renderer_workaround_is_narrow_and_respects_override() {
        assert!(should_disable_dmabuf_renderer(
            Some("5.15.153.1-microsoft-standard-WSL2"),
            false,
            false
        ));
        assert!(!should_disable_dmabuf_renderer(
            Some("6.8.0-generic"),
            false,
            false
        ));
        assert!(!should_disable_dmabuf_renderer(
            Some("5.15.153.1-Microsoft-standard-WSL2"),
            false,
            true
        ));
        assert!(!should_disable_dmabuf_renderer(None, false, false));
        assert!(should_disable_dmabuf_renderer(None, true, false));
        assert!(!should_disable_dmabuf_renderer(None, true, true));
    }

    #[cfg(feature = "updater")]
    #[test]
    fn direct_updates_are_appimage_only_on_linux() {
        assert!(direct_updates_available_for(false, false));
        assert!(direct_updates_available_for(true, true));
        assert!(!direct_updates_available_for(true, false));
    }
}
