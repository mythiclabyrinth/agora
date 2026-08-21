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

/// Voice feature defaults. STT and TTS providers are independent — Groq can
/// handle STT while OpenAI still does TTS, or the reverse.
pub const VOICE_PROVIDER_OPENAI: &str = "openai";
pub const VOICE_PROVIDER_GROQ: &str = "groq";
pub const DEFAULT_STT_PROVIDER: &str = VOICE_PROVIDER_OPENAI;
pub const DEFAULT_TTS_PROVIDER: &str = VOICE_PROVIDER_OPENAI;
pub const DEFAULT_STT_MODEL: &str = "gpt-4o-mini-transcribe";
pub const DEFAULT_GROQ_STT_MODEL: &str = "whisper-large-v3-turbo";
pub const DEFAULT_TTS_MODEL: &str = "gpt-4o-mini-tts";
pub const DEFAULT_TTS_VOICE: &str = "alloy";
pub const DEFAULT_GROQ_TTS_MODEL: &str = "canopylabs/orpheus-v1-english";
pub const DEFAULT_GROQ_ARABIC_TTS_MODEL: &str = "canopylabs/orpheus-arabic-saudi";
pub const DEFAULT_GROQ_TTS_VOICE: &str = "autumn";
pub const DEFAULT_GROQ_ARABIC_TTS_VOICE: &str = "noura";
pub const DEFAULT_OPENAI_BRITISH_TTS_VOICE: &str = "fable";

/// Provider-agnostic spoken accent. OpenAI gpt-4o-mini-tts follows it via
/// `instructions`; Groq maps Arabic onto the Arabic Orpheus model and English
/// accents onto English voices (Orpheus has no British-specific set).
pub const TTS_ACCENT_AMERICAN: &str = "american";
pub const TTS_ACCENT_BRITISH: &str = "british";
pub const TTS_ACCENT_ARABIC: &str = "arabic";
pub const DEFAULT_TTS_ACCENT: &str = TTS_ACCENT_AMERICAN;
pub const TTS_ACCENTS: &[(&str, &str)] = &[
    (TTS_ACCENT_AMERICAN, "American English"),
    (TTS_ACCENT_BRITISH, "British English"),
    (TTS_ACCENT_ARABIC, "Arabic (Saudi)"),
];

pub const SUGGESTED_OPENAI_STT_MODELS: &[&str] = &["gpt-4o-mini-transcribe", "whisper-1"];
pub const SUGGESTED_GROQ_STT_MODELS: &[&str] =
    &["whisper-large-v3-turbo", "whisper-large-v3", "distil-whisper-large-v3-en"];
pub const SUGGESTED_OPENAI_TTS_MODELS: &[&str] = &["gpt-4o-mini-tts", "tts-1", "tts-1-hd"];
pub const SUGGESTED_GROQ_TTS_MODELS: &[&str] = &[
    "canopylabs/orpheus-v1-english",
    "canopylabs/orpheus-arabic-saudi",
];
pub const SUGGESTED_OPENAI_TTS_VOICES: &[&str] = &[
    "alloy", "ash", "ballad", "coral", "echo", "fable", "onyx", "nova", "sage", "shimmer", "verse",
];
pub const SUGGESTED_GROQ_ENGLISH_TTS_VOICES: &[&str] =
    &["autumn", "diana", "hannah", "austin", "daniel", "troy"];
pub const SUGGESTED_GROQ_ARABIC_TTS_VOICES: &[&str] =
    &["abdullah", "fahad", "sultan", "lulwa", "noura", "aisha"];

/// Ask-AI defaults (Anthropic Messages API).
pub const DEFAULT_SEARCH_PROVIDER: &str = "anthropic";
pub const DEFAULT_SEARCH_MODEL: &str = "claude-sonnet-5";
pub const SEARCH_PROVIDER_ANTHROPIC: &str = "anthropic";
pub const SEARCH_PROVIDER_OPENAI: &str = "openai";
pub const SEARCH_PROVIDER_CODEX: &str = "codex";

fn default_stt_provider() -> String {
    DEFAULT_STT_PROVIDER.to_string()
}
fn default_tts_provider() -> String {
    DEFAULT_TTS_PROVIDER.to_string()
}
fn default_search_provider() -> String {
    DEFAULT_SEARCH_PROVIDER.to_string()
}

pub fn is_supported_stt_provider(p: &str) -> bool {
    matches!(p, VOICE_PROVIDER_OPENAI | VOICE_PROVIDER_GROQ)
}

pub fn is_supported_tts_provider(p: &str) -> bool {
    matches!(p, VOICE_PROVIDER_OPENAI | VOICE_PROVIDER_GROQ)
}

pub fn is_supported_search_provider(p: &str) -> bool {
    matches!(
        p,
        SEARCH_PROVIDER_ANTHROPIC | SEARCH_PROVIDER_OPENAI | SEARCH_PROVIDER_CODEX
    )
}

pub fn default_stt_model_for_provider(provider: &str) -> &'static str {
    match provider {
        VOICE_PROVIDER_GROQ => DEFAULT_GROQ_STT_MODEL,
        _ => DEFAULT_STT_MODEL,
    }
}

pub fn suggested_stt_models_for_provider(provider: &str) -> &'static [&'static str] {
    match provider {
        VOICE_PROVIDER_GROQ => SUGGESTED_GROQ_STT_MODELS,
        _ => SUGGESTED_OPENAI_STT_MODELS,
    }
}

