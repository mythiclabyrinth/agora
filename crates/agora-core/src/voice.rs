//! Speech-to-text and text-to-speech HTTP clients.
//!
//! STT: OpenAI or Groq (OpenAI-compatible multipart transcriptions).
//! TTS: OpenAI (mp3) or Groq Orpheus (wav only, 200-char input cap).
//!
//! Keys and models come from the caller ([`crate::config::Config::voice`]).
//! Endpoints stay hard-coded — an admin-settable base URL would be an SSRF /
//! key-exfiltration primitive. Powers `/api/channels/{id}/voice` and
//! `/api/messages/{id}/speech`.

use std::io::Read;
use std::time::Duration;

/// Speech API input cap; clip a bit below to stay safe.
const MAX_TTS_CHARS: usize = 4000;
/// Groq Orpheus rejects anything over 200 characters per request.
const GROQ_TTS_MAX_CHARS: usize = 200;

const TIMEOUT: Duration = Duration::from_secs(120);

pub const OPENAI_TRANSCRIPTIONS_URL: &str = "https://api.openai.com/v1/audio/transcriptions";
pub const GROQ_TRANSCRIPTIONS_URL: &str = "https://api.groq.com/openai/v1/audio/transcriptions";
const OPENAI_SPEECH_URL: &str = "https://api.openai.com/v1/audio/speech";
const GROQ_SPEECH_URL: &str = "https://api.groq.com/openai/v1/audio/speech";
const OPENAI_MODELS_URL: &str = "https://api.openai.com/v1/models";
const GROQ_MODELS_URL: &str = "https://api.groq.com/openai/v1/models";

pub const AUDIO_MPEG: &str = "audio/mpeg";
pub const AUDIO_WAV: &str = "audio/wav";

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

/// Synthesized speech plus the MIME type clients should play.
pub struct SpeechAudio {
    pub bytes: Vec<u8>,
    pub content_type: &'static str,
}

/// Render text to playable audio. Blocking — run via `spawn_blocking`.
///
/// OpenAI returns MP3 (Safari's `<audio>` can't decode Opus). Groq Orpheus
/// only accepts `wav` and a 200-character input, so longer text is split and
/// the WAV chunks are concatenated. `accent` is provider-agnostic; OpenAI
/// gpt-4o-*tts applies it via `instructions`, Groq already selected the
/// matching Orpheus model/voice upstream.
pub fn synthesize(
    tts_provider: &str,
    key: &str,
    text: &str,
    model: &str,
    voice: &str,
    accent: &str,
) -> anyhow::Result<SpeechAudio> {
    let input = clip_for_tts(text);
    anyhow::ensure!(!input.is_empty(), "nothing to speak");
    if tts_provider == crate::config::VOICE_PROVIDER_GROQ {
        synthesize_groq(key, &input, model, voice)
    } else {
        synthesize_openai(key, &input, model, voice, accent)
    }
}

fn synthesize_openai(
    key: &str,
    input: &str,
    model: &str,
    voice: &str,
    accent: &str,
) -> anyhow::Result<SpeechAudio> {
    let bytes = post_speech(
        OPENAI_SPEECH_URL,
        "OpenAI",
        key,
        model,
        voice,
        input,
        "mp3",
        crate::config::openai_tts_instructions(model, accent),
    )?;
    Ok(SpeechAudio {
        bytes,
        content_type: AUDIO_MPEG,
    })
}

fn synthesize_groq(key: &str, input: &str, model: &str, voice: &str) -> anyhow::Result<SpeechAudio> {
    let chunks = chunk_for_groq_tts(input);
    anyhow::ensure!(!chunks.is_empty(), "nothing to speak");
    let mut fmt: Option<Vec<u8>> = None;
    let mut pcm = Vec::new();
    for chunk in chunks {
        let wav = post_speech(
            GROQ_SPEECH_URL,
            "Groq",
            key,
            model,
            voice,
            &chunk,
            "wav",
            None,
        )?;
        let (next_fmt, data) = wav_fmt_and_data(&wav)?;
        match &fmt {
            Some(prev) => anyhow::ensure!(next_fmt == prev.as_slice(), "wav format mismatch across Groq chunks"),
            None => fmt = Some(next_fmt.to_vec()),
        }
        pcm.extend_from_slice(data);
    }
    let fmt = fmt.expect("groq returned no wav");
    // Groq streams WAV with 0xFFFFFFFF sizes (Lavf); browsers won't play that,
    // and a second chunk would fail to parse. Always rewrite a finite PCM file.
    Ok(SpeechAudio {
        bytes: write_wav(&fmt, &pcm),
        content_type: AUDIO_WAV,
    })
}

