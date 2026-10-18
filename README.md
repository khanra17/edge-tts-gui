# Edge Speak

A Windows and Android reader built with Tauri, using Microsoft's public Edge TTS
service. No account or API key is required. Speech synthesis requires an internet
connection. Windows uses WebView2; Android uses the system WebView.

## Features

- Voice and language selection, live speed and volume, server-side pitch.
- Immediate cancellation when voice, language, pitch, or reading mode changes.
- First sentence and a short one-sentence bridge fetched in parallel, then
  three-sentence batches with up to three requests in flight and three chunks ahead.
- Incoming MP3 frames play through MediaSource without waiting for a complete
  batch; full-audio playback remains a fallback for unsupported WebViews.
- Sentence-aware splitting that keeps filenames, versions, and URLs intact.
- Plain text and sanitized Markdown, Markdown-only code controls, word highlighting,
  pause/resume, seeking, and MP3 export.
- Touch-friendly phone and tablet layouts, with Open text/Markdown and Save MP3.
- Fullscreen reading: tap the text to show/hide controls, or scroll to reveal
  them. Controls also hide after three seconds; a floating button resumes following.
- Windows: F9 or middle-click to read selected text in another application.
- Persistent preferences; desktop builds use a single application instance.

OCR and its embedded executable/models have been removed. Image selections are
not supported.

## Develop

Use Node **26.12.0**, npm **11.20.0**, Rust **1.99.1**, Microsoft C++ Build Tools,
and WebView2. Versions are recorded in `.node-version`, `rust-toolchain.toml`,
and the dependency lockfiles.

```powershell
npm ci
npm run tauri dev
```

`npm run dev` runs only the frontend server; native commands need the Tauri app.

## Android

See [ANDROID.md](ANDROID.md) for SDK setup, device development, APK builds,
and the on-device verification checklist. Android uses the same TypeScript UI,
Rust speech service, and playback engine as Windows, not a separate native UI.

## Check and test

```powershell
npm run check
npm test
npx playwright install chromium --only-shell
npm run test:ui
cd src-tauri
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test
cargo test live_synthesis_smoke -- --ignored --nocapture
```

The ignored test contacts Microsoft and verifies audio plus word timings.
Frontend tests exercise the playback engine directly with an injected speech
service and audio resources, without a browser or mocked global DOM. Playwright
checks touch targets, overflow, file opening, long export status messages, and
keyboard-safe highlighting from
320px portrait through tablet and landscape sizes, with mocked Tauri IPC.
Screenshots and failure traces go to `test-results/`.

For machines without MSVC Build Tools, `cargo-xwin` with LLVM is an alternative:

```powershell
cargo xwin test --target x86_64-pc-windows-msvc --no-run
```

Run the resulting `target\x86_64-pc-windows-msvc\debug\deps\edge_speak_lib-*.exe`
directly on Windows; cargo-xwin otherwise assumes Wine as its test runner.

## Unsigned release

From the repository root:

```powershell
npm run release
```

Output: `src-tauri/target/release/edge-speak.exe`. This builds a portable
executable, not an installer. Bundling and signing are disabled.

With cargo-xwin:

```powershell
npm run release -- --runner cargo-xwin --target x86_64-pc-windows-msvc
```

That output is `src-tauri/target/x86_64-pc-windows-msvc/release/edge-speak.exe`.
The minimal `src-tauri/build.rs` generates Tauri metadata and permissions.
`scripts/sign_android.py` handles APK signing after the optimized Android build.

## Automated release builds

[GitHub Actions](https://github.com/khanra17/edge-tts-gui/actions/workflows/build.yml)
builds an unsigned optimized Windows portable EXE and an optimized Android ARM64
release APK signed with the repository release key. Pull requests build unsigned
Android release APKs without access to signing secrets.

See [CI and signing setup](docs/ci.md) for artifact downloads, key backups, and
upgrading from older debug-signed Android builds.

## Code layout

```text
src/
    main.ts         Frontend entry point and styles
    app.ts          Shared application controller
    view.ts         Normal and fullscreen control rendering
    api.ts          Typed native command boundary
    playback.ts     Playback scheduling, buffering, cancellation, seeking
    audio.ts        Streaming MP3 and complete-audio resource lifecycles
    speech.ts       Sentence/chunk planning and word alignment
    editor.ts       Markdown sanitization, speech mapping, highlighting
    settings.ts     Validated preference persistence
    types.ts        Shared frontend contracts
    styles.css      Reader styles
    responsive.css  Touch targets, safe areas, and platform layout adjustments
    reader-mode.ts  Fullscreen reader, control timeout, and keyboard focus
    reader-mode.css Fullscreen reading layout
src-tauri/
    src/
        main.rs     Desktop entry point
        lib.rs      Shared Tauri setup and Android entry point
        commands.rs Typed frontend commands
        platform.rs Desktop-only lifecycle and Windows selection hooks
        export.rs   Shared document picker and URI-aware file writing
        jobs.rs     Cancellation generations
        selection.rs Windows selected-text shortcuts
        voices.rs   Embedded voice catalog
        tts/
            mod.rs      Service connection and synthesis
            protocol.rs WebSocket messages and SSML
            text.rs     UTF-8/XML-safe request splitting
            token.rs    Upstream-compatible v2 service token
    voices.tsv
tests/              Node's built-in test runner, native TypeScript support
```

## Runtime and memory

Both platforms use their system WebView. No Chromium, Electron, or CEF runtime
is packaged. See [architecture and resource lifetimes](docs/architecture.md) for
the shared design, memory changes, and what still needs device profiling.

## Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| Ctrl+Enter | Play, pause, resume |
| Space outside controls/editor | Play, pause, resume |
| Esc | Exit fullscreen; otherwise stop playback or cancel export |
| Alt+Left / Alt+Right | Seek five seconds |
| Ctrl+S | Save MP3 |
| F9 / middle mouse | Read selected text globally |

## Manual verification

Start with a short sentence followed by several longer sentences. Verify that
requests for the first two sentences overlap, later batches are fetched during
playback, and ready audio plays immediately at chunk boundaries. With a long first
sentence, verify that playback starts before synthesis of the sentence completes. Under slow
network conditions, check that one pending batch does not block other lookahead.
Read text containing `AGENTS.md`, `v1.2.3`, and URLs with query parameters; these
must not be split at their internal punctuation.

Read a multi-sentence document, then change voice/language/pitch while playing,
buffering, and paused. Old audio must stop immediately; paused playback must
remain paused. Toggle Markdown/code reading near the middle of a document and
verify continuation near the current word. Check highlighting, zero volume,
seeking, F9/middle-click, dropped text files, and MP3 export. Disconnect the
network to verify visible errors rather than skipped sentences. Tap fullscreen text
repeatedly to show/hide controls without hiding the persistent Auto Scroll button.
Code controls must disappear outside Markdown mode. Copy uses the platform text
selection menu or Ctrl+C; there is no separate Copy button.

The service fingerprint in `tts/mod.rs` intentionally follows upstream
[edge-tts](https://github.com/rany2/edge-tts), not the installed Edge version.
See `THIRD_PARTY_NOTICES.md` and `LICENSE` for attribution and licensing.
