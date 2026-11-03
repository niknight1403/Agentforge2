"""Offline checks for the live webhook secret recovery primitives."""
import importlib.util
from pathlib import Path
import hashlib
import hmac
import json
import unittest
from types import SimpleNamespace
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[1] / "pilot-safe-webhook-repair.py"
spec = importlib.util.spec_from_file_location("pilot_webhook_repair", SCRIPT)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class FakeResponse:
    status = 200
    def __enter__(self):
        return self
    def __exit__(self, *args):
        return False
    def read(self, *args):
        return b'{"received":true}'


class WebhookRecoveryTests(unittest.TestCase):
    def test_secret_install_preserves_existing_environment(self):
        result = module.install_secret("PORT=3910\nSTRIPE_PRICE_PRO=price_123\n",
                                       "whsec_test_only", "we_new")
        self.assertIn("PORT=3910\nSTRIPE_PRICE_PRO=price_123\n", result)
        self.assertEqual(result.count("STRIPE_WEBHOOK_SECRET="), 1)
        self.assertIn("STRIPE_WEBHOOK_ENDPOINT_ID=we_new", result)

    def test_secret_install_newline_normalization(self):
        result = module.install_secret("PORT=3910", "whsec_test_only", "we_new")
        self.assertEqual(result.splitlines(), [
            "PORT=3910", "STRIPE_WEBHOOK_SECRET=whsec_test_only",
            "STRIPE_WEBHOOK_ENDPOINT_ID=we_new"
        ])


    def test_stripe_api_uses_curl_without_secret_in_command_arguments(self):
        result = SimpleNamespace(returncode=0, stdout='{"id":"we_test"}')
        with patch.object(module.subprocess, "run", return_value=result) as run:
            data = module.request_stripe("sk_live_unit_test_only", "webhook_endpoints",
                                         [("url", "https://example.test/path")])
        self.assertEqual(data["id"], "we_test")
        args, kwargs = run.call_args
        self.assertNotIn("sk_live_unit_test_only", " ".join(args[0]))
        self.assertIn("Authorization: Bearer sk_live_unit_test_only", kwargs["input"])
        self.assertIn("data = ", kwargs["input"])


    def test_stripe_request_curl_config_has_real_line_breaks(self):
        result = SimpleNamespace(returncode=0, stdout='{"id":"price_test"}')
        with patch.object(module.subprocess, "run", return_value=result) as run:
            module.request_stripe("sk_live_unit_test_only", "prices/price_test",
                                  [("enabled_events[]", "checkout.session.completed")])
        config = run.call_args.kwargs["input"]
        self.assertEqual(config.count(chr(10)), 3)
        self.assertEqual(config.splitlines()[0], 'header = "Authorization: Bearer sk_live_unit_test_only"')
        self.assertIn('enabled_events%5B%5D', config)

    def test_signed_probe_is_valid_hmac_and_contains_no_payment(self):
        captured = []
        def fake_run(command, **kwargs):
            captured.append((command, kwargs))
            return SimpleNamespace(returncode=0, stdout=b'{"received":true}' + bytes([10]) + b'200')
        with patch.object(module.subprocess, "run", side_effect=fake_run), \
             patch.object(module.time, "time", return_value=1793700000):
            module.check_local_webhook("whsec_test_only")
        self.assertEqual(len(captured), 1)
        command, kwargs = captured[0]
        self.assertIn("--noproxy", command)
        self.assertIn("*", command)
        payload = kwargs["input"]
        event = json.loads(payload)
        self.assertEqual(event["type"], "pilot.signing_probe")
        self.assertEqual(event["data"]["object"], {})
        header = command[command.index("--header") + 3]
        self.assertTrue(header.startswith("Stripe-Signature: "))
        _, raw = header.split(": ", 1)
        stamp, signature = raw.split(",")
        timestamp = stamp.split("=")[1]
        actual = signature.split("=")[1]
        expected = hmac.new(
            b"whsec_test_only", (timestamp + ".").encode() + payload,
            hashlib.sha256
        ).hexdigest()
        self.assertEqual(actual, expected)

    def test_local_check_rejects_non_200_http(self):
        fake = SimpleNamespace(returncode=0, stdout=b'{"error":"bad"}' + bytes([10]) + b'422')
        with patch.object(module.subprocess, "run", return_value=fake):
            with self.assertRaisesRegex(RuntimeError, "status 422"):
                module.local_json("/api/billing/webhook", b'{}', "fake")

    def test_local_check_rejects_failed_connection(self):
        fake = SimpleNamespace(returncode=7, stdout=b"")
        with patch.object(module.subprocess, "run", return_value=fake):
            with self.assertRaisesRegex(RuntimeError, "curl 7"):
                module.local_json("/api/plans")


if __name__ == "__main__":
    unittest.main()