fn post_speech(
    url: &str,
    provider_label: &str,
    key: &str,
    model: &str,
    voice: &str,
    input: &str,
    response_format: &str,
    instructions: Option<&str>,
) -> anyhow::Result<Vec<u8>> {
    let mut body = serde_json::json!({
        "model": model,
        "voice": voice,
        "input": input,
        "response_format": response_format,
    });
    if let Some(instructions) = instructions.filter(|s| !s.is_empty()) {
        body["instructions"] = serde_json::json!(instructions);
    }
    let response = ureq::post(url)
        .timeout(TIMEOUT)
        .set("Authorization", &format!("Bearer {key}"))
        .send_json(body)
        .map_err(|e| flatten_api_error(provider_label, e))?;
    let mut audio = Vec::new();
    response
        .into_reader()
        .take(32 * 1024 * 1024)
        .read_to_end(&mut audio)?;
    anyhow::ensure!(!audio.is_empty(), "empty audio response");
    Ok(audio)
}

/// Split clipped text into Groq Orpheus-sized pieces at sentence-ish boundaries.
pub fn chunk_for_groq_tts(text: &str) -> Vec<String> {
    let text = text.trim();
    if text.is_empty() {
        return Vec::new();
    }
    let chars: Vec<char> = text.chars().collect();
    let mut out = Vec::new();
    let mut start = 0;
    while start < chars.len() {
        let remaining = chars.len() - start;
        let take = remaining.min(GROQ_TTS_MAX_CHARS);
        let slice = &chars[start..start + take];
        let cut = if take == remaining {
            take
        } else {
            let window: String = slice.iter().collect();
            let at = window
                .rfind(". ")
                .into_iter()
                .chain(window.rfind("? "))
                .chain(window.rfind("! "))
                .chain(window.rfind('\n'))
                .chain(window.rfind(' '))
                .max();
            match at {
                Some(i) if i > 0 => window[..i + 1].chars().count(),
                _ => take,
            }
        };
        let piece: String = chars[start..start + cut].iter().collect();
        let piece = piece.trim();
        if !piece.is_empty() {
            out.push(piece.to_string());
        }
        start += cut;
    }
    out
}

/// Concatenate PCM WAV files that share the same `fmt` chunk.
fn concat_wavs(parts: &[Vec<u8>]) -> anyhow::Result<Vec<u8>> {
    anyhow::ensure!(!parts.is_empty(), "no wav parts");
    let (fmt0, data0) = wav_fmt_and_data(&parts[0])?;
    let fmt0 = fmt0.to_vec();
    let mut data = data0.to_vec();
    for part in &parts[1..] {
        let (fmt, next) = wav_fmt_and_data(part)?;
        anyhow::ensure!(fmt == fmt0.as_slice(), "wav format mismatch across Groq chunks");
        data.extend_from_slice(next);
    }
    Ok(write_wav(&fmt0, &data))
}

