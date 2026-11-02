/**
 * TASTE- und SPION-Artefakte als Pflicht der Villa-Uebergabe (Nikos Auftrag 2026-11-02).
 *
 * Bisher entstand eine Villa, sobald das Produkt-Gate erfuellt war. Die beiden
 * Agenten TASTE (Praefenzprofil) und SPION (Wettbewerbsbeobachtung) waren im
 * DeepAgent-Prompt vorgesehen, aber ihre Ergebnisse wurden bei der Uebergabe
 * nicht verlangt. Damit konnte eine Villa ohne die eigentlich wertvollen
 * Startbedingungen entstehen - das Profil, warum ein Nutzer etwas will, und
 * die Beobachtung, was der Wettbewerb schon tut.
 *
 * Regel: Jede Aussage braucht einen Beleg. Fehlt die Quelle oder ist sie keine
 * oeffentliche Adresse, gilt die Aussage als unbelegt und blockiert die
 * Uebergabe. "Unbekannt" ist nie "bestanden".
 *
 * Reine Logik, kein Dateisystem in evaluateHandoverArtifacts -> ohne Fixtures
 * testbar. Lesen aus dem Projektordner leistet scanHandoverArtifacts.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { findSecretInText } from './deep-product-gate.mjs';

export const TASTE_MIN_STATEMENTS = 3;
export const SPION_MIN_COMPETITORS = 2;
export const TASTE_FILE = 'taste.json';
export const SPION_FILE = 'spion.json';

const MIN_CLAIM = 15;
const MIN_OBSERVATION = 20;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function check(ok, label, evidence) {
  return { status: ok ? 'passed' : 'failed', label, evidence };
}

function unknown(label, hint) {
  return { status: 'unknown', label, evidence: hint };
}

/** JSON-Artefakt lesen. Markdown zaehlt nicht: Belege muessen maschinell pruefbar sein. */
export function parseArtifact(content) {
  if (typeof content !== 'string' || !content.trim()) return null;
  try {
    const parsed = JSON.parse(content);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isPublicSource(value) {
  const text = String(value || '').trim();
  if (!/^https?:\/\//i.test(text)) return false;
  // Lokale/private Ziele sind keine oeffentliche Wettbewerbsquelle.
  return !/^https?:\/\/(localhost|127\.|0\.0\.0\.0|10\.|192\.168\.|\[::1\])/i.test(text);
}

function evidenceSource(evidence) {
  if (!evidence) return '';
  if (typeof evidence === 'string') return evidence.trim();
  if (typeof evidence === 'object') return String(evidence.source || evidence.url || '').trim();
  return '';
}

/** TASTE: Praeferenzaussagen mit Beleg. Kein Satz ohne Quelle. */
export function evaluateTasteArtifact(artifact) {
  if (!artifact) {
    return {
      status: 'unknown',
      label: 'TASTE-Praeferenzprofil mit Belegen',
      evidence: `${TASTE_FILE} fehlt oder ist kein JSON (Aussagen mit Belegquelle noetig)`
    };
  }
  const statements = Array.isArray(artifact.statements) ? artifact.statements : [];
  const unbacked = [];
  const tooShort = [];
  statements.forEach((entry, index) => {
    const claim = String(entry?.claim || '').trim();
    const source = evidenceSource(entry?.evidence);
    if (claim.length < MIN_CLAIM) tooShort.push(index);
    if (!source) unbacked.push(index);
    else if (!isPublicSource(source) && !/^(repo|produkt|preis|feedback|kunde|interview|kauf)\b/i.test(source)) unbacked.push(index);
  });
  const problems = [];
  if (statements.length < TASTE_MIN_STATEMENTS) problems.push(`nur ${statements.length} von mindestens ${TASTE_MIN_STATEMENTS} Aussagen`);
  if (tooShort.length) problems.push(`Aussagen ohne ausreichenden Inhalt: ${tooShort.join(', ')}`);
  if (unbacked.length) problems.push(`Aussagen ohne brauchbare Quelle: ${unbacked.join(', ')}`);
  const ok = problems.length === 0;
  return check(ok, 'TASTE-Praeferenzprofil mit Belegen', ok
    ? `${statements.length} belegte Aussagen`
    : problems.join('; '));
}

/** SPION: oeffentliche Wettbewerbsbeobachtung mit Quelle und Datum. */
export function evaluateSpionArtifact(artifact, today = new Date()) {
  if (!artifact) {
    return {
      status: 'unknown',
      label: 'SPION-Wettbewerbsbeobachtung mit Quellen',
      evidence: `${SPION_FILE} fehlt oder ist kein JSON (Beobachtung, Quelle und Datum noetig)`
    };
  }
  const competitors = Array.isArray(artifact.competitors) ? artifact.competitors : [];
  const bad = [];
  const todayIso = today.toISOString().slice(0, 10);
  competitors.forEach((entry, index) => {
    const name = String(entry?.name || '').trim();
    const observation = String(entry?.observation || '').trim();
    const source = String(entry?.source || '').trim();
    const date = String(entry?.date || '').trim();
    if (!name) bad.push(`${index}: Name fehlt`);
    else if (observation.length < MIN_OBSERVATION) bad.push(`${index}: Beobachtung zu kurz`);
    else if (!isPublicSource(source)) bad.push(`${index}: keine oeffentliche Quelle`);
    else if (!ISO_DATE.test(date)) bad.push(`${index}: Datum fehlt (JJJJ-MM-TT)`);
    else if (date > todayIso) bad.push(`${index}: Datum liegt in der Zukunft`);
  });
  const problems = [];
  if (competitors.length < SPION_MIN_COMPETITORS) problems.push(`nur ${competitors.length} von mindestens ${SPION_MIN_COMPETITORS} Wettbewerbern`);
  if (bad.length) problems.push(bad.join('; '));
  const ok = problems.length === 0;
  return check(ok, 'SPION-Wettbewerbsbeobachtung mit Quellen', ok
    ? `${competitors.length} belegte Beobachtungen`
    : problems.join('; '));
}

/**
 * Bewertet beide Artefakte fuer die Uebergabe.
 * @param {{taste?: object|string|null, spion?: object|string|null, today?: Date}} input
 */
export function evaluateHandoverArtifacts({ taste = null, spion = null, today = new Date() } = {}) {
  const tasteArtifact = typeof taste === 'string' ? parseArtifact(taste) : taste;
  const spionArtifact = typeof spion === 'string' ? parseArtifact(spion) : spion;

  const checks = {
    taste: tasteArtifact ? evaluateTasteArtifact(tasteArtifact) : unknown('TASTE-Praeferenzprofil mit Belegen', `${TASTE_FILE} fehlt`),
    spion: spionArtifact ? evaluateSpionArtifact(spionArtifact, today) : unknown('SPION-Wettbewerbsbeobachtung mit Quellen', `${SPION_FILE} fehlt`),
    secrets: check(true, 'Keine Secrets in den Artefakten', 'keine bekannten Schluesselmuster gefunden')
  };

  const secret = findSecretInText(JSON.stringify({ taste: tasteArtifact, spion: spionArtifact }));
  if (secret) {
    checks.secrets = check(false, 'Keine Secrets in den Artefakten', `${secret.kind} in den Artefakten gefunden`);
  }

  const blockers = Object.entries(checks)
    .filter(([, entry]) => entry.status !== 'passed')
    .map(([key, entry]) => ({ key, label: entry.label, detail: entry.evidence }));

  return { ready: blockers.length === 0, checks, blockers };
}

/** Liest taste.json und spion.json aus einem Projektordner. Fehlende Dateien sind kein "bestanden". */
export function scanHandoverArtifacts(dir, { today = new Date() } = {}) {
  const read = (name) => {
    const file = join(String(dir || ''), name);
    if (!dir || !existsSync(file)) return { content: null, present: false };
    try {
      return { content: readFileSync(file, 'utf8'), present: true };
    } catch {
      return { content: null, present: false };
    }
  };
  const taste = read(TASTE_FILE);
  const spion = read(SPION_FILE);
  const report = evaluateHandoverArtifacts({ taste: taste.content, spion: spion.content, today });
  return { ...report, files: { taste: taste.present, spion: spion.present } };
}
