#!/usr/bin/env python3
"""Restore existing, verified live Stripe price IDs without creating charges.

Intended for an authenticated, privileged deployment runner only.
Checks the server's own Stripe key before changing its configuration.
"""
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
from urllib.request import Request, urlopen

ENV = Path("/opt/anfragepilot/pilot.env")
PRICES = {
    "STRIPE_PRICE_STARTER": ("price_1UWy5fAuUge07PL9xtaKXMtw", 4900),
    "STRIPE_PRICE_PRO": ("price_1UWy5gAuUge07PL9OA0Y1W2t", 9900),
    "STRIPE_PRICE_BUSINESS": ("price_1UWy5gAuUge07PL9vz9JCYML", 19900),
}
SERVICE = "anfragepilot.service"


def fail(message):
    raise RuntimeError(message)


def read_entries(contents):
    entries = {}
    for line in contents.splitlines():
        match = re.match(r"^(?:export )?([A-Z][A-Z0-9_]*)=(.*)$", line.strip())
        if match:
            entries[match.group(1)] = match.group(2).strip().strip("'\"")
    return entries


def verify_stripe_prices(secret):
    if not secret or not secret.startswith(("sk_live_", "rk_live_")):
        fail("Production Stripe secret is absent or not a live key; configuration unchanged")
    for env_key, (price_id, expected_amount) in PRICES.items():
        request = Request(
            "https://api.stripe.com/v1/prices/" + price_id,
            headers={"Authorization": "Bearer " + secret},
        )
        with urlopen(request, timeout=15) as response:
            price = json.load(response)
        if not (
            price.get("id") == price_id
            and price.get("livemode") is True
            and price.get("active") is True
            and price.get("currency") == "eur"
            and price.get("unit_amount") == expected_amount
            and (price.get("recurring") or {}).get("interval") == "month"
        ):
            fail("Verified Stripe price does not match " + env_key)
    print("Verified 3 existing live recurring prices using the server Stripe key")


def verify_local_api():
    for attempt in range(12):
        try:
            with urlopen("http://127.0.0.1:3910/api/plans", timeout=3) as response:
                if response.status != 200:
                    raise RuntimeError("Plans HTTP not 200")
                body = json.load(response)
            by_key = {row["key"]: row for row in body.get("plaene", [])}
            if all(by_key.get(key.removeprefix("STRIPE_PRICE_").lower(), {}).get("kaufbar") is True for key in PRICES):
                return
        except Exception:
            time.sleep(1)
        else:
            time.sleep(1)
    fail("Local API does not report all 3 paid plans as purchasable")


def restart():
    subprocess.run(["systemctl", "restart", SERVICE], check=True, timeout=35)


def main():
    if os.geteuid() != 0:
        fail("Requires sudo/root")
    if not ENV.is_file():
        fail("Pilot environment file missing; no changes made")
    original = ENV.read_text()
    entries = read_entries(original)
    current_key = entries.get("STRIPE_SECRET_KEY") or ""
    incoming_file = Path("/run/pilot-stripe-runtime.key")
    supplied_key = ""
    if incoming_file.is_file():
        try:
            supplied_key = incoming_file.read_text().strip()
        finally:
            incoming_file.unlink(missing_ok=True)
    # Prefer an already configured live runtime key. Do not use a setup key
    # as a permanent application credential.
    replace_key = not current_key.startswith(("sk_live_", "rk_live_"))
    candidate_key = supplied_key if replace_key else current_key
    if replace_key and not supplied_key:
        fail("Missing live runtime key; configure GitHub secret STRIPE_SECRET_KEY")
    verify_stripe_prices(candidate_key)
    for key, (price_id, _) in PRICES.items():
        if key in entries and entries[key] != price_id:
            fail("Existing " + key + " differs; manual reconciliation required")
    additions = [key + "=" + price_id for key, (price_id, _) in PRICES.items() if key not in entries]
    if replace_key:
        if "STRIPE_SECRET_KEY" in entries:
            # Replace existing test/invalid key, retaining all unrelated settings.
            original = re.sub(
                r"^(?:export )?STRIPE_SECRET_KEY=.*$",
                lambda _: "STRIPE_SECRET_KEY=" + candidate_key,
                original, flags=re.MULTILINE,
            )
        else:
            additions.insert(0, "STRIPE_SECRET_KEY=" + candidate_key)
    metadata = ENV.stat()
    backup = ENV.with_name(ENV.name + ".before-price-repair-" + str(os.getpid()))
    shutil.copy2(ENV, backup)
    os.chmod(backup, 0o600)
    tmp_name = None
    changed = False
    try:
        if additions or replace_key:
            with tempfile.NamedTemporaryFile(mode="w", dir=ENV.parent, prefix=".pilot-price-", delete=False) as tmp:
                tmp_name = tmp.name
                tmp.write(original.rstrip("\n") + "\n" + "\n".join(additions) + "\n")
            os.chown(tmp_name, metadata.st_uid, metadata.st_gid)
            os.chmod(tmp_name, stat.S_IMODE(metadata.st_mode))
            os.replace(tmp_name, ENV)
            tmp_name = None
            changed = True
        restart()
        verify_local_api()
        print("LIVE_PRICE_MAPPING_OK: Starter, Pro, Business")
    except Exception:
        if changed:
            shutil.copy2(backup, ENV)
            os.chmod(ENV, stat.S_IMODE(metadata.st_mode))
            restart()
        raise
    finally:
        if tmp_name:
            os.unlink(tmp_name)
        print("Recovery backup retained at " + str(backup))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print("PRICE_RECOVERY_FAILED: " + type(exc).__name__ + ": " + str(exc), file=sys.stderr)
        sys.exit(1)
