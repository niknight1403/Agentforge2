#!/usr/bin/env node
/**
 * Ops-Werkzeug für die Route-Quota: Status, nächste Route, Kapazitätsplan.
 *
 *   node scripts/ops/route-quota.mjs status
 *   node scripts/ops/route-quota.mjs next --tokens 3000 --tools
 *   node scripts/ops/route-quota.mjs plan --per-hour 40 --hours 24
 */
import { createLedger, loadRouteConfig, saveState } from '../../server/route-quota.mjs';

const args = process.argv.slice(2);
const task = args[0] || 'status';

function flag(name, fallback = '') {
  const index = args.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = args[index + 1];
  return value && !value.startsWith('--') ? value : 'true';
}

const routes = loadRouteConfig(flag('config', 'config/routes.json'));
const clock = Date.now;
const stateFile = flag('state', process.env.ROUTE_QUOTA_STATE || '');
const ledger = createLedger({ routes, clock, file: stateFile });

function printAdvice(advice) {
  for (const line of advice) console.log(`  - ${line}`);
}

if (task === 'status') {
  const rows = ledger.status();
  console.log('Route | lokal | nutzbar | Tag | Minuten | Kopffreiheit | Trefferquote');
  for (const row of rows) {
    console.log(
      `${row.id} | ${row.isLocal ? 'ja' : 'nein'} | ${row.usable ? 'ja' : `nein (${row.cooldownReason})`} | ` +
        `${row.usedDay}/${row.limits.rpd || '∞'} | ${row.usedMinute}/${row.limits.rpm || '∞'} | ${row.headroom} | ${row.successRate}`
    );
  }
} else if (task === 'next') {
  const pick = ledger.next({
    tokens: Number(flag('tokens', '1500')),
    needsTools: flag('tools', '') === 'true',
    exclude: flag('exclude', '').split(',').filter(Boolean)
  });
  if (!pick.route) {
    console.log(`Keine Route verfügbar: ${pick.reason}`);
    for (const gap of pick.gaps) console.log(`  - ${gap.route}: ${gap.reason}`);
    process.exitCode = 1;
  } else {
    console.log(`${pick.route.id} (${pick.route.baseUrl} ${pick.route.model})`);
  }
} else if (task === 'plan') {
  const plan = ledger.plan({
    demandPerHour: Number(flag('per-hour', '1')),
    horizonHours: Number(flag('hours', '24')),
    tokensPerRequest: Number(flag('tokens', '1500'))
  });
  console.log(`Bedarf: ${plan.demand} Aufträge auf ${plan.horizonHours} h`);
  console.log(`Gedeckt: ${plan.covered} | Fehlbetrag: ${plan.shortfall} | eigene Hardware: ${plan.localHealthy ? 'ja' : 'nein'}`);
  console.log('Je Route:');
  for (const row of plan.perRoute) {
    console.log(`  - ${row.route}: ${row.usable ? row.capacity : 'gesperrt'}`);
  }
  console.log('Empfehlungen:');
  printAdvice(plan.advice);
  if (plan.shortfall > 0) process.exitCode = 2;
} else {
  console.error(`Unbekannte Aufgabe: ${task} (status | next | plan)`);
  process.exitCode = 2;
}

if (stateFile) saveState(stateFile, ledger.toJSON());
