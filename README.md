# Edge Speak

A Windows desktop reader using Microsoft's public Edge TTS service. No account
or API key is required. Speech synthesis requires an internet connection;
WebView2 is the only runtime requirement for the portable executable.

## Features

- Voice and language selection, live speed and volume, server-side pitch.
- Immediate cancellation when voice, language, pitch, or reading mode changes.
- First sentence and a short one-sentence bridge fetched in parallel, then
  three-sentence batches with up to three requests in flight and three chunks ahead.
- Incoming MP3 frames play through MediaSource without waiting for a complete
  batch; full-audio playback remains a fallback for unsupported WebViews.
- Sentence-aware splitting that keeps filenames, versions, and URLs intact.
- Plain text and sanitized Markdown, optional code reading, word highlighting,
  pause/resume, seeking, and MP3 export.
- F9 or middle-click to read selected text in another application.
- Persistent preferences and a single application instance.

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

## Check and test

```powershell
npm run check
npm test
cd src-tauri
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test
cargo test live_synthesis_smoke -- --ignored --nocapture
```

The ignored test contacts Microsoft and verifies audio plus word timings.
Frontend tests exercise the playback engine directly with an injected speech
service and audio resources, without a browser or mocked global DOM.

For machines without MSVC Build Tools, `cargo-xwin` with LLVM is an alternative:

```powershell
cargo xwin test --target x86_64-pc-windows-msvc --no-run
```

Run the resulting `target\x86_64-pc-windows-msvc\debug\deps\edge_speak-*.exe`
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
The minimal `src-tauri/build.rs` is required by Tauri to generate application
metadata and permissions; there are no custom build or compression scripts.

## Code layout

```text
src/
    main.ts         Application wiring and controls
    api.ts          Typed native command boundary
    playback.ts     Playback scheduling, buffering, cancellation, seeking
    audio.ts        Streaming MP3 and complete-audio resource lifecycles
    speech.ts       Sentence/chunk planning and word alignment
    editor.ts       Markdown sanitization, speech mapping, highlighting
    settings.ts     Validated preference persistence
    types.ts        Shared frontend contracts
    styles.css      Reader styles
src-tauri/
    src/
        main.rs     Native application setup
        commands.rs Four frontend commands and MP3 export
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

## Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| Ctrl+Enter | Play, pause, resume |
| Space outside controls/editor | Play, pause, resume |
| Esc | Stop playback or cancel export |
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
network to verify visible errors rather than skipped sentences.

The service fingerprint in `tts/mod.rs` intentionally follows upstream
[edge-tts](https://github.com/rany2/edge-tts), not the installed Edge version.
See `THIRD_PARTY_NOTICES.md` and `LICENSE` for attribution and licensing.
