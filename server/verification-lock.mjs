/**
 * Kurzzeitige Sperre des Quellstands je Villa.
 *
 * Waehrend eine Abnahme (build/tests/smoke) laeuft, darf kein Agent in den
 * Projektordner schreiben: sonst aendert sich der Fingerprint mitten in der
 * Pruefung und der Nachweis verfaellt sofort ("Quellstand waehrend der Pruefung
 * veraendert"). Die Sperre lebt im Prozess, gilt pro Villa und raeumt sich nach
 * einer Obergrenze selbst auf, damit ein abgestuerzter Lauf nichts blockiert.
 */
const MAX_AGE_MS = 15 * 60 * 1000;
const locks = new Map();

function key(id) {
  const value = Number(id);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

export function lockVilla(id, by = 'verification') {
  const villaId = key(id);
  if (villaId === null) return null;
  const entry = { villaId, by: String(by || 'verification'), since: Date.now() };
  locks.set(villaId, entry);
  return { ...entry };
}

export function unlockVilla(id, by = '') {
  const villaId = key(id);
  if (villaId === null) return false;
  const current = locks.get(villaId);
  if (!current) return false;
  // Nur der Eigentuemer der Sperre darf sie loesen; ein fremder Halter bleibt.
  if (by && current.by !== String(by)) return false;
  locks.delete(villaId);
  return true;
}

export function villaLock(id) {
  const villaId = key(id);
  if (villaId === null) return null;
  const current = locks.get(villaId);
  if (!current) return null;
  if (Date.now() - current.since > MAX_AGE_MS) {
    locks.delete(villaId);
    return null;
  }
  return { ...current };
}

export function isVillaLocked(id) {
  return villaLock(id) !== null;
}

/** Kurzer, ehrlicher Hinweis fuer Agenten, die waehrend der Abnahme schreiben wollen. */
export function lockMessage(id) {
  const lock = villaLock(id);
  if (!lock) return '';
  const seconds = Math.max(1, Math.round((Date.now() - lock.since) / 1000));
  return `Quellstand gesperrt: Abnahme laeuft (${lock.by}, seit ${seconds}s). Schreibe jetzt keine Projektdateien - warte kurz und versuche es erneut.`;
}
