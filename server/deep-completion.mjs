/**
 * Fertigstellungs-Bericht fuer ein Deep-Projekt (Villa-Entwicklung + Live-Ansicht).
 *
 * Der Develop-Endpunkt verweigert die Villa, solange Produkt-Gate und
 * Uebergabe-Artefakte nicht belegt sind. Bisher erfuhr man das nur aus einem
 * 409 beim Startversuch. Dieser Bericht macht den Stand jederzeit lesbar:
 * welche Pruefungen bestehen, was genau fehlt und welcher Schritt als naechstes
 * wirklich hilft — ohne etwas als fertig zu bezeichnen, was es nicht ist.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { productGateForProjectDir } from './deep-product-gate.mjs';
import { deepProjectDetail, deepProjectDir } from './deepagent.mjs';
import { scanHandoverArtifacts } from './handover-artifacts.mjs';
import { db } from './db.mjs';

/** Live-Ansicht gilt nur als erreichbar, wenn der Vorschau-Ordner existiert. */
export function liveViewState(projectId) {
  const dir = deepProjectDir(projectId);
  const candidates = ['index.html', join('dist', 'index.html'), join('public', 'index.html'), join('web-dist', 'index.html')];
  const found = candidates.filter((relative) => existsSync(join(dir, relative)));
  return {
    available: found.length > 0,
    entry: found[0] || null,
    detail: found.length
      ? 'Vorschau-Einstiegspunkt vorhanden.'
      : 'Kein Einstiegspunkt (index.html) im Projektordner — die Live-Ansicht ist noch nicht auslieferbar.'
  };
}

/** Reine Zusammenfassung: gut testbar, keine IO. */
export function summarizeReadiness({ projectId, gate, handover, villa = null, live = null }) {
  const blockers = [
    ...(gate?.blockers || []).map((entry) => ({ area: 'produkt', label: entry.label, detail: entry.detail || null })),
    ...(handover?.blockers || []).map((entry) => ({ area: 'uebergabe', label: entry.label, detail: entry.detail || null }))
  ];
  if (!villa) blockers.push({ area: 'villa', label: 'Keine Villa verknuepft', detail: 'Die Villa entsteht erst nach bestandenen Gates.' });
  if (live && !live.available) blockers.push({ area: 'live', label: 'Live-Ansicht ohne Einstiegspunkt', detail: live.detail });

  const nextActions = [];
  if (blockers.some((entry) => entry.area === 'produkt')) {
    nextActions.push('Produktnachweis im Projektordner erzeugen (Build-Log, Testlauf, Abnahmekriterien).');
  }
  if (blockers.some((entry) => entry.area === 'uebergabe')) {
    nextActions.push('taste.json mit mindestens drei belegten Praeferenz-Aussagen und spion.json mit mindestens zwei Wettbewerbern samt Quelle und Datum ablegen.');
  }
  if (!villa && !blockers.some((entry) => entry.area === 'produkt' || entry.area === 'uebergabe')) {
    nextActions.push('Entwicklung starten (POST /api/deep/projects/:id/develop) — die Gates sind erfuellt.');
  }
  if (live && !live.available) nextActions.push('Auslieferbaren Web-Build im Projektordner erzeugen, damit die Live-Ansicht einen Einstiegspunkt hat.');

  return {
    projectId: Number(projectId),
    ready: blockers.length === 0,
    productGateReady: Boolean(gate?.ready),
    handoverReady: Boolean(handover?.ready),
    villaLinked: Boolean(villa),
    liveViewAvailable: Boolean(live?.available),
    blockers,
    nextActions,
    note: blockers.length
      ? 'Nicht fertig. Die Blocker sind belegt und einzeln abarbeitbar; eine Fertigmeldung waere hier falsch.'
      : 'Alle belegten Pruefungen bestehen. Die Live-Ansicht hat einen Einstiegspunkt.'
  };
}

/** Voller Bericht fuer ein Projekt (IO + Zusammenfassung). */
export function projectReadiness(projectId) {
  const id = Number(projectId);
  const detail = deepProjectDetail(id);
  if (!detail) return null;
  const dir = deepProjectDir(id);
  const gate = productGateForProjectDir(dir);
  const handover = scanHandoverArtifacts(dir);
  const villaId = Number(detail.project.villa_id || 0);
  const villaRow = villaId ? db.prepare('SELECT id,name,status FROM villas WHERE id=?').get(villaId) : null;
  const live = liveViewState(id);
  return {
    ...summarizeReadiness({ projectId: id, gate, handover, villa: villaRow, live }),
    project: { id, title: detail.project.title, status: detail.project.status },
    gateChecks: gate.checks,
    handoverChecks: handover.checks,
    villa: villaRow || null,
    live
  };
}
