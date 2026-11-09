import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { QuotaLedger, createLedger, loadRouteConfig, saveState, BREAKER } from '../route-quota.mjs';

const MINUTE = 60_000;

function routes() {
  return [
    {
      id: 'local',
      isLocal: true,
      needsKey: false,
      tools: true,
      baseUrl: 'http://127.0.0.1:11434/v1',
      model: 'qwen2.5-coder:7b',
      limits: { rpm: 0, rpd: 0, tpm: 0, tpd: 0 },
      limitsVerified: true
    },
    {
      id: 'free-small',
      tools: true,
      baseUrl: 'https://a.example/v1',
      model: 'm1',
      limits: { rpm: 2, rpd: 10, tpm: 4000, tpd: 0 },
      limitsVerified: true
    },
    {
      id: 'free-ohne-tools',
      tools: false,
      baseUrl: 'https://b.example/v1',
      model: 'm2',
      limits: { rpm: 10, rpd: 100, tpm: 0, tpd: 0 }
    }
  ];
}

function ledger(extra = {}) {
  let now = 1_000_000;
  const clock = () => now;
  const instance = new QuotaLedger({ routes: routes(), clock, ...extra });
  return {
    instance,
    advance(ms) {
      now += ms;
    },
    get now() {
      return now;
    }
  };
}

test('eigene Hardware wird zuerst gewählt', () => {
  const { instance } = ledger();
  assert.equal(instance.next({ tokens: 100 }).route.id, 'local');
});

test('Minutenlimit wird eingehalten und begründet abgelehnt', () => {
  const { instance } = ledger();
  assert.equal(instance.consume('free-small', { tokens: 10 }).ok, true);
  assert.equal(instance.consume('free-small', { tokens: 10 }).ok, true);
  const dritter = instance.consume('free-small', { tokens: 10 });
  assert.equal(dritter.ok, false);
  assert.equal(dritter.reason, 'rpm');
});

test('Minutenfenster läuft rollierend weiter', () => {
  const { instance, advance } = ledger();
  instance.consume('free-small', { tokens: 10 });
  instance.consume('free-small', { tokens: 10 });
  assert.equal(instance.consume('free-small', { tokens: 10 }).ok, false);
  advance(MINUTE + 1);
  assert.equal(instance.consume('free-small', { tokens: 10 }).ok, true);
});

test('Tageslimit zählt über 24 Stunden', () => {
  const { instance, advance } = ledger();
  for (let i = 0; i < 10; i += 1) {
    advance(MINUTE);
    assert.equal(instance.consume('free-small', { tokens: 10 }).ok, true);
  }
  advance(MINUTE);
  const elfter = instance.consume('free-small', { tokens: 10 });
  assert.equal(elfter.ok, false);
  assert.equal(elfter.reason, 'rpd');
});

test('Token-Budget pro Minute sperrt große Anfragen', () => {
  const { instance } = ledger();
  assert.equal(instance.consume('free-small', { tokens: 3900 }).ok, true);
  const gross = instance.consume('free-small', { tokens: 500 });
  assert.equal(gross.ok, false);
  assert.equal(gross.reason, 'tpm');
});

test('429 legt eine Pause mit Retry-After an', () => {
  const { instance, advance } = ledger();
  const pause = instance.settle('free-small', { ok: false, status: 429, retryAfterMs: 90_000 });
  assert.equal(pause.reason, 'rate_limit');
  assert.equal(pause.cooldownMs, 90_000);
  assert.equal(instance.consume('free-small').reason, 'cooldown');
  advance(90_001);
  assert.equal(instance.consume('free-small').ok, true);
});

test('drei Fehler in Folge verdoppeln die Pause bis zur Obergrenze', () => {
  const { instance } = ledger();
  instance.settle('free-small', { ok: false, status: 500 });
  instance.settle('free-small', { ok: false, status: 500 });
  const dritter = instance.settle('free-small', { ok: false, status: 500 });
  assert.equal(dritter.cooldownMs, Math.max(60_000, BREAKER.baseMs));
  instance.settle('free-small', { ok: false, status: 500 });
  assert.equal(instance.get('free-small').breakerMs, BREAKER.baseMs * 2);
  instance.settle('free-small', { ok: true, status: 200 });
  assert.equal(instance.get('free-small').failures, 0);
  assert.equal(instance.get('free-small').cooldownUntil, 0);
});

test('Werkzeuganforderung filtert Routen ohne Tool-Calling', () => {
  const { instance } = ledger();
  const pick = instance.next({ needsTools: true, tokens: 10 });
  assert.equal(pick.route.id, 'local');
  const ohneLokal = instance.next({ needsTools: true, tokens: 10, exclude: ['local'] });
  assert.equal(ohneLokal.route.id, 'free-small');
  assert.ok(ohneLokal.gaps.some((gap) => gap.route === 'free-ohne-tools'));
});

