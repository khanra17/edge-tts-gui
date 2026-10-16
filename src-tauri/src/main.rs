#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod jobs;
#[cfg(windows)]
mod selection;
mod tts;
mod voices;

use tauri::Manager;
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Shortcut, ShortcutState};

fn main() {
    tauri::Builder::default()
        .manage(jobs::Jobs::default())
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _, event| {
                    if event.state == ShortcutState::Pressed {
                        #[cfg(windows)]
                        selection::read(app.clone());
                    }
                })
                .build(),
        )
        .setup(|app| {
            if let Err(error) = app
                .global_shortcut()
                .register(Shortcut::new(None, Code::F9))
            {
                eprintln!("Cannot register F9: {error}");
            }
            #[cfg(windows)]
            if let Err(error) = selection::register(app.handle().clone()) {
                eprintln!("Cannot register middle mouse: {error}");
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_voices,
            commands::set_current_job,
            commands::synthesize,
            commands::save_audio,
        ])
        .run(tauri::generate_context!())
        .expect("Cannot start Edge Speak");
}
