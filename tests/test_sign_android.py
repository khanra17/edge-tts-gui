import base64
import importlib.util
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location(
    "sign_android", Path(__file__).parents[1] / "scripts" / "sign_android.py"
)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class AndroidSigningTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.source = self.root / "release.apk"
        self.source.write_bytes(b"unsigned APK")
        self.destination = self.root / "artifacts" / "signed.apk"
        self.environment = {
            "ANDROID_HOME": str(self.root / "sdk"),
            "ANDROID_KEYSTORE_BASE64": base64.b64encode(b"test keystore").decode(),
            "ANDROID_KEYSTORE_PASSWORD": "test-store-password",
            "ANDROID_KEY_ALIAS": "test-alias",
            "ANDROID_KEY_PASSWORD": "test-key-password",
            "RUNNER_TEMP": str(self.root),
        }

    def test_missing_secret_fails_before_running_tools(self):
        self.environment.pop("ANDROID_KEY_PASSWORD")
        with patch.dict(os.environ, self.environment, clear=True), patch.object(
            MODULE.subprocess, "run"
        ) as run:
            with self.assertRaisesRegex(ValueError, "ANDROID_KEY_PASSWORD"):
                MODULE.sign_apk(self.source, self.destination)
            run.assert_not_called()

    def test_debug_apks_are_rejected(self):
        with patch.dict(os.environ, self.environment, clear=True), patch.object(
            MODULE.subprocess, "run",
            return_value=subprocess.CompletedProcess([], 0, "application-debuggable"),
        ) as run:
            with self.assertRaisesRegex(ValueError, "debug APK"):
                MODULE.sign_apk(self.source, self.destination)
            self.assertEqual(run.call_count, 1)
            self.assertEqual(list(self.root.glob("edge-speak-signing-*")), [])

    def test_signing_keeps_passwords_out_of_arguments_and_cleans_up(self):
        def run(arguments, **options):
            if "sign" in arguments:
                keystore = Path(arguments[arguments.index("--ks") + 1])
                self.assertEqual(keystore.read_bytes(), b"test keystore")
                self.assertNotIn("test-store-password", arguments)
                self.assertNotIn("test-key-password", arguments)
                self.assertIn("env:ANDROID_KEYSTORE_PASSWORD", arguments)
            return subprocess.CompletedProcess(arguments, 0, "")

        with patch.dict(os.environ, self.environment, clear=True), patch.object(
            MODULE.subprocess, "run", side_effect=run
        ) as mocked:
            MODULE.sign_apk(self.source, self.destination)
            self.assertEqual(mocked.call_count, 5)
        self.assertEqual(list(self.root.glob("edge-speak-signing-*")), [])

    def test_failed_signing_also_removes_the_temporary_key(self):
        def run(arguments, **options):
            if "sign" in arguments:
                raise subprocess.CalledProcessError(1, arguments)
            return subprocess.CompletedProcess(arguments, 0, "")

        with patch.dict(os.environ, self.environment, clear=True), patch.object(
            MODULE.subprocess, "run", side_effect=run
        ):
            with self.assertRaises(subprocess.CalledProcessError):
                MODULE.sign_apk(self.source, self.destination)
        self.assertEqual(list(self.root.glob("edge-speak-signing-*")), [])


if __name__ == "__main__":
    unittest.main()
