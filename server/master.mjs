import { db, now } from './db.mjs';
import { chat as realChat } from './llm.mjs';
import { createVilla, orchestrate, stopVilla } from './agents.mjs';

/*
 * MASTER-AGENT (v1.33.0): persoenlicher App-Entwicklungs-Manager mit eigenem
 * Chat. Der Nutzer beschreibt einen Wunsch ("aendere Bereich X der App",
 * "baue mir Y") - der Master
 *   1. uebersetzt es in ein PROFESSIONELLES Entwicklungs-Prompt,
 *   2. stuendet daraus eine Villa mit passendem Design-System,
 *   3. startet die autonome Entwicklung sofort,
 *   4. liefert ein Design-Konzeptbild aus dem kostenlosen Designer-Tool
 *      (Pollinations.ai, kein API-Key) mit.
 * Verlauf und erzeugte Villen liegen in master_messages.
 */

db.exec(`CREATE TABLE IF NOT EXISTS master_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  villa_id INTEGER NOT NULL DEFAULT 0,
  villa_name TEXT NOT NULL DEFAULT '',
  design_image TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
)`);

let chatFn = realChat;
export function _setChat(fn) { chatFn = fn || realChat; }

/** Kostenloses Designer-Tool (Pollinations.ai): Konzeptbild-URL aus Brief. */
/**
 * DESIGN-AUSWAHL (Nutzerwunsch 2026-10-18): Der Master-Designer liefert zu
 * jedem Design-Konzept drei unterschiedliche Stilrichtungen zur Auswahl.
 * Die App zeigt alle drei; die Auswahl des Nutzers landet als normale
 * Chat-Nachricht im Verlauf. designImage (Variante 0) bleibt fuer aeltere
 * App-Versionen kompatibel.
 */
export const DESIGN_STYLES = [
  { key: 'cyber-neon', label: 'Cyber Neon', suffix: 'dark futuristic cyber neon aesthetic, glowing cyan and magenta accents on deep dark background, high contrast tech style' },
  { key: 'clean-minimal', label: 'Clean Minimal', suffix: 'clean minimal light design, elegant white and warm neutral surfaces, generous whitespace, soft shadows, premium simplicity' },
  { key: 'glass-aurora', label: 'Glass Aurora', suffix: 'modern glassmorphism design, translucent frosted glass panels, aurora gradient background in violet and teal, premium futuristic feel' }
];

export function designVariantUrls(brief, seed = Date.now() % 9973) {
  const base = String(brief || '').slice(0, 300);
  return DESIGN_STYLES.map((st, i) => ({
    label: st.label,
    key: st.key,
    url: designImageUrl(`${base}, ${st.suffix}`, (seed * 7 + i * 13) % 9973)
  }));
}

export function designImageUrl(brief, seed = Date.now() % 9973) {
  const clean = String(brief || 'premium mobile app concept').slice(0, 160);
  const prompt = encodeURIComponent(
    `professional mobile app UI design concept mockup, ${clean}, dark cyber neon glassmorphism, cyan magenta electric blue glowing accents, premium, high quality`
  );
  return `https://image.pollinations.ai/prompt/${prompt}?width=720&height=320&nologo=true&seed=${seed}`;
}

const TOOL_PACK = `
APP DESIGNER TOOL PACK (kostenlos, integriert):
- Fuer jede Gruendung formulierst du einen designBrief (1-2 Saetze, konkrete Design-Richtung,
  z.B. "Dark Glassmorphism Dashboard mit Neon-Karten und Live-Ring-Statistiken").
  Das System generiert daraus automatisch ein Design-Konzeptbild.
- Das Design-System der VillaForge-Produktfamilie ist Cyber-Neon und wird in jedem
  Prompt verankert: Hintergrund #050816, Akzente Cyan #00FFD1 / Magenta #FF3DDB /
  Electric Blue #00A3FF, Glas-Karten mit duennem Neon-Rand, mobil-optimiert,
  klare Typo-Hierarchie.
`;

