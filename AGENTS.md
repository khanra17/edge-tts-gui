# Repository Guidelines

## Project Structure & Module Organization
- `rust/`: Tauri/Rust application.
  - `src/`: vanilla HTML/CSS/JS frontend.
  - `src-tauri/`: Rust backend, Tauri config, embedded voice list, and icon.
  - `scripts/compress-exe.ps1`: UPX compression helper for the release exe.
- Root: `README.md`, `LICENSE`, and screenshots (`interface.png`, `button.jpg`).

## Build, Test, and Development Commands
Rust/Tauri application:
- Prereqs: Rust stable, Node.js/npm, WebView2 runtime, and `upx.exe` on `PATH` for final compression.
- Install deps: `cd rust && npm install`.
- Dev run: `npm run tauri dev`.
- Tests: `cd rust/src-tauri && cargo test`.
- Optional live Edge TTS smoke test: `cargo test live_synthesis_smoke -- --ignored --nocapture`.
- No-bundle release build: `cd rust && npm run build:no-bundle`.
- Extreme-compressed exe: `cd rust && npm run build:compressed`.
- Final output: `rust/src-tauri/target/release/edge-tts-gui-rust.exe`.
- Tauri bundling stays disabled in `rust/src-tauri/tauri.conf.json` (`bundle.active=false`); do not switch to MSI/NSIS/AppImage bundling unless explicitly requested.

## Coding Style & Naming Conventions
- Use 4-space indentation.

## Testing Guidelines
- There is no automated test suite in the repo today.
- For behavior changes, include manual verification steps in the PR.

## Commit & Pull Request Guidelines
- Commit history is mostly short, imperative subjects. Keep messages concise and scoped.
- PRs should include: what changed, why, how to test, and screenshots/GIFs for UI changes; link related issues if applicable.

## Security & Configuration Tips
- Don’t commit build outputs (`build/`, `dist/`, `rust/dist/`, `rust/src-tauri/target/`, `rust/node_modules/`).
- Avoid hardcoding secrets/tokens; treat network failures as expected and handle them gracefully.
