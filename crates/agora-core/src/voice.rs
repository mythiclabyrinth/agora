//! Speech-to-text and text-to-speech HTTP clients.
//!
//! STT: OpenAI or Groq (OpenAI-compatible multipart transcriptions).
//! TTS: OpenAI only for now.
//!
//! Keys and models come from the caller ([`crate::config::Config::voice`]).
//! Endpoints stay hard-coded — an admin-settable base URL would be an SSRF /
//! key-exfiltration primitive. Powers `/api/channels/{id}/voice` and
//! `/api/messages/{id}/speech`.

use std::io::Read;
use std::time::Duration;

/// Speech API input cap; clip a bit below to stay safe.
const MAX_TTS_CHARS: usize = 4000;

const TIMEOUT: Duration = Duration::from_secs(120);

pub const OPENAI_TRANSCRIPTIONS_URL: &str = "https://api.openai.com/v1/audio/transcriptions";
pub const GROQ_TRANSCRIPTIONS_URL: &str = "https://api.groq.com/openai/v1/audio/transcriptions";
const OPENAI_SPEECH_URL: &str = "https://api.openai.com/v1/audio/speech";
const OPENAI_MODELS_URL: &str = "https://api.openai.com/v1/models";
const GROQ_MODELS_URL: &str = "https://api.groq.com/openai/v1/models";

/// Clip overly long replies at a sentence-ish boundary for speech.
pub fn clip_for_tts(text: &str) -> String {
    let text = text.trim();
    let chars: Vec<char> = text.chars().collect();
    if chars.len() <= MAX_TTS_CHARS {
        return text.to_string();
    }
    let clipped: String = chars[..MAX_TTS_CHARS].iter().collect();
    let cut = clipped.rfind(". ").into_iter().chain(clipped.rfind('\n')).max();
    match cut {
        Some(cut) if cut > clipped.len() / 2 => clipped[..=cut].trim().to_string(),
        _ => clipped.trim().to_string(),
    }
}

pub fn transcription_url(stt_provider: &str) -> &'static str {
    match stt_provider {
        crate::config::VOICE_PROVIDER_GROQ => GROQ_TRANSCRIPTIONS_URL,
        _ => OPENAI_TRANSCRIPTIONS_URL,
    }
}

/// Transcribe an audio clip (webm/ogg/m4a/wav…). The API infers the codec
/// from the filename extension. Blocking — run via `spawn_blocking`.
pub fn transcribe(
    stt_provider: &str,
    key: &str,
    data: &[u8],
    filename: &str,
    model: &str,
) -> anyhow::Result<String> {
    let url = transcription_url(stt_provider);
    let boundary = format!("agora{}", crate::store::new_token());
    let mut body: Vec<u8> = Vec::with_capacity(data.len() + 512);
    let part = |body: &mut Vec<u8>, headers: &str| {
        body.extend_from_slice(format!("--{boundary}\r\n{headers}\r\n\r\n").as_bytes());
    };
    part(&mut body, "Content-Disposition: form-data; name=\"model\"");
    body.extend_from_slice(model.as_bytes());
    body.extend_from_slice(b"\r\n");
    let safe_name: String = filename
        .chars()
        .filter(|c| c.is_alphanumeric() || matches!(c, '.' | '-' | '_'))
        .take(80)
        .collect();
    let safe_name = if safe_name.is_empty() {
        "voice-note.webm".into()
    } else {
        safe_name
    };
    part(
        &mut body,
        &format!(
            "Content-Disposition: form-data; name=\"file\"; filename=\"{safe_name}\"\r\n\
             Content-Type: application/octet-stream"
        ),
    );
    body.extend_from_slice(data);
    body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());

    let provider_label = if stt_provider == crate::config::VOICE_PROVIDER_GROQ {
        "Groq"
    } else {
        "OpenAI"
    };
    let response = ureq::post(url)
        .timeout(TIMEOUT)
        .set("Authorization", &format!("Bearer {key}"))
        .set(
            "Content-Type",
            &format!("multipart/form-data; boundary={boundary}"),
        )
        .send_bytes(&body)
        .map_err(|e| flatten_api_error(provider_label, e))?;
    let parsed: serde_json::Value = response.into_json()?;
    Ok(parsed["text"]
        .as_str()
        .unwrap_or_default()
        .trim()
        .to_string())
}

/// Render text to MP3 bytes (Safari's `<audio>` can't decode Opus).
/// Blocking — run via `spawn_blocking`. OpenAI only for now.
pub fn synthesize(key: &str, text: &str, model: &str, voice: &str) -> anyhow::Result<Vec<u8>> {
    let input = clip_for_tts(text);
    anyhow::ensure!(!input.is_empty(), "nothing to speak");
    let response = ureq::post(OPENAI_SPEECH_URL)
        .timeout(TIMEOUT)
        .set("Authorization", &format!("Bearer {key}"))
        .send_json(serde_json::json!({
            "model": model,
            "voice": voice,
            "input": input,
            "response_format": "mp3",
        }))
        .map_err(|e| flatten_api_error("OpenAI", e))?;
    let mut audio = Vec::new();
    response
        .into_reader()
        .take(32 * 1024 * 1024)
        .read_to_end(&mut audio)?;
    anyhow::ensure!(!audio.is_empty(), "empty audio response");
    Ok(audio)
}

/// Cheap auth/connectivity probe for OpenAI (lists models — no billed audio).
pub fn test_connection(key: &str) -> anyhow::Result<()> {
    let response = ureq::get(OPENAI_MODELS_URL)
        .timeout(Duration::from_secs(30))
        .set("Authorization", &format!("Bearer {key}"))
        .call()
        .map_err(|e| flatten_api_error("OpenAI", e))?;
    let _ = response.into_string()?;
    Ok(())
}

/// Cheap auth/connectivity probe for Groq.
pub fn test_connection_groq(key: &str) -> anyhow::Result<()> {
    let response = ureq::get(GROQ_MODELS_URL)
        .timeout(Duration::from_secs(30))
        .set("Authorization", &format!("Bearer {key}"))
        .call()
        .map_err(|e| flatten_api_error("Groq", e))?;
    let _ = response.into_string()?;
    Ok(())
}

/// Pull the API's error message out of a non-2xx response so logs say
/// "invalid api key" instead of just "status 401".
fn flatten_api_error(provider: &str, e: ureq::Error) -> anyhow::Error {
    match e {
        ureq::Error::Status(code, response) => {
            let body = response.into_string().unwrap_or_default();
            let detail = serde_json::from_str::<serde_json::Value>(&body)
                .ok()
                .and_then(|v| v["error"]["message"].as_str().map(String::from))
                .unwrap_or(body);
            anyhow::anyhow!(
                "{provider} API error {code}: {}",
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
    fn clip_for_tts_passes_short_text_and_cuts_long_text_at_sentences() {
        assert_eq!(clip_for_tts("  hello there  "), "hello there");
        let long = format!("{}. {}", "a".repeat(3000), "b".repeat(3000));
        let clipped = clip_for_tts(&long);
        assert!(clipped.len() <= MAX_TTS_CHARS);
        assert!(clipped.ends_with('.'));
    }

    #[test]
    fn transcription_url_dispatches_openai_and_groq() {
        assert_eq!(
            transcription_url(crate::config::VOICE_PROVIDER_OPENAI),
            OPENAI_TRANSCRIPTIONS_URL
        );
        assert_eq!(
            transcription_url(crate::config::VOICE_PROVIDER_GROQ),
            GROQ_TRANSCRIPTIONS_URL
        );
        assert!(GROQ_TRANSCRIPTIONS_URL.contains("api.groq.com"));
    }
}
