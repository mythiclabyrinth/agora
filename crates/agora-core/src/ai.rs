//! AI answers over search ("ask Agora"): retrieve candidate messages with the
//! FTS index, then have Claude synthesize a short, cited answer from those
//! excerpts. Powers `POST /api/search/ask`.
//!
//! Pure HTTP client: keys and models come from the caller
//! ([`crate::config::Config::search_ai`]). The Anthropic URL stays hard-coded
//! — an admin-settable endpoint would be an SSRF / key-exfiltration path.

use std::time::Duration;

use serde_json::{json, Value};

const ANTHROPIC_URL: &str = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION: &str = "2023-06-01";
const TIMEOUT: Duration = Duration::from_secs(60);
const MAX_ANSWER_TOKENS: u32 = 1024;

/// Cap on retrieved messages handed to the model as context.
pub const CONTEXT_MESSAGES: usize = 30;
/// Cap on keywords extracted from the question for retrieval.
const MAX_KEYWORDS: usize = 12;

/// Curated Ask-AI models shown in the admin UI (free-text still allowed).
pub const SUGGESTED_SEARCH_MODELS: &[&str] = &[
    "claude-opus-5",
    "claude-sonnet-5",
    "claude-haiku-4-5-20251001",
];

/// Question words that carry no retrieval signal. Small on purpose: a missed
/// stopword just adds one low-weight OR term.
const STOPWORDS: &[&str] = &[
    "a", "an", "and", "any", "are", "about", "been", "but", "can", "could", "did", "do", "does",
    "for", "from", "had", "has", "have", "how", "into", "is", "it", "its", "of", "on", "or",
    "our", "she", "should", "that", "the", "their", "them", "then", "there", "these", "they",
    "this", "was", "we", "were", "what", "when", "where", "which", "who", "why", "will", "with",
    "would", "you", "your",
];

/// Distill a natural-language question into a recall-oriented keyword list
/// for FTS retrieval ("What did we decide about the deploy?" -> "decide
/// deploy"). Returns None when nothing survives — the caller should fall
/// back to the raw question.
pub fn retrieval_keywords(question: &str) -> Option<String> {
    let mut seen = std::collections::HashSet::new();
    let words: Vec<String> = question
        .split(|c: char| !c.is_alphanumeric())
        .map(str::to_lowercase)
        .filter(|w| w.len() >= 2 && !STOPWORDS.contains(&w.as_str()))
        .filter(|w| seen.insert(w.clone()))
        .take(MAX_KEYWORDS)
        .collect();
    if words.is_empty() {
        None
    } else {
        Some(words.join(" "))
    }
}

/// Ask Claude to answer `question` from numbered message excerpts (the rows
/// `Store::search_messages` returns). Blocking — run via `spawn_blocking`.
/// Returns the answer text, which cites excerpts as [1], [2], ….
pub fn answer(key: &str, model: &str, question: &str, context: &[Value]) -> anyhow::Result<String> {
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
    let response = ureq::post(ANTHROPIC_URL)
        .timeout(TIMEOUT)
        .set("x-api-key", key)
        .set("anthropic-version", ANTHROPIC_VERSION)
        .send_json(json!({
            "model": model,
            "max_tokens": MAX_ANSWER_TOKENS,
            "system": system,
            "messages": [{"role": "user", "content": prompt}],
        }))
        .map_err(flatten_api_error)?;
    let parsed: Value = response.into_json()?;
    let text = parsed["content"]
        .as_array()
        .map(|blocks| {
            blocks
                .iter()
                .filter_map(|b| b["text"].as_str())
                .collect::<Vec<_>>()
                .join("")
        })
        .unwrap_or_default();
    anyhow::ensure!(!text.trim().is_empty(), "empty answer from model");
    Ok(text.trim().to_string())
}

/// Cheap auth/connectivity probe for the admin "Test connection" button.
pub fn test_connection(key: &str, model: &str) -> anyhow::Result<()> {
    let response = ureq::post(ANTHROPIC_URL)
        .timeout(Duration::from_secs(30))
        .set("x-api-key", key)
        .set("anthropic-version", ANTHROPIC_VERSION)
        .send_json(json!({
            "model": model,
            "max_tokens": 1,
            "messages": [{"role": "user", "content": "ping"}],
        }))
        .map_err(flatten_api_error)?;
    let _ = response.into_string()?;
    Ok(())
}

/// Pull the API's error message out of a non-2xx response so logs say
/// "invalid x-api-key" instead of just "status 401".
fn flatten_api_error(e: ureq::Error) -> anyhow::Error {
    match e {
        ureq::Error::Status(code, response) => {
            let body = response.into_string().unwrap_or_default();
            let detail = serde_json::from_str::<Value>(&body)
                .ok()
                .and_then(|v| v["error"]["message"].as_str().map(String::from))
                .unwrap_or(body);
            anyhow::anyhow!(
                "Anthropic API error {code}: {}",
                detail.chars().take(300).collect::<String>()
            )
        }
        other => anyhow::anyhow!(other),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retrieval_keywords_drops_stopwords_and_dedupes() {
        assert_eq!(
            retrieval_keywords("What did we decide about the deploy deploy?"),
            Some("decide deploy".to_string())
        );
        assert_eq!(retrieval_keywords("what is the of"), None);
        assert_eq!(retrieval_keywords(""), None);
    }
}