pub fn default_tts_model_for_provider(provider: &str) -> &'static str {
    match provider {
        VOICE_PROVIDER_GROQ => DEFAULT_GROQ_TTS_MODEL,
        _ => DEFAULT_TTS_MODEL,
    }
}

pub fn suggested_tts_models_for_provider(provider: &str) -> &'static [&'static str] {
    match provider {
        VOICE_PROVIDER_GROQ => SUGGESTED_GROQ_TTS_MODELS,
        _ => SUGGESTED_OPENAI_TTS_MODELS,
    }
}

pub fn groq_tts_model_is_arabic(model: &str) -> bool {
    model.contains("arabic")
}

pub fn is_supported_tts_accent(accent: &str) -> bool {
    matches!(
        accent,
        TTS_ACCENT_AMERICAN | TTS_ACCENT_BRITISH | TTS_ACCENT_ARABIC
    )
}

/// Empty/unknown stored accent: Groq Arabic model implies Arabic, else American.
pub fn resolve_tts_accent(
    stored: &str,
    tts_provider: &str,
    groq_model: &str,
) -> (String, AiFieldSource) {
    let stored = stored.trim();
    if is_supported_tts_accent(stored) {
        return (stored.to_string(), AiFieldSource::Config);
    }
    if tts_provider == VOICE_PROVIDER_GROQ && groq_tts_model_is_arabic(groq_model) {
        return (TTS_ACCENT_ARABIC.to_string(), AiFieldSource::Default);
    }
    (DEFAULT_TTS_ACCENT.to_string(), AiFieldSource::Default)
}

pub fn groq_tts_model_for_accent(accent: &str) -> &'static str {
    if accent == TTS_ACCENT_ARABIC {
        DEFAULT_GROQ_ARABIC_TTS_MODEL
    } else {
        DEFAULT_GROQ_TTS_MODEL
    }
}

pub fn default_tts_voice_for(provider: &str, model: &str, accent: &str) -> &'static str {
    match provider {
        VOICE_PROVIDER_GROQ if groq_tts_uses_arabic(model, accent) => DEFAULT_GROQ_ARABIC_TTS_VOICE,
        VOICE_PROVIDER_GROQ => DEFAULT_GROQ_TTS_VOICE,
        _ if accent == TTS_ACCENT_BRITISH => DEFAULT_OPENAI_BRITISH_TTS_VOICE,
        _ => DEFAULT_TTS_VOICE,
    }
}

fn groq_tts_uses_arabic(model: &str, accent: &str) -> bool {
    accent == TTS_ACCENT_ARABIC || groq_tts_model_is_arabic(model)
}

pub fn suggested_tts_voices_for(provider: &str, model: &str, accent: &str) -> &'static [&'static str] {
    match provider {
        VOICE_PROVIDER_GROQ if groq_tts_uses_arabic(model, accent) => SUGGESTED_GROQ_ARABIC_TTS_VOICES,
        VOICE_PROVIDER_GROQ => SUGGESTED_GROQ_ENGLISH_TTS_VOICES,
        _ => SUGGESTED_OPENAI_TTS_VOICES,
    }
}

/// Human label for a provider voice id. Unknown ids are returned as-is.
pub fn tts_voice_label(id: &str) -> String {
    match id {
        "alloy" => "Alloy — neutral".into(),
        "ash" => "Ash — male".into(),
        "ballad" => "Ballad — male".into(),
        "coral" => "Coral — female".into(),
        "echo" => "Echo — male".into(),
        "fable" => "Fable — male".into(),
        "onyx" => "Onyx — male".into(),
        "nova" => "Nova — female".into(),
        "sage" => "Sage — neutral".into(),
        "shimmer" => "Shimmer — female".into(),
        "verse" => "Verse — male".into(),
        "autumn" => "Autumn — female".into(),
        "diana" => "Diana — female".into(),
        "hannah" => "Hannah — female".into(),
        "austin" => "Austin — male".into(),
        "daniel" => "Daniel — male".into(),
        "troy" => "Troy — male".into(),
        "abdullah" => "Abdullah — male".into(),
        "fahad" => "Fahad — male".into(),
        "sultan" => "Sultan — male".into(),
        "lulwa" => "Lulwa — female".into(),
        "noura" => "Noura — female".into(),
        "aisha" => "Aisha — female".into(),
        other => other.to_string(),
    }
}

/// OpenAI `instructions` for gpt-4o-*tts models. `tts-1` rejects the field.
pub fn openai_tts_instructions(model: &str, accent: &str) -> Option<&'static str> {
    let m = model.to_ascii_lowercase();
    if !(m.contains("gpt-4o") && m.contains("tts")) {
        return None;
    }
    match accent {
        TTS_ACCENT_BRITISH => Some("Speak with a clear British English accent."),
        TTS_ACCENT_ARABIC => Some("Speak in Arabic using a Saudi dialect."),
        TTS_ACCENT_AMERICAN => Some("Speak with a clear American English accent."),
        _ => None,
    }
}

pub fn tts_accent_label(id: &str) -> &'static str {
    TTS_ACCENTS
        .iter()
        .find(|(accent, _)| *accent == id)
        .map(|(_, label)| *label)
        .unwrap_or("")
}

/// True when `source` is an outbound Pantheo connection name (not a pairing
/// token). Those agents own their TTS in Pantheo; Agora must not overwrite it.
pub fn agent_tts_is_remote(source: &str, connection_names: impl IntoIterator<Item = impl AsRef<str>>) -> bool {
    connection_names.into_iter().any(|name| name.as_ref() == source)
}

