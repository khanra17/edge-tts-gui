# Android (Tauri)

The Android app runs the existing TypeScript reader in a Tauri WebView. Speech
synthesis stays in Rust. Only the document picker and file writing use Tauri's
Android plugins. There is no separate Kotlin/Compose reader.

## Prerequisites

Use the Node/npm and Rust versions listed in [README.md](README.md). Install:

- Android Studio and JDK 21 (Android Studio's bundled JDK is suitable).
- Android SDK Platform, Platform-Tools, Build-Tools, and Command-line Tools.
- A current stable NDK (Side by side), selected in Android Studio's SDK Manager.
- Windows: MSVC C++ Build Tools for Rust build scripts on the host, or a configured
  equivalent host linker. The NDK handles Android target linking.

With [Android CLI](https://developer.android.com/tools/android-cli), install the
build components used by the current Tauri template:

```powershell
android sdk install platform-tools cmdline-tools/latest platforms/android-37.0 build-tools/37.0.0 ndk/30.0.16248370
```

Set these in your terminal before running Tauri. PowerShell example; replace the
JDK and NDK paths with the installed versions:

```powershell
$env:JAVA_HOME = "C:\Program Files\Android\Android Studio\jbr"
$env:ANDROID_HOME = "$env:LOCALAPPDATA\Android\Sdk"
$env:NDK_HOME = "$env:ANDROID_HOME\ndk\30.0.16248370"
$env:Path = "$env:JAVA_HOME\bin;$env:ANDROID_HOME\platform-tools;$env:Path"
```

Follow [Tauri's Android prerequisites](https://v2.tauri.app/start/prerequisites/#android)
for other host platforms. Accept the SDK licenses with SDK Manager or
`sdkmanager --licenses`.

## Initialize and run

From the repository root:

```powershell
npm ci
npm run android:init
npm run android:dev
```

Initialization creates the Gradle project in `src-tauri/gen/android/` and installs
the Rust Android targets. That generated directory remains ignored; regenerate it
on a fresh checkout. Enable USB debugging and authorize the device, or start an
Android emulator before running the dev command.

The Vite configuration uses `TAURI_DEV_HOST` supplied by the Tauri CLI so a phone
can reach the development server. Allow the dev server through the host firewall
on your private network. Production builds package the frontend and do not need
a development server.

## Build an installable test APK

```powershell
npm run android:build -- --debug --target aarch64
```

The debug APK is signed with the Android debug key. The ARM64 build on this host
is `src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk`.
Debug builds retain native symbols and are much larger than release builds. Install it with
`adb install -r <apk-path>`. Use `--target x86_64` for an x86-64 emulator.

For an optimized release APK, run `npm run android:build -- --target aarch64`
(without `--debug`). Signing is separate from the optimization profile.
Configure your own Android signing key before distributing a release; never
commit keystores or passwords. See
[Tauri's Android signing guide](https://v2.tauri.app/distribute/sign/android/).

GitHub Actions builds optimized APKs and signs trusted builds using a dedicated
release key from GitHub Secrets. See [CI and signing](docs/ci.md). This certificate
differs from the older local debug key; uninstall an old debug-signed app once
before installing a release-key APK.

Desktop Tauri bundling remains disabled. Android APK generation uses the separate
Tauri Android build command, not a desktop installer.

## Windows host linker without MSVC

This host used its existing cargo-xwin Windows SDK cache and `lld-link.exe` for
Rust's Windows build scripts. If using that same setup, set these before the
Android build (Android target linking still uses the NDK):

~~~powershell
$env:CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_LINKER = "lld-link"
$xwin = "$env:LOCALAPPDATA\cargo-xwin\xwin"
$env:LIB = "$xwin\crt\lib\x86_64;$xwin\sdk\lib\um\x86_64;$xwin\sdk\lib\ucrt\x86_64"
~~~

## Phone behavior

- Android 7 / API 24 minimum; keep Android System WebView updated.
- The reader is taller (at least 320px on phones). Scroll outside the text area
  to reach settings and actions; normal controls no longer float over the reader.
- Tap Fullscreen for an app-wide reading view with play/pause, stop, seek, and
  Exit. Tap the text to show or hide controls. Scrolling and keyboard input reveal
  them; they hide after three seconds. Keyboard-focused controls remain visible.
- Scrolling away from the spoken word shows a floating Auto Scroll button that
  stays visible even when fullscreen controls hide. Tap it to follow again.
- Touch targets are at least 48px tall, and long language/voice selectors stack.
- Open uses Android's file picker for UTF-8 text and Markdown. Use the system
  selection menu to copy or paste. Code Speak/Skip appears only in Markdown mode.
- Save MP3 uses Android's document picker. Rust writes through the filesystem
  plugin to the selected `content://` URI; no broad storage permission is needed.
- Playback dismisses the keyboard. Word highlighting does not refocus the editor;
  Markdown auto-scroll moves only the preview, not the entire page.
- Close and desktop shortcut hints are hidden. Global F9/middle-click selection
  reading is Windows-only.
- This is a foreground reader. Background/lock-screen playback and media
  notification controls are not implemented.

## Layout previews

Chromium touch emulation, not device screenshots:
[360px portrait](docs/screenshots/android-phone.png) ·
[740px landscape](docs/screenshots/android-landscape.png) ·
[fullscreen controls](docs/screenshots/reader-fullscreen.png) ·
[following paused](docs/screenshots/reader-fullscreen-follow-paused.png).

## Verification

Automated frontend checks:

```powershell
npm run check
npm test
npx playwright install chromium --only-shell
npm run test:ui
```

The browser tests mock native IPC, not Android itself. Before distributing an APK,
check these on a real device:

1. Portrait and landscape at 320–390dp, a tablet, larger system font/display
   scaling, gesture navigation, and a display cutout. No sideways page scroll;
   every control must remain reachable by vertical scrolling.
2. Type, select, copy, paste, and open both text and Markdown. Open the keyboard,
   rotate, then tap Play. It should dismiss and stay dismissed while words advance.
3. Read a long Markdown document, manually scroll it, then resume Auto Scroll.
   Only the preview should move. Test inline code, long URLs, and wide tables.
   Enter Fullscreen, wait three seconds, scroll to reveal controls, then wait
   again. Tap the text twice to show and hide controls. Auto Scroll must remain
   available while following is paused. Test Exit,
   Esc, keyboard focus, and rotation without interrupting playback.
4. Play, pause, resume, stop, seek, mute, and change voice/pitch rapidly, including
   while paused or buffering. Confirm immediate cancellation, first-sentence
   priority, and no stale audio.
5. Save an MP3 to Downloads and another document provider, rename it, cancel the
   picker, and stop an export. Open each saved MP3 in another app and confirm it
   has audio, not a zero-byte file.
6. Disconnect the network during playback/export. Errors must be visible and
   unread text must not be silently skipped. Reconnect and retry.
7. Navigate away and return, use Android Back, and relaunch after termination.
   Check preference persistence; do not assume background audio is supported.

Implementation checks passed on the development host: frontend typecheck/build,
37 audio/playback/planning unit tests, 20 Chromium UI/audio tests, desktop
Rust Clippy, and 14 Rust unit tests (the network test was not run). Android CLI
installed the SDK and NDK 30.0.16248370. The ARM64 release APK builds successfully;
its APK signature, minimum API 24, target API 37, and native ABI were checked.
An optimized release APK, locally signed with the same Android debug test key,
is available at `src-tauri/target/android/edge-speak-arm64.apk` (about 6.8 MiB,
versus 164 MiB for the previous symbol-heavy debug build). It is a test build,
not production-signed. No browser runtime is bundled.
Device tests have not been run because no Android device is connected.
