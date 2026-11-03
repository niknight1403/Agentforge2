#!/usr/bin/env python3
"""Safely re-key an existing AnfragePilot Stripe webhook without creating payments.

Run on the existing Oracle VM as root. Obtain the setup key exclusively from
the one-time /run file provided by a protected GitHub Actions secret.
"""
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import time
from urllib.parse import urlencode
from urllib.request import Request, urlopen

ENV = Path("/opt/anfragepilot/pilot.env")
SETUP_KEY_FILE = Path("/run/pilot-stripe-webhook-setup.key")
ENDPOINT_URL = "https://hub.cybersarah-ki.com/pilot/api/billing/webhook"
PREVIOUS_ENDPOINT_ID = "we_1UWy5gAuUge07PL9GBjBhMO0"
EXPECTED_PRICE = "price_1UWy5gAuUge07PL9OA0Y1W2t"
EVENTS = [
    "checkout.session.completed",
    "customer.subscription.created",
    "customer.subscription.updated",
    "customer.subscription.deleted",
    "invoice.payment_failed",
]


def request_stripe(key, path, fields=None):
    payload = urlencode(fields).encode() if fields is not None else None
    req = Request(
        "https://api.stripe.com/v1/" + path,
        data=payload,
        headers={"Authorization": "Bearer " + key,
                 "Content-Type": "application/x-www-form-urlencoded"},
        method="POST" if payload is not None else "GET",
    )
    with urlopen(req, timeout=20) as response:
        return json.load(response)


def entries_from(text):
    result = {}
    for line in text.splitlines():
        match = re.match(r"^(?:export )?([A-Z][A-Z0-9_]*)=(.*)$", line.strip())
        if match:
            result[match.group(1)] = match.group(2).strip().strip("'\"")
    return result


def check_local_webhook(secret):
    """Synthetic unsigned-payload-free probe; no customer/payment actions."""
    timestamp = str(int(time.time()))
    event = {"id": "evt_pilot_signing_probe_" + timestamp,
             "object": "event", "type": "pilot.signing_probe",
             "data": {"object": {}}}
    body = json.dumps(event, separators=(",", ":")).encode()
    signed = (timestamp + ".").encode() + body
    signature = hmac.new(secret.encode(), signed, hashlib.sha256).hexdigest()
    req = Request(
        "http://127.0.0.1:3910/api/billing/webhook",
        data=body, method="POST",
        headers={"Content-Type": "application/json",
                 "Stripe-Signature": "t=" + timestamp + ",v1=" + signature},
    )
    with urlopen(req, timeout=10) as response:
        reply = json.load(response)
        if response.status != 200 or reply.get("received") is not True:
            raise RuntimeError("Signing probe rejected")


def verify_paid_plans():
    with urlopen("http://127.0.0.1:3910/api/plans", timeout=10) as response:
        body = json.load(response)
    plans = {p["key"]: p for p in body.get("plaene", [])}
    if not all(plans.get(key, {}).get("kaufbar") is True
               for key in ("starter", "pro", "business")):
        raise RuntimeError("Paid plans not ready after signing repair")


def install_secret(original, secret, endpoint_id):
    # Never rewrite an unrelated signing secret; the preflight checks its absence.
    suffix = ("\n" if original and not original.endswith("\n") else "")
    return original + suffix + "STRIPE_WEBHOOK_SECRET=" + secret + "\n" + (
        "STRIPE_WEBHOOK_ENDPOINT_ID=" + endpoint_id + "\n")


def restart():
    subprocess.run(["systemctl", "restart", "anfragepilot.service"], check=True, timeout=35)


