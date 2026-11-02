/**
 * Bewertungs-Rubrik und Minderheitenvoten des Rats (Nikos Auftrag 2026-11-02).
 *
 * Der Rat speicherte bisher nur `proposals` mit impact/effort. Zwei Luecken:
 *   1. Keine Rubrik — "Wirkung vs. Aufwand" sagt nichts ueber Belegbarkeit
 *      oder Differenzierung, also genau die Punkte, die einen Vorschlag
 *      gegenueber dem Wettbewerb tragen.
 *   2. Keine Minderheitenvoten — was nicht als Aufgabe uebernommen wurde,
 *      verschwand. Damit ging die Begruendung verloren, warum etwas liegen
 *      blieb, und eine spaetere Runde musste neu raten.
 *
 * Ehrlichkeit: Laesst sich die Bewertung nicht auswerten, wird `rated: false`
 * gesetzt. Es werden KEINE neutralen 5/5-Werte als Messung ausgegeben.
 */

/** Rubrik-Dimensionen des Rats, jeweils 1-5. */
export const RUBRIC_KEYS = ['nutzen', 'machbarkeit', 'belegbarkeit', 'differenzierung'];

/** Gewichtung: Nutzen und Belegbarkeit tragen am meisten. */
export const RUBRIC_WEIGHTS = { nutzen: 0.35, machbarkeit: 0.25, belegbarkeit: 0.25, differenzierung: 0.15 };

/** Systemprompt fuer die Bewertungs-Synthese (eine Modellantwort). */
export function rubricSystemPrompt() {
  return [
    'Du bist die Bewertungs-Synthese des Rats.',
    'Bewerte jeden Vorschlag strikt und unabhaengig:',
    'impact (Wirkung auf Marktreife 1-10), effort (Aufwand 1-10, mehr = teurer),',
    'nutzen, machbarkeit, belegbarkeit, differenzierung (jeweils 1-5).',
    'belegbarkeit = gibt es echte Hinweise, dass es funktioniert?',
    'differenzierung = hebt es das Produkt von vergleichbaren Produkten ab?',
    'Antworte NUR mit JSON: {"ranked":[{"agent":"Name","impact":7,"effort":3,"nutzen":4,"machbarkeit":4,"belegbarkeit":3,"differenzierung":4}]}',
    'fuer jeden Vorschlag in derselben Reihenfolge.',
  ].join(' ');
}

/** Nutzernachricht mit den zu bewertenden Vorschlaegen. */
export function rubricUserPrompt(proposals = []) {
  return proposals.map((p, i) => `${i + 1}. ${p.agent}: ${p.text}`).join('\n');
}

function stripFence(raw) {
  return String(raw ?? '')
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '');
}

function intInRange(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const rounded = Math.round(n);
  if (rounded < min || rounded > max) return null;
  return rounded;
}

/**
 * Wertet die Modellantwort aus.
 * @returns {{rated:boolean, entries:Array<object>, reason?:string}}
 */
export function parseRubric(raw, proposals = []) {
  let parsed;
  try {
    parsed = JSON.parse(stripFence(raw));
  } catch {
    return { rated: false, entries: [], reason: 'Antwort war kein gueltiges JSON' };
  }
  const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.ranked) ? parsed.ranked : null;
  if (!list || list.length === 0) return { rated: false, entries: [], reason: 'keine Bewertungsliste in der Antwort' };

  const entries = proposals.map((proposal, i) => {
    const item = list[i] || {};
    const impact = intInRange(item.impact, 1, 10);
    const effort = intInRange(item.effort, 1, 10);
    const rubric = {};
    const missing = [];
    for (const key of RUBRIC_KEYS) {
      const value = intInRange(item[key], 1, 5);
      if (value === null) missing.push(key);
      rubric[key] = value;
    }
    // Teildaten sind keine Messung: fehlt ein Wert, bleibt der Eintrag unbewertet.
    const rated = impact !== null && effort !== null && missing.length === 0;
    const weighted = rated
      ? Math.round(RUBRIC_KEYS.reduce((sum, key) => sum + rubric[key] * RUBRIC_WEIGHTS[key], 0) * 100) / 100
      : null;
    return {
      agent: String(item.agent || proposal.agent || ''),
      impact,
      effort,
      rubric,
      weighted,
      rated,
      leverage: rated ? Math.round(((impact * 10 - effort * 3) / 7) * 10) / 10 : null,
      missing,
    };
  });
  const rated = entries.length > 0 && entries.every((e) => e.rated);
  return {
    rated,
    entries,
    reason: rated ? undefined : 'mindestens ein Vorschlag ohne vollstaendige Bewertung',
  };
}

/**
 * Minderheitenvoten: Vorschlaege, die nicht als Aufgabe uebernommen wurden.
 * Sie werden mit ihrer schwaechsten Dimension begruendet, statt zu verschwinden.
 */
export function buildDissent(entries = [], { selectedAgents = [], threshold = 6 } = {}) {
  const chosen = new Set(selectedAgents.map((a) => String(a)));
  return entries
    .filter((entry) => !chosen.has(String(entry.agent)))
    .map((entry) => {
      const dims = RUBRIC_KEYS
        .map((key) => ({ key, value: entry.rubric?.[key] }))
        .filter((d) => typeof d.value === 'number');
      const weakest = dims.length ? dims.reduce((a, b) => (b.value < a.value ? b : a)) : null;
      const reason = entry.rated
        ? `schwaechste Dimension: ${weakest?.key ?? 'unbekannt'} (${weakest?.value ?? '-'}/5), Hebel ${entry.leverage ?? '-'} unter Schwelle ${threshold}`
        : `nicht bewertet (${entry.missing?.join(', ') || 'keine Werte'}) — bleibt als offener Vorschlag stehen`;
      return {
        agent: entry.agent,
        reason,
        leverage: entry.leverage,
        weakestDimension: weakest?.key ?? null,
        rated: entry.rated,
      };
    });
}

/** Kompakte Zusammenfassung fuer API-Antworten und Berichte. */
export function summarizeScores(parsed) {
  if (!parsed?.rated) {
    return { rated: false, reason: parsed?.reason || 'nicht bewertet', entries: [] };
  }
  return {
    rated: true,
    entries: parsed.entries.map((e) => ({
      agent: e.agent,
      weighted: e.weighted,
      rubric: e.rubric,
      leverage: e.leverage,
    })),
  };
}
