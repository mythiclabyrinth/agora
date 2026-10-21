//! ChatGPT / Codex CLI OAuth helpers for Ask AI.
//!
//! Auth is **authorization_code + PKCE** with the public Codex CLI client id
//! and its registered loopback redirect (`http://localhost:1455/auth/callback`)
//! — the same flow `codex login` uses. There is no device-code grant.
//!
//! Token endpoints and the Codex responses URL stay hard-coded (no
//! admin-settable base URL — SSRF / key-exfiltration risk).

use std::io::Read;
use std::time::Duration;

use base64::engine::general_purpose::{URL_SAFE_NO_PAD, STANDARD as B64};
use base64::Engine;
use rand::RngCore;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

/// Public Codex CLI OAuth client id (installed app; not a secret).
pub const CODEX_OAUTH_CLIENT_ID: &str = "app_EMoamEEZ73f0CkXaXp7hrann";

/// Loopback redirect registered for the Codex CLI client.
pub const CODEX_OAUTH_REDIRECT_URI: &str = "http://localhost:1455/auth/callback";

const AUTHORIZE_URL: &str = "https://auth.openai.com/oauth/authorize";
/// Path the Codex CLI uses (verified by refresh in the wild). Discovery also
/// advertises `/api/accounts/oauth/token` — do not swap without a live check.
const TOKEN_URL: &str = "https://auth.openai.com/oauth/token";
const CODEX_RESPONSES_URL: &str = "https://chatgpt.com/backend-api/codex/responses";

const OAUTH_SCOPES: &str = "openid profile email offline_access";

const TIMEOUT: Duration = Duration::from_secs(60);

/// Default Ask-AI model when provider is `codex`.
pub const DEFAULT_CODEX_MODEL: &str = "gpt-6-sol";

/// Client version the Codex CLI sends when listing models. Required by
/// `GET …/codex/models` (`client_version` query param). Bump when updating
/// the fallback catalog from a newer CLI cache.
pub const CODEX_CLIENT_VERSION: &str = "0.156.1";

/// Fallback suggestions when the live Codex catalog cannot be fetched
/// (OAuth not linked, network error, cold cache, etc.). Prefer live
/// `/models?client_version=…` when linked.
pub const SUGGESTED_CODEX_MODELS: &[&str] = &[
    "gpt-6-sol",
    "gpt-6-luna",
    "gpt-5.6-sol",
    "gpt-5.6-terra",
    "gpt-5.6-luna",
    "gpt-5.5",
    "gpt-5.4",
    "gpt-5.4-mini",
    "gpt-5.3-codex-spark",
    "codex-auto-review",
    "gpt-5.1",
    "gpt-5.1-codex",
    "gpt-5.1-codex-mini",
    "gpt-4.1",
];

const CODEX_MODELS_URL: &str = "https://chatgpt.com/backend-api/codex/models";

#[derive(Clone, Debug)]
pub struct CodexTokens {
    pub access_token: String,
    pub refresh_token: String,
    pub account_id: String,
}

#[derive(Clone, Debug)]
pub struct PkceChallenge {
    pub verifier: String,
    pub challenge: String,
    pub state: String,
}

/// Generate PKCE verifier/challenge + opaque CSRF `state`.
pub fn generate_pkce() -> PkceChallenge {
    let mut verifier_bytes = [0u8; 32];
    let mut state_bytes = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut verifier_bytes);
    rand::thread_rng().fill_bytes(&mut state_bytes);
    let verifier = URL_SAFE_NO_PAD.encode(verifier_bytes);
    let mut hasher = Sha256::new();
    hasher.update(verifier.as_bytes());
    let challenge = URL_SAFE_NO_PAD.encode(hasher.finalize());
    let state = URL_SAFE_NO_PAD.encode(state_bytes);
    PkceChallenge {
        verifier,
        challenge,
        state,
    }
}

/// Build the ChatGPT authorize URL for a PKCE start.
pub fn build_authorize_url(challenge: &str, state: &str) -> String {
    format!(
        "{AUTHORIZE_URL}?response_type=code&client_id={}&redirect_uri={}&scope={}&code_challenge={}&code_challenge_method=S256&state={}",
        urlencoding_form(CODEX_OAUTH_CLIENT_ID),
        urlencoding_form(CODEX_OAUTH_REDIRECT_URI),
        urlencoding_form(OAUTH_SCOPES),
        urlencoding_form(challenge),
        urlencoding_form(state),
    )
}

/// Exchange an authorization code + PKCE verifier for tokens.
pub fn exchange_code(code: &str, verifier: &str) -> anyhow::Result<CodexTokens> {
    let code = code.trim();
    let verifier = verifier.trim();
    anyhow::ensure!(!code.is_empty(), "authorization code required");
    anyhow::ensure!(!verifier.is_empty(), "pkce verifier required");
    let body = format!(
        "grant_type=authorization_code&code={}&redirect_uri={}&client_id={}&code_verifier={}",
        urlencoding_form(code),
        urlencoding_form(CODEX_OAUTH_REDIRECT_URI),
        urlencoding_form(CODEX_OAUTH_CLIENT_ID),
        urlencoding_form(verifier),
    );
    let response = ureq::post(TOKEN_URL)
        .timeout(TIMEOUT)
        .set("Content-Type", "application/x-www-form-urlencoded")
        .send_string(&body)
        .map_err(flatten_http_error)?;
    tokens_from_token_response(response.into_json()?, None)
}

