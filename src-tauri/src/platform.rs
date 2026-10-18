/// Platform-specific integration only. Reader commands and dialogs stay shared.
pub fn configure(builder: tauri::Builder<tauri::Wry>) -> tauri::Builder<tauri::Wry> {
    #[cfg(desktop)]
    let builder = {
        use tauri::Manager;
        builder.plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
    };

    #[cfg(windows)]
    let builder = {
        use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Shortcut, ShortcutState};
        builder
            .plugin(
                tauri_plugin_global_shortcut::Builder::new()
                    .with_handler(|app, _, event| {
                        if event.state == ShortcutState::Pressed {
                            crate::selection::read(app.clone());
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
                if let Err(error) = crate::selection::register(app.handle().clone()) {
                    eprintln!("Cannot register middle mouse: {error}");
                }
                Ok(())
            })
    };

    builder
}