/// Optional TTS block on a `hello.agents[]` entry. Missing keys mean "leave
/// Agora-stored values alone" (dial-in). Present keys, even empty, replace.
pub fn parse_agent_hello_tts(agent: &serde_json::Value) -> Option<(String, String, String)> {
    let has_accent = agent.get("tts_accent").is_some();
    let has_voices = agent.get("tts_voices").is_some() || agent.get("tts_voice").is_some();
    if !has_accent && !has_voices {
        return None;
    }
    let accent = agent["tts_accent"].as_str().unwrap_or("").trim();
    let accent = if is_supported_tts_accent(accent) {
        accent.to_string()
    } else {
        String::new()
    };
    let voices = agent.get("tts_voices").and_then(|v| v.as_object());
    let clip = |s: &str| s.trim().chars().take(40).collect::<String>();
    let openai = voices
        .and_then(|v| v.get("openai"))
        .and_then(|v| v.as_str())
        .or_else(|| agent["tts_voice"].as_str())
        .map(clip)
        .unwrap_or_default();
    let groq = voices
        .and_then(|v| v.get("groq"))
        .and_then(|v| v.as_str())
        .map(clip)
        .unwrap_or_default();
    Some((accent, openai, groq))
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

/// Per-provider STT model overrides. Switching STT provider must not keep a
/// foreign model id (e.g. `gpt-4o-mini-transcribe` while on Groq).
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct AiVoiceSttModels {
    #[serde(default)]
    pub openai: String,
    #[serde(default)]
    pub groq: String,
}

impl AiVoiceSttModels {
    pub fn get(&self, provider: &str) -> &str {
        match provider {
            VOICE_PROVIDER_GROQ => self.groq.as_str(),
            _ => self.openai.as_str(),
        }
    }

    pub fn set(&mut self, provider: &str, value: String) {
        match provider {
            VOICE_PROVIDER_GROQ => self.groq = value,
            _ => self.openai = value,
        }
    }
}

/// Per-provider TTS model overrides. Switching TTS provider must not keep a
/// foreign model id (e.g. `gpt-4o-mini-tts` while on Groq Orpheus).
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct AiVoiceTtsModels {
    #[serde(default)]
    pub openai: String,
    #[serde(default)]
    pub groq: String,
}

impl AiVoiceTtsModels {
    pub fn get(&self, provider: &str) -> &str {
        match provider {
            VOICE_PROVIDER_GROQ => self.groq.as_str(),
            _ => self.openai.as_str(),
        }
    }

    pub fn set(&mut self, provider: &str, value: String) {
        match provider {
            VOICE_PROVIDER_GROQ => self.groq = value,
            _ => self.openai = value,
        }
    }
}

/// Per-provider TTS voice overrides. Groq Orpheus voices are not OpenAI names.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct AiVoiceTtsVoices {
    #[serde(default)]
    pub openai: String,
    #[serde(default)]
    pub groq: String,
}

impl AiVoiceTtsVoices {
    pub fn get(&self, provider: &str) -> &str {
        match provider {
            VOICE_PROVIDER_GROQ => self.groq.as_str(),
            _ => self.openai.as_str(),
        }
    }

