import { ROLES } from './agent-roles.mjs';

const text = (value, field, max = 1200) => {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Swarm-Aufgabe benötigt ${field}.`);
  const result = value.trim();
  if (result.length > max) throw new Error(`${field} überschreitet ${max} Zeichen.`);
  return result;
};

/** Validate a small, execution-grounded task contract before any agents are created. */
export function normalizeSwarmBlueprint(input) {
  if (!Array.isArray(input) || input.length < 1 || input.length > 8) {
    throw new Error('Ein Swarm-Plan muss 1 bis 8 Aufgaben enthalten.');
  }
  return input.map((task, index) => {
    if (!task || typeof task !== 'object' || Array.isArray(task)) throw new Error(`Aufgabe ${index + 1} ist ungültig.`);
    const role = String(task.role || 'WORKER').trim().toUpperCase();
    if (!ROLES.includes(role) || role === 'ROOT') throw new Error(`Rolle für Aufgabe ${index + 1} ist nicht delegierbar.`);
    return {
      title: text(task.title, `Titel in Aufgabe ${index + 1}`, 160),
      goal: text(task.goal, `Ziel in Aufgabe ${index + 1}`),
      acceptance: text(task.acceptance, `Abnahmekriterium in Aufgabe ${index + 1}`),
      constraints: typeof task.constraints === 'string' ? task.constraints.trim().slice(0, 1200) : '',
      role,
      priority: Math.max(1, Math.min(9, Number(task.priority) || 5))
    };
  });
}
