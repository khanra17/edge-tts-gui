mod protocol;
mod text;
mod token;

use std::{
    sync::Once,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use tokio::time::timeout;
use tokio_tungstenite::{
    connect_async,
    tungstenite::{Message, client::IntoClientRequest, http::HeaderValue},
};
use uuid::Uuid;

const ENDPOINT: &str = "wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=6A5AA1D4EAFF4E9FB37E23D68491D6F4";
// Service protocol fingerprint, not the installed browser version. Update with upstream.
const EDGE_VERSION: &str = "143.0.3650.75";
const NETWORK_TIMEOUT: Duration = Duration::from_secs(30);
static TLS: Once = Once::new();

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeechRequest {
    pub text: String,
    pub voice: String,
    pub rate: i32,
    pub pitch: i32,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WordBoundary {
    pub offset_ms: f64,
    pub duration_ms: f64,
    pub text: String,
}

pub struct Speech {
    pub audio: Vec<u8>,
    pub word_boundaries: Vec<WordBoundary>,
}

pub enum SpeechUpdate<'a> {
    Audio(&'a [u8]),
    Words(&'a [WordBoundary]),
}

pub fn display_error(error: impl std::fmt::Display) -> String {
    error.to_string()
}

pub async fn synthesize(
    request: &SpeechRequest,
    progress: impl Fn(u8),
    updates: impl Fn(SpeechUpdate<'_>),
) -> Result<Speech, String> {
    TLS.call_once(|| {
        let _ = rustls::crypto::ring::default_provider().install_default();
    });
    let parts = text::split(&text::escape_xml(&text::clean(&request.text)));
    if parts.is_empty() {
        return Err("Text is empty".into());
    }
    if !(-50..=50).contains(&request.pitch) || !(-50..=200).contains(&request.rate) {
        return Err("Pitch or rate is outside the supported range".into());
    }
    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(display_error)?
        .as_secs();
    let url = format!(
        "{ENDPOINT}&Sec-MS-GEC={}&Sec-MS-GEC-Version=2-{EDGE_VERSION}&ConnectionId={}",
        token::service_token(seconds),
        Uuid::new_v4().simple()
    );
    let mut handshake = url.into_client_request().map_err(display_error)?;
    for (key, value) in [
        ("Pragma", "no-cache"),
        ("Cache-Control", "no-cache"),
        (
            "Origin",
            "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold",
        ),
        ("Accept-Encoding", "gzip, deflate, br, zstd"),
        ("Accept-Language", "en-US,en;q=0.9"),
        (
            "User-Agent",
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0",
        ),
    ] {
        handshake
            .headers_mut()
            .insert(key, HeaderValue::from_static(value));
    }
    handshake.headers_mut().insert(
        "Cookie",
        HeaderValue::from_str(&format!(
            "muid={};",
            Uuid::new_v4().simple().to_string().to_uppercase()
        ))
        .map_err(display_error)?,
    );
    let (socket, _) = timeout(NETWORK_TIMEOUT, connect_async(handshake))
        .await
        .map_err(|_| "Connection timed out".to_string())?
        .map_err(|error| format!("Connection failed: {error}"))?;
    let (mut writer, mut reader) = socket.split();
    let mut result = Speech {
        audio: Vec::new(),
        word_boundaries: Vec::new(),
    };
    let rate = format!("{:+}%", request.rate);
    let pitch = format!("{:+}Hz", request.pitch);
    let mut index = 0;
    let mut downloading = false;
    let mut boundary_base_ms = 0.0;
    let mut part_audio_start = 0;
    progress(1);
    timeout(
        NETWORK_TIMEOUT,
        protocol::send(&mut writer, &parts[0], &request.voice, &rate, &pitch),
    )
    .await
    .map_err(|_| "Request timed out".to_string())??;

    loop {
        let message = timeout(NETWORK_TIMEOUT, reader.next())
            .await
            .map_err(|_| "Speech service timed out".to_string())?
            .ok_or_else(|| "Speech service disconnected before completing the text".to_string())?
            .map_err(display_error)?;
        match message {
            Message::Binary(bytes) => {
                if !downloading {
                    return Err("Received audio outside a speech turn".into());
                }
                let audio = protocol::audio(&bytes)?;
                result.audio.extend_from_slice(audio);
                if !audio.is_empty() {
                    updates(SpeechUpdate::Audio(audio));
                }
            }
            Message::Text(message) => match protocol::path(&message) {
                Some("turn.start") => downloading = true,
                Some("turn.end") => {
                    if result.audio.len() == part_audio_start {
                        return Err("No audio received for a text segment".into());
                    }
                    downloading = false;
                    // The MP3 stream is 48 kbit/s CBR: use actual audio duration between turns.
                    boundary_base_ms += (result.audio.len() - part_audio_start) as f64 / 6.0;
                    part_audio_start = result.audio.len();
                    index += 1;
                    progress((index * 100 / parts.len()) as u8);
                    if index == parts.len() {
                        return Ok(result);
                    }
                    timeout(
                        NETWORK_TIMEOUT,
                        protocol::send(&mut writer, &parts[index], &request.voice, &rate, &pitch),
                    )
                    .await
                    .map_err(|_| "Request timed out".to_string())??;
                }
                Some("audio.metadata") => {
                    let words = protocol::boundaries(&message, boundary_base_ms);
                    updates(SpeechUpdate::Words(&words));
                    result.word_boundaries.extend(words);
                }
                Some("response") => {}
                _ => return Err("Unrecognized speech service response".into()),
            },
            Message::Close(_) => {
                return Err("Speech service closed before completing the text".into());
            }
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    #[ignore = "contacts Microsoft's public Edge TTS service"]
    async fn live_synthesis_smoke() {
        for (voice, text) in [
            ("en-US, AvaNeural", "Hello. This is a speech test.".into()),
            ("zh-CN, XiaoyiNeural", "你好。这是语音测试。".into()),
            (
                "en-US, AvaNeural",
                "A long document needs several requests. ".repeat(120),
            ),
        ] {
            let speech = synthesize(
                &SpeechRequest {
                    text,
                    voice: voice.into(),
                    rate: 0,
                    pitch: 0,
                },
                |_| {},
                |_| {},
            )
            .await
            .unwrap();
            assert!(speech.audio.len() > 1024);
            assert!(!speech.word_boundaries.is_empty());
            assert!(
                speech
                    .word_boundaries
                    .windows(2)
                    .all(|pair| pair[0].offset_ms <= pair[1].offset_ms)
            );
        }
    }
}
