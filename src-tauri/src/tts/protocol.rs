use chrono::Utc;
use futures_util::SinkExt;
use tokio_tungstenite::tungstenite::Message;
use uuid::Uuid;

use super::{WordBoundary, display_error, text::escape_xml};

pub async fn send<W>(
    write: &mut W,
    part: &str,
    voice: &str,
    rate: &str,
    pitch: &str,
) -> Result<(), String>
where
    W: SinkExt<Message> + Unpin,
    W::Error: std::fmt::Display,
{
    let date = Utc::now()
        .format("%a %b %d %Y %H:%M:%S GMT+0000 (Coordinated Universal Time)")
        .to_string();
    let config = concat!(
        "Content-Type:application/json; charset=utf-8\r\n",
        "Path:speech.config\r\n\r\n",
        "{\"context\":{\"synthesis\":{\"audio\":{\"metadataoptions\":{",
        "\"sentenceBoundaryEnabled\":\"false\",\"wordBoundaryEnabled\":\"true\"},",
        "\"outputFormat\":\"audio-24khz-48kbitrate-mono-mp3\"}}}}\r\n"
    );
    write
        .send(Message::Text(
            format!("X-Timestamp:{date}\r\n{config}").into(),
        ))
        .await
        .map_err(display_error)?;

    let ssml = mkssml(
        part,
        &escape_xml(voice).replace('\'', "&apos;"),
        rate,
        pitch,
    );
    let data = format!(
        "X-RequestId:{}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:{}Z\r\nPath:ssml\r\n\r\n{}",
        Uuid::new_v4().simple(),
        date,
        ssml
    );
    write
        .send(Message::Text(data.into()))
        .await
        .map_err(display_error)
}

pub fn audio(message: &[u8]) -> Result<&[u8], String> {
    if message.len() < 2 {
        return Err("Audio message missing header length".into());
    }
    let header_len = ((message[0] as usize) << 8) | message[1] as usize;
    if message.len() < header_len + 2 {
        return Err("Audio message missing data".into());
    }
    let header = std::str::from_utf8(&message[2..header_len + 2]).map_err(display_error)?;
    if path(header) != Some("audio") {
        return Err("Unexpected binary message path".into());
    }
    Ok(&message[header_len + 2..])
}

pub fn path(message: &str) -> Option<&str> {
    message
        .split_once("\r\n\r\n")
        .map_or(message, |(headers, _)| headers)
        .lines()
        .find_map(|line| line.strip_prefix("Path:").map(str::trim))
}

pub fn boundaries(message: &str, base_ms: f64) -> Vec<WordBoundary> {
    let Some((_, body)) = message.split_once("\r\n\r\n") else {
        return Vec::new();
    };
    let Ok(payload) = serde_json::from_str::<serde_json::Value>(body) else {
        return Vec::new();
    };
    let Some(metadata) = payload.get("Metadata").and_then(|value| value.as_array()) else {
        return Vec::new();
    };

    metadata
        .iter()
        .filter_map(|item| {
            if item.get("Type")?.as_str()? != "WordBoundary" {
                return None;
            }
            let data = item.get("Data")?;
            let text_value = data.get("text")?;
            let text = text_value
                .get("Text")
                .and_then(|value| value.as_str())
                .or_else(|| text_value.as_str())?;
            let offset = data.get("Offset")?.as_f64()? / 10_000.0;
            let duration = data.get("Duration")?.as_f64()? / 10_000.0;
            Some(WordBoundary {
                offset_ms: base_ms + offset.max(0.0),
                duration_ms: duration.max(0.0),
                text: decode_xml(text),
            })
        })
        .collect()
}

fn decode_xml(text: &str) -> String {
    text.replace("&apos;", "'")
        .replace("&quot;", "\"")
        .replace("&gt;", ">")
        .replace("&lt;", "<")
        .replace("&amp;", "&")
}

fn mkssml(text: &str, voice: &str, rate: &str, pitch: &str) -> String {
    format!(
        "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'><voice name='Microsoft Server Speech Text to Speech Voice ({voice})'><prosody pitch='{pitch}' rate='{rate}' volume='+0%'>{text}</prosody></voice></speak>"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn binary_audio_validates_headers_and_length() {
        let header = b"Path:audio\r\nContent-Type:audio/mpeg\r\n";
        let mut message = (header.len() as u16).to_be_bytes().to_vec();
        message.extend_from_slice(header);
        message.extend_from_slice(b"mp3");
        assert_eq!(audio(&message).unwrap(), b"mp3");
        assert!(audio(&[]).is_err());
        assert!(audio(&[0, 10, 1]).is_err());
        assert!(audio(&[0, 1, b'x']).is_err());
    }

    #[test]
    fn path_does_not_read_body_as_headers() {
        assert_eq!(path("Path:turn.end\r\n\r\nPath:audio"), Some("turn.end"));
        assert_eq!(path("X-RequestId:123"), None);
    }

    #[test]
    fn metadata_converts_ticks_and_decodes_entities() {
        let message = concat!(
            "Path:audio.metadata\r\n\r\n",
            r#"{"Metadata":[{"Type":"WordBoundary","Data":{"Offset":1000000,"Duration":2000000,"text":{"Text":"A&amp;B"}}}]}"#
        );
        let words = boundaries(message, 50.0);
        assert_eq!(words.len(), 1);
        assert_eq!(words[0].offset_ms, 150.0);
        assert_eq!(words[0].duration_ms, 200.0);
        assert_eq!(words[0].text, "A&B");
        assert!(boundaries("invalid", 0.0).is_empty());
    }

    #[test]
    fn ssml_contains_selected_prosody_and_voice() {
        let xml = mkssml("Hello &amp; world", "en-US, AvaNeural", "+20%", "-5Hz");
        assert!(xml.contains("AvaNeural"));
        assert!(xml.contains("pitch='-5Hz' rate='+20%'"));
        assert!(xml.contains("Hello &amp; world"));
    }
}