const SYSTEM = `Du bist der MASTER-AGENT des VillaForge-Systems: ein autonomer App-Entwicklungs-Manager mit Vollmachten. Der Nutzer ist der Administrator.
WICHTIG - UMSATZPRIORITAET: Das CyberSarah Control Center ist das HAUPTUMSATZ-Projekt des Administrators. Bei allen Optimierungen und Wuenschen priorisiere Schritte, die CCC echten Umsatz bringen. Wenn du bei der Kernidee des Administrators (KI-Agenten zentral von unterwegs steuern) ein Produkt siehst, das WEITAUS umsatzstaerker waere, schlage es von selbst konkret vor (mit Umsatzschaetzung in EUR und Begruendung).
DEINE AUFGABE:
1. Verstehe den Wunsch: Veraenderung an einer App/einem Bereich, neue App, Verbesserung, Frage.
2. Uebersetze jeden Entwicklungswunsch in ein PROFESSIONELLES Gruendungsprompt mit:
   - Klarer Zieldefinition und Zielgruppe
   - 4-7 Kernfunktionen, jede mit pruefbarem Akzeptanzkriterium ("Akzeptanz: ...")
   - Design-System-Anweisung (Cyber-Neon, siehe Tool Pack)
   - Tech-Stack-Empfehlung (z.B. React/Vite + Express oder Kotlin/Compose, SQLite)
3. Nur wenn tatsaechlich etwas entwickelt/geaendert werden soll: setze "create".
   Bei reinen Fragen/Gespraechen: "create": null.
4. Du kannst Villen auch STEUERN - setze "actions" als Liste:
   [{"type": "stop_villa", "name": "Villen-Name"}] - laufende Villa stoppen
   [{"type": "pause_villa", "name": "Villen-Name"}] - Villa pausieren (kein Neustart)
   [{"type": "start_villa", "name": "Villen-Name"}] - Villa (weiter)entwickeln
   Mehrere Aktionen sind erlaubt. Namen muessen den echten Villen entsprechen
   (siehe SYSTEMSTATUS); bei Unklarheit frage in reply nach.
${TOOL_PACK}
Antworte AUSSCHLIESSLICH mit JSON:
{"reply": "persoenliche Antwort an den Administrator (2-4 Saetze, was du gerade gruendest/steuerst/erledigst)", "create": {"name": "Kurzer Villen-Name (2-3 Woerter)", "idea": "das professionelle Prompt (300-800 Woerter)", "designBrief": "Design-Richtung"} oder null, "actions": [{"type": "stop_villa|pause_villa|start_villa", "name": "Villen-Name"}] oder null}
Alles auf Deutsch.`;

