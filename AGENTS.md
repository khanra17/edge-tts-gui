# Repository guidelines

## Structure
- `src/`: strict TypeScript frontend; application wiring, playback engine,
  speech planning, editor, native API, and preferences are separate modules.
- `src-tauri/src/`: Rust 2024 backend. TTS code is independent of Tauri;
  native commands handle serialization, dialogs, and events.
- `tests/`: direct frontend unit tests using Node's built-in runner.
- `src-tauri/voices.tsv`: embedded voice catalog.
- Do not restore OCR, duplicate synthesis APIs, generated artifacts, or the old
  nested `rust/` layout.

## Commands
- Install: `npm ci`.
- Develop: `npm run tauri dev`.
- Frontend checks: `npm run check && npm test`.
- Rust checks (in `src-tauri`): `cargo fmt --check`,
  `cargo clippy --all-targets -- -D warnings`, `cargo test`.
- Optional network test: `cargo test live_synthesis_smoke -- --ignored --nocapture`.
- Unsigned portable release: `npm run release`.
- Without native MSVC: append
  `-- --runner cargo-xwin --target x86_64-pc-windows-msvc` to release.
- Tauri bundling must remain disabled. Do not add installers unless requested.

## Conventions
- Four-space indentation, ES modules, strict TypeScript, Rust 2024.
- Keep native command contracts in `src/types.ts` and `commands.rs` aligned.
- Preserve immediate cancellation and first-sentence priority. Test stale
  responses, rapid settings changes, and paused playback when changing buffering.
- Network failures must be visible and must not silently skip unread text.
- The public Edge token is not an account secret. Never commit private credentials.
- Keep lockfiles current. Prefer latest stable dependencies, not prereleases.
- Do not commit `node_modules/`, `dist/`, `target/`, or generated Tauri schemas.
- Include tests and manual verification notes for behavior changes.
- Keep commits concise and scoped; include screenshots for visible UI changes.
