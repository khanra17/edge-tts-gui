# Shared desktop and Android reader

## Boundaries

- `src/main.ts` loads styles and starts the application.
- `app.ts` owns preferences, document changes, export state, and playback actions.
  Neither platform has a separate reader implementation.
- `view.ts` drives normal and fullscreen controls from one playback state. It
  caches DOM references and changes text/properties only when needed.
- `reader-mode.ts` owns fullscreen layout, tap toggling, the three-second timeout,
  and keyboard focus. Entering/exiting fullscreen never recreates playback.
- `editor.ts` owns Markdown sanitization, source-to-speech mapping, and highlights.
- `playback.ts` owns ordering, bounded prefetch, cached seeking, and generations.
  It has injected speech/audio boundaries and no Tauri dependency.
- `audio.ts` owns compressed MP3 data, media elements, MediaSource, and Blob URLs.
- `api.ts` is the only frontend module importing Tauri APIs.
- Rust `lib.rs` sets up the common commands, document plugins, and runtime.
  `platform.rs` contains desktop single-instance handling and Windows-only
  selection shortcuts. Android does not load those plugins.
- `export.rs` uses the same Tauri dialog/filesystem plugins on both platforms;
  Android content URIs never go through ordinary path-based filesystem writes.
- Rust `tts/` remains independent of Tauri. `jobs.rs` cancels obsolete operations.
  The monotonic generation is shared by playback, prefetch, and export.

Generated Gradle bindings stay under ignored `src-tauri/gen/`. They are not an
alternative native UI. The direct desktop `rfd` dependency was removed; the
official dialog plugin supplies one cross-platform dialog implementation.

## WebView, not a bundled browser

Windows uses the installed WebView2 runtime. Android uses the system WebView
provider. Tauri/Wry hosts those views; neither Electron nor CEF is used.
Playwright and its downloaded browser are development tools, not app contents.
The frontend distribution is roughly 140 KiB uncompressed, including Markdown
and sanitization libraries.

The inspected ARM64 release APK contains one native app library,
`lib/arm64-v8a/libedge_speak_lib.so`, plus Android application resources/classes.
It contains no Chromium/CEF native runtime. The 164 MiB earlier APK retained
debug symbols; the optimized, locally test-signed release APK is about 6.8 MiB.
APK size is not a measurement of running RAM.

## Resource lifetimes

- The first sentence and short bridge are still requested together. There are
  at most three synthesis requests in flight and three chunks ahead.
- Lookahead keeps compressed MP3 packets/Blobs. It creates no Audio element,
  object URL, MediaSource, or decoder until attached for playback.
- Leaving an active chunk unloads its media element and revokes its URL while
  retaining compressed data for replay. One previous chunk is retained; older
  seeks restart synthesis at the requested sentence, without skipping text.
- Stop and reconfiguration dispose the whole cache immediately. Late responses
  cannot append packets to a replacement generation.
- Completed streams use Blob playback when revisited. Completion only decodes
  the authoritative base64 result if some streamed packets are missing.
- Playback detaches pending metadata callbacks when changing chunks.
- Turning Markdown off drops its hidden DOM, word mappings, and derived text.
  Stop drops the playback engine's document reference.
- Highlight polling runs every 80 ms while visible and playing, not on every
  display frame. Hidden windows stop polling; pause/stop cancel the timer.
- Rust uses two async workers and at most four blocking workers, rather than
  scaling its executor with the host's logical CPU count.

The system WebView still has its own renderer/media memory. A very long sentence
can produce a large chunk; the cache is bounded by chunks, not a hard byte quota.
MP3 export still assembles the full output in Rust before writing it. Those are
not covered by a claimed universal RAM ceiling.

## Checks and profiling

`npm test` covers ordering, cancellation, paused settings changes, bounded history,
decoder release, and base64 completion sizes. `npm run test:ui` covers responsive
layouts, tap toggling, Markdown controls, and actual MP3 decoder release/replay.
The browser allocation check confirms zero players/MediaSources/URLs for four
prefetched MP3s and one pending stream before attachment.

Rust formatting, desktop Clippy, and 14 Rust unit tests pass. The network smoke
test is opt-in. Android release packaging, APK signing, and 16 KiB ZIP alignment
were checked. The portable Windows release also builds (about 4.1 MiB). No
connected Android device was available, so there is no measured before/after
device RAM claim.

For device comparison, install optimized builds, read the same long document,
and compare `adb shell dumpsys meminfo com.edge.tts.gui.rust` at idle, during
playback, while paused, and after Stop. Repeat after rapid voice/pitch changes
and a long export. Include the WebView renderer process; do not compare only the
Rust host process or confuse APK size with working memory.
