//! App configuration persisted as `config.json` in the data dir.
//!
//! The admin key authenticates the (single) local user's UI/API calls; it
//! is generated on first run. Pairing tokens authenticate dial-in agent
//! bridges. Connections are the Pantheo (or compatible) endpoints the app
//! dials out to.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::store::new_token;

#[derive(Clone, Serialize, Deserialize)]
pub struct Connection {
    pub name: String,
    /// ws(s)://host:port/agora/connect
    pub url: String,
    pub token: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct PairingToken {
    /// Stable non-secret identity used to associate remembered agents with
    /// this credential. The bearer token remains authentication-only.
    #[serde(default)]
    pub id: String,
    pub token: String,
    pub name: String,
    /// UI hint for the CLI/integration this credential was created for.
    /// Optional so existing config.json files continue to load unchanged.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    pub created_at: f64,
}

fn default_true() -> bool {
    true
}

/// Resolved Google OAuth client settings (see [`Config::google`]).
#[derive(Clone)]
pub struct GoogleConfig {
    pub client_id: String,
    pub client_secret: String,
    pub allowed_emails: Vec<String>,
}

/// Resolved Sign in with Apple settings (see [`Config::apple`]). The native
/// mobile flow needs no client secret: the identity token's audience is the
/// app's bundle id and its signature is checked against Apple's JWKS.
#[derive(Clone)]
pub struct AppleConfig {
    pub bundle_id: String,
    pub allowed_emails: Vec<String>,
}

/// Audience the mobile app's Apple identity tokens carry by default.
pub const DEFAULT_APPLE_BUNDLE_ID: &str = "app.agora.mobile";

fn default_username() -> String {
    "me".to_string()
}

fn default_instance_name() -> String {
    "My Agora".to_string()
}

fn default_admin_login_enabled() -> bool {
    true
}

#[derive(Clone, Serialize, Deserialize)]
pub struct ConfigData {
    /// Formerly `owner_token`; the alias keeps existing config.json files
    /// loading (a miss here would regenerate the key and lock clients out).
    #[serde(default, alias = "owner_token")]
    pub admin_key: String,
    /// Whether clients offer the operator-key form. The key remains valid for
    /// API/desktop operations; this only hides the interactive login surface.
    #[serde(default = "default_admin_login_enabled")]
    pub admin_login_enabled: bool,
    /// Signs the short-lived session tokens minted by Google sign-in.
    /// Generated once; rotating it signs every session out.
    #[serde(default)]
    pub session_secret: String,
    /// Stable identity this app declares to every linked Pantheo (an
    /// `identify` frame after connect), so an instance serving several Agoras
    /// can keep their sessions and channels apart. Generated once, kept for
    /// the life of the data dir.
    #[serde(default)]
    pub instance_id: String,
    /// Human-readable name shown alongside this app's chats on the other side.
    #[serde(default = "default_instance_name")]
    pub instance_name: String,
    #[serde(default = "default_username")]
    pub username: String,
    /// Loopback by default; set 0.0.0.0 to accept LAN bridges.
    #[serde(default = "default_bind")]
    pub bind: String,
    #[serde(default = "default_port")]
    pub port: u16,
    /// When true, refuse plaintext `ws://`/`http://` to non-loopback hosts on
    /// outbound connections (the token and all traffic would otherwise travel
    /// in the clear). Off by default so LAN/dev setups keep working; turn it on
    /// for deployments where every peer is reachable over TLS.
    #[serde(default)]
    pub require_tls: bool,
    #[serde(default)]
    pub connections: Vec<Connection>,
    #[serde(default)]
    pub pairing_tokens: Vec<PairingToken>,
    /// Per-attachment upload cap, megabytes.
    #[serde(default = "default_max_file_mb")]
    pub max_file_mb: u64,
    /// Per-attachment cap for verified video uploads, megabytes.
    #[serde(default = "default_max_video_mb")]
    pub max_video_mb: u64,
    /// Google OAuth client (Web application type). Both must be set for
    /// Google sign-in to be offered.
    #[serde(default)]
    pub google_client_id: String,
    #[serde(default)]
    pub google_client_secret: String,
    /// Google accounts that may sign in without a pending invite
    /// (lowercased) — pre-account installs used this as the whole gate, so
    /// it keeps working as a standing allowlist. Everyone else needs an
    /// existing account or an invite created on the admin Users page.
    #[serde(default)]
    pub google_allowed_emails: Vec<String>,
    /// Sign in with Apple: emails that may sign in without an invite
    /// (lowercased; a Hide-My-Email relay address counts — it is stable per
    /// Apple ID and app). Apple sign-in is offered when this list is
    /// non-empty or `apple_bundle_id` is set explicitly.
    #[serde(default)]
    pub apple_allowed_emails: Vec<String>,
    /// iOS bundle id the identity token must be issued for. Empty means the
    /// stock mobile app id ([`DEFAULT_APPLE_BUNDLE_ID`]).
    #[serde(default)]
    pub apple_bundle_id: String,
    /// Public base URL (https://agora.example.com) used to build the OAuth
    /// redirect URI behind a proxy. When empty it is derived per request.
    #[serde(default)]
    pub public_url: String,
    /// MapLibre style URL used to render map artifacts (vector tiles + style
    /// JSON). Empty means the built-in default ([`DEFAULT_MAP_STYLE_URL`]);
    /// `"none"` opts out of third-party tiles entirely (clients then draw the
    /// coordinate-only fallback). Operator-overridable so tile
    /// hosting/licensing stays out of the agent protocol.
    #[serde(default)]
    pub map_style_url: String,
    /// Instance-admin AI settings (voice STT/TTS + Ask AI). Keys may also come
    /// from process env at *read* time — they are never folded into this file
    /// by `apply_env_overrides` (a boot write would clobber UI-set values).
    #[serde(default)]
    pub ai: AiSettings,
}

/// Where a resolved AI field came from. Exposed per-field on the admin API so
/// an env-backed key and a config-backed model can coexist cleanly.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AiFieldSource {
    Config,
    Env,
    Default,
    None,
}

