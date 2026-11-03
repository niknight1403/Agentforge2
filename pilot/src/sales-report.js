/**
 * Private, read-only first-customer funnel diagnostics.
 * No personal information, credentials, or unsupported payment claims.
 * This report alone cannot confirm actual Stripe cash settlement.
 */
export function reportFirstSale(db, now = Date.now()) {
  const since = now - 30 * 86400000;
  const all = (sql, ...args) => db.prepare(sql).get(...args).count;

  const registeredLast30d = all(
    "SELECT COUNT(*) AS count FROM users WHERE created_at >= ?", since
  );
  const registeredTotal = all("SELECT COUNT(*) AS count FROM users");
  const trialAccounts = all(
    "SELECT COUNT(*) AS count FROM subscriptions WHERE plan='trial'"
  );
  const activePaidAccounts = all(
    "SELECT COUNT(*) AS count FROM subscriptions WHERE status='active' AND plan IN ('starter','pro','business')"
  );
  const pendingPaidAccounts = all(
    "SELECT COUNT(*) AS count FROM subscriptions WHERE status='pending' AND plan IN ('starter','pro','business')"
  );
  const answeredLast30d = all(
    "SELECT COUNT(*) AS count FROM requests_log WHERE created_at >= ?", since
  );
  const accountsWithAnswersLast30d = all(
    "SELECT COUNT(DISTINCT user_id) AS count FROM requests_log WHERE created_at >= ?", since
  );
  const checkoutCompletedEvents = all(
    "SELECT COUNT(*) AS count FROM billing_events WHERE typ = 'checkout.session.completed'"
  );

  return {
    period: "last_30_days",
    registeredLast30d,
    registeredTotal,
    trialAccounts,
    activePaidAccounts,
    pendingPaidAccounts,
    answeredLast30d,
    accountsWithAnswersLast30d,
    checkoutCompletedEvents,
    firstRevenueVerified: false,
    firstRevenueEvidence: "Stripe Live payment reconciliation required",
    note: "Subscriptions and webhook receipts do not prove a settled payment.",
  };
}
