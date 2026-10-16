use std::{
    sync::{
        OnceLock,
        atomic::{AtomicBool, Ordering},
    },
    thread,
    time::Duration,
};
use tauri::Emitter;
use windows::Win32::{
    Foundation::{LPARAM, LRESULT, WPARAM},
    System::DataExchange::GetClipboardSequenceNumber,
    UI::{
        Input::KeyboardAndMouse::{
            INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP, SendInput, VIRTUAL_KEY,
            VK_CONTROL,
        },
        WindowsAndMessaging::{CallNextHookEx, SetWindowsHookExW, WH_MOUSE_LL, WM_MBUTTONDOWN},
    },
};

static APP: OnceLock<tauri::AppHandle> = OnceLock::new();
static COPYING: AtomicBool = AtomicBool::new(false);

fn copy_selection() {
    let key = |code, flags| INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: code,
                dwFlags: flags,
                ..Default::default()
            },
        },
    };
    let inputs = [
        key(VK_CONTROL, Default::default()),
        key(VIRTUAL_KEY(0x43), Default::default()),
        key(VIRTUAL_KEY(0x43), KEYEVENTF_KEYUP),
        key(VK_CONTROL, KEYEVENTF_KEYUP),
    ];
    // SAFETY: each INPUT contains a correctly initialized keyboard event.
    unsafe {
        SendInput(&inputs, std::mem::size_of::<INPUT>() as i32);
    }
}

pub fn read(app: tauri::AppHandle) {
    if COPYING.swap(true, Ordering::AcqRel) {
        return;
    }
    thread::spawn(move || {
        // Only use clipboard text produced by this copy, never stale clipboard contents.
        let before = unsafe { GetClipboardSequenceNumber() };
        copy_selection();
        for _ in 0..20 {
            thread::sleep(Duration::from_millis(25));
            if unsafe { GetClipboardSequenceNumber() } != before
                && let Ok(mut clipboard) = arboard::Clipboard::new()
                && let Ok(text) = clipboard.get_text()
                && !text.trim().is_empty()
            {
                let _ = app.emit("selection-text", text);
                break;
            }
        }
        COPYING.store(false, Ordering::Release);
    });
}

unsafe extern "system" fn mouse_hook(code: i32, message: WPARAM, data: LPARAM) -> LRESULT {
    if code >= 0
        && message.0 == WM_MBUTTONDOWN as usize
        && let Some(app) = APP.get()
    {
        read(app.clone());
    }
    // SAFETY: forward the untouched hook arguments to the next Windows hook.
    unsafe { CallNextHookEx(None, code, message, data) }
}

pub fn register(app: tauri::AppHandle) -> windows::core::Result<()> {
    let _ = APP.set(app);
    // SAFETY: the callback and stored app live for the process lifetime.
    // Windows removes the hook when the process exits.
    unsafe { SetWindowsHookExW(WH_MOUSE_LL, Some(mouse_hook), None, 0) }?;
    Ok(())
}
