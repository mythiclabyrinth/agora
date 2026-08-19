//! ChatGPT / Codex CLI OAuth helpers for Ask AI.
//!
//! Codex CLI stores ChatGPT session tokens in `~/.codex/auth.json` after
//! `codex login`. Agora can import those tokens (or accept a pasted
//! refresh token) and refresh them against the fixed OpenAI auth host.
//!
//! The OAuth client id is the public installed-app id embedded in every
//! Codex CLI binary (`app_EMoamEEZ73f0CkXaXp7hrann`) — it is not a secret.
//! Token endpoints and the Codex responses URL stay hard-coded (no
//! admin-settable base URL — SSRF / exfiltration risk).

use std::time::Duration;

use serde_json::{json, Value};

/// Public Codex CLI OAuth client id (device-code / refresh).
pub const CODEX_OAUTH_CLIENT_ID: &str = "app_EMoamEEZ73f0CkXaXp7hrann";

const TOKEN_URL: &str = "https://auth.openai.com/oauth/token";
const CODEX_RESPONSES_URL: &str = "https://chatgpt.com/backend-api/codex/responses";

const TIMEOUT: Duration = Duration::from_secs(60);
const MAX_ANSWER_TOKENS: u32 = 1024;

/// Default Ask-AI model when provider is `codex`.
pub const DEFAULT_CODEX_MODEL: &str = "gpt-5.1";

pub const SUGGESTED_CODEX_MODELS: &[&str] = &[
    "gpt-5.1",
    "gpt-5.1-codex",
    "gpt-5.1-codex-mini",
    "gpt-4.1",
];

#[derive(Clone, Debug)]
pub struct CodexTokens {
    pub access_token: String,
    pub refresh_token: String,
    pub account_id: String,
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
    let parsed: Value = response.into_json()?;
    let access = parsed["access_token"]
        .as_str()
        .unwrap_or("")
        .trim()
        .to_string();
    anyhow::ensure!(!access.is_empty(), "oauth refresh returned no access_token");
    let new_refresh = parsed["refresh_token"]
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(refresh_token)
        .to_string();
    // account_id may ride the id_token claims or a top-level field.
    let account_id = parsed["account_id"]
        .as_str()
        .or_else(|| parsed["chatgpt_account_id"].as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    Ok(CodexTokens {
        access_token: access,
        refresh_token: new_refresh,
        account_id,
    })
}

/// Parse a Codex CLI `auth.json` object into tokens.
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

/// Ask Codex (ChatGPT backend) to answer from numbered excerpts.
pub fn answer(
    access_token: &str,
    account_id: &str,
    model: &str,
    question: &str,
    context: &[Value],
) -> anyhow::Result<String> {
    anyhow::ensure!(!context.is_empty(), "no matching messages to answer from");
    let excerpts: String = context
        .iter()
        .enumerate()
        .map(|(i, m)| {
            let author = m["author_name"]
                .as_str()
                .filter(|s| !s.is_empty())
                .or_else(|| m["author_id"].as_str())
                .unwrap_or("unknown");
            let where_ = format!(
                "{} / #{}",
                m["group_name"].as_str().unwrap_or(""),
                m["channel_name"].as_str().unwrap_or(""),
            );
            let ts = crate::hub::format_ts(m["ts"].as_f64().unwrap_or(0.0));
            let text: String = m["text"].as_str().unwrap_or("").chars().take(1500).collect();
            format!("[{}] ({where_} — {author}, {ts})\n{text}\n", i + 1)
        })
        .collect();
    let system = "You answer questions about a chat workspace from message excerpts found by \
                  full-text search. Use only the excerpts as evidence. Cite the excerpts that \
                  support each claim inline as [1], [2] (the client links them to the original \
                  messages). Be direct and brief: answer first, in a few sentences; use Markdown \
                  lists only when the answer is genuinely a list. If the excerpts don't answer \
                  the question, say so plainly and mention the closest related thing they do \
                  cover. Never invent message content.";
    let prompt = format!("Question: {question}\n\nMessage excerpts:\n\n{excerpts}");
    let mut req = ureq::post(CODEX_RESPONSES_URL)
        .timeout(TIMEOUT)
        .set("Authorization", &format!("Bearer {access_token}"))
        .set("Content-Type", "application/json")
        .set("OpenAI-Beta", "responses=experimental");
    if !account_id.trim().is_empty() {
        req = req.set("ChatGPT-Account-Id", account_id.trim());
    }
    let response = req
        .send_json(json!({
            "model": model,
            "store": false,
            "instructions": system,
            "input": [{
                "role": "user",
                "content": [{"type": "input_text", "text": prompt}]
            }],
            "max_output_tokens": MAX_ANSWER_TOKENS,
        }))
        .map_err(flatten_http_error)?;
    let parsed: Value = response.into_json()?;
    let text = extract_responses_text(&parsed);
    anyhow::ensure!(!text.trim().is_empty(), "empty answer from Codex");
    Ok(text.trim().to_string())
}

/// Cheap auth probe: refresh is enough when we only have a refresh token;
/// otherwise hit responses with a tiny ping.
pub fn test_connection(access_token: &str, account_id: &str, model: &str) -> anyhow::Result<()> {
    let empty: Vec<Value> = Vec::new();
    // Build a one-excerpt context so answer() accepts the call.
    let ctx = vec![json!({
        "author_name": "test",
        "group_name": "test",
        "channel_name": "test",
        "ts": 0,
        "text": "ping",
    })];
    let _ = empty;
    let _ = answer(access_token, account_id, model, "ping", &ctx)?;
    Ok(())
}

fn extract_responses_text(parsed: &Value) -> String {
    if let Some(s) = parsed["output_text"].as_str() {
        return s.to_string();
    }
    let mut out = String::new();
    if let Some(items) = parsed["output"].as_array() {
        for item in items {
            if let Some(parts) = item["content"].as_array() {
                for part in parts {
                    if let Some(t) = part["text"].as_str() {
                        out.push_str(t);
                    }
                }
            }
        }
    }
    out
}

fn flatten_http_error(e: ureq::Error) -> anyhow::Error {
    match e {
        ureq::Error::Status(code, response) => {
            let body = response.into_string().unwrap_or_default();
            let detail = serde_json::from_str::<Value>(&body)
                .ok()
                .and_then(|v| {
                    v["error"]["message"]
                        .as_str()
                        .or_else(|| v["detail"].as_str())
                        .or_else(|| v["error"].as_str())
                        .map(String::from)
                })
                .unwrap_or(body);
            anyhow::anyhow!(
                "Codex/OpenAI OAuth error {code}: {}",
                detail.chars().take(300).collect::<String>()
            )
        }
        other => anyhow::anyhow!(other),
    }
}

/// Minimal application/x-www-form-urlencoded for token refresh (no new dep).
fn urlencoding_form(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            b' ' => out.push('+'),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
