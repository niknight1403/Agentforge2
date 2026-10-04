import { db } from './db.mjs';
import { FREE_ROUTE_CATALOG } from './routes.mjs';

/**
 * Fuellt den Routen-Katalog einmalig in die Datenbank.
 *
 * Extrahiert aus server.mjs, damit Serverstart und Tests dieselbe Logik
 * verwenden. Rueckgabe: Anzahl neu eingefuegter Routen (0, wenn der
 * Katalog bereits stand).
 */
export function seedRoutes() {
  const count = db.prepare('SELECT COUNT(*) c FROM routes').get().c;
  if (count > 0) return 0;
  const ins = db.prepare(
    'INSERT INTO routes (name, provider, base_url, model, key_env, is_free, enabled, priority, weight, status, ok, fail, last_used) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)'
  );
  for (const r of FREE_ROUTE_CATALOG) {
    ins.run(r.name, r.provider, r.baseUrl, r.model, r.keyEnv, 1, 1, r.priority, 1, 'NEW', 0, 0, 0);
  }
  console.log('[villaforge] Routen-Katalog initialisiert:', FREE_ROUTE_CATALOG.length);
  return FREE_ROUTE_CATALOG.length;
}

/**
 * Synchronisiert Modell- und URL-Aenderungen des Katalogs in bestehende
 * Datenbanken. Statistiken (ok/fail) und Einstellungen des Nutzers
 * (enabled, priority) bleiben unberuehrt; nur veraltete technische Felder
 * werden auf den Katalogstand gebracht.
 */
export function syncCatalog() {
  let changed = 0;
  for (const r of FREE_ROUTE_CATALOG) {
    const row = db.prepare('SELECT * FROM routes WHERE provider = ?').get(r.provider);
    if (!row) continue;
    if (row.model !== r.model || row.base_url !== r.baseUrl || row.name !== r.name) {
      db.prepare('UPDATE routes SET name = ?, base_url = ?, model = ?, status = ? WHERE provider = ?')
        .run(r.name, r.baseUrl, r.model, 'NEW', r.provider);
      changed++;
    }
  }
  return changed;
}
