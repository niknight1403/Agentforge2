import test from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../src/db.js";
import { reportFirstSale } from "../src/sales-report.js";

test("Sales report: count real user actions but never infer cash payments", () => {
  const db = openDatabase(":memory:");
  try {
    const now = Date.now();
    const addUser = db.prepare("INSERT INTO users(email,password_hash,created_at) VALUES (?,?,?)");
    addUser.run("first@example.invalid", "fake", now);
    addUser.run("old@example.invalid", "fake", now - 40 * 86400000);
    const sub = db.prepare("INSERT INTO subscriptions(user_id,plan,status,updated_at) VALUES (?,?,?,?)");
    sub.run(1, "trial", "active", now);
    sub.run(2, "pro", "active", now);
    db.prepare("INSERT INTO requests_log(user_id,eingang,antwort,created_at) VALUES (?,?,?,?)")
      .run(1, "sample question", "sample answer", now);
    db.prepare("INSERT INTO billing_events(id,typ,payload,created_at) VALUES (?,?,?,?)")
      .run("evt_check", "checkout.session.completed", "{}", now);
    const result = reportFirstSale(db, now);
    assert.equal(result.registeredTotal, 2);
    assert.equal(result.registeredLast30d, 1);
    assert.equal(result.activePaidAccounts, 1);
    assert.equal(result.trialAccounts, 1);
    assert.equal(result.answeredLast30d, 1);
    assert.equal(result.accountsWithAnswersLast30d, 1);
    assert.equal(result.checkoutCompletedEvents, 1);
    assert.equal(result.firstRevenueVerified, false);
    assert.doesNotMatch(JSON.stringify(result), /first@example|old@example/);
  } finally {
    db.close();
  }
});

test("Sales report: empty installation reports zero leads and no revenue claim", () => {
  const db = openDatabase(":memory:");
  try {
    const result = reportFirstSale(db);
    assert.equal(result.registeredTotal, 0);
    assert.equal(result.activePaidAccounts, 0);
    assert.equal(result.firstRevenueVerified, false);
  } finally {
    db.close();
  }
});