/// Voice feature defaults (OpenAI audio APIs). Provider is fixed in v1; the
/// field stays in the schema so clients don't invent a free-form endpoint.
pub const DEFAULT_VOICE_PROVIDER: &str = "openai";
pub const DEFAULT_STT_MODEL: &str = "gpt-4o-mini-transcribe";
pub const DEFAULT_TTS_MODEL: &str = "gpt-4o-mini-tts";
pub const DEFAULT_TTS_VOICE: &str = "alloy";

/// Ask-AI defaults (Anthropic Messages API).
pub const DEFAULT_SEARCH_PROVIDER: &str = "anthropic";
pub const DEFAULT_SEARCH_MODEL: &str = "claude-sonnet-5";
pub const SEARCH_PROVIDER_ANTHROPIC: &str = "anthropic";
pub const SEARCH_PROVIDER_OPENAI: &str = "openai";
pub const SEARCH_PROVIDER_CODEX: &str = "codex";

fn default_voice_provider() -> String {
    DEFAULT_VOICE_PROVIDER.to_string()
}
fn default_search_provider() -> String {
    DEFAULT_SEARCH_PROVIDER.to_string()
}

pub fn is_supported_search_provider(p: &str) -> bool {
    matches!(
        p,
        SEARCH_PROVIDER_ANTHROPIC | SEARCH_PROVIDER_OPENAI | SEARCH_PROVIDER_CODEX
    )
}

pub fn default_model_for_search_provider(provider: &str) -> &'static str {
    match provider {
        SEARCH_PROVIDER_OPENAI => crate::ai::DEFAULT_OPENAI_SEARCH_MODEL,
        SEARCH_PROVIDER_CODEX => crate::codex_oauth::DEFAULT_CODEX_MODEL,
        _ => DEFAULT_SEARCH_MODEL,
    }
}

pub fn suggested_models_for_search_provider(provider: &str) -> &'static [&'static str] {
    match provider {
        SEARCH_PROVIDER_OPENAI => crate::ai::SUGGESTED_OPENAI_MODELS,
        SEARCH_PROVIDER_CODEX => crate::codex_oauth::SUGGESTED_CODEX_MODELS,
        _ => crate::ai::SUGGESTED_ANTHROPIC_MODELS,
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct AiVoiceSettings {
    /// Admin kill-switch: false hides voice even when a key is present (env
    /// or config). Clearing the config key alone cannot express that when
    /// Railway still exports `OPENAI_API_KEY`.
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default = "default_voice_provider")]
    pub provider: String,
    #[serde(default)]
    pub api_key: String,
    /// Empty means "use the built-in default at resolve time" so an
    /// env-only deploy can still override via process env without the
    /// first `config.json` write baking the stock model in as `config`.
    #[serde(default)]
    pub stt_model: String,
    #[serde(default)]
    pub tts_model: String,
    #[serde(default)]
    pub tts_voice: String,
}

impl Default for AiVoiceSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            provider: default_voice_provider(),
            api_key: String::new(),
            stt_model: String::new(),
            tts_model: String::new(),
            tts_voice: String::new(),
        }
    }
}

/// Per-provider Ask-AI model overrides. Switching provider must not keep a
/// foreign model (e.g. `claude-*` while on openai) — each slot is independent.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct AiSearchModels {
    #[serde(default)]
    pub anthropic: String,
    #[serde(default)]
    pub openai: String,
    #[serde(default)]
    pub codex: String,
}

impl AiSearchModels {
    pub fn get(&self, provider: &str) -> &str {
        match provider {
            SEARCH_PROVIDER_OPENAI => self.openai.as_str(),
            SEARCH_PROVIDER_CODEX => self.codex.as_str(),
            _ => self.anthropic.as_str(),
        }
    }

