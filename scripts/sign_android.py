"""Sign an optimized APK without putting keystores or passwords in the project."""

import argparse
import base64
import os
from pathlib import Path
import subprocess
import tempfile

SECRET_NAMES = (
    "ANDROID_KEYSTORE_BASE64",
    "ANDROID_KEYSTORE_PASSWORD",
    "ANDROID_KEY_ALIAS",
    "ANDROID_KEY_PASSWORD",
)


def sign_apk(source: Path, destination: Path) -> None:
    for name in SECRET_NAMES:
        if not os.environ.get(name):
            raise ValueError(f"Missing signing secret: {name}")
    sdk = os.environ.get("ANDROID_HOME") or os.environ.get("ANDROID_SDK_ROOT")
    if not sdk:
        raise ValueError("Set ANDROID_HOME to the Android SDK")
    tools = Path(sdk) / "build-tools" / os.environ.get(
        "ANDROID_BUILD_TOOLS_VERSION", "37.0.0"
    )
    windows = os.name == "nt"
    signer = tools / ("apksigner.bat" if windows else "apksigner")
    aligner = tools / ("zipalign.exe" if windows else "zipalign")
    inspector = tools / ("aapt2.exe" if windows else "aapt2")
    if not source.is_file():
        raise ValueError(f"APK does not exist: {source}")
    if source.resolve() == destination.resolve():
        raise ValueError("Use a separate destination for the signed APK")

    manifest = subprocess.run(
        [str(inspector), "dump", "badging", str(source)],
        check=True, capture_output=True, text=True,
    )
    if "application-debuggable" in manifest.stdout:
        raise ValueError("Refusing to sign a debug APK; build the release variant")
    subprocess.run([str(aligner), "-c", "-P", "16", "4", str(source)], check=True)
    key = base64.b64decode(os.environ["ANDROID_KEYSTORE_BASE64"], validate=True)
    if not key:
        raise ValueError("The Android keystore is empty")

    destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(
        prefix="edge-speak-signing-", dir=os.environ.get("RUNNER_TEMP")
    ) as temporary:
        keystore = Path(temporary) / "release.p12"
        keystore.write_bytes(key)
        keystore.chmod(0o600)
        subprocess.run([
            str(signer), "sign",
            "--ks", str(keystore),
            "--ks-key-alias", os.environ["ANDROID_KEY_ALIAS"],
            "--ks-pass", "env:ANDROID_KEYSTORE_PASSWORD",
            "--key-pass", "env:ANDROID_KEY_PASSWORD",
            "--out", str(destination), str(source),
        ], check=True)
        subprocess.run([str(signer), "verify", "--verbose", str(destination)], check=True)
        subprocess.run([str(aligner), "-c", "-P", "16", "4", str(destination)], check=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("destination", type=Path)
    arguments = parser.parse_args()
    sign_apk(arguments.source, arguments.destination)