/// Refresh a ChatGPT access token. Returns updated tokens (refresh may rotate).
pub fn refresh_access_token(refresh_token: &str) -> anyhow::Result<CodexTokens> {
    let refresh_token = refresh_token.trim();
    anyhow::ensure!(!refresh_token.is_empty(), "refresh token required");
    let body = format!(
        "grant_type=refresh_token&refresh_token={}&client_id={}",
        urlencoding_form(refresh_token),
        urlencoding_form(CODEX_OAUTH_CLIENT_ID),
    );
    let response = ureq::post(TOKEN_URL)
        .timeout(TIMEOUT)
        .set("Content-Type", "application/x-www-form-urlencoded")
        .send_string(&body)
        .map_err(flatten_http_error)?;
    tokens_from_token_response(response.into_json()?, Some(refresh_token))
}

fn tokens_from_token_response(
    parsed: Value,
    fallback_refresh: Option<&str>,
) -> anyhow::Result<CodexTokens> {
    let access = parsed["access_token"]
        .as_str()
        .unwrap_or("")
        .trim()
        .to_string();
    anyhow::ensure!(!access.is_empty(), "oauth token response has no access_token");
    let new_refresh = parsed["refresh_token"]
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .or_else(|| fallback_refresh.map(str::to_string))
        .unwrap_or_default();
    anyhow::ensure!(!new_refresh.is_empty(), "oauth token response has no refresh_token");
    let mut account_id = parsed["account_id"]
        .as_str()
        .or_else(|| parsed["chatgpt_account_id"].as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if account_id.is_empty() {
        if let Some(id_token) = parsed["id_token"].as_str() {
            account_id = account_id_from_id_token(id_token).unwrap_or_default();
        }
    }
    Ok(CodexTokens {
        access_token: access,
        refresh_token: new_refresh,
        account_id,
    })
}

/// Best-effort account id from an unsigned JWT payload (no signature check —
/// we only use this as a display hint after a successful token exchange).
fn account_id_from_id_token(id_token: &str) -> Option<String> {
    let payload = id_token.split('.').nth(1)?;
    let bytes = URL_SAFE_NO_PAD.decode(payload).or_else(|_| B64.decode(payload)).ok()?;
    let v: Value = serde_json::from_slice(&bytes).ok()?;
    v.get("chatgpt_account_id")
        .or_else(|| v.get("account_id"))
        .and_then(|x| x.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// Parse `code` + `state` from a redirect URL (or bare query string).
pub fn parse_redirect_callback(input: &str) -> anyhow::Result<(String, String)> {
    let input = input.trim();
    anyhow::ensure!(!input.is_empty(), "redirect URL required");
    let query = if let Some(q) = input.split_once('?').map(|(_, q)| q) {
        q
    } else if input.contains('=') {
        input
    } else {
        anyhow::bail!("no query string in redirect URL");
    };
    let mut code = None;
    let mut state = None;
    let mut oauth_error = None;
    for pair in query.split('&') {
        let mut it = pair.splitn(2, '=');
        let k = it.next().unwrap_or("");
        let v = it.next().unwrap_or("");
        let v = urlencoding_decode(v);
        match k {
            "code" => code = Some(v),
            "state" => state = Some(v),
            "error" => oauth_error = Some(v),
            _ => {}
        }
    }
    if let Some(e) = oauth_error {
        anyhow::bail!("OAuth error: {e}");
    }
    let code = code.filter(|s| !s.is_empty()).ok_or_else(|| anyhow::anyhow!("missing code"))?;
    let state = state.filter(|s| !s.is_empty()).ok_or_else(|| anyhow::anyhow!("missing state"))?;
    Ok((code, state))
}

/// Parse a Codex CLI `auth.json` object into tokens (advanced fallback).
pub fn tokens_from_auth_json(auth: &Value) -> anyhow::Result<CodexTokens> {
    let tokens = auth.get("tokens").unwrap_or(auth);
    let access = tokens["access_token"]
        .as_str()
        .unwrap_or("")
        .trim()
        .to_string();
    let refresh = tokens["refresh_token"]
        .as_str()
        .unwrap_or("")
        .trim()
        .to_string();
    let account_id = tokens["account_id"]
        .as_str()
        .unwrap_or("")
        .trim()
        .to_string();
    anyhow::ensure!(!refresh.is_empty(), "auth.json has no refresh_token");
    Ok(CodexTokens {
        access_token: access,
        refresh_token: refresh,
        account_id,
    })
}

/// Body for a Codex `/responses` call. Two constraints this backend enforces
/// and the plain OpenAI Responses API does not, both verified against the live
/// endpoint — a request violating either is rejected with a 400 before any
/// tokens are produced:
///
/// - `stream` must be `true` ("Stream must be set to true").
/// - `max_output_tokens` must be absent ("Unsupported parameter"), so answer
///   length is steered by the system prompt alone. The Anthropic path still
///   caps properly.
fn answer_request_body(model: &str, prompt: &str) -> Value {
    json!({
        "model": model,
        "store": false,
        "stream": true,
        "instructions": crate::ai::SYSTEM_PROMPT,
        "input": [{
            "role": "user",
            "content": [{"type": "input_text", "text": prompt}]
        }],
    })
}

/// Ask Codex (ChatGPT backend) to answer from numbered excerpts.
///
/// Streams because the endpoint requires it (see [`answer_request_body`]), but
/// returns one completed string — Ask AI's UI is not a live typewriter.
pub fn answer(
    access_token: &str,
    account_id: &str,
    model: &str,
    question: &str,
    context: &[Value],
) -> anyhow::Result<String> {
    anyhow::ensure!(!context.is_empty(), "no matching messages to answer from");
    let excerpts = crate::ai::format_excerpts(context);
    let prompt = format!("Question: {question}\n\nMessage excerpts:\n\n{excerpts}");
    let mut req = ureq::post(CODEX_RESPONSES_URL)
        .timeout(TIMEOUT)
        .set("Authorization", &format!("Bearer {access_token}"))
        .set("Content-Type", "application/json")
        .set("Accept", "text/event-stream")
        .set("OpenAI-Beta", "responses=experimental");
    if !account_id.trim().is_empty() {
        req = req.set("ChatGPT-Account-Id", account_id.trim());
    }
    let response = req
        .send_json(answer_request_body(model, &prompt))
        .map_err(flatten_http_error)?;
    let mut body = String::new();
    response
        .into_reader()
        .take(8 * 1024 * 1024)
        .read_to_string(&mut body)?;
    let text = extract_sse_text(&body)?;
    Ok(text.trim().to_string())
}

// ------------------------------------------------------------ tool calling
//
// Jarvis mode drives the same `/responses` endpoint with function tools,
// mirroring what the Codex CLI sends (`codex-rs` ResponsesApiRequest):
//
// - `tools`: `[{"type":"function","name","description","strict":false,"parameters"}]`
// - `tool_choice: "auto"`, `parallel_tool_calls: false` (one call per step
//   keeps the status orb honest and the transcript linear)
// - `store: false`, so nothing persists server-side and every request replays
//   the whole transcript as `input` items. Replayed `function_call` items must
//   omit the server `id` ("Items are not persisted when `store` is false"),
//   and their results go back as `{"type":"function_call_output","call_id","output"}`.
//
// Reasoning items are not replayed: that needs `include:
// ["reasoning.encrypted_content"]`, which some models reject, and dropping
// them only costs the model its private scratchpad between steps.

/// One function call the model asked for.
#[derive(Clone, Debug, PartialEq)]
pub struct FunctionCall {
    pub call_id: String,
    pub name: String,
    /// Raw JSON arguments string, exactly as the model produced it.
    pub arguments: String,
}

/// What one streamed `/responses` round produced.
#[derive(Clone, Debug, Default)]
pub struct ToolTurn {
    pub text: String,
    pub calls: Vec<FunctionCall>,
}

/// Request body for a tool-enabled streamed round. Same two backend
/// constraints as [`answer_request_body`]: `stream: true`, no `max_output_tokens`.
pub fn tool_request_body(model: &str, instructions: &str, input: &[Value], tools: &[Value]) -> Value {
    let mut body = json!({
        "model": model,
        "store": false,
        "stream": true,
        "instructions": instructions,
        "input": input,
    });
    if !tools.is_empty() {
        body["tools"] = json!(tools);
        body["tool_choice"] = json!("auto");
        body["parallel_tool_calls"] = json!(false);
    }
    body
}

/// Incremental parser state for a Responses SSE stream with tool calls.
#[derive(Default)]
pub struct ToolStreamAccumulator {
    pub text: String,
    pub calls: Vec<FunctionCall>,
    /// function_call items keyed by item id while their arguments stream in —
    /// the fallback when a stream ends without `output_item.done`.
    pending: Vec<(String, FunctionCall)>,
    pub completed: bool,
    pub error: Option<String>,
}

impl ToolStreamAccumulator {
    fn push_call(&mut self, call: FunctionCall) {
        if call.name.is_empty() || self.calls.iter().any(|c| c.call_id == call.call_id) {
            return;
        }
        self.calls.push(call);
    }

    fn call_from_item(item: &Value) -> Option<FunctionCall> {
        (item["type"] == "function_call").then(|| FunctionCall {
            call_id: item["call_id"]
                .as_str()
                .or_else(|| item["id"].as_str())
                .unwrap_or_default()
                .to_string(),
            name: item["name"].as_str().unwrap_or_default().to_string(),
            arguments: item["arguments"].as_str().unwrap_or("{}").to_string(),
        })
    }

    /// Feed one SSE `data:` payload. Returns a text delta to surface live.
    pub fn feed(&mut self, payload: &str) -> Option<String> {
        if payload == "[DONE]" {
            self.completed = true;
            return None;
        }
        let v: Value = serde_json::from_str(payload).ok()?;
        let ty = v["type"].as_str().unwrap_or("");
        match ty {
            "response.output_text.delta" => {
                let d = v["delta"].as_str()?.to_string();
                self.text.push_str(&d);
                Some(d)
            }
            "response.output_item.added" => {
                if let Some(call) = Self::call_from_item(&v["item"]) {
                    let id = v["item"]["id"].as_str().unwrap_or(&call.call_id).to_string();
                    self.pending.push((id, call));
                }
                None
            }
            "response.function_call_arguments.delta" => {
                let id = v["item_id"].as_str().unwrap_or_default();
                if let Some((_, call)) = self.pending.iter_mut().find(|(k, _)| k == id) {
                    call.arguments.push_str(v["delta"].as_str().unwrap_or_default());
                }
                None
            }
            "response.function_call_arguments.done" => {
                let id = v["item_id"].as_str().unwrap_or_default();
                if let (Some((_, call)), Some(args)) = (
                    self.pending.iter_mut().find(|(k, _)| k == id),
                    v["arguments"].as_str(),
                ) {
                    call.arguments = args.to_string();
                }
                None
            }
            "response.output_item.done" => {
                let item = &v["item"];
                if let Some(call) = Self::call_from_item(item) {
                    self.push_call(call);
                } else if item["type"] == "message" && self.text.is_empty() {
                    self.text = extract_responses_text(&json!({"output": [item]}));
                }
                None
            }
            "response.completed" | "response.done" => {
                self.completed = true;
                let resp = v.get("response").unwrap_or(&v);
                if let Some(items) = resp["output"].as_array() {
                    for item in items {
                        if let Some(call) = Self::call_from_item(item) {
                            self.push_call(call);
                        }
                    }
                }
                if self.text.is_empty() {
                    self.text = extract_responses_text(resp);
                }
                None
            }
            "response.failed" | "response.incomplete" | "error" => {
                let msg = v
                    .pointer("/response/error/message")
                    .or_else(|| v.pointer("/error/message"))
                    .or_else(|| v.pointer("/response/incomplete_details/reason"))
                    .and_then(|x| x.as_str())
                    .or_else(|| v["message"].as_str())
                    .unwrap_or(ty);
                self.error = Some(msg.to_string());
                None
            }
            _ => None,
        }
    }

    /// Close the stream: promote half-finished calls, surface errors.
    pub fn finish(mut self) -> anyhow::Result<ToolTurn> {
        if let Some(err) = self.error.take() {
            anyhow::bail!("Codex stream error: {err}");
        }
        for (_, call) in std::mem::take(&mut self.pending) {
            self.push_call(call);
        }
        anyhow::ensure!(
            !self.text.trim().is_empty() || !self.calls.is_empty(),
            "empty response from Codex stream"
        );
        Ok(ToolTurn { text: self.text, calls: self.calls })
    }
}

/// Split a byte stream of SSE into `data:` payloads as lines arrive.
#[derive(Default)]
pub struct SseLineBuffer {
    data: Vec<String>,
}

impl SseLineBuffer {
    /// Feed one line (without its newline). Returns a complete payload when a
    /// blank line closes an event.
    pub fn line(&mut self, raw: &str) -> Option<String> {
        let line = raw.trim_end_matches('\r');
        if line.is_empty() {
            if self.data.is_empty() {
                return None;
            }
            let out = self.data.join("\n");
            self.data.clear();
            return Some(out);
        }
        if let Some(rest) = line.strip_prefix("data:") {
            self.data.push(rest.strip_prefix(' ').unwrap_or(rest).to_string());
        }
        None
    }

    pub fn flush(&mut self) -> Option<String> {
        self.line("")
    }
}

/// Run one tool-enabled round against Codex, calling `on_delta` for each
/// streamed text chunk as it arrives. Blocking — call from `spawn_blocking`.
pub fn stream_tool_turn(
    access_token: &str,
    account_id: &str,
    body: &Value,
    on_delta: &mut dyn FnMut(&str),
) -> anyhow::Result<ToolTurn> {
    use std::io::BufRead;
    let mut req = ureq::post(CODEX_RESPONSES_URL)
        // Generous: a streamed tool round can think for a while before the
        // first byte; the read itself is bounded below.
        .timeout(Duration::from_secs(180))
        .set("Authorization", &format!("Bearer {access_token}"))
        .set("Content-Type", "application/json")
        .set("Accept", "text/event-stream")
        .set("OpenAI-Beta", "responses=experimental");
    if !account_id.trim().is_empty() {
        req = req.set("ChatGPT-Account-Id", account_id.trim());
    }
    let response = req.send_json(body.clone()).map_err(flatten_http_error)?;
    let reader = std::io::BufReader::new(response.into_reader().take(16 * 1024 * 1024));
    let mut lines = SseLineBuffer::default();
    let mut acc = ToolStreamAccumulator::default();
    for line in reader.lines() {
        let line = line?;
        if let Some(payload) = lines.line(&line) {
            if let Some(d) = acc.feed(&payload) {
                on_delta(&d);
            }
        }
    }
    if let Some(payload) = lines.flush() {
        if let Some(d) = acc.feed(&payload) {
            on_delta(&d);
        }
    }
    acc.finish()
}

/// True for errors that a token refresh can fix.
pub fn is_auth_error(e: &anyhow::Error) -> bool {
    let s = e.to_string();
    s.starts_with("HTTP 401") || s.starts_with("HTTP 403")
}

/// Cheap auth probe with a tiny synthetic excerpt.
pub fn test_connection(access_token: &str, account_id: &str, model: &str) -> anyhow::Result<()> {
    let ctx = vec![json!({
        "author_name": "test",
        "group_name": "test",
        "channel_name": "test",
        "ts": 0.0,
        "text": "ping",
    })];
    let _ = answer(access_token, account_id, model, "Say ok", &ctx)?;
    Ok(())
}

/// Fetch the live Codex model catalog (same source the Codex CLI caches).
/// Requires `client_version` — without it the ChatGPT backend returns 400.
/// Filters to list-visible / API-supported entries when those flags are present.
pub fn list_models(access_token: &str, account_id: &str) -> anyhow::Result<Vec<String>> {
    let access_token = access_token.trim();
    anyhow::ensure!(!access_token.is_empty(), "access token required");
    let models = fetch_models_json(&models_list_url(), access_token, account_id)?;
    anyhow::ensure!(!models.is_empty(), "empty Codex models list");
    Ok(models)
}

pub fn models_list_url() -> String {
    format!(
        "{CODEX_MODELS_URL}?client_version={}",
        urlencoding_form(CODEX_CLIENT_VERSION)
    )
}

fn fetch_models_json(
    url: &str,
    access_token: &str,
    account_id: &str,
) -> anyhow::Result<Vec<String>> {
    let mut req = ureq::get(url)
        .timeout(Duration::from_secs(30))
        .set("Authorization", &format!("Bearer {access_token}"))
        .set("OpenAI-Beta", "responses=experimental")
        .set("User-Agent", "agora/codex-oauth");
    if !account_id.trim().is_empty() {
        req = req.set("ChatGPT-Account-Id", account_id.trim());
    }
    let response = req.call().map_err(flatten_http_error)?;
    let parsed: Value = response.into_json()?;
    Ok(parse_models_payload(&parsed))
}

fn parse_models_payload(parsed: &Value) -> Vec<String> {
    let entries = parsed
        .get("models")
        .and_then(|v| v.as_array())
        .or_else(|| parsed.get("data").and_then(|v| v.as_array()))
        .cloned()
        .unwrap_or_default();
    let mut out = Vec::new();
    for entry in entries {
        let slug = entry
            .get("slug")
            .or_else(|| entry.get("id"))
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty());
        let Some(slug) = slug else { continue };
        // When the catalog advertises visibility / API support, honour it —
        // otherwise keep the entry (older response shapes).
        if let Some(vis) = entry.get("visibility").and_then(|v| v.as_str()) {
            if vis != "list" {
                continue;
            }
        }
        if let Some(api) = entry.get("supported_in_api") {
            if api.as_bool() == Some(false) {
                continue;
            }
        }
        if !out.iter().any(|s| s == slug) {
            out.push(slug.to_string());
        }
    }
    out
}

fn extract_responses_text(parsed: &Value) -> String {
    if let Some(arr) = parsed["output"].as_array() {
        let mut out = String::new();
        for item in arr {
            if let Some(content) = item["content"].as_array() {
                for block in content {
                    if let Some(t) = block["text"].as_str() {
                        out.push_str(t);
                    }
                }
            }
        }
        if !out.is_empty() {
            return out;
        }
    }
    parsed["output_text"]
        .as_str()
        .or_else(|| parsed["text"].as_str())
        .unwrap_or("")
        .to_string()
}

/// Collect assistant text from a Codex/OpenAI Responses SSE body.
/// Prefer concatenated `output_text.delta` events; fall back to the completed
/// response object when deltas were omitted.
fn extract_sse_text(body: &str) -> anyhow::Result<String> {
    let mut deltas = String::new();
    let mut completed = String::new();
    let mut stream_error: Option<String> = None;
    for payload in sse_data_payloads(body) {
        if payload == "[DONE]" {
            break;
        }
        let Ok(v) = serde_json::from_str::<Value>(&payload) else {
            continue;
        };
        if let Some(msg) = v
            .pointer("/error/message")
            .and_then(|x| x.as_str())
            .or_else(|| v["message"].as_str().filter(|_| v["type"].as_str() == Some("error")))
        {
            stream_error = Some(msg.to_string());
            continue;
        }
        let ty = v["type"].as_str().unwrap_or("");
        if ty.ends_with("output_text.delta") {
            if let Some(d) = v["delta"].as_str() {
                deltas.push_str(d);
            }
        } else if ty == "response.completed" || ty.ends_with("response.completed") {
            let resp = v.get("response").unwrap_or(&v);
            let text = extract_responses_text(resp);
            if !text.is_empty() {
                completed = text;
            }
        }
    }
    if let Some(err) = stream_error {
        anyhow::bail!("Codex stream error: {err}");
    }
    let text = if !deltas.trim().is_empty() {
        deltas
    } else {
        completed
    };
    anyhow::ensure!(!text.trim().is_empty(), "empty answer from Codex stream");
    Ok(text)
}

/// Yield each SSE `data:` payload (multi-line data joined with `\n`).
fn sse_data_payloads(body: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut data_lines: Vec<String> = Vec::new();
    for raw in body.split('\n') {
        let line = raw.trim_end_matches('\r');
        if line.is_empty() {
            if !data_lines.is_empty() {
                out.push(data_lines.join("\n"));
                data_lines.clear();
            }
            continue;
        }
        if let Some(rest) = line.strip_prefix("data:") {
            data_lines.push(rest.strip_prefix(' ').unwrap_or(rest).to_string());
        }
        // Ignore event:/id:/comment lines — type lives inside the JSON.
    }
    if !data_lines.is_empty() {
        out.push(data_lines.join("\n"));
    }
    out
}

fn flatten_http_error(e: ureq::Error) -> anyhow::Error {
    match e {
        ureq::Error::Status(code, resp) => {
            let body = resp.into_string().unwrap_or_default();
            let detail = serde_json::from_str::<Value>(&body)
                .ok()
                .and_then(|v| {
                    // OAuth token errors: {"error":"invalid_grant","error_description":"…"}
                    match (v["error"].as_str(), v["error_description"].as_str()) {
                        (Some(kind), Some(desc)) if v["error"].is_string() => {
                            Some(format!("{kind}: {desc}"))
                        }
                        _ => v["error"]["message"]
                            .as_str()
                            .or_else(|| v["error_description"].as_str())
                            .or_else(|| v["error"].as_str())
                            .or_else(|| v["detail"].as_str())
                            .map(str::to_string),
                    }
                })
                .unwrap_or(body);
            anyhow::anyhow!(
                "HTTP {code}: {}",
                detail.chars().take(300).collect::<String>()
            )
        }
        other => other.into(),
    }
}

fn urlencoding_form(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char);
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

fn urlencoding_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let h = |c: u8| -> Option<u8> {
                match c {
                    b'0'..=b'9' => Some(c - b'0'),
                    b'a'..=b'f' => Some(c - b'a' + 10),
                    b'A'..=b'F' => Some(c - b'A' + 10),
                    _ => None,
                }
            };
            if let (Some(a), Some(b)) = (h(bytes[i + 1]), h(bytes[i + 2])) {
                out.push((a << 4) | b);
                i += 3;
                continue;
            }
        }
        if bytes[i] == b'+' {
            out.push(b' ');
        } else {
            out.push(bytes[i]);
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pkce_challenge_is_s256_of_verifier() {
        let pkce = generate_pkce();
        assert!(!pkce.verifier.is_empty());
        assert!(!pkce.state.is_empty());
        let mut hasher = Sha256::new();
        hasher.update(pkce.verifier.as_bytes());
        assert_eq!(pkce.challenge, URL_SAFE_NO_PAD.encode(hasher.finalize()));
        let url = build_authorize_url(&pkce.challenge, &pkce.state);
        assert!(url.contains("code_challenge_method=S256"));
        assert!(url.contains("localhost%3A1455"));
    }

    #[test]
    fn parse_redirect_callback_from_full_url() {
        let (code, state) = parse_redirect_callback(
            "http://localhost:1455/auth/callback?code=abc%2Fdef&state=xyz",
        )
        .unwrap();
        assert_eq!(code, "abc/def");
        assert_eq!(state, "xyz");
    }

    #[test]
    fn parse_redirect_callback_rejects_error() {
        let err = parse_redirect_callback(
            "http://localhost:1455/auth/callback?error=access_denied&state=x",
        )
        .unwrap_err();
        assert!(err.to_string().contains("access_denied"));
    }

    #[test]
    fn tokens_from_auth_json_reads_nested_tokens() {
        let auth = json!({
            "auth_mode": "chatgpt",
            "tokens": {
                "access_token": "at",
                "refresh_token": "rt",
                "account_id": "acct",
            }
        });
        let t = tokens_from_auth_json(&auth).unwrap();
        assert_eq!(t.access_token, "at");
        assert_eq!(t.refresh_token, "rt");
        assert_eq!(t.account_id, "acct");
    }

    #[test]
    fn tokens_from_auth_json_requires_refresh() {
        let auth = json!({"tokens": {"access_token": "at"}});
        assert!(tokens_from_auth_json(&auth).is_err());
    }

    #[test]
    fn models_list_url_includes_required_client_version() {
        let url = models_list_url();
        assert!(url.starts_with("https://chatgpt.com/backend-api/codex/models?"));
        assert!(url.contains(&format!("client_version={CODEX_CLIENT_VERSION}")));
        assert!(!url.contains("/v1/models"));
    }

    #[test]
    fn answer_request_streams_and_omits_max_output_tokens() {
        // Both of these were live 400s from the Codex backend, one hiding
        // behind the other. Pin them so a "tidy-up" can't reintroduce either.
        let body = answer_request_body("gpt-5.6-sol", "Question: hi");
        assert_eq!(body["stream"], true);
        assert!(body.get("max_output_tokens").is_none());
        assert_eq!(body["model"], "gpt-5.6-sol");
        assert_eq!(body["store"], false);
    }

    #[test]
    fn extract_sse_text_concatenates_output_text_deltas() {
        let body = "\
event: response.output_text.delta\n\
data: {\"type\":\"response.output_text.delta\",\"delta\":\"Hello\"}\n\
\n\
event: response.output_text.delta\n\
data: {\"type\":\"response.output_text.delta\",\"delta\":\" world\"}\n\
\n\
event: response.completed\n\
data: {\"type\":\"response.completed\",\"response\":{\"output\":[]}}\n\
\n";
        assert_eq!(extract_sse_text(body).unwrap(), "Hello world");
    }

    #[test]
    fn extract_sse_text_falls_back_to_completed_response() {
        let body = "\
data: {\"type\":\"response.completed\",\"response\":{\"output\":[{\"content\":[{\"text\":\"from completed\"}]}]}}\n\
\n";
        assert_eq!(extract_sse_text(body).unwrap(), "from completed");
    }

    #[test]
    fn extract_sse_text_surfaces_stream_errors() {
        let body = "\
data: {\"type\":\"error\",\"error\":{\"message\":\"Stream must be set to true\"}}\n\
\n";
        let err = extract_sse_text(body).unwrap_err().to_string();
        assert!(err.contains("Stream must be set to true"));
    }

    fn feed_all(body: &str) -> (ToolStreamAccumulator, String) {
        let mut lines = SseLineBuffer::default();
        let mut acc = ToolStreamAccumulator::default();
        let mut live = String::new();
        for line in body.split('\n') {
            if let Some(p) = lines.line(line) {
                if let Some(d) = acc.feed(&p) {
                    live.push_str(&d);
                }
            }
        }
        if let Some(p) = lines.flush() {
            acc.feed(&p);
        }
        (acc, live)
    }

    #[test]
    fn tool_request_body_matches_codex_cli_shape() {
        let tools = vec![json!({"type":"function","name":"get_unreads","description":"d","strict":false,
            "parameters":{"type":"object","properties":{}}})];
        let input = vec![
            json!({"type":"message","role":"user","content":[{"type":"input_text","text":"hi"}]}),
            json!({"type":"function_call","call_id":"call_1","name":"get_unreads","arguments":"{}"}),
            json!({"type":"function_call_output","call_id":"call_1","output":"{\"items\":[]}"}),
        ];
        let body = tool_request_body("gpt-5.6-sol", "be brief", &input, &tools);
        assert_eq!(body["stream"], true);
        assert_eq!(body["store"], false);
        assert!(body.get("max_output_tokens").is_none());
        assert_eq!(body["tool_choice"], "auto");
        assert_eq!(body["parallel_tool_calls"], false);
        assert_eq!(body["tools"][0]["type"], "function");
        assert_eq!(body["input"][1]["type"], "function_call");
        // store=false: replayed items must not reference server item ids.
        assert!(body["input"][1].get("id").is_none());
        assert_eq!(body["input"][2]["call_id"], "call_1");
        let bare = tool_request_body("m", "i", &input, &[]);
        assert!(bare.get("tools").is_none() && bare.get("tool_choice").is_none());
    }

    #[test]
    fn tool_stream_collects_function_call_from_item_events() {
        // Fixture in the event order the Responses API streams a tool call.
        let body = "\
event: response.created\n\
data: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_1\"}}\n\
\n\
event: response.output_item.added\n\
data: {\"type\":\"response.output_item.added\",\"output_index\":0,\"item\":{\"type\":\"function_call\",\"id\":\"fc_1\",\"call_id\":\"call_abc\",\"name\":\"read_channel\",\"arguments\":\"\"}}\n\
\n\
data: {\"type\":\"response.function_call_arguments.delta\",\"item_id\":\"fc_1\",\"delta\":\"{\\\"channel\\\":\"}\n\
\n\
data: {\"type\":\"response.function_call_arguments.delta\",\"item_id\":\"fc_1\",\"delta\":\"\\\"general\\\"}\"}\n\
\n\
data: {\"type\":\"response.function_call_arguments.done\",\"item_id\":\"fc_1\",\"arguments\":\"{\\\"channel\\\":\\\"general\\\"}\"}\n\
\n\
data: {\"type\":\"response.output_item.done\",\"output_index\":0,\"item\":{\"type\":\"function_call\",\"id\":\"fc_1\",\"call_id\":\"call_abc\",\"name\":\"read_channel\",\"arguments\":\"{\\\"channel\\\":\\\"general\\\"}\",\"status\":\"completed\"}}\n\
\n\
data: {\"type\":\"response.completed\",\"response\":{\"output\":[{\"type\":\"function_call\",\"id\":\"fc_1\",\"call_id\":\"call_abc\",\"name\":\"read_channel\",\"arguments\":\"{\\\"channel\\\":\\\"general\\\"}\"}]}}\n\
\n";
        let (acc, live) = feed_all(body);
        assert!(live.is_empty());
        let turn = acc.finish().unwrap();
        assert_eq!(turn.calls.len(), 1, "completed must not duplicate the done item");
        assert_eq!(turn.calls[0].call_id, "call_abc");
        assert_eq!(turn.calls[0].name, "read_channel");
        assert_eq!(turn.calls[0].arguments, "{\"channel\":\"general\"}");
    }

    #[test]
    fn tool_stream_streams_text_deltas_live() {
        let body = "\
data: {\"type\":\"response.output_text.delta\",\"item_id\":\"msg_1\",\"delta\":\"Two \"}\n\
\n\
data: {\"type\":\"response.output_text.delta\",\"item_id\":\"msg_1\",\"delta\":\"threads need you.\"}\n\
\n\
data: {\"type\":\"response.output_item.done\",\"item\":{\"type\":\"message\",\"role\":\"assistant\",\"content\":[{\"type\":\"output_text\",\"text\":\"Two threads need you.\"}]}}\n\
\n\
data: {\"type\":\"response.completed\",\"response\":{\"output\":[]}}\n";
        let (acc, live) = feed_all(body);
        assert_eq!(live, "Two threads need you.");
        let turn = acc.finish().unwrap();
        assert_eq!(turn.text, "Two threads need you.");
        assert!(turn.calls.is_empty());
    }

    #[test]
    fn tool_stream_promotes_pending_call_when_done_event_missing() {
        let body = "\
data: {\"type\":\"response.output_item.added\",\"item\":{\"type\":\"function_call\",\"id\":\"fc_9\",\"call_id\":\"call_9\",\"name\":\"get_unreads\",\"arguments\":\"\"}}\n\
\n\
data: {\"type\":\"response.function_call_arguments.delta\",\"item_id\":\"fc_9\",\"delta\":\"{}\"}\n\
\n";
        let turn = feed_all(body).0.finish().unwrap();
        assert_eq!(turn.calls, vec![FunctionCall { call_id: "call_9".into(), name: "get_unreads".into(), arguments: "{}".into() }]);
    }

    #[test]
    fn tool_stream_surfaces_failures() {
        let body = "data: {\"type\":\"response.failed\",\"response\":{\"error\":{\"message\":\"Unsupported parameter: tools\"}}}\n\n";
        let err = feed_all(body).0.finish().unwrap_err().to_string();
        assert!(err.contains("Unsupported parameter: tools"), "{err}");
        let empty = feed_all("data: {\"type\":\"response.completed\",\"response\":{\"output\":[]}}\n\n").0.finish();
        assert!(empty.is_err());
    }

    /// Opt-in live compatibility spike against the real ChatGPT/Codex backend.
    /// Never runs in CI (`#[ignore]`, and it needs a local auth file):
    ///
    /// `AGORA_CODEX_AUTH_JSON=~/.codex/auth.json cargo test -p agora-core live_codex_tool_spike -- --ignored --nocapture`
    ///
    /// Uses the file's access token as-is and never refreshes it — a refresh
    /// rotates the refresh token and would sign the Codex CLI out. Prints only
    /// event types and call names, never tokens.
    #[test]
    #[ignore]
    fn live_codex_tool_spike() {
        let Ok(path) = std::env::var("AGORA_CODEX_AUTH_JSON") else {
            eprintln!("spike skipped: AGORA_CODEX_AUTH_JSON not set");
            return;
        };
        let auth: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        let tokens = tokens_from_auth_json(&auth).unwrap();
        let model = std::env::var("AGORA_CODEX_MODEL").unwrap_or_else(|_| DEFAULT_CODEX_MODEL.into());
        let tools = vec![json!({"type":"function","name":"get_weather","strict":false,
            "description":"Current weather for a city.",
            "parameters":{"type":"object","properties":{"city":{"type":"string"}},"required":["city"]}})];
        let mut input = vec![json!({"type":"message","role":"user","content":[
            {"type":"input_text","text":"What's the weather in Paris? Use the tool."}]})];
        let body = tool_request_body(&model, "You are terse. Always use tools when relevant.", &input, &tools);
        let mut deltas = 0usize;
        let first = stream_tool_turn(&tokens.access_token, &tokens.account_id, &body, &mut |_| deltas += 1)
            .expect("first round failed");
        eprintln!("round1: model={model} calls={:?} text_chars={} deltas={deltas}",
            first.calls.iter().map(|c| (&c.name, &c.arguments)).collect::<Vec<_>>(), first.text.len());
        let call = first.calls.first().expect("endpoint did not stream a function_call").clone();
        input.push(json!({"type":"function_call","call_id":call.call_id,"name":call.name,"arguments":call.arguments}));
        input.push(json!({"type":"function_call_output","call_id":call.call_id,"output":"{\"temp_c\":18,\"sky\":\"clear\"}"}));
        let body = tool_request_body(&model, "You are terse. Always use tools when relevant.", &input, &tools);
        let mut deltas2 = 0usize;
        let second = stream_tool_turn(&tokens.access_token, &tokens.account_id, &body, &mut |_| deltas2 += 1)
            .expect("function_call_output follow-up rejected");
        eprintln!("round2: calls={} deltas={deltas2} text={:?}", second.calls.len(), second.text);
        assert!(!second.text.trim().is_empty());
    }

    #[test]
    fn parse_models_payload_filters_visibility_and_api_flags() {
        let payload = json!({
            "models": [
                {"slug": "gpt-5.6-sol", "visibility": "list", "supported_in_api": true},
                {"slug": "gpt-5.6-terra", "visibility": "list", "supported_in_api": true},
                {"slug": "hidden", "visibility": "hide", "supported_in_api": true},
                {"slug": "spark", "visibility": "list", "supported_in_api": false},
                {"id": "gpt-4.1"},
            ]
        });
        assert_eq!(
            parse_models_payload(&payload),
            vec!["gpt-5.6-sol", "gpt-5.6-terra", "gpt-4.1"]
        );
    }
}