    pub fn set(&mut self, provider: &str, value: String) {
        match provider {
            SEARCH_PROVIDER_OPENAI => self.openai = value,
            SEARCH_PROVIDER_CODEX => self.codex = value,
            _ => self.anthropic = value,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct AiSearchSettings {
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// `anthropic` (API key), `openai` (API key), or `codex` (ChatGPT OAuth).
    #[serde(default = "default_search_provider")]
    pub provider: String,
    /// Anthropic Messages API key. OpenAI Ask AI shares [`AiVoiceSettings::api_key`].
    #[serde(default)]
    pub api_key: String,
    /// Per-provider model overrides (preferred).
    #[serde(default)]
    pub models: AiSearchModels,
    /// Legacy single-model override. Migrated into [`Self::models`] for the
    /// active provider on load; still read as a fallback until cleared.
    #[serde(default)]
    pub model: String,
    /// Codex / ChatGPT OAuth refresh token (provider=`codex`). Never folded
    /// from env at boot.
    #[serde(default)]
    pub codex_refresh_token: String,
    #[serde(default)]
    pub codex_access_token: String,
    #[serde(default)]
    pub codex_account_id: String,
    #[serde(default)]
    pub codex_last_refresh: f64,
}

impl Default for AiSearchSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            provider: default_search_provider(),
            api_key: String::new(),
            models: AiSearchModels::default(),
            model: String::new(),
            codex_refresh_token: String::new(),
            codex_access_token: String::new(),
            codex_account_id: String::new(),
            codex_last_refresh: 0.0,
        }
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct AiSettings {
    #[serde(default)]
    pub voice: AiVoiceSettings,
    #[serde(default)]
    pub search: AiSearchSettings,
}

/// Runtime voice settings after config/env/default resolution.
#[derive(Clone, Debug)]
pub struct ResolvedVoice {
    pub enabled: bool,
    pub provider: String,
    pub api_key: Option<String>,
    pub api_key_source: AiFieldSource,
    pub stt_model: String,
    pub stt_model_source: AiFieldSource,
    pub tts_model: String,
    pub tts_model_source: AiFieldSource,
    pub tts_voice: String,
    pub tts_voice_source: AiFieldSource,
}

impl ResolvedVoice {
    /// Feature is on for clients: admin enabled it *and* a usable key exists.
    pub fn available(&self) -> bool {
        self.enabled && self.api_key.is_some()
    }
}

/// Runtime Ask-AI settings after config/env/default resolution.
#[derive(Clone, Debug)]
pub struct ResolvedSearchAi {
    pub enabled: bool,
    pub provider: String,
    /// API key for anthropic/openai providers.
    pub api_key: Option<String>,
    pub api_key_source: AiFieldSource,
    /// Codex OAuth: refresh token present (config).
    pub oauth_configured: bool,
    pub oauth_source: AiFieldSource,
    pub access_token: Option<String>,
    pub account_id: String,
    pub model: String,
    pub model_source: AiFieldSource,
    /// Resolved model field for every provider (Features tab keeps all three).
    pub models: ResolvedSearchModels,
}

#[derive(Clone, Debug)]
pub struct ResolvedSearchModels {
    pub anthropic: (String, AiFieldSource),
    pub openai: (String, AiFieldSource),
    pub codex: (String, AiFieldSource),
}

impl ResolvedSearchAi {
    pub fn available(&self) -> bool {
        if !self.enabled {
            return false;
        }
        match self.provider.as_str() {
            SEARCH_PROVIDER_CODEX => self.oauth_configured || self.access_token.is_some(),
            _ => self.api_key.is_some(),
        }
    }
}

/// Config-first secret: non-empty config wins, else env, else none.
/// Deterministic — callers pass the env value in so tests never touch ambient
/// process state.
pub fn resolve_secret(config_value: &str, env_value: Option<&str>) -> (Option<String>, AiFieldSource) {
    let cfg = config_value.trim();
    if !cfg.is_empty() {
        return (Some(cfg.to_string()), AiFieldSource::Config);
    }
    match env_value.map(str::trim).filter(|s| !s.is_empty()) {
        Some(v) => (Some(v.to_string()), AiFieldSource::Env),
        None => (None, AiFieldSource::None),
    }
}

/// Config-first setting with a hard-coded default when both config and env
/// are empty.
pub fn resolve_setting(
    config_value: &str,
    env_value: Option<&str>,
    default: &str,
) -> (String, AiFieldSource) {
    let cfg = config_value.trim();
    if !cfg.is_empty() {
        return (cfg.to_string(), AiFieldSource::Config);
    }
    match env_value.map(str::trim).filter(|s| !s.is_empty()) {
        Some(v) => (v.to_string(), AiFieldSource::Env),
        None => (default.to_string(), AiFieldSource::Default),
    }
}

/// Mask a secret for admin UI: keep a short head/tail, never the middle.
pub fn key_hint(key: &str) -> String {
    let k = key.trim();
    let chars: Vec<char> = k.chars().collect();
    if chars.len() <= 8 {
        return "••••".to_string();
    }
    let head: String = chars.iter().take(4).collect();
    let tail: String = chars.iter().rev().take(4).rev().collect();
    format!("{head}…{tail}")
}

/// OpenFreeMap's Liberty style: free vector tiles, no API key, MapLibre
/// native — maps work out of the box while `map_style_url` lets operators
/// swap in their own tiles (or `"none"` for the offline SVG view).
pub const DEFAULT_MAP_STYLE_URL: &str = "https://tiles.openfreemap.org/styles/liberty";

fn default_bind() -> String {
    "127.0.0.1".to_string()
}

fn default_port() -> u16 {
    4470
}

fn default_max_file_mb() -> u64 {
    10
}

fn default_max_video_mb() -> u64 { 100 }

impl Default for ConfigData {
    fn default() -> Self {
        Self {
            admin_key: new_token(),
            admin_login_enabled: true,
            session_secret: new_token(),
            instance_id: new_token(),
            instance_name: default_instance_name(),
            username: default_username(),
            bind: default_bind(),
            port: default_port(),
            require_tls: false,
            connections: Vec::new(),
            pairing_tokens: Vec::new(),
            max_file_mb: default_max_file_mb(),
            max_video_mb: default_max_video_mb(),
            google_client_id: String::new(),
            google_client_secret: String::new(),
            google_allowed_emails: Vec::new(),
            apple_allowed_emails: Vec::new(),
            apple_bundle_id: String::new(),
            public_url: String::new(),
            map_style_url: String::new(),
            ai: AiSettings::default(),
        }
    }
}

pub struct Config {
    path: PathBuf,
    data: Mutex<ConfigData>,
}

impl Config {
    pub fn load(data_dir: &Path) -> anyhow::Result<Self> {
        std::fs::create_dir_all(data_dir)?;
        let path = data_dir.join("config.json");
        let mut data: ConfigData = match std::fs::read_to_string(&path) {
            Ok(text) => serde_json::from_str(&text).unwrap_or_default(),
            Err(_) => ConfigData::default(),
        };
        if data.admin_key.is_empty() {
            data.admin_key = new_token();
        }
        if data.session_secret.is_empty() {
            data.session_secret = new_token();
        }
        if data.instance_id.is_empty() {
            data.instance_id = new_token();
        }
        if data.instance_name.trim().is_empty() {
            data.instance_name = default_instance_name();
        }
        for pairing in &mut data.pairing_tokens {
            if pairing.id.is_empty() {
                pairing.id = new_token();
            }
        }
        migrate_legacy_search_model(&mut data.ai.search);
        let cfg = Self {
            path,
            data: Mutex::new(data),
        };
        cfg.save();
        Ok(cfg)
    }

    pub fn snapshot(&self) -> ConfigData {
        self.data.lock().unwrap().clone()
    }

    pub fn admin_key(&self) -> String {
        self.data.lock().unwrap().admin_key.clone()
    }

    pub fn admin_login_enabled(&self) -> bool {
        self.data.lock().unwrap().admin_login_enabled
    }

    pub fn username(&self) -> String {
        self.data.lock().unwrap().username.clone()
    }

    pub fn instance_id(&self) -> String {
        self.data.lock().unwrap().instance_id.clone()
    }

    pub fn instance_name(&self) -> String {
        self.data.lock().unwrap().instance_name.clone()
    }

    pub fn update<F: FnOnce(&mut ConfigData)>(&self, f: F) {
        {
            let mut data = self.data.lock().unwrap();
            f(&mut data);
        }
        self.save();
    }

    pub fn valid_pairing_token(&self, token: &str) -> Option<String> {
        let data = self.data.lock().unwrap();
        data.pairing_tokens
            .iter()
            .find(|t| constant_time_eq(&t.token, token))
            .map(|t| t.name.clone())
    }

    pub fn valid_pairing_id(&self, token: &str) -> Option<String> {
        let data = self.data.lock().unwrap();
        data.pairing_tokens
            .iter()
            .find(|t| constant_time_eq(&t.token, token))
            .map(|t| t.id.clone())
    }

    pub fn is_admin_key(&self, token: &str) -> bool {
        constant_time_eq(&self.data.lock().unwrap().admin_key, token)
    }

    pub fn session_secret(&self) -> String {
        self.data.lock().unwrap().session_secret.clone()
    }

    /// The Google OAuth client, when sign-in is configured (client id +
    /// secret). Who may sign in is decided per email at callback time
    /// (existing account, pending invite, or this allowlist), so an empty
    /// allowlist no longer disables the flow.
    pub fn google(&self) -> Option<GoogleConfig> {
        let data = self.data.lock().unwrap();
        if data.google_client_id.is_empty() || data.google_client_secret.is_empty() {
            return None;
        }
        Some(GoogleConfig {
            client_id: data.google_client_id.clone(),
            client_secret: data.google_client_secret.clone(),
            allowed_emails: data
                .google_allowed_emails
                .iter()
                .map(|e| e.trim().to_lowercase())
                .filter(|e| !e.is_empty())
                .collect(),
        })
    }

    /// Sign in with Apple, when configured: a non-empty email allowlist or
    /// an explicit bundle id (invite-only setups have no allowlist; setting
    /// the bundle id is the opt-in). The bundle id has a stock default.
    pub fn apple(&self) -> Option<AppleConfig> {
        let data = self.data.lock().unwrap();
        if data.apple_allowed_emails.is_empty() && data.apple_bundle_id.trim().is_empty() {
            return None;
        }
        let bundle_id = if data.apple_bundle_id.trim().is_empty() {
            DEFAULT_APPLE_BUNDLE_ID.to_string()
        } else {
            data.apple_bundle_id.trim().to_string()
        };
        Some(AppleConfig {
            bundle_id,
            allowed_emails: data
                .apple_allowed_emails
                .iter()
                .map(|e| e.trim().to_lowercase())
                .filter(|e| !e.is_empty())
                .collect(),
        })
    }

    pub fn public_url(&self) -> String {
        self.data
            .lock()
            .unwrap()
            .public_url
            .trim_end_matches('/')
            .to_string()
    }

    /// The style URL clients should render map artifacts with: the operator's
    /// override when set, the built-in default when empty, and empty when the
    /// operator opted out with `"none"` (clients then use the SVG fallback).
    pub fn map_style_url(&self) -> String {
        let configured = self.data.lock().unwrap().map_style_url.trim().to_string();
        if configured.is_empty() {
            return DEFAULT_MAP_STYLE_URL.to_string();
        }
        if configured.eq_ignore_ascii_case("none") {
            return String::new();
        }
        configured
    }

    /// Resolve voice settings. Env values are passed in (never read here) so
    /// unit tests stay deterministic — see [`resolve_secret`].
    ///
    /// `openai_api_key_env` is typically `std::env::var("OPENAI_API_KEY").ok()`.
    /// These env vars are deliberately *not* folded into config.json at boot
    /// (`apply_env_overrides` must never touch them): a Railway restart would
    /// otherwise overwrite an admin's UI-set key.
    pub fn voice(&self, openai_api_key_env: Option<&str>) -> ResolvedVoice {
        let data = self.data.lock().unwrap();
        let v = &data.ai.voice;
        let (api_key, api_key_source) = resolve_secret(&v.api_key, openai_api_key_env);
        let (stt_model, stt_model_source) =
            resolve_setting(&v.stt_model, None, DEFAULT_STT_MODEL);
        let (tts_model, tts_model_source) =
            resolve_setting(&v.tts_model, None, DEFAULT_TTS_MODEL);
        let (tts_voice, tts_voice_source) =
            resolve_setting(&v.tts_voice, None, DEFAULT_TTS_VOICE);
        let provider = {
            let p = v.provider.trim();
            if p.is_empty() {
                DEFAULT_VOICE_PROVIDER.to_string()
            } else {
                p.to_string()
            }
        };
        ResolvedVoice {
            enabled: v.enabled,
            provider,
            api_key,
            api_key_source,
            stt_model,
            stt_model_source,
            tts_model,
            tts_model_source,
            tts_voice,
            tts_voice_source,
        }
    }

    /// Resolve Ask-AI settings. Env values are never folded into config.json
    /// at boot (same rule as voice).
    ///
    /// OpenAI Ask AI shares the voice OpenAI key (`ai.voice.api_key` /
    /// `OPENAI_API_KEY`). Anthropic uses `ai.search.api_key` /
    /// `ANTHROPIC_API_KEY`. Models are per-provider.
    pub fn search_ai(
        &self,
        anthropic_api_key_env: Option<&str>,
        openai_api_key_env: Option<&str>,
        agora_ai_model_env: Option<&str>,
    ) -> ResolvedSearchAi {
        let data = self.data.lock().unwrap();
        let s = &data.ai.search;
        let provider = {
            let p = s.provider.trim();
            if p.is_empty() || !is_supported_search_provider(p) {
                DEFAULT_SEARCH_PROVIDER.to_string()
            } else {
                p.to_string()
            }
        };
        let (api_key, api_key_source) = match provider.as_str() {
            SEARCH_PROVIDER_OPENAI => {
                resolve_secret(&data.ai.voice.api_key, openai_api_key_env)
            }
            SEARCH_PROVIDER_ANTHROPIC => resolve_secret(&s.api_key, anthropic_api_key_env),
            _ => (None, AiFieldSource::None),
        };
        // `AGORA_AI_MODEL` is the legacy Anthropic-only knob — do not apply it
        // to openai/codex or a deployment with `AGORA_AI_MODEL=claude-…` would
        // send Claude model ids to OpenAI the moment an admin switches provider.
        let models = ResolvedSearchModels {
            anthropic: resolve_provider_model(
                &s.models,
                SEARCH_PROVIDER_ANTHROPIC,
                agora_ai_model_env,
            ),
            openai: resolve_provider_model(&s.models, SEARCH_PROVIDER_OPENAI, None),
            codex: resolve_provider_model(&s.models, SEARCH_PROVIDER_CODEX, None),
        };
        let (model, model_source) = match provider.as_str() {
            SEARCH_PROVIDER_OPENAI => models.openai.clone(),
            SEARCH_PROVIDER_CODEX => models.codex.clone(),
            _ => models.anthropic.clone(),
        };
        let refresh = s.codex_refresh_token.trim();
        let access = s.codex_access_token.trim();
        let oauth_configured = !refresh.is_empty();
        let oauth_source = if oauth_configured {
            AiFieldSource::Config
        } else {
            AiFieldSource::None
        };
        ResolvedSearchAi {
            enabled: s.enabled,
            provider,
            api_key,
            api_key_source,
            oauth_configured,
            oauth_source,
            access_token: (!access.is_empty()).then(|| access.to_string()),
            account_id: s.codex_account_id.trim().to_string(),
            model,
            model_source,
            models,
        }
    }

    /// Persist refreshed Codex OAuth tokens after a successful refresh.
    pub fn store_codex_tokens(&self, tokens: &crate::codex_oauth::CodexTokens) {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs_f64())
            .unwrap_or(0.0);
        self.update(|c| {
            c.ai.search.codex_access_token = tokens.access_token.clone();
            if !tokens.refresh_token.is_empty() {
                c.ai.search.codex_refresh_token = tokens.refresh_token.clone();
            }
            if !tokens.account_id.is_empty() {
                c.ai.search.codex_account_id = tokens.account_id.clone();
            }
            c.ai.search.codex_last_refresh = now;
        });
    }

    /// Atomic write: temp file + rename, mode 0600 on Unix. A torn
    /// `fs::write` onto the live path used to leave unparseable JSON; load
    /// then falls back to `ConfigData::default()` and regenerates
    /// `admin_key` / `session_secret` (total lockout).
    fn save(&self) {
        let data = self.data.lock().unwrap();
        let Ok(text) = serde_json::to_string_pretty(&*data) else {
            return;
        };
        let tmp = self.path.with_extension("json.tmp");
        if std::fs::write(&tmp, text.as_bytes()).is_err() {
            return;
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600));
        }
        if std::fs::rename(&tmp, &self.path).is_err() {
            let _ = std::fs::remove_file(&tmp);
        }
    }
}