test('ohne Restkontingent nennt next die Lücken statt zu werfen', () => {
  const { instance, advance } = ledger();
  // Zeit zwischen den Aufträgen: das Tageslimit greift, nicht das Minutenlimit.
  for (let i = 0; i < 10; i += 1) {
    advance(MINUTE);
    instance.consume('free-small', { tokens: 1 });
  }
  const pick = instance.next({ tokens: 1, exclude: ['local', 'free-ohne-tools'] });
  assert.equal(pick.route, null);
  assert.equal(pick.reason, 'keine Route mit Restkontingent');
  assert.equal(pick.gaps[0].reason, 'rpd');
});

test('Plan rechnet ohne lokale Route den Fehlbetrag aus', () => {
  const { instance } = ledger();
  instance.settle('local', { ok: false, status: 0 });
  const plan = instance.plan({ demandPerHour: 2, horizonHours: 24, tokensPerRequest: 1000 });
  assert.equal(plan.demand, 48);
  assert.equal(plan.localHealthy, false);
  assert.equal(plan.covered, 48);
  assert.equal(plan.shortfall, 0);
  const gross = instance.plan({ demandPerHour: 20, horizonHours: 24, tokensPerRequest: 1000 });
  assert.equal(gross.shortfall, 480 - gross.covered);
  assert.ok(gross.advice.some((line) => line.includes('Lokale Route')));
});

test('Plan mit eigener Hardware deckt jede Last', () => {
  const { instance } = ledger();
  const plan = instance.plan({ demandPerHour: 500, horizonHours: 24 });
  assert.equal(plan.localHealthy, true);
  assert.equal(plan.shortfall, 0);
  assert.ok(plan.advice[0].includes('Eigene Hardware'));
});

test('Zustand überlebt einen Neustart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'route-quota-'));
  try {
    const file = join(dir, 'state.json');
    const { instance } = ledger();
    instance.consume('free-small', { tokens: 7 });
    instance.settle('free-small', { ok: false, status: 429, retryAfterMs: 30_000 });
    saveState(file, instance.toJSON());
    const wieder = createLedger({ routes: routes(), clock: () => 1_000_000, file });
    assert.equal(wieder.usage('free-small').usedDay, 1);
    assert.equal(wieder.get('free-small').cooldownUntil, 1_030_000);
    assert.equal(wieder.consume('free-small').reason, 'cooldown');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Konfiguration aus config/routes.json ist lesbar und lokal zuerst', () => {
  const geladen = loadRouteConfig('config/routes.json');
  assert.ok(geladen.length >= 2);
  const instance = createLedger({ routes: geladen });
  assert.equal(instance.next({ tokens: 500, needsTools: true }).route.isLocal, true);
});

test('ein Konto mit zwei Routen: 429 sperrt beide', () => {
  let now = 1_000_000;
  const instance = new QuotaLedger({
    clock: () => now,
    routes: [
      { id: 'g-main', account: 'google-niko', baseUrl: 'https://g.example/v1', limits: { rpd: 100 } },
      { id: 'g-zweit', account: 'google-niko', baseUrl: 'https://g.example/v1', limits: { rpd: 100 } },
      { id: 'groq', account: 'groq-niko', baseUrl: 'https://q.example/v1', limits: { rpd: 100 } }
    ]
  });
  instance.settle('g-main', { ok: false, status: 429, retryAfterMs: 60_000 });
  assert.equal(instance.consume('g-zweit').reason, 'cooldown');
  assert.equal(instance.consume('groq').ok, true);
  now += 60_001;
  assert.equal(instance.consume('g-zweit').ok, true);
});

test('Plan zaehlt Routen desselben Kontos nicht doppelt', () => {
  const instance = new QuotaLedger({
    routes: [
      { id: 'a1', account: 'konto-a', baseUrl: 'https://a.example/v1', limits: { rpd: 40 } },
      { id: 'a2', account: 'konto-a', baseUrl: 'https://a.example/v1', limits: { rpd: 40 } },
      { id: 'b1', account: 'konto-b', baseUrl: 'https://b.example/v1', limits: { rpd: 30 } }
    ]
  });
  const plan = instance.plan({ demandPerHour: 100, horizonHours: 24 });
  assert.equal(plan.finiteCapacity, 70, 'ein Konto zaehlt einmal, nicht je Route');
  assert.equal(plan.shortfall, 2400 - 70);
  assert.ok(plan.perRoute.every((row) => typeof row.account === 'string'));
});
