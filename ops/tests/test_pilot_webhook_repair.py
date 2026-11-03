"""Offline checks for the live webhook secret recovery primitives."""
import importlib.util
from pathlib import Path
import hashlib
import hmac
import json
import unittest
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

    def test_signed_probe_is_valid_hmac_and_contains_no_payment(self):
        captured = []
        def fake_urlopen(request, timeout=0):
            captured.append(request)
            return FakeResponse()
        with patch.object(module, "urlopen", side_effect=fake_urlopen), \
             patch.object(module.time, "time", return_value=1793700000):
            module.check_local_webhook("whsec_test_only")
        self.assertEqual(len(captured), 1)
        request = captured[0]
        payload = request.data
        event = json.loads(payload)
        self.assertEqual(event["type"], "pilot.signing_probe")
        self.assertEqual(event["data"]["object"], {})
        header = request.headers["Stripe-signature"]
        stamp, signature = header.split(",")
        timestamp = stamp.split("=")[1]
        value = signature.split("=")[1]
        expected = hmac.new(
            b"whsec_test_only",
            (timestamp + ".").encode() + payload,
            hashlib.sha256
        ).hexdigest()
        self.assertEqual(value, expected)


if __name__ == "__main__":
    unittest.main()