fn wav_fmt_and_data(bytes: &[u8]) -> anyhow::Result<(&[u8], &[u8])> {
    anyhow::ensure!(bytes.len() >= 12, "wav too short");
    anyhow::ensure!(&bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WAVE", "not a wav");
    let mut i = 12;
    let mut fmt = None;
    let mut data = None;
    while i + 8 <= bytes.len() {
        let id = &bytes[i..i + 4];
        let size_u = u32::from_le_bytes(bytes[i + 4..i + 8].try_into()?);
        let start = i + 8;
        // Groq/Lavf streams WAV with chunk size 0xFFFFFFFF ("until EOF").
        let end = if size_u == u32::MAX {
            bytes.len()
        } else {
            let end = start.saturating_add(size_u as usize);
            anyhow::ensure!(end <= bytes.len(), "truncated wav chunk");
            end
        };
        if id == b"fmt " {
            fmt = Some(&bytes[start..end]);
        } else if id == b"data" {
            data = Some(&bytes[start..end]);
        }
        if size_u == u32::MAX {
            break;
        }
        i = end + (size_u as usize % 2); // word-align
    }
    match (fmt, data) {
        (Some(fmt), Some(data)) => Ok((fmt, data)),
        _ => anyhow::bail!("wav missing fmt or data chunk"),
    }
}

fn write_wav(fmt: &[u8], data: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(44 + fmt.len() + data.len());
    out.extend_from_slice(b"RIFF");
    let riff_size = (4 + 8 + fmt.len() + 8 + data.len()) as u32;
    out.extend_from_slice(&riff_size.to_le_bytes());
    out.extend_from_slice(b"WAVE");
    out.extend_from_slice(b"fmt ");
    out.extend_from_slice(&(fmt.len() as u32).to_le_bytes());
    out.extend_from_slice(fmt);
    out.extend_from_slice(b"data");
    out.extend_from_slice(&(data.len() as u32).to_le_bytes());
    out.extend_from_slice(data);
    out
}

/// Guess MIME from the payload so a cached clip stays playable after a
/// provider switch that forgot to flush.
pub fn audio_content_type(bytes: &[u8]) -> &'static str {
    if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WAVE" {
        AUDIO_WAV
    } else {
        AUDIO_MPEG
    }
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

    #[test]
    fn groq_chunks_stay_at_or_under_200_chars_and_prefer_sentences() {
        let short = chunk_for_groq_tts("  hello there  ");
        assert_eq!(short, vec!["hello there"]);
        let sentence = "This is a complete sentence. ";
        let long = sentence.repeat(10);
        let chunks = chunk_for_groq_tts(&long);
        assert!(chunks.len() > 1);
        for chunk in &chunks {
            assert!(chunk.chars().count() <= GROQ_TTS_MAX_CHARS);
        }
        assert!(chunks[0].contains("complete sentence"));
    }

    #[test]
    fn concat_wavs_joins_matching_pcm_payloads() {
        let fmt = [1, 0, 1, 0, 68, 172, 0, 0, 136, 88, 1, 0, 2, 0, 16, 0];
        let a = write_wav(&fmt, &[1, 2, 3, 4]);
        let b = write_wav(&fmt, &[5, 6]);
        let joined = concat_wavs(&[a, b]).unwrap();
        let (out_fmt, data) = wav_fmt_and_data(&joined).unwrap();
        assert_eq!(out_fmt, fmt);
        assert_eq!(data, &[1, 2, 3, 4, 5, 6]);
        assert_eq!(audio_content_type(&joined), AUDIO_WAV);
    }

    #[test]
    fn groq_streaming_wav_with_unknown_sizes_is_rewritten() {
        // Groq/Lavf: RIFF and data sizes are 0xFFFFFFFF, plus a LIST/INFO
        // chunk between fmt and data. Browsers will not play that as-is.
        let fmt = [1u8, 0, 1, 0, 0xc0, 0x5d, 0, 0, 0x80, 0xbb, 0, 0, 2, 0, 16, 0];
        let pcm = [7u8, 8, 9, 10];
        let mut streamed = Vec::new();
        streamed.extend_from_slice(b"RIFF");
        streamed.extend_from_slice(&u32::MAX.to_le_bytes());
        streamed.extend_from_slice(b"WAVE");
        streamed.extend_from_slice(b"fmt ");
        streamed.extend_from_slice(&(fmt.len() as u32).to_le_bytes());
        streamed.extend_from_slice(&fmt);
        streamed.extend_from_slice(b"LIST");
        streamed.extend_from_slice(&26u32.to_le_bytes());
        streamed.extend_from_slice(&[0u8; 26]);
        streamed.extend_from_slice(b"data");
        streamed.extend_from_slice(&u32::MAX.to_le_bytes());
        streamed.extend_from_slice(&pcm);

        let (got_fmt, got_pcm) = wav_fmt_and_data(&streamed).unwrap();
        assert_eq!(got_fmt, fmt);
        assert_eq!(got_pcm, pcm);
        let rewritten = write_wav(got_fmt, got_pcm);
        let riff_size = u32::from_le_bytes(rewritten[4..8].try_into().unwrap());
        assert_ne!(riff_size, u32::MAX);
        let (_, data) = wav_fmt_and_data(&rewritten).unwrap();
        assert_eq!(data, pcm);

        let joined = concat_wavs(&[streamed.clone(), streamed]).unwrap();
        let (_, data) = wav_fmt_and_data(&joined).unwrap();
        assert_eq!(data, [7, 8, 9, 10, 7, 8, 9, 10]);
    }

    #[test]
    fn openai_tts_instructions_only_on_gpt4o_tts() {
        use crate::config::{openai_tts_instructions, TTS_ACCENT_BRITISH};
        assert!(openai_tts_instructions("gpt-4o-mini-tts", TTS_ACCENT_BRITISH)
            .unwrap()
            .contains("British"));
        assert!(openai_tts_instructions("tts-1", TTS_ACCENT_BRITISH).is_none());
        assert!(openai_tts_instructions("tts-1-hd", TTS_ACCENT_BRITISH).is_none());
    }
}
