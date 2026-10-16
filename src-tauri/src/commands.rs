use base64::Engine;
use serde::Serialize;
use tauri::{Emitter, State};

use crate::{
    jobs::Jobs,
    tts::{self, SpeechRequest, WordBoundary},
    voices::{self, Voice},
};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SynthesizedSpeech {
    audio_base64: String,
    word_boundaries: Vec<WordBoundary>,
}

#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum SynthesisUpdate {
    Audio { data: String },
    Words { boundaries: Vec<WordBoundary> },
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SaveProgress {
    job_id: u64,
    percent: u8,
}

fn validate(request: &SpeechRequest) -> Result<(), String> {
    if voices::contains(&request.voice) {
        Ok(())
    } else {
        Err("Unknown voice".into())
    }
}

#[tauri::command]
pub fn get_voices() -> Vec<Voice> {
    voices::all()
}

#[tauri::command]
pub fn set_current_job(jobs: State<'_, Jobs>, job_id: u64) -> Result<(), String> {
    jobs.advance(job_id)
}

#[tauri::command]
pub async fn synthesize(
    jobs: State<'_, Jobs>,
    request: SpeechRequest,
    job_id: u64,
    streaming: bool,
    on_update: tauri::ipc::Channel<SynthesisUpdate>,
) -> Result<SynthesizedSpeech, String> {
    validate(&request)?;
    let speech = jobs
        .run(
            job_id,
            tts::synthesize(
                &request,
                |_| {},
                |update| {
                    if streaming {
                        let event = match update {
                            tts::SpeechUpdate::Audio(bytes) => SynthesisUpdate::Audio {
                                data: base64::engine::general_purpose::STANDARD.encode(bytes),
                            },
                            tts::SpeechUpdate::Words(words) => SynthesisUpdate::Words {
                                boundaries: words.to_vec(),
                            },
                        };
                        let _ = on_update.send(event);
                    }
                },
            ),
        )
        .await?;
    Ok(SynthesizedSpeech {
        audio_base64: base64::engine::general_purpose::STANDARD.encode(speech.audio),
        word_boundaries: speech.word_boundaries,
    })
}

#[tauri::command]
pub async fn save_audio(
    app: tauri::AppHandle,
    jobs: State<'_, Jobs>,
    request: SpeechRequest,
    job_id: u64,
) -> Result<Option<String>, String> {
    validate(&request)?;
    jobs.advance(job_id)?;
    let Some(file) = rfd::AsyncFileDialog::new()
        .add_filter("MP3 audio", &["mp3"])
        .set_file_name("speech.mp3")
        .save_file()
        .await
    else {
        return Ok(None);
    };
    let mut path = file.path().to_path_buf();
    if path.extension().is_none() {
        path.set_extension("mp3");
    }
    let speech = jobs
        .run(
            job_id,
            tts::synthesize(
                &request,
                |percent| {
                    let _ = app.emit("save-progress", SaveProgress { job_id, percent });
                },
                |_| {},
            ),
        )
        .await?;
    tokio::fs::write(&path, speech.audio)
        .await
        .map_err(|error| format!("Save failed: {error}"))?;
    #[cfg(windows)]
    if let Some(parent) = path.parent() {
        let _ = std::process::Command::new("explorer").arg(parent).spawn();
    }
    Ok(Some(path.display().to_string()))
}
