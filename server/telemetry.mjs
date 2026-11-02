/**
 * Telemetrie des Produktpfads (Nikos Auftrag 2026-11-02).
 *
 * Die drei Kennzahlen aus docs/deepagent-product-first.md waren bisher nur
 * beschrieben, nicht messbar:
 *   - build_green_rate      — Anteil erfolgreicher Builds
 *   - time_to_first_working — Zeit von der Villa bis zum ersten gruenen Build
 *   - rework_quote          — Anteil Aufgaben, die wiederholt werden mussten
 *
 * Grundsaetze:
 *   1. Ehrlich: ohne Messdaten ist eine Kennzahl `null`, nicht 0. Eine 0
 *      waere eine Aussage ("nichts ist gruen"), die die Daten nicht tragen.
 *   2. Nachvollziehbar: jede Kennzahl nennt ihre Stichprobe (`samples`).
 *   3. Nur belegte Quellen: Build-Ergebnisse werden beim Abschluss
 *      protokolliert, Nacharbeit kommt aus den vorhandenen Zaehlern
 *      `retry_count` und `assignments` der Aufgaben.
 */
import { db, now } from './db.mjs';

/** Schwelle fuer "brauchbar schnell" — nur fuer die Einordnung im Bericht. */
export const FAST_FIRST_BUILD_MS = 60 * 60 * 1000;

function percent(part, total) {
  if (!total) return null;
  return Math.round((part / total) * 1000) / 10;
}

function quantile(sortedValues, q) {
  if (!sortedValues.length) return null;
  const pos = (sortedValues.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sortedValues[lo];
  return Math.round(sortedValues[lo] + (sortedValues[hi] - sortedValues[lo]) * (pos - lo));
}

/** Ein Build-Ergebnis dauerhaft festhalten (aufgerufen am Ende eines Builds). */
export function recordBuildResult({ villaId, status, ok = false, startedAt = 0, finishedAt = 0, error = '' } = {}) {
  const id = Number(villaId);
  if (!Number.isFinite(id) || id <= 0) throw new Error('villaId fehlt');
  const start = Number(startedAt) || 0;
  const end = Number(finishedAt) || now();
  const durationMs = start > 0 && end >= start ? end - start : null;
  db.prepare(
    'INSERT INTO build_events (villa_id, status, ok, duration_ms, finished_at, error, created_at) VALUES (?,?,?,?,?,?,?)'
  ).run(id, String(status || 'unknown').slice(0, 40), ok ? 1 : 0, durationMs, end, String(error || '').slice(0, 300), now());
  return { villaId: id, ok: Boolean(ok), durationMs };
}

/** Zeit bis zum ersten gruenen Build je Villa (ms), nur Villen mit Treffer. */
export function timeToFirstWorking(villaId = null) {
  const rows = villaId
    ? db.prepare(`
        SELECT v.id, v.created_at AS villa_start, MIN(COALESCE(b.finished_at, b.created_at)) AS first_ok
        FROM villas v JOIN build_events b ON b.villa_id = v.id AND b.ok = 1
        WHERE v.id = ? GROUP BY v.id`).all(Number(villaId))
    : db.prepare(`
        SELECT v.id, v.created_at AS villa_start, MIN(COALESCE(b.finished_at, b.created_at)) AS first_ok
        FROM villas v JOIN build_events b ON b.villa_id = v.id AND b.ok = 1
        GROUP BY v.id`).all();
  const values = rows
    .map((r) => Number(r.first_ok) - Number(r.villa_start))
    .filter((v) => Number.isFinite(v) && v >= 0)
    .sort((a, b) => a - b);
  if (!values.length) return { samples: 0, medianMs: null, p90Ms: null, fastestMs: null, slowestMs: null };
  return {
    samples: values.length,
    medianMs: quantile(values, 0.5),
    p90Ms: quantile(values, 0.9),
    fastestMs: values[0],
    slowestMs: values[values.length - 1],
  };
}

/** Anteil Aufgaben mit Nacharbeit (Wiederholung oder erneute Zuweisung). */
export function reworkQuote(villaId = null) {
  const id = Number(villaId);
  const where = Number.isFinite(id) && id > 0 ? 'WHERE villa_id = ?' : '';
  const args = where ? [id] : [];
  const row = db.prepare(`
    SELECT COUNT(*) AS total,
           SUM(CASE WHEN COALESCE(retry_count,0) > 0 OR COALESCE(assignments,0) > 1 THEN 1 ELSE 0 END) AS reworked
    FROM tasks ${where}`).get(...args);
  const total = Number(row?.total || 0);
  const reworked = Number(row?.reworked || 0);
  return { samples: total, reworked, quote: percent(reworked, total) };
}

/** Anteil gruener Builds. */
export function buildGreenRate(villaId = null) {
  const id = Number(villaId);
  const where = Number.isFinite(id) && id > 0 ? 'WHERE villa_id = ?' : '';
  const args = where ? [id] : [];
  const row = db.prepare(`
    SELECT COUNT(*) AS total, SUM(CASE WHEN ok = 1 THEN 1 ELSE 0 END) AS green
    FROM build_events ${where}`).get(...args);
  const total = Number(row?.total || 0);
  const green = Number(row?.green || 0);
  return { samples: total, green, rate: percent(green, total) };
}

/**
 * Gesamtbild fuer Bericht und API. Jede Kennzahl traegt ihre Stichprobe;
 * fehlende Daten bleiben `null` statt geschaetzt zu werden.
 */
export function telemetrySummary({ villaId = null } = {}) {
  const builds = buildGreenRate(villaId);
  const ttfw = timeToFirstWorking(villaId);
  const rework = reworkQuote(villaId);
  const notes = [];
  if (builds.samples === 0) notes.push('build_green_rate: noch keine Build-Ergebnisse protokolliert');
  if (ttfw.samples === 0) notes.push('time_to_first_working: noch kein gruener Build erreicht');
  if (rework.samples === 0) notes.push('rework_quote: noch keine Aufgaben vorhanden');
  return {
    scope: villaId ? { villaId: Number(villaId) } : { scope: 'alle Villen' },
    buildGreenRate: builds,
    timeToFirstWorking: { ...ttfw, thresholdMs: FAST_FIRST_BUILD_MS },
    reworkQuote: rework,
    complete: builds.samples > 0 && ttfw.samples > 0 && rework.samples > 0,
    notes,
    generatedAt: now(),
  };
}