    pub fn set(&mut self, provider: &str, value: String) {
        match provider {
            VOICE_PROVIDER_GROQ => self.groq = value,
            _ => self.openai = value,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct AiVoiceSettings {
    /// Admin kill-switches, one per half — they are configured separately and
    /// can be credentialed separately, so they turn off separately. Clearing a
    /// key cannot express "off" when the env still exports one.
    #[serde(default = "default_true")]
    pub stt_enabled: bool,
    #[serde(default = "default_true")]
    pub tts_enabled: bool,
    #[serde(default = "default_stt_provider")]
    pub stt_provider: String,
    #[serde(default = "default_tts_provider")]
    pub tts_provider: String,
    /// OpenAI API key — shared with Ask AI when that provider is openai.
    #[serde(default)]
    pub api_key: String,
    /// Groq API key for STT/TTS when the selected half is Groq.
    #[serde(default)]
    pub groq_api_key: String,
    /// Per-provider STT model overrides. Empty slots resolve to the provider
    /// default.
    #[serde(default)]
    pub stt_models: AiVoiceSttModels,
    /// Per-provider TTS model overrides. Empty slots resolve to the provider
    /// default. Legacy `tts_model` is folded into the OpenAI slot on resolve.
    #[serde(default)]
    pub tts_models: AiVoiceTtsModels,
    /// Per-provider TTS voice overrides. Legacy `tts_voice` is folded into the
    /// OpenAI slot on resolve.
    #[serde(default)]
    pub tts_voices: AiVoiceTtsVoices,
    /// Provider-agnostic accent (`american` / `british` / `arabic`). Empty
    /// resolves to American, or Arabic when the Groq slot is an Arabic model.
    #[serde(default)]
    pub tts_accent: String,
    /// Legacy OpenAI-only TTS model. Kept so older config.json still loads;
    /// new writes go to `tts_models`.
    #[serde(default)]
    pub tts_model: String,
    /// Legacy OpenAI-only TTS voice. New writes go to `tts_voices`.
    #[serde(default)]
    pub tts_voice: String,
}

impl Default for AiVoiceSettings {
    fn default() -> Self {
        Self {
            stt_enabled: true,
            tts_enabled: true,
            stt_provider: default_stt_provider(),
            tts_provider: default_tts_provider(),
            api_key: String::new(),
            groq_api_key: String::new(),
            stt_models: AiVoiceSttModels::default(),
            tts_models: AiVoiceTtsModels::default(),
            tts_voices: AiVoiceTtsVoices::default(),
            tts_accent: String::new(),
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
    /// Per-provider model overrides. Empty slots resolve to the provider default.
    #[serde(default)]
    pub models: AiSearchModels,
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
    pub stt_enabled: bool,
    pub tts_enabled: bool,
    pub stt_provider: String,
    pub tts_provider: String,
    /// OpenAI key (Voice TTS + Ask AI openai + OpenAI STT).
    pub openai_api_key: Option<String>,
    pub openai_api_key_source: AiFieldSource,
    /// Groq key (STT/TTS when that half is set to groq).
    pub groq_api_key: Option<String>,
    pub groq_api_key_source: AiFieldSource,
    pub stt_model: String,
    pub stt_model_source: AiFieldSource,
    pub stt_models: ResolvedVoiceSttModels,
    pub tts_model: String,
    pub tts_model_source: AiFieldSource,
    pub tts_models: ResolvedVoiceTtsModels,
    pub tts_voice: String,
    pub tts_voice_source: AiFieldSource,
    pub tts_voices: ResolvedVoiceTtsVoices,
    pub tts_accent: String,
    pub tts_accent_source: AiFieldSource,
}

#[derive(Clone, Debug)]
pub struct ResolvedVoiceSttModels {
    pub openai: (String, AiFieldSource),
    pub groq: (String, AiFieldSource),
}

#[derive(Clone, Debug)]
pub struct ResolvedVoiceTtsModels {
    pub openai: (String, AiFieldSource),
    pub groq: (String, AiFieldSource),
}

#[derive(Clone, Debug)]
pub struct ResolvedVoiceTtsVoices {
    pub openai: (String, AiFieldSource),
    pub groq: (String, AiFieldSource),
}

impl ResolvedVoice {
    /// Either half is enabled *and* credentialed. Settings may still report
    /// this for diagnostics; clients advertise UI from the Enabled toggles
    /// alone (`stt_enabled` / `tts_enabled` on `/api/me`) and fail at use
    /// time when a key is missing.
    pub fn available(&self) -> bool {
        self.stt_available() || self.tts_available()
    }

    /// Transcription is enabled and the selected STT provider has a key.
    pub fn stt_available(&self) -> bool {
        self.stt_enabled && self.stt_ready()
    }

    /// Synthesis is enabled and the TTS provider has a key.
    pub fn tts_available(&self) -> bool {
        self.tts_enabled && self.tts_ready()
    }

    pub fn stt_ready(&self) -> bool {
        match self.stt_provider.as_str() {
            VOICE_PROVIDER_GROQ => self.groq_api_key.is_some(),
            _ => self.openai_api_key.is_some(),
        }
    }

    pub fn tts_ready(&self) -> bool {
        match self.tts_provider.as_str() {
            VOICE_PROVIDER_GROQ => self.groq_api_key.is_some(),
            _ => self.openai_api_key.is_some(),
        }
    }

    pub fn stt_api_key(&self) -> Option<&str> {
        match self.stt_provider.as_str() {
            VOICE_PROVIDER_GROQ => self.groq_api_key.as_deref(),
            _ => self.openai_api_key.as_deref(),
        }
    }

    pub fn tts_api_key(&self) -> Option<&str> {
        match self.tts_provider.as_str() {
            VOICE_PROVIDER_GROQ => self.groq_api_key.as_deref(),
            _ => self.openai_api_key.as_deref(),
        }
    }

    /// Overlay per-agent accent/voice onto instance TTS.
    ///
    /// `replace_defaults` is true for Pantheo (dial-out) agents: empty fields
    /// use the provider default for that accent, never the instance voice.
    /// For Agora-configured agents, empty slots keep the instance value.
    pub fn overlay_agent_tts(
        &mut self,
        accent: &str,
        voice_openai: &str,
        voice_groq: &str,
        replace_defaults: bool,
    ) {
        let accent = accent.trim();
        let has_accent = is_supported_tts_accent(accent);
        if has_accent {
            self.tts_accent = accent.to_string();
            self.tts_accent_source = AiFieldSource::Config;
        } else if replace_defaults {
            self.tts_accent = DEFAULT_TTS_ACCENT.to_string();
            self.tts_accent_source = AiFieldSource::Default;
        }

        let slot = match self.tts_provider.as_str() {
            VOICE_PROVIDER_GROQ => voice_groq.trim(),
            _ => voice_openai.trim(),
        };
        let suggested = suggested_tts_voices_for(
            &self.tts_provider,
            &self.tts_model,
            &self.tts_accent,
        );
        if !slot.is_empty() && suggested.iter().any(|v| *v == slot) {
            self.tts_voice = slot.to_string();
            self.tts_voice_source = AiFieldSource::Config;
        } else if replace_defaults || !slot.is_empty() {
            self.tts_voice = default_tts_voice_for(
                &self.tts_provider,
                &self.tts_model,
                &self.tts_accent,
            )
            .to_string();
            self.tts_voice_source = AiFieldSource::Default;
        } else if has_accent && !suggested.iter().any(|v| *v == self.tts_voice.as_str()) {
            self.tts_voice = default_tts_voice_for(
                &self.tts_provider,
                &self.tts_model,
                &self.tts_accent,
            )
            .to_string();
            self.tts_voice_source = AiFieldSource::Default;
        }
    }

    /// Back-compat alias used by older call sites that only knew OpenAI.
    pub fn api_key(&self) -> Option<&str> {
        self.openai_api_key.as_deref()
    }

    pub fn api_key_source(&self) -> AiFieldSource {
        self.openai_api_key_source
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
    /// Enabled and the selected provider has credentials. `/api/me` uses
    /// [`Self::enabled`] alone so Ask AI can appear before keys are saved.
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
    /// `openai_api_key_env` / `groq_api_key_env` are typically
    /// `OPENAI_API_KEY` / `GROQ_API_KEY`. Never folded into config.json at boot.
    pub fn voice(
        &self,
        openai_api_key_env: Option<&str>,
        groq_api_key_env: Option<&str>,
    ) -> ResolvedVoice {
        let data = self.data.lock().unwrap();
        let v = &data.ai.voice;
        let (openai_api_key, openai_api_key_source) =
            resolve_secret(&v.api_key, openai_api_key_env);
        let (groq_api_key, groq_api_key_source) =
            resolve_secret(&v.groq_api_key, groq_api_key_env);
        let stt_provider = {
            let p = v.stt_provider.trim();
            if p.is_empty() || !is_supported_stt_provider(p) {
                DEFAULT_STT_PROVIDER.to_string()
            } else {
                p.to_string()
            }
        };
        let tts_provider = {
            let p = v.tts_provider.trim();
            if p.is_empty() || !is_supported_tts_provider(p) {
                DEFAULT_TTS_PROVIDER.to_string()
            } else {
                p.to_string()
            }
        };
        let stt_models = ResolvedVoiceSttModels {
            openai: resolve_setting(
                v.stt_models.get(VOICE_PROVIDER_OPENAI),
                None,
                default_stt_model_for_provider(VOICE_PROVIDER_OPENAI),
            ),
            groq: resolve_setting(
                v.stt_models.get(VOICE_PROVIDER_GROQ),
                None,
                default_stt_model_for_provider(VOICE_PROVIDER_GROQ),
            ),
        };
        let (stt_model, stt_model_source) = match stt_provider.as_str() {
            VOICE_PROVIDER_GROQ => stt_models.groq.clone(),
            _ => stt_models.openai.clone(),
        };
        // Legacy `tts_model` / `tts_voice` were OpenAI-only; fold them into
        // the OpenAI slot so existing config.json keeps its chosen voice.
        let openai_tts_model = if v.tts_models.openai.trim().is_empty() {
            v.tts_model.as_str()
        } else {
            v.tts_models.openai.as_str()
        };
        let groq_tts_model = v.tts_models.groq.as_str();
        let tts_models = ResolvedVoiceTtsModels {
            openai: resolve_setting(
                openai_tts_model,
                None,
                default_tts_model_for_provider(VOICE_PROVIDER_OPENAI),
            ),
            groq: resolve_setting(
                groq_tts_model,
                None,
                default_tts_model_for_provider(VOICE_PROVIDER_GROQ),
            ),
        };
        let (tts_model, tts_model_source) = match tts_provider.as_str() {
            VOICE_PROVIDER_GROQ => tts_models.groq.clone(),
            _ => tts_models.openai.clone(),
        };
        let (tts_accent, tts_accent_source) =
            resolve_tts_accent(&v.tts_accent, &tts_provider, &tts_models.groq.0);
        let openai_tts_voice = if v.tts_voices.openai.trim().is_empty() {
            v.tts_voice.as_str()
        } else {
            v.tts_voices.openai.as_str()
        };
        let groq_tts_voice = v.tts_voices.groq.as_str();
        let tts_voices = ResolvedVoiceTtsVoices {
            openai: resolve_setting(
                openai_tts_voice,
                None,
                default_tts_voice_for(VOICE_PROVIDER_OPENAI, &tts_models.openai.0, &tts_accent),
            ),
            groq: resolve_setting(
                groq_tts_voice,
                None,
                default_tts_voice_for(VOICE_PROVIDER_GROQ, &tts_models.groq.0, &tts_accent),
            ),
        };
        let (tts_voice, tts_voice_source) = match tts_provider.as_str() {
            VOICE_PROVIDER_GROQ => tts_voices.groq.clone(),
            _ => tts_voices.openai.clone(),
        };
        ResolvedVoice {
            stt_enabled: v.stt_enabled,
            tts_enabled: v.tts_enabled,
            stt_provider,
            tts_provider,
            openai_api_key,
            openai_api_key_source,
            groq_api_key,
            groq_api_key_source,
            stt_model,
            stt_model_source,
            stt_models,
            tts_model,
            tts_model_source,
            tts_models,
            tts_voice,
            tts_voice_source,
            tts_voices,
            tts_accent,
            tts_accent_source,
        }
    }

    /// Resolve Ask-AI settings. Env key fallbacks are never folded into
    /// config.json at boot (same rule as voice).
    ///
    /// OpenAI Ask AI shares the voice OpenAI key (`ai.voice.api_key` /
    /// `OPENAI_API_KEY`). Anthropic uses `ai.search.api_key` /
    /// `ANTHROPIC_API_KEY`. Models come from per-provider Settings overrides
    /// or the hard-coded provider default — never from process env.
    pub fn search_ai(
        &self,
        anthropic_api_key_env: Option<&str>,
        openai_api_key_env: Option<&str>,
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
        let models = ResolvedSearchModels {
            anthropic: resolve_provider_model(&s.models, SEARCH_PROVIDER_ANTHROPIC),
            openai: resolve_provider_model(&s.models, SEARCH_PROVIDER_OPENAI),
            codex: resolve_provider_model(&s.models, SEARCH_PROVIDER_CODEX),
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
fn resolve_provider_model(
    models: &AiSearchModels,
    provider: &str,
) -> (String, AiFieldSource) {
    let default = default_model_for_search_provider(provider);
    resolve_setting(models.get(provider), None, default)
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
    fn groq_stt_without_an_openai_key_still_enables_the_microphone() {
        // The whole point of Groq being selectable: someone with no OpenAI
        // account can still record voice notes. Gating the mic on a combined
        // "voice" flag would hide a working feature.
        let dir = tempfile::tempdir().unwrap();
        let cfg = Config::load(dir.path()).unwrap();
        cfg.update(|c| {
            c.ai.voice.stt_provider = VOICE_PROVIDER_GROQ.into();
            c.ai.voice.groq_api_key = "gsk-live".into();
        });
        let v = cfg.voice(None, None);
        assert!(v.stt_available(), "Groq key should enable transcription");
        assert!(!v.tts_available(), "no OpenAI key means no spoken replies");
        assert!(v.available(), "some voice capability exists");

        // Adding the OpenAI key lights up TTS without touching STT.
        cfg.update(|c| c.ai.voice.api_key = "sk-openai".into());
        let v = cfg.voice(None, None);
        assert!(v.stt_available() && v.tts_available());

        // The kill-switch still beats present credentials on both halves.
        cfg.update(|c| {
            c.ai.voice.stt_enabled = false;
            c.ai.voice.tts_enabled = false;
        });
        let v = cfg.voice(None, None);
        assert!(!v.stt_available() && !v.tts_available() && !v.available());
    }

    #[test]
    fn voice_resolver_honors_enabled_and_env_key() {
        let dir = tempfile::tempdir().unwrap();
        let cfg = Config::load(dir.path()).unwrap();
        // Env key alone: available when enabled (default).
        let v = cfg.voice(Some("sk-env"), None);
        assert!(v.available());
        assert_eq!(v.openai_api_key_source, AiFieldSource::Env);
        assert_eq!(v.stt_model, DEFAULT_STT_MODEL);
        // Kill-switch beats a present key.
        cfg.update(|c| {
            c.ai.voice.stt_enabled = false;
            c.ai.voice.tts_enabled = false;
        });
        assert!(!cfg.voice(Some("sk-env"), None).available());
        // Config key wins over env.
        cfg.update(|c| {
            c.ai.voice.stt_enabled = true;
            c.ai.voice.tts_enabled = true;
            c.ai.voice.api_key = "sk-cfg".into();
            c.ai.voice.tts_voice = "shimmer".into();
        });
        let v = cfg.voice(Some("sk-env"), None);
        assert_eq!(v.openai_api_key.as_deref(), Some("sk-cfg"));
        assert_eq!(v.openai_api_key_source, AiFieldSource::Config);
        assert_eq!(v.tts_voice, "shimmer");
        assert_eq!(v.tts_voice_source, AiFieldSource::Config);
    }

    #[test]
    fn voice_stt_provider_switch_keeps_per_provider_models() {
        let dir = tempfile::tempdir().unwrap();
        let cfg = Config::load(dir.path()).unwrap();
        cfg.update(|c| {
            c.ai.voice.stt_models.openai = "whisper-1".into();
            c.ai.voice.stt_models.groq = "whisper-large-v3".into();
            c.ai.voice.stt_provider = VOICE_PROVIDER_OPENAI.into();
            c.ai.voice.api_key = "sk".into();
            c.ai.voice.groq_api_key = "gsk".into();
        });
        let v = cfg.voice(None, None);
        assert_eq!(v.stt_model, "whisper-1");
        cfg.update(|c| c.ai.voice.stt_provider = VOICE_PROVIDER_GROQ.into());
        let v = cfg.voice(None, None);
        assert_eq!(v.stt_model, "whisper-large-v3");
        assert_eq!(v.stt_models.openai.0, "whisper-1");
        assert_ne!(v.stt_model, "whisper-1");
    }

    #[test]
    fn voice_tts_provider_switch_keeps_per_provider_models_and_voices() {
        let dir = tempfile::tempdir().unwrap();
        let cfg = Config::load(dir.path()).unwrap();
        cfg.update(|c| {
            c.ai.voice.tts_models.openai = "tts-1-hd".into();
            c.ai.voice.tts_voices.openai = "shimmer".into();
            c.ai.voice.tts_models.groq = "canopylabs/orpheus-arabic-saudi".into();
            c.ai.voice.tts_voices.groq = "fahad".into();
            c.ai.voice.tts_provider = VOICE_PROVIDER_OPENAI.into();
            c.ai.voice.api_key = "sk".into();
            c.ai.voice.groq_api_key = "gsk".into();
        });
        let v = cfg.voice(None, None);
        assert_eq!(v.tts_model, "tts-1-hd");
        assert_eq!(v.tts_voice, "shimmer");
        assert_eq!(v.tts_accent, crate::config::DEFAULT_TTS_ACCENT);
        cfg.update(|c| c.ai.voice.tts_provider = VOICE_PROVIDER_GROQ.into());
        let v = cfg.voice(None, None);
        assert_eq!(v.tts_model, "canopylabs/orpheus-arabic-saudi");
        assert_eq!(v.tts_voice, "fahad");
        assert_eq!(v.tts_accent, crate::config::TTS_ACCENT_ARABIC);
        assert_eq!(v.tts_models.openai.0, "tts-1-hd");
        assert_eq!(v.tts_voices.openai.0, "shimmer");
    }

    #[test]
    fn tts_accent_survives_provider_switch_and_picks_british_openai_default() {
        let dir = tempfile::tempdir().unwrap();
        let cfg = Config::load(dir.path()).unwrap();
        cfg.update(|c| {
            c.ai.voice.tts_accent = TTS_ACCENT_BRITISH.into();
            c.ai.voice.tts_provider = VOICE_PROVIDER_OPENAI.into();
            c.ai.voice.api_key = "sk".into();
            c.ai.voice.groq_api_key = "gsk".into();
        });
        let v = cfg.voice(None, None);
        assert_eq!(v.tts_accent, TTS_ACCENT_BRITISH);
        assert_eq!(v.tts_voice, DEFAULT_OPENAI_BRITISH_TTS_VOICE);
        cfg.update(|c| c.ai.voice.tts_provider = VOICE_PROVIDER_GROQ.into());
        let v = cfg.voice(None, None);
        assert_eq!(v.tts_accent, TTS_ACCENT_BRITISH);
        assert_eq!(v.tts_voice, DEFAULT_GROQ_TTS_VOICE);
    }

    #[test]
    fn overlay_agent_tts_pantheo_ignores_instance_voice() {
        let dir = tempfile::tempdir().unwrap();
        let cfg = Config::load(dir.path()).unwrap();
        cfg.update(|c| {
            c.ai.voice.tts_voices.openai = "shimmer".into();
            c.ai.voice.tts_accent = TTS_ACCENT_BRITISH.into();
            c.ai.voice.api_key = "sk".into();
        });
        let mut v = cfg.voice(None, None);
        assert_eq!(v.tts_voice, "shimmer");
        assert_eq!(v.tts_accent, TTS_ACCENT_BRITISH);
        v.overlay_agent_tts(TTS_ACCENT_AMERICAN, "onyx", "troy", true);
        assert_eq!(v.tts_accent, TTS_ACCENT_AMERICAN);
        assert_eq!(v.tts_voice, "onyx");
        v.overlay_agent_tts("", "", "", true);
        assert_eq!(v.tts_accent, DEFAULT_TTS_ACCENT);
        assert_eq!(v.tts_voice, DEFAULT_TTS_VOICE);
    }

    #[test]
    fn parse_agent_hello_tts_requires_an_explicit_key() {
        assert!(parse_agent_hello_tts(&serde_json::json!({"id": "bot"})).is_none());
        let got = parse_agent_hello_tts(&serde_json::json!({
            "tts_accent": "british",
            "tts_voices": { "openai": "fable", "groq": "austin" }
        }))
        .unwrap();
        assert_eq!(got, ("british".into(), "fable".into(), "austin".into()));
    }

    #[test]
    fn legacy_tts_model_and_voice_fold_into_the_openai_slot() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("config.json"),
            r#"{"admin_key":"k","session_secret":"s","instance_id":"i","ai":{"voice":{"tts_model":"tts-1","tts_voice":"nova","api_key":"sk"}}}"#,
        )
        .unwrap();
        let cfg = Config::load(dir.path()).unwrap();
        let v = cfg.voice(None, None);
        assert_eq!(v.tts_model, "tts-1");
        assert_eq!(v.tts_voice, "nova");
        assert_eq!(v.tts_model_source, AiFieldSource::Config);
    }

    #[test]
    fn voice_readiness_tracks_each_selected_provider_independently() {
        let dir = tempfile::tempdir().unwrap();
        let cfg = Config::load(dir.path()).unwrap();
        // Groq STT selected but only an OpenAI key present: TTS works, the
        // mic does not. Each half is judged on its own credential.
        cfg.update(|c| {
            c.ai.voice.stt_provider = VOICE_PROVIDER_GROQ.into();
            c.ai.voice.api_key = "sk".into();
        });
        let v = cfg.voice(None, None);
        assert!(!v.stt_available() && v.tts_available());
        // Groq key via env makes STT ready too.
        let v = cfg.voice(None, Some("gsk-env"));
        assert!(v.stt_available() && v.tts_available());
        // Drop OpenAI: Groq STT still works, OpenAI TTS does not.
        cfg.update(|c| c.ai.voice.api_key.clear());
        let v = cfg.voice(None, Some("gsk-env"));
        assert!(v.stt_available() && !v.tts_available() && v.available());
        assert!(cfg.voice(Some("sk-env"), Some("gsk-env")).tts_available());
        // Same Groq key lights TTS once that half is pointed at Groq.
        cfg.update(|c| c.ai.voice.tts_provider = VOICE_PROVIDER_GROQ.into());
        let v = cfg.voice(None, Some("gsk-env"));
        assert!(v.stt_available() && v.tts_available());
        assert_eq!(v.tts_model, DEFAULT_GROQ_TTS_MODEL);
        assert_eq!(v.tts_voice, DEFAULT_GROQ_TTS_VOICE);
        // OpenAI STT+TTS: the one key covers both halves.
        cfg.update(|c| {
            c.ai.voice.stt_provider = VOICE_PROVIDER_OPENAI.into();
            c.ai.voice.tts_provider = VOICE_PROVIDER_OPENAI.into();
        });
        let v = cfg.voice(Some("sk-env"), None);
        assert!(v.stt_available() && v.tts_available());
        // Back on OpenAI for both, a Groq key alone leaves nothing usable.
        assert!(!cfg.voice(None, Some("gsk-env")).available());
    }

    #[test]
    fn superseded_voice_keys_are_ignored_not_migrated() {
        // There is no migration path by design: an older config.json still
        // loads (serde ignores unknown fields) but its `provider` /
        // `stt_model` values are dropped rather than carried forward, and the
        // model falls back to the provider default until re-picked.
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("config.json"),
            r#"{"admin_key":"k","session_secret":"s","instance_id":"i","ai":{"voice":{"provider":"groq","stt_model":"whisper-1","api_key":"sk"}}}"#,
        )
        .unwrap();
        let cfg = Config::load(dir.path()).unwrap();
        let snap = cfg.snapshot();
        assert!(snap.ai.voice.stt_models.openai.is_empty());
        assert_eq!(snap.ai.voice.stt_provider, VOICE_PROVIDER_OPENAI);
        assert_eq!(snap.ai.voice.api_key, "sk", "real settings still load");
        let v = cfg.voice(None, None);
        assert_eq!(v.stt_model, DEFAULT_STT_MODEL);
        assert_eq!(v.stt_model_source, AiFieldSource::Default);
    }

    #[test]
    fn search_ai_resolver_uses_config_model_then_default() {
        let dir = tempfile::tempdir().unwrap();
        let cfg = Config::load(dir.path()).unwrap();
        let s = cfg.search_ai(Some("ant-key"), None);
        assert!(s.available());
        assert_eq!(s.model, DEFAULT_SEARCH_MODEL);
        assert_eq!(s.model_source, AiFieldSource::Default);
        cfg.update(|c| {
            c.ai.search.models.anthropic = "claude-haiku-4-5-20251001".into();
        });
        let s = cfg.search_ai(Some("ant-key"), None);
        assert_eq!(s.model, "claude-haiku-4-5-20251001");
        assert_eq!(s.model_source, AiFieldSource::Config);
    }

    #[test]
    fn search_ai_openai_provider_uses_openai_env_key() {
        let dir = tempfile::tempdir().unwrap();
        let cfg = Config::load(dir.path()).unwrap();
        cfg.update(|c| c.ai.search.provider = SEARCH_PROVIDER_OPENAI.into());
        let s = cfg.search_ai(Some("ant"), Some("sk-openai"));
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
        let s = cfg.search_ai(None, Some("sk-env"));
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
        let s = cfg.search_ai(Some("ant"), Some("sk"));
        assert_eq!(s.model, "claude-opus-5");
        cfg.update(|c| c.ai.search.provider = SEARCH_PROVIDER_OPENAI.into());
        let s = cfg.search_ai(Some("ant"), Some("sk"));
        assert_eq!(s.model, "gpt-4.1");
        assert_eq!(s.models.anthropic.0, "claude-opus-5");
        // Never emit the anthropic override while on openai.
        assert_ne!(s.model, "claude-opus-5");
    }

    #[test]
    fn search_ai_defaults_are_independent_per_provider() {
        let dir = tempfile::tempdir().unwrap();
        let cfg = Config::load(dir.path()).unwrap();
        let resolved = cfg.search_ai(Some("ant"), Some("sk"));
        assert_eq!(resolved.models.anthropic.0, DEFAULT_SEARCH_MODEL);
        assert_eq!(resolved.models.anthropic.1, AiFieldSource::Default);
        assert_eq!(resolved.models.openai.0, crate::ai::DEFAULT_OPENAI_SEARCH_MODEL);
        assert_eq!(resolved.models.openai.1, AiFieldSource::Default);
        assert_eq!(resolved.models.codex.0, crate::codex_oauth::DEFAULT_CODEX_MODEL);
        assert_eq!(resolved.models.codex.1, AiFieldSource::Default);

        cfg.update(|c| c.ai.search.provider = SEARCH_PROVIDER_OPENAI.into());
        let s = cfg.search_ai(Some("ant"), Some("sk"));
        assert_eq!(s.model, crate::ai::DEFAULT_OPENAI_SEARCH_MODEL);

        cfg.update(|c| c.ai.search.provider = SEARCH_PROVIDER_CODEX.into());
        let s = cfg.search_ai(None, None);
        assert_eq!(s.model, crate::codex_oauth::DEFAULT_CODEX_MODEL);
    }

    #[test]
    fn legacy_top_level_search_model_in_config_is_ignored() {
        // Pre-per-provider configs used ai.search.model. That field is gone;
        // unknown JSON keys are ignored and the provider default applies.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        std::fs::write(
            &path,
            r#"{"admin_key":"k","session_secret":"s","instance_id":"i","ai":{"search":{"provider":"anthropic","model":"claude-opus-5"}}}"#,
        )
        .unwrap();
        let cfg = Config::load(dir.path()).unwrap();
        let snap = cfg.snapshot();
        assert!(snap.ai.search.models.anthropic.is_empty());
        cfg.update(|c| c.ai.search.provider = SEARCH_PROVIDER_OPENAI.into());
        let s = cfg.search_ai(None, Some("sk"));
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
        let s = cfg.search_ai(None, None);
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
