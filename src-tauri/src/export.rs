use std::io::Write;
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_fs::{FilePath, FsExt, OpenOptions};

/// The same document boundary on desktop and Android, including content:// URIs.
pub async fn choose(app: &tauri::AppHandle) -> Result<Option<FilePath>, String> {
    let (sender, receiver) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .add_filter("MP3 audio", &["mp3"])
        .set_file_name("speech.mp3")
        .save_file(move |file| {
            let _ = sender.send(file);
        });
    receiver
        .await
        .map_err(|error| format!("Save dialog failed: {error}"))
}

pub async fn write(
    app: &tauri::AppHandle,
    destination: FilePath,
    audio: Vec<u8>,
) -> Result<String, String> {
    let app = app.clone();
    let label = destination.to_string();
    tauri::async_runtime::spawn_blocking(move || {
        let mut options = OpenOptions::new();
        options.write(true).create(true).truncate(true);
        let mut file = app
            .fs()
            .open(destination, options)
            .map_err(|error| format!("Cannot open MP3: {error}"))?;
        file.write_all(&audio)
            .map_err(|error| format!("Save failed: {error}"))?;
        file.flush()
            .map_err(|error| format!("Save failed: {error}"))?;
        Ok(label)
    })
    .await
    .map_err(|error| format!("Save failed: {error}"))?
}