def main():
    if os.geteuid() != 0 or not ENV.is_file():
        raise RuntimeError("Requires root and existing AnfragePilot installation")
    if not SETUP_KEY_FILE.is_file():
        raise RuntimeError("GitHub Stripe setup key not supplied")
    try:
        setup_key = SETUP_KEY_FILE.read_text().strip()
    finally:
        SETUP_KEY_FILE.unlink(missing_ok=True)
    if not setup_key.startswith(("sk_live_", "rk_live_")):
        raise RuntimeError("A valid live setup key is required")

    original = ENV.read_text()
    previous = entries_from(original)
    if previous.get("STRIPE_WEBHOOK_SECRET", "").startswith("whsec_"):
        raise RuntimeError("Webhook signing secret already set: refusing replacement")
    runtime_key = previous.get("STRIPE_SECRET_KEY", "")
    if not runtime_key.startswith(("sk_live_", "rk_live_")):
        raise RuntimeError("Runtime Stripe key missing; refusing webhook changes")

    expected = request_stripe(setup_key, "prices/" + EXPECTED_PRICE)
    if expected.get("livemode") is not True or expected.get("unit_amount") != 9900:
        raise RuntimeError("Setup key cannot verify the expected live Stripe account")
    endpoint = request_stripe(setup_key, "webhook_endpoints/" + PREVIOUS_ENDPOINT_ID)
    if endpoint.get("url") != ENDPOINT_URL or endpoint.get("status") != "enabled":
        raise RuntimeError("Expected existing webhook endpoint differs or is not enabled")

    backup = ENV.with_name(ENV.name + ".before-webhook-repair-" + str(os.getpid()))
    shutil.copy2(ENV, backup)
    os.chmod(backup, 0o600)
    original_stat = ENV.stat()
    new_id = None
    did_install = False
    old_disabled = False
    tmp_path = None
    try:
        fields = [("url", ENDPOINT_URL), ("description", "AnfragePilot verified signing secret recovery")]
        fields += [("enabled_events[]", name) for name in EVENTS]
        fields.append(("api_version", "2024-06-20"))
        created = request_stripe(setup_key, "webhook_endpoints", fields)
        new_id = created.get("id")
        signing = created.get("secret")
        if (not new_id or not signing or not signing.startswith("whsec_")
                or created.get("livemode") is not True):
            raise RuntimeError("New live endpoint did not return a signing secret")

        with tempfile.NamedTemporaryFile("w", dir=ENV.parent, prefix=".pilot-webhook-", delete=False) as tmp:
            tmp_path = Path(tmp.name)
            tmp.write(install_secret(original, signing, new_id))
        os.chmod(tmp_path, stat.S_IMODE(original_stat.st_mode))
        os.chown(tmp_path, original_stat.st_uid, original_stat.st_gid)
        os.replace(tmp_path, ENV)
        tmp_path = None
        did_install = True
        restart()
        check_local_webhook(signing)
        verify_paid_plans()

        # The old endpoint cannot sign requests against the new secret.
        # Disable it ONLY after our replacement has passed the signed probe.
        retired = request_stripe(setup_key, "webhook_endpoints/" + PREVIOUS_ENDPOINT_ID,
                                 [("disabled", "true")])
        if retired.get("status") != "disabled":
            raise RuntimeError("Could not safely retire the obsolete signing endpoint")
        old_disabled = True
        print("PILOT_WEBHOOK_SIGNING_READY")
        print("PILOT_OLD_WEBHOOK_DISABLED")
        print("PILOT_PAID_PLANS_READY")
    except Exception:
        if did_install:
            shutil.copy2(backup, ENV)
            os.chmod(ENV, stat.S_IMODE(original_stat.st_mode))
            os.chown(ENV, original_stat.st_uid, original_stat.st_gid)
            restart()
        if old_disabled:
            try:
                request_stripe(setup_key, "webhook_endpoints/" + PREVIOUS_ENDPOINT_ID,
                               [("disabled", "false")])
            except Exception:
                print("WARNING: Could not re-enable previous endpoint", file=sys.stderr)
        if new_id:
            try:
                request_stripe(setup_key, "webhook_endpoints/" + new_id,
                               [("disabled", "true")])
            except Exception:
                print("WARNING: Could not disable replacement endpoint", file=sys.stderr)
        raise
    finally:
        if tmp_path and tmp_path.exists():
            tmp_path.unlink()
        print("Webhook environment backup retained in protected directory")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        # Never print API response bodies or secret-bearing request data.
        print("WEBHOOK_RECOVERY_FAILED: " + type(exc).__name__, file=sys.stderr)
        sys.exit(1)
