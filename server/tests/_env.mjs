/**
 * Test-Umgebung: jede Testdatei laeuft in einem eigenen Prozess und bekommt
 * damit eine eigene temporre Datenbank und einen eigenen Workspace-Ordner.
 *
 * WICHTIG: Diese Datei muss in jeder Testdatei ZUERST importiert werden,
 * damit die Umgebungsvariablen gesetzt sind, bevor db.mjs/agents.mjs
 * geladen werden (beide lesen VF_DB/VF_WORKSPACE beim Import).
 *
 * Zusaetzlich werden alle LLM-Key-Umgebungsvariablen aus dem Prozess
 * entfernt: Tests duerfen nicht davon abhaengen, ob auf dem Rechner
 * zufaellig echte Keys in der Umgebung liegen.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FREE_ROUTE_CATALOG } from '../routes.mjs';

export const TMP = mkdtempSync(join(tmpdir(), 'vf-test-'));
process.env.VF_TEST = '1';
process.env.VF_DB = join(TMP, 'test.db');
process.env.VF_WORKSPACE = join(TMP, 'workspace');
// Hub unit tests must not inherit the runtime integration service connection.
// RESP-client tests configure their own sockets; runtime tests use real Redis.
delete process.env.REDIS_URL;

for (const r of FREE_ROUTE_CATALOG) {
  if (r.keyEnv) delete process.env[r.keyEnv];
}
