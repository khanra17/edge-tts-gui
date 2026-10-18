# Release builds on GitHub Actions

[Build release apps](https://github.com/khanra17/edge-tts-gui/actions/workflows/build.yml)
runs on pushes to `master`, `v*` tags, pull requests, and manual dispatch.

Download the outputs from a completed run's **Artifacts** section:

| Artifact | Contents |
| --- | --- |
| `edge-speak-windows-x64-release` | Optimized, unsigned portable EXE. No installer or browser runtime. |
| `edge-speak-android-arm64-release` | Optimized ARM64 release APK. Signed on trusted pushes/manual runs; explicitly unsigned on pull requests. |

Android builds use `tauri android build --apk --target aarch64`, never
`--debug`. Rust release optimization, LTO, symbol stripping, and Android's
release shrinking remain enabled. Signing happens **after** compilation and
does not turn a release build into a debug build.

Windows uses `tauri build --no-bundle --no-sign`; Windows code signing is not
configured. Desktop Tauri bundling remains disabled.

## Android signing secrets

Configure these repository secrets under Settings → Secrets and variables →
Actions. They have already been configured for this repository.

| Secret | Value |
| --- | --- |
| `ANDROID_KEYSTORE_BASE64` | Base64 of the dedicated release PKCS12 keystore |
| `ANDROID_KEYSTORE_PASSWORD` | Keystore password |
| `ANDROID_KEY_ALIAS` | Signing key alias |
| `ANDROID_KEY_PASSWORD` | Key password |

A missing secret fails a trusted Android build rather than silently uploading
an unsigned APK. Pull requests do not receive signing credentials and produce
an unsigned release APK for build verification, not installation.

`scripts/sign_android.py` rejects debuggable APKs, checks 16 KiB ZIP alignment,
decodes the key into a temporary owner-readable file, signs with passwords
passed through environment variables, verifies the result, and removes the
temporary key on success or failure. Only the final APK is uploaded. Signing
credentials are not supplied to npm, Cargo, Gradle, or their caches.

The actions are pinned to reviewed commit SHAs. Workflow token permissions are
read-only, checkout does not persist credentials, and builds do not publish
GitHub Releases automatically.

## Keep the key backed up

The dedicated key created for CI is backed up locally outside the repository:

```text
%USERPROFILE%\.config\edge-speak\signing\release.p12
%USERPROFILE%\.config\edge-speak\signing\release-credentials.json
```

The directory is restricted to the current Windows account. Keep an encrypted
offline backup of both files. GitHub Secrets cannot be downloaded as a backup;
losing the signing key prevents ordinary upgrades of installed APKs.

This key is separate from the earlier Android debug/test key. Installing this
release over an old debug-signed APK requires a one-time uninstall (which removes
its preferences). Subsequent release builds keep the same certificate and can
update in place. Do not regenerate the key for each build.

To replace repository secrets, use the GitHub settings UI or `gh secret set`.
Never commit keystores, password files, decoded/base64 key data, or `key.properties`.

## Local checks

```sh
npm run check
npm test
npm run test:ui
python3 -m unittest discover -s tests -p 'test_*.py'
```

For a local release signing check, set the four secret environment variables,
`ANDROID_HOME`, and `JAVA_HOME`, then run:

```sh
python3 scripts/sign_android.py \
    src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release-unsigned.apk \
    src-tauri/target/android/edge-speak-arm64-release.apk
```

Use a test key for local experiments, not a newly generated release identity.