function parseJson(raw) {
  try { return JSON.parse(raw); } catch { /* unten regex-Fallback */ }
  const m = String(raw).match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

/** Verlauf des Master-Chats (aeltere zuerst). */
export function masterHistory(limit = 60) {
  const rows = db.prepare('SELECT * FROM master_messages ORDER BY id DESC LIMIT ?').all(Number(limit) || 60);
  return rows.reverse().map((r) => ({
    role: r.role, content: r.content, createdAt: r.created_at,
    villaId: r.villa_id, villaName: r.villa_name, designImage: r.design_image
  }));
}

/**
 * Ein Zug im Master-Chat: Wunsch -> professionelles Prompt -> Villa + Start.
 * Die Villa wird sofort autonom gestartet (orchestrate); der Administrator
 * sieht in der App die neue Villa mit Design-Konzeptbild.
 */
export async function masterChat(message) {
  const history = masterHistory(12);
  db.prepare('INSERT INTO master_messages (role, content, created_at) VALUES (?,?,?)')
    .run('user', String(message).slice(0, 4000), now());

  // Systemstatus mitgeben: Der Master weiss sonst nicht, welche Villen existieren,
  // und fabuliert dann z.B. 'keine Villen aktiv'.
  const villas = db.prepare('SELECT name, status FROM villas ORDER BY id DESC LIMIT 20').all();
  const statusLine = 'SYSTEMSTATUS: ' + villas.length + ' Villen im System (' +
    villas.map((v) => v.name.slice(0, 20)).join(', ').slice(0, 400) + '). Antworte ehrlich zu diesem Stand.';

  let parsed = null;
  let offline = false;
  // Der Master ist der direkte Draht zum Administrator: unter Volllast sind
  // Routen kurzfristig geparkt (429/Cooldown). Deshalb bis zu 3 Versuche mit
  // 20 s Pause - eine geparkte Route ist meist nach Sekunden wieder frei.
  for (let attempt = 1; attempt <= 3 && !parsed; attempt++) {
    try {
      const res = await chatFn(
        [
          { role: 'system', content: SYSTEM + '\n' + statusLine },
          ...history.map((h) => ({ role: h.role, content: h.content })),
          { role: 'user', content: String(message).slice(0, 4000) }
        ],
        { json: true, role: 'ARCHITECT', strategy: 'FALLBACK', maxTokens: 2800, timeoutMs: 60_000 }
      );
      if (res && res.offline) {
        offline = true;
        if (attempt < 3) { await new Promise((r) => setTimeout(r, 20_000)); continue; }
      }
      parsed = parseJson(res.content || res.answer || '');
      offline = !parsed || !!res.offline;
    } catch (error) {
      if(error.code==='LLM_UNAVAILABLE')throw error;
      if (attempt < 3) { await new Promise((r) => setTimeout(r, 20_000)); }
    }
  }

  // Kein Modell / unbrauchbare Antwort: ehrlicher Hinweis, nichts halbfertiges gruenden.
  if (!parsed || typeof parsed.reply !== 'string') {
    const reply = 'Ich kann gerade kein Sprachmodell erreichen und gründe ungern eine Villa mit einem schwachen Standardplan. Bitte versuche es in Kürze erneut.';
    db.prepare('INSERT INTO master_messages (role, content, created_at) VALUES (?,?,?)').run('assistant', reply, now());
    return { reply, villaId: 0, offline: true };
  }

  let villaId = 0, villaName = '', designImage = '', designVariants = [];
  const create = parsed.create && parsed.create.name && parsed.create.idea ? parsed.create : null;
  if (create && !offline) {
    const seed = Math.floor(Math.random() * 9973) + Date.now() % 97;
    designImage = designImageUrl(create.designBrief || parsed.reply, seed);
    designVariants = designVariantUrls(create.designBrief || parsed.reply, seed);
    const { villaId: id } = await createVilla({
      name: String(create.name).slice(0, 80),
      idea: String(create.idea).slice(0, 6000) +
        '\n\nDESIGN-KONZEPT: ' + String(create.designBrief || '').slice(0, 400),
      agentCount: 12
    });
    villaId = id;
    villaName = String(create.name).slice(0, 80);
    // Autonomer Start: die Villa arbeitet sofort ihre Aufgaben ab.
    orchestrate(id, { concurrency: 0, maxRounds: 6 }).catch(() => {});
  }

  // Steueraktionen ausfuehren (stop/pause/start je Villen-Name)
  const doneActions = [];
  for (const a of Array.isArray(parsed.actions) ? parsed.actions : []) {
    if (!a || !a.name) continue;
    const v = db.prepare('SELECT id, name, status, autonomy FROM villas WHERE name LIKE ? ORDER BY id LIMIT 1').get('%' + String(a.name).slice(0, 40) + '%');
    if (!v) { doneActions.push({ type: a.type, name: a.name, ok: false, note: 'Villa nicht gefunden' }); continue; }
    try {
      if (a.type === 'stop_villa') {
        const wasRunning = stopVilla(v.id);
        db.prepare('UPDATE villas SET status = ?, updated_at = ? WHERE id = ?').run('PAUSED', now(), v.id);
        doneActions.push({ type: 'stop_villa', name: v.name, ok: true, note: wasRunning ? 'Lauf gestoppt und pausiert' : 'war nicht am Laufen, jetzt pausiert' });
      } else if (a.type === 'pause_villa') {
        stopVilla(v.id);
        db.prepare('UPDATE villas SET status = ?, updated_at = ? WHERE id = ?').run('PAUSED', now(), v.id);
        doneActions.push({ type: 'pause_villa', name: v.name, ok: true, note: 'pausiert' });
      } else if (a.type === 'start_villa') {
        db.prepare('UPDATE villas SET autonomy = 1, status = ?, updated_at = ? WHERE id = ?').run('RUNNING', now(), v.id);
        orchestrate(v.id, { concurrency: 0, maxRounds: 6 }).catch(() => {});
        doneActions.push({ type: 'start_villa', name: v.name, ok: true, note: ' gestartet' });
      } else {
        doneActions.push({ type: a.type, name: v.name, ok: false, note: 'unbekannter Befehlstyp' });
      }
    } catch (e) {
      doneActions.push({ type: a.type, name: v.name, ok: false, note: String(e?.message || e).slice(0, 80) });
    }
  }

  db.prepare('INSERT INTO master_messages (role, content, villa_id, villa_name, design_image, created_at) VALUES (?,?,?,?,?,?)')
    .run('assistant', String(parsed.reply).slice(0, 3000), villaId, villaName, designImage, now());
  return { reply: parsed.reply, villaId, villaName, designImage, designVariants, offline: false, started: villaId > 0, actions: doneActions };
}