/// Fold the legacy single `model` into the active provider's slot once, then
/// clear it so a later provider switch cannot resurrect a foreign model.
fn migrate_legacy_search_model(search: &mut AiSearchSettings) {
    let legacy = search.model.trim().to_string();
    if legacy.is_empty() {
        return;
    }
    let provider = {
        let p = search.provider.trim();
        if p.is_empty() || !is_supported_search_provider(p) {
            DEFAULT_SEARCH_PROVIDER
        } else {
            p
        }
    };
    if search.models.get(provider).is_empty() {
        search.models.set(provider, legacy);
    }
    search.model.clear();
}

fn resolve_provider_model(
    models: &AiSearchModels,
    provider: &str,
    agora_ai_model_env: Option<&str>,
) -> (String, AiFieldSource) {
    let default = default_model_for_search_provider(provider);
    resolve_setting(models.get(provider), agora_ai_model_env, default)
}

fn constant_time_eq(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() || a.is_empty() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn instance_identity_is_generated_once_and_stable() {
        let dir = tempfile::tempdir().unwrap();
        let cfg = Config::load(dir.path()).unwrap();
        let id = cfg.instance_id();
        assert_eq!(id.len(), 32); // 16 random bytes, hex
        assert_eq!(cfg.instance_name(), "My Agora");
        cfg.update(|c| c.instance_name = "Home Agora".into());
        drop(cfg);
        // A reload keeps both the generated id and the chosen name.
        let cfg = Config::load(dir.path()).unwrap();
        assert_eq!(cfg.instance_id(), id);
        assert_eq!(cfg.instance_name(), "Home Agora");
    }

    #[test]
    fn google_requires_client_and_normalizes_emails() {
        let dir = tempfile::tempdir().unwrap();
        let cfg = Config::load(dir.path()).unwrap();
        assert!(cfg.google().is_none());
        cfg.update(|c| c.google_client_id = "cid".into());
        // Secret still missing -> disabled.
        assert!(cfg.google().is_none());
        cfg.update(|c| c.google_client_secret = "shh".into());
        // Invite-only: sign-in is offered with an empty allowlist (each
        // email is judged at callback time against accounts/invites).
        let gc = cfg.google().expect("client configured");
        assert!(gc.allowed_emails.is_empty());
        cfg.update(|c| c.google_allowed_emails = vec![" Tom@Example.COM ".into()]);
        let gc = cfg.google().expect("fully configured");
        assert_eq!(gc.allowed_emails, vec!["tom@example.com"]);
    }

    #[test]
    fn apple_requires_allowlist_or_bundle_id() {
        let dir = tempfile::tempdir().unwrap();
        let cfg = Config::load(dir.path()).unwrap();
        assert!(cfg.apple().is_none());
        cfg.update(|c| c.apple_allowed_emails = vec![" Tom@Example.COM ".into()]);
        let ac = cfg.apple().expect("configured");
        assert_eq!(ac.bundle_id, DEFAULT_APPLE_BUNDLE_ID);
        assert_eq!(ac.allowed_emails, vec!["tom@example.com"]);
        cfg.update(|c| c.apple_bundle_id = "app.custom.ios".into());
        assert_eq!(cfg.apple().unwrap().bundle_id, "app.custom.ios");
        // Invite-only: explicit bundle id alone enables the flow.
        cfg.update(|c| c.apple_allowed_emails = Vec::new());
        let ac = cfg.apple().expect("bundle id opt-in");
        assert!(ac.allowed_emails.is_empty());
    }

    #[test]
    fn map_style_url_defaults_and_supports_opt_out() {
        let dir = tempfile::tempdir().unwrap();
        let cfg = Config::load(dir.path()).unwrap();
        // Unset -> the built-in tiles so maps render out of the box.
        assert_eq!(cfg.map_style_url(), DEFAULT_MAP_STYLE_URL);
        cfg.update(|c| c.map_style_url = " https://tiles.example.com/style.json ".into());
        assert_eq!(cfg.map_style_url(), "https://tiles.example.com/style.json");
        // "none" (any case) disables third-party tiles entirely.
        cfg.update(|c| c.map_style_url = "None".into());
        assert_eq!(cfg.map_style_url(), "");
    }

    #[test]
    fn session_secret_is_generated_and_persists() {
        let dir = tempfile::tempdir().unwrap();
        let cfg = Config::load(dir.path()).unwrap();
        let secret = cfg.session_secret();
        assert!(!secret.is_empty());
        drop(cfg);
        let cfg = Config::load(dir.path()).unwrap();
        assert_eq!(cfg.session_secret(), secret);
    }

    #[test]
    fn legacy_config_without_identity_gets_one() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("config.json"),
            r#"{"admin_key": "aaaa", "username": "tom"}"#,
        )
        .unwrap();
        let cfg = Config::load(dir.path()).unwrap();
        assert!(cfg.snapshot().admin_login_enabled);
        assert!(!cfg.instance_id().is_empty());
        assert_eq!(cfg.instance_name(), "My Agora");
        assert_eq!(cfg.username(), "tom");
    }

    #[test]
    fn admin_login_is_visible_by_default_and_can_be_hidden() {
        let defaulted: ConfigData = serde_json::from_str(r#"{"admin_key":"key"}"#).unwrap();
        assert_eq!(defaulted.max_file_mb, 10);
        assert_eq!(defaulted.max_video_mb, 100);
        assert!(defaulted.admin_login_enabled);
        let hidden: ConfigData = serde_json::from_str(
            r#"{"admin_key":"key","admin_login_enabled":false}"#,
        )
        .unwrap();
        assert!(!hidden.admin_login_enabled);
    }

    #[test]
    fn legacy_owner_token_field_still_loads_and_is_rewritten() {
        // Pre-rename config.json: the key must load under its old name (a
        // miss would regenerate it and lock every client out) and be saved
        // back under the new one.
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("config.json"),
            r#"{"owner_token": "cafe1234", "username": "tom"}"#,
        )
        .unwrap();
        let cfg = Config::load(dir.path()).unwrap();
        assert_eq!(cfg.admin_key(), "cafe1234");
        assert!(cfg.is_admin_key("cafe1234"));
        drop(cfg);
        let text = std::fs::read_to_string(dir.path().join("config.json")).unwrap();
        assert!(text.contains("\"admin_key\": \"cafe1234\""));
        assert!(!text.contains("owner_token"));
    }

    #[test]
    fn legacy_pairing_tokens_load_without_a_kind() {
        let token: PairingToken =
            serde_json::from_str(r#"{"token":"tok","name":"Old agent","created_at":123}"#).unwrap();
        assert!(token.kind.is_none());
        assert!(token.id.is_empty());
    }

    #[test]
    fn legacy_pairing_tokens_gain_stable_non_secret_ids() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("config.json"),
            r#"{"admin_key":"key","pairing_tokens":[{"token":"secret","name":"Codex","created_at":1}]}"#).unwrap();
        let first=Config::load(dir.path()).unwrap().snapshot().pairing_tokens[0].id.clone();
        assert!(!first.is_empty()); assert_ne!(first,"secret");
        let second=Config::load(dir.path()).unwrap().snapshot().pairing_tokens[0].id.clone();
        assert_eq!(first,second);
    }

    #[test]
    fn resolve_secret_is_config_first_then_env() {
        assert_eq!(
            resolve_secret("cfg-key", Some("env-key")),
            (Some("cfg-key".into()), AiFieldSource::Config)
        );
        assert_eq!(
            resolve_secret("  ", Some("env-key")),
            (Some("env-key".into()), AiFieldSource::Env)
        );
        assert_eq!(resolve_secret("", None), (None, AiFieldSource::None));
        assert_eq!(resolve_secret("  ", Some("  ")), (None, AiFieldSource::None));
    }

    #[test]
    fn resolve_setting_falls_through_to_default() {
        assert_eq!(
            resolve_setting("m1", Some("m2"), "def"),
            ("m1".into(), AiFieldSource::Config)
        );
        assert_eq!(
            resolve_setting("", Some("m2"), "def"),
            ("m2".into(), AiFieldSource::Env)
        );
        assert_eq!(
            resolve_setting("", None, "def"),
            ("def".into(), AiFieldSource::Default)
        );
    }

    #[test]
    fn voice_resolver_honors_enabled_and_env_key() {
        let dir = tempfile::tempdir().unwrap();
        let cfg = Config::load(dir.path()).unwrap();
        // Env key alone: available when enabled (default).
        let v = cfg.voice(Some("sk-env"));
        assert!(v.available());
        assert_eq!(v.api_key_source, AiFieldSource::Env);
        assert_eq!(v.stt_model, DEFAULT_STT_MODEL);
        // Kill-switch beats a present key.
        cfg.update(|c| c.ai.voice.enabled = false);
        assert!(!cfg.voice(Some("sk-env")).available());
        // Config key wins over env.
        cfg.update(|c| {
            c.ai.voice.enabled = true;
            c.ai.voice.api_key = "sk-cfg".into();
            c.ai.voice.tts_voice = "shimmer".into();
        });
        let v = cfg.voice(Some("sk-env"));
        assert_eq!(v.api_key.as_deref(), Some("sk-cfg"));
        assert_eq!(v.api_key_source, AiFieldSource::Config);
        assert_eq!(v.tts_voice, "shimmer");
        assert_eq!(v.tts_voice_source, AiFieldSource::Config);
    }

    #[test]
    fn search_ai_resolver_uses_agora_ai_model_env() {
        let dir = tempfile::tempdir().unwrap();
        let cfg = Config::load(dir.path()).unwrap();
        let s = cfg.search_ai(Some("ant-key"), None, Some("claude-opus-5"));
        assert!(s.available());
        assert_eq!(s.model, "claude-opus-5");
        assert_eq!(s.model_source, AiFieldSource::Env);
        cfg.update(|c| {
            c.ai.search.models.anthropic = "claude-haiku-4-5-20251001".into();
        });
        let s = cfg.search_ai(Some("ant-key"), None, Some("claude-opus-5"));
        assert_eq!(s.model, "claude-haiku-4-5-20251001");
        assert_eq!(s.model_source, AiFieldSource::Config);
    }

    #[test]
    fn search_ai_openai_provider_uses_openai_env_key() {
        let dir = tempfile::tempdir().unwrap();
        let cfg = Config::load(dir.path()).unwrap();
        cfg.update(|c| c.ai.search.provider = SEARCH_PROVIDER_OPENAI.into());
        let s = cfg.search_ai(Some("ant"), Some("sk-openai"), None);
        assert!(s.available());
        assert_eq!(s.api_key.as_deref(), Some("sk-openai"));
        assert_eq!(s.model, crate::ai::DEFAULT_OPENAI_SEARCH_MODEL);
    }

    #[test]
    fn search_ai_openai_provider_shares_voice_config_key() {
        let dir = tempfile::tempdir().unwrap();
        let cfg = Config::load(dir.path()).unwrap();
        cfg.update(|c| {
            c.ai.search.provider = SEARCH_PROVIDER_OPENAI.into();
            c.ai.voice.api_key = "sk-voice".into();
        });
        let s = cfg.search_ai(None, Some("sk-env"), None);
        assert_eq!(s.api_key.as_deref(), Some("sk-voice"));
        assert_eq!(s.api_key_source, AiFieldSource::Config);
    }

    #[test]
    fn search_ai_provider_switch_keeps_per_provider_models() {
        let dir = tempfile::tempdir().unwrap();
        let cfg = Config::load(dir.path()).unwrap();
        cfg.update(|c| {
            c.ai.search.models.anthropic = "claude-opus-5".into();
            c.ai.search.models.openai = "gpt-4.1".into();
            c.ai.search.provider = SEARCH_PROVIDER_ANTHROPIC.into();
        });
        let s = cfg.search_ai(Some("ant"), Some("sk"), None);
        assert_eq!(s.model, "claude-opus-5");
        cfg.update(|c| c.ai.search.provider = SEARCH_PROVIDER_OPENAI.into());
        let s = cfg.search_ai(Some("ant"), Some("sk"), None);
        assert_eq!(s.model, "gpt-4.1");
        assert_eq!(s.models.anthropic.0, "claude-opus-5");
        // Never emit the anthropic override while on openai.
        assert_ne!(s.model, "claude-opus-5");
    }

    #[test]
    fn agora_ai_model_env_scopes_to_anthropic_only() {
        let dir = tempfile::tempdir().unwrap();
        let cfg = Config::load(dir.path()).unwrap();
        // Empty per-provider overrides: env must not leak Claude ids into
        // openai/codex when an admin switches provider in the Features tab.
        let resolved = cfg.search_ai(Some("ant"), Some("sk"), Some("claude-sonnet-5"));
        assert_eq!(resolved.models.anthropic.0, "claude-sonnet-5");
        assert_eq!(resolved.models.anthropic.1, AiFieldSource::Env);
        assert_eq!(resolved.models.openai.0, crate::ai::DEFAULT_OPENAI_SEARCH_MODEL);
        assert_eq!(resolved.models.openai.1, AiFieldSource::Default);
        assert_eq!(resolved.models.codex.0, crate::codex_oauth::DEFAULT_CODEX_MODEL);
        assert_eq!(resolved.models.codex.1, AiFieldSource::Default);

        cfg.update(|c| c.ai.search.provider = SEARCH_PROVIDER_OPENAI.into());
        let s = cfg.search_ai(Some("ant"), Some("sk"), Some("claude-sonnet-5"));
        assert_eq!(s.model, crate::ai::DEFAULT_OPENAI_SEARCH_MODEL);
        assert_ne!(s.model, "claude-sonnet-5");

        cfg.update(|c| c.ai.search.provider = SEARCH_PROVIDER_CODEX.into());
        let s = cfg.search_ai(None, None, Some("claude-sonnet-5"));
        assert_eq!(s.model, crate::codex_oauth::DEFAULT_CODEX_MODEL);
        assert_ne!(s.model, "claude-sonnet-5");
    }

    #[test]
    fn legacy_search_model_migrates_into_active_provider_slot() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        std::fs::write(
            &path,
            r#"{"admin_key":"k","session_secret":"s","instance_id":"i","ai":{"search":{"provider":"anthropic","model":"claude-opus-5"}}}"#,
        )
        .unwrap();
        let cfg = Config::load(dir.path()).unwrap();
        let snap = cfg.snapshot();
        assert_eq!(snap.ai.search.models.anthropic, "claude-opus-5");
        assert!(snap.ai.search.model.is_empty());
        cfg.update(|c| c.ai.search.provider = SEARCH_PROVIDER_OPENAI.into());
        let s = cfg.search_ai(None, Some("sk"), None);
        assert_eq!(s.model, crate::ai::DEFAULT_OPENAI_SEARCH_MODEL);
    }

    #[test]
    fn search_ai_codex_available_with_refresh_token() {
        let dir = tempfile::tempdir().unwrap();
        let cfg = Config::load(dir.path()).unwrap();
        cfg.update(|c| {
            c.ai.search.provider = SEARCH_PROVIDER_CODEX.into();
            c.ai.search.codex_refresh_token = "rt".into();
            c.ai.search.codex_account_id = "acct".into();
        });
        let s = cfg.search_ai(None, None, None);
        assert!(s.available());
        assert!(s.oauth_configured);
        assert_eq!(s.account_id, "acct");
    }

    #[test]
    fn save_is_atomic_and_unix_mode_is_owner_only() {
        let dir = tempfile::tempdir().unwrap();
        let cfg = Config::load(dir.path()).unwrap();
        cfg.update(|c| c.instance_name = "Safe".into());
        let path = dir.path().join("config.json");
        assert!(path.is_file());
        assert!(!dir.path().join("config.json.tmp").exists());
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(text.contains("\"instance_name\": \"Safe\""));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600);
        }
    }

    #[test]
    fn key_hint_masks_middle() {
        assert_eq!(key_hint("sk-abcdefghijklmnop"), "sk-a…mnop");
        assert_eq!(key_hint("short"), "••••");
    }
}
