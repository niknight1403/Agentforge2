/**
 * META-AGENT-FACTORY (v1.48.0 — Nutzerdirektive 22.10.2026).
 *
 * 5-Phasen-Pipeline, die aus einer beliebigen Idee autonom einen
 * spezialisierten VillaForge-Agenten synthetisiert:
 *   Phase 1: Kontext- & Intent-Dekomposition (Domain, Trigger, Ausgaben)
 *   Phase 2: Blueprint- & Prompt-Vertrags-Synthese (Missions-Prompt mit
 *            ZIEL/KONTEXT/ANFORDERUNGEN/ABNAHMEKRITERIEN/ARBEITSWEISE/SCHUTZREGELN)
 *   Phase 3: Skill-/Tool-Pack-Vorgaben im Missions-Prompt (Registrierung via Hub)
 *   Phase 4: Code-Wrapper: Villa + Startaufgaben produktionsfertig anlegen
 *   Phase 5: Registrierung in der Flotten-DB (Status CREATED, Autonomie-Default aus)
 *
 * Qualitaets-Schleuse vor Registrierung (S >= 85/100):
 *   30% Name/Vision-Substanz + 40% Missions-Sektionen + 30% Aufgaben-Qualitaet.
 *   Bei S < 85 greift autonom der deterministische Fallback-Blueprint,
 *   der die Schleuse immer besteht — LLM-Ausfall blockiert die Factory nie.
 *
 * Lokal-First: Blueprint-Synthese laeuft ueber die Hub-Kaskade
 * (Ollama 3B/7B/32B lokal; HF-Router/OpenRouter erst als spaetere Stufe).
 */
import { db, now } from './db.mjs';
import { chat } from './llm.mjs';

const MISSION_SECTIONS = ['ZIEL', 'KONTEXT', 'ANFORDERUNGEN', 'ABNAHMEKRITERIEN', 'ARBEITSWEISE', 'FEHLERBEHANDLUNG', 'SCHUTZREGELN'];
const QUALITY_THRESHOLD = 85;

/** Phase 2-Fallback: deterministischer Blueprint, besteht die Schleuse immer. */
export function fallbackBlueprint(idea) {
  const clean = String(idea).replace(/\s+/g, ' ').trim();
  const name = clean.split(/[.,;:!?]/)[0].slice(0, 40) || `Agent ${now()}`;
  return {
    name,
    vision: `Autonomer Spezialagent fuer: ${clean.slice(0, 220)}`,
    mission: [
      `## ZIEL\n${clean}`,
      '## KONTEXT\nAutonomer VillaForge-Agent in der lokalen LLM-Kaskade (Local-First, 24/7-Faehigkeit).',
      '## ANFORDERUNGEN\nProduktionsreifer, vollstaendiger Code ohne Platzhalter; fehlerhafte Zustaende selbst heilen.',
      '## ABNAHMEKRITERIEN\nErgebnis nachweisbar: Tests, Builds oder Datei-Beweise im Resultat.',
      '## ARBEITSWEISE\nSchrittweise, evidenzbasiert, jede Annahme dokumentieren.',
      '## FEHLERBEHANDLUNG\nFehlerbeweis sichern, kleinsten reversiblen Fix anwenden, betroffenen Test erneut ausfuehren; bei lokalem Modell-Ausfall ueber die konfigurierte Gratis-Kaskade eskalieren. Nie Erfolg behaupten, wenn Gate oder Policy blockiert.',
      '## SCHUTZREGELN\nKeine Secrets im Code, lokale Ressourcengrenzen respektieren, keine externen Nebenwirkungen ohne Auftrag.',
    ].join('\n'),
    tasks: [
      'Mission analysieren und einen konkreten Umsetzungsplan erstellen',
      'Kernfunktion vollstaendig implementieren und mit Beweis verifizieren',
      'Dokumentation und Uebergabe-Notiz erstellen',
    ],
    source: 'fallback',
  };
}

/** Qualitaets-Schleuse S e [0,100]: 30% Name/Vision, 40% Sektionen, 30% Aufgaben. */
export function blueprintScore(bp) {
  if (!bp) return 0;
  let s = 0;
  if (typeof bp.name === 'string' && bp.name.trim().length >= 3) s += 15;
  if (typeof bp.vision === 'string' && bp.vision.trim().length >= 20) s += 15;
  const sections = MISSION_SECTIONS.filter((sec) => typeof bp.mission === 'string' && bp.mission.includes(sec)).length;
  s += Math.round((40 * sections) / MISSION_SECTIONS.length);
  const goodTasks = Array.isArray(bp.tasks) ? bp.tasks.filter((t) => typeof t === 'string' && t.trim().length >= 8).length : 0;
  s += Math.min(30, goodTasks * 10);
  return Math.min(100, s);
}

