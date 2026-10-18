mod commands;
mod export;
mod jobs;
mod platform;
#[cfg(windows)]
mod selection;
mod tts;
mod voices;

use std::sync::OnceLock;

// A reader needs a few async network tasks, not one worker per logical CPU.
// Keep the runtime alive for the Android process as well as the desktop event loop.
static RUNTIME: OnceLock<tokio::runtime::Runtime> = OnceLock::new();

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    RUNTIME.get_or_init(|| {
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .max_blocking_threads(4)
            .enable_all()
            .build()
            .expect("Cannot start speech runtime");
        tauri::async_runtime::set(runtime.handle().clone());
        runtime
    });

    let builder = tauri::Builder::default()
        .manage(jobs::Jobs::default())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init());

    platform::configure(builder)
        .invoke_handler(tauri::generate_handler![
            commands::get_platform,
            commands::get_voices,
            commands::set_current_job,
            commands::synthesize,
            commands::save_audio,
        ])
        .run(tauri::generate_context!())
        .expect("Cannot start Edge Speak");
}
