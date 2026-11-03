#!/usr/bin/env python3
"""Print aggregate first-sale funnel counts from existing production SQLite only.

Read-only: no new database files, migrations, or account changes. No PII.
"""
import datetime
import json
import os
from pathlib import Path
import re
import sqlite3
import sys

HOME = Path("/opt/anfragepilot")
CONF = HOME / "pilot.env"


def db_path():
    raw = CONF.read_text()
    match = re.search(r"^DB_FILE=(.*)$", raw, re.MULTILINE)
    path = (match.group(1).strip().strip("'\"") if match else "data/anfragepilot.db")
    full = Path(path)
    return full if full.is_absolute() else HOME / full


def main():
    path = db_path().resolve()
    if not path.is_file():
        raise RuntimeError("Existing production database unavailable")
    connection = sqlite3.connect("file:" + str(path) + "?mode=ro", uri=True, timeout=3)
    try:
        count = lambda sql, arg=(): int(connection.execute(sql, arg).fetchone()[0])
        now = datetime.datetime.now(datetime.timezone.utc)
        since = int((now - datetime.timedelta(days=30)).timestamp() * 1000)
        result = {
            "registered_30d": count("SELECT COUNT(*) FROM users WHERE created_at >= ?", (since,)),
            "registered_total": count("SELECT COUNT(*) FROM users"),
            "answered_30d": count("SELECT COUNT(*) FROM requests_log WHERE created_at >= ?", (since,)),
            "active_users_30d": count("SELECT COUNT(DISTINCT user_id) FROM requests_log WHERE created_at >= ?", (since,)),
            "trial_accounts": count("SELECT COUNT(*) FROM subscriptions WHERE plan='trial'"),
            "pending_paid_accounts": count("SELECT COUNT(*) FROM subscriptions WHERE status='pending' AND plan IN ('starter','pro','business')"),
            "active_paid_accounts": count("SELECT COUNT(*) FROM subscriptions WHERE status='active' AND plan IN ('starter','pro','business')"),
            "checkout_completed_receipts": count("SELECT COUNT(*) FROM billing_events WHERE typ='checkout.session.completed'"),
            "verified_revenue": None,
            "evidence": "Stripe Live settlement verification required",
        }
        print(json.dumps(result, sort_keys=True))
    finally:
        connection.close()


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print("FUNNEL_AUDIT_FAILED: " + type(exc).__name__, file=sys.stderr)
        sys.exit(1)
