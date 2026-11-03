"""Offline tests for the price recovery's secret handling and rollback."""
import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

MODULE = Path(__file__).resolve().parents[1] / "pilot-restore-stripe-prices.py"
spec = importlib.util.spec_from_file_location("pilot_price_recovery", MODULE)
repair = importlib.util.module_from_spec(spec)
spec.loader.exec_module(repair)


class RecoveryTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        root = Path(self.directory.name)
        self.env = root / "pilot.env"
        self.runtime = root / "runtime.key"
        self.env.write_text("PORT=3910\nSTRIPE_PRICE_STARTER=price_1UWy5fAuUge07PL9xtaKXMtw\n")
        self.patchers = [
            patch.object(repair, "ENV", self.env),
            patch.object(repair, "RUNTIME_KEY_FILE", self.runtime),
            patch.object(repair.os, "geteuid", return_value=0),
            patch.object(repair, "verify_stripe_prices"),
            patch.object(repair, "restart"),
            patch.object(repair, "verify_local_api"),
        ]
        for patcher in self.patchers:
            patcher.start()
            self.addCleanup(patcher.stop)

    def test_runtime_key_is_verified_and_saved_without_overwriting_unrelated_config(self):
        self.runtime.write_text("sk_live_unit_test_only")
        repair.main()
        content = self.env.read_text()
        self.assertIn("STRIPE_SECRET_KEY=sk_live_unit_test_only", content)
        self.assertIn("PORT=3910", content)
        self.assertIn("STRIPE_PRICE_BUSINESS=", content)
        self.assertFalse(self.runtime.exists())
        repair.verify_stripe_prices.assert_called_once_with("sk_live_unit_test_only")
        repair.verify_local_api.assert_called_once()
        repair.restart.assert_called_once()

    def test_missing_runtime_key_aborts_without_modifying_environment(self):
        previous = self.env.read_text()
        with self.assertRaisesRegex(RuntimeError, "Missing live runtime key"):
            repair.main()
        self.assertEqual(self.env.read_text(), previous)
        repair.restart.assert_not_called()

    def test_rollback_restores_configuration_when_health_fails(self):
        self.runtime.write_text("sk_live_unit_test_only")
        previous = self.env.read_text()
        repair.verify_local_api.side_effect = RuntimeError("local api failed")
        with self.assertRaisesRegex(RuntimeError, "local api failed"):
            repair.main()
        self.assertEqual(self.env.read_text(), previous)
        self.assertEqual(repair.restart.call_count, 2)
        self.assertFalse(self.runtime.exists())

    def test_unexpected_existing_price_is_never_overwritten(self):
        self.env.write_text("STRIPE_SECRET_KEY=sk_live_original\nSTRIPE_PRICE_PRO=price_wrong\n")
        previous = self.env.read_text()
        with self.assertRaisesRegex(RuntimeError, "STRIPE_PRICE_PRO differs"):
            repair.main()
        self.assertEqual(self.env.read_text(), previous)
        repair.restart.assert_not_called()


if __name__ == "__main__":
    unittest.main()
