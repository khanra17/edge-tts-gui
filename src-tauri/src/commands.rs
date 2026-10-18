use base64::Engine;
use serde::Serialize;
use tauri::{Emitter, State};

use crate::{
    export,
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
pub fn get_platform() -> &'static str {
    if cfg!(target_os = "android") {
        "android"
    } else {
        "desktop"
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
    let Some(destination) = jobs.run(job_id, export::choose(&app)).await? else {
        return Ok(None);
    };
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
    export::write(&app, destination, speech.audio)
        .await
        .map(Some)
}
