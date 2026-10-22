/**
 * MESSENGER-TRIGGER (v1.46.0 — Nutzerdirektive 2026-10-22, OpenClaw-Architektur).
 *
 * Telegram-Bot als Fernsteuerung fuer die VillaForge-Flotte: einfache Text-
 * Befehle vom Handy steuern Villen, fragen Status und Scores ab. Long-Polling
 * (kein oeffentlicher Webhook noetig), Allowlist-geschuetzt.
 *
 * Aktivierung (einmalig): Secret VF_TELEGRAM_BOT_TOKEN (VM-Umgebung) oder
 * Hub-Setting 'telegramBotToken' + erlaubte Chat-IDs per VF_TELEGRAM_CHAT_IDS
 * oder Setting 'telegramChatIds' (Komma-Liste). Ohne Token bleibt das Modul
 * still inaktiv — der Hub-Takt wird nie blockiert.
 *
 * Befehle:
 *   /status            Flotten- und Scheduler-Status
 *   /scores            Top-Villa-Scores (Scorer)
 *   /tasks <villaId>   offene Aufgaben einer Villa
 *   /pause <villaId>   Villa pausieren (Autonomie aus)
 *   /resume <villaId>  Villa fortsetzen (Autonomie an + Scheduler)
 *   /pauseall          komplette Flotte pausieren
 *   /resumeall         komplette Flotte fortsetzen
 *   /help              Befehlsuebersicht
 */
import { db } from './db.mjs';
import { getSetting } from './control-store.mjs';
import { schedulerStatus, scheduleVilla, removeFromQueue } from './scheduler.mjs';
import { villaScores } from './scorer.mjs';

let messengerRunning = false;

const botToken = () => (process.env.VF_TELEGRAM_BOT_TOKEN || getSetting('telegramBotToken', '') || '').trim();
const allowList = () => String(process.env.VF_TELEGRAM_CHAT_IDS || getSetting('telegramChatIds', '') || '')
  .split(',').map((s) => s.trim()).filter(Boolean);

export function messengerStatus() {
  return { enabled: Boolean(botToken()), allowedChats: allowList().length, running: messengerRunning };
}

async function tg(method, payload) {
  try {
    await fetch(`https://api.telegram.org/bot${botToken()}/${method}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
    });
  } catch { /* Netz-Dip: naechster Poll holt nach */ }
}

function pauseVilla(id) {
  const r = db.prepare("UPDATE villas SET status='PAUSED', autonomy=0 WHERE id=? AND status!='ARCHIVED'").run(id);
  removeFromQueue(id);
  return r.changes > 0;
}

function resumeVilla(id) {
  const r = db.prepare("UPDATE villas SET autonomy=1 WHERE id=? AND status!='ARCHIVED'").run(id);
  if (r.changes > 0) scheduleVilla(id, { concurrency: 0, maxRounds: 6 });
  return r.changes > 0;
}

async function handleCommand(text) {
  const [cmd, ...args] = text.split(/\s+/);
  const id = Number(args[0]) || 0;
  switch (cmd) {
    case '/start': case '/help':
      return 'VillaForge Fernsteuerung:\n/status — Flottenstatus\n/scores — Villa-Bestenliste\n/tasks <id> — offene Aufgaben\n/pause <id> / /resume <id> — Villa steuern\n/pauseall / /resumeall — gesamte Flotte';
    case '/status': {
      const st = schedulerStatus();
      const villas = db.prepare("SELECT status, COUNT(*) c FROM villas WHERE status!='ARCHIVED' GROUP BY status").all();
      const scored = db.prepare('SELECT COUNT(*) c FROM task_scores').get().c;
      return `Flotte: ${villas.map((v) => `${v.status}=${v.c}`).join(', ')}\nSlots: ${st.active.length}/${st.slots} aktiv (${st.active.join(', ') || '-'}), ${st.queued} in Warteschlange\nBewertete Aufgaben: ${scored}`;
    }
    case '/scores': {
      const top = villaScores().slice(0, 5);
      if (!top.length) return 'Noch keine Scores.';
      return 'Top-Villen:\n' + top.map((v) => `V${v.villaId} (${v.name?.slice(0, 24)}): ${v.score} — Ø Task ${v.avgTaskScore}, ${v.doneLastHour} DONE/h, ${v.open} offen`).join('\n');
    }
    case '/tasks': {
      if (!id) return 'Nutzung: /tasks <villaId>';
      const open = db.prepare("SELECT COUNT(*) c FROM tasks WHERE villa_id=? AND status IN ('PENDING','READY','RUNNING')").get(id).c;
      const latest = db.prepare("SELECT title FROM tasks WHERE villa_id=? AND status IN ('PENDING','READY','RUNNING') ORDER BY priority, updated_at DESC LIMIT 3").all(id);
      return `Villa ${id}: ${open} offen\n` + (latest.map((t) => `• ${String(t.title).slice(0, 60)}`).join('\n') || '(keine)');
    }
    case '/pause':
      return id ? (pauseVilla(id) ? `Villa ${id} pausiert.` : `Villa ${id} nicht gefunden.`) : 'Nutzung: /pause <villaId>';
    case '/resume':
      return id ? (resumeVilla(id) ? `Villa ${id} fortgesetzt (in Scheduler-Warteschlange).` : `Villa ${id} nicht gefunden.`) : 'Nutzung: /resume <villaId>';
    case '/pauseall': {
      const rows = db.prepare("SELECT id FROM villas WHERE status!='ARCHIVED' AND (status!='PAUSED' OR autonomy!=0)").all();
      rows.forEach((r) => pauseVilla(r.id));
      return `Flotte pausiert (${rows.length} Villa(n)).`;
    }
    case '/resumeall': {
      const rows = db.prepare("SELECT id FROM villas WHERE status!='ARCHIVED' AND autonomy=0").all();
      rows.forEach((r) => resumeVilla(r.id));
      return `Flotte fortgesetzt (${rows.length} Villa(n)).`;
    }
    default:
      return null; // Kein Befehl → still schweigen
  }
}

/** Messenger starten. Ohne Token: einmaliger Hinweis, Modul bleibt inaktiv. */
export function startMessenger() {
  const token = botToken();
  const allowed = allowList();
  if (!token || !allowed.length) {
    console.log('[villaforge] Messenger: kein Telegram-Token/Chat-Allowlist gesetzt (VF_TELEGRAM_BOT_TOKEN, VF_TELEGRAM_CHAT_IDS) — Fernsteuerung inaktiv.');
    return null;
  }
  messengerRunning = true;
  let offset = 0;
  (async () => {
    while (true) {
      try {
        const r = await fetch(`https://api.telegram.org/bot${token}/getUpdates?timeout=50&offset=${offset}`);
        const d = await r.json();
        for (const u of d.result || []) {
          offset = Math.max(offset, (u.update_id || 0) + 1);
          const chatId = String(u.message?.chat?.id || '');
          if (!allowed.includes(chatId)) continue;
          const reply = await handleCommand(String(u.message?.text || '').trim());
          if (reply) await tg('sendMessage', { chat_id: chatId, text: reply });
        }
      } catch { await new Promise((r2) => setTimeout(r2, 5000)); }
    }
  })().catch(() => {});
  console.log(`[villaforge] Messenger: Telegram-Fernsteuerung aktiv (Allowlist: ${allowed.length} Chat(s)).`);
  return null;
}