/** Phase 1+2: Blueprint via LLM-Kaskade (JSON-erzwungen), sonst null. */
async function synthesizeBlueprintViaCascade(idea, domain) {
  const sys = `Du bist die Agentforge2 Meta-Agent-Factory. Zerlege die Idee (Domain, Datenquellen, Trigger, Ausgaben, optimale Modell-Route) und synthetisiere einen spezialisierten Agenten-Blueprint. Antworte AUSSCHLIESSLICH JSON: {"name": "kurzer sprechender Name", "vision": "1-2 Saetze Zweck", "mission": "Missions-Prompt mit GENAU den Abschnitten ## ZIEL, ## KONTEXT, ## ANFORDERUNGEN, ## ABNAHMEKRITERIEN, ## ARBEITSWEISE, ## FEHLERBEHANDLUNG, ## SCHUTZREGELN", "tasks": ["aufgabe1", "aufgabe2", "aufgabe3"]}`;
  try {
    const out = await chat([
      { role: 'system', content: sys },
      { role: 'user', content: (domain ? `Domain: ${domain}\n` : '') + `Idee: ${idea}` },
    ], { json: true });
    const raw = typeof out === 'string' ? out : JSON.stringify(out);
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const parsed = JSON.parse(m[0]);
    return {
      name: String(parsed.name || '').trim().slice(0, 60),
      vision: String(parsed.vision || '').trim().slice(0, 500),
      mission: String(parsed.mission || '').trim(),
      tasks: (Array.isArray(parsed.tasks) ? parsed.tasks : []).slice(0, 5).map((t) => String(t).trim().slice(0, 200)),
      source: 'cascade',
    };
  } catch {
    return null; // LLM_UNAVAILABLE/BUSY → Fallback-Pfad
  }
}

/**
 * Phase 1-5: komplette Agenten-Synthese. Legt Villa (Status CREATED) und
 * Startaufgaben an. Autonomie bleibt per Default AUS (0) — Aktivierung
 * explizit via resume, nie automatisch (Schutzregel).
 */
export async function synthesizeAgent({ idea, domain = null, autonomy = 0 } = {}) {
  if (typeof idea !== 'string' || idea.trim().length < 5) {
    throw new Error('IDEA_INVALID: Idee braucht mindestens 5 Zeichen.');
  }
  const cleanIdea = idea.replace(/\s+/g, ' ').trim().slice(0, 500);

  let bp = await synthesizeBlueprintViaCascade(cleanIdea, domain);
  if (blueprintScore(bp) < QUALITY_THRESHOLD) {
    const fb = fallbackBlueprint(cleanIdea);
    if (blueprintScore(fb) >= blueprintScore(bp)) bp = fb;
  }

  const t = now();
  const auto = Number(autonomy) === 1 ? 1 : 0;
  const r = db.prepare(
    "INSERT INTO villas (name, idea, status, max_agents, autonomy, created_at, updated_at) VALUES (?,?,?,?,?,?,?)",
  ).run(bp.name, cleanIdea, 'CREATED', 1000, auto, t, t);
  const villaId = Number(r.lastInsertRowid);

  // Vision nachziehen, falls die Spalte existiert (prompt-agent-Healer pflegt sie)
  try { db.prepare('UPDATE villas SET vision = ? WHERE id = ?').run(bp.vision, villaId); } catch { /* Spalte fehlt */ }

  const ins = db.prepare('INSERT INTO tasks (villa_id, title, description, status, priority, created_at, updated_at) VALUES (?,?,?,?,?,?,?)');
  const tasks = [];
  for (const [i, title] of bp.tasks.slice(0, 5).entries()) {
    if (!title || title.length < 3) continue;
    const rr = ins.run(villaId, title, bp.mission, 'PENDING', Math.max(1, 3 - i), now(), now());
    tasks.push({ id: Number(rr.lastInsertRowid), title });
  }

  return {
    villaId,
    name: bp.name,
    status: 'CREATED',
    autonomy: auto,
    qualityScore: blueprintScore(bp),
    blueprint: bp,
    tasks,
    nextStep: auto === 0 ? 'Aktivierung via /resume <villaId> oder Messenger /resume' : 'Autonomer Start beim naechsten Scheduler-Takt',
  };
}
