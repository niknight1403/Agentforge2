/**
 * Kernprodukt: aus einer Kundenanfrage eine versandfertige deutsche Antwort
 * plus Einordnung (Kategorie, Dringlichkeit, naechster Schritt) erzeugen.
 *
 * Der LLM-Aufruf ist injizierbar; damit sind Tests deterministisch und die
 * Produktionsroute laeuft ueber die echte Kette aus llm.js.
 */

export const KATEGORIEN = [
  "angebotsanfrage",
  "terminanfrage",
  "reklamation",
  "preisfrage",
  "support",
  "sonstiges",
];

export const DRINGLICHKEIT = ["hoch", "mittel", "niedrig"];

const SYSTEM = `Du bist der Antwort-Assistent eines deutschen kleinen oder mittleren Unternehmens.
Aufgabe: Beantworte die Kundenanfrage so, dass der Mitarbeiter sie nur noch pruefen und senden muss.

Regeln:
- Sprache: Deutsch, Sie-Form, hoeflich und knapp (maximal 120 Woerter).
- Keine erfundenen Preise, Termine, Zusagen oder Garantien. Wenn Angaben fehlen, frage konkret danach.
- Keine Floskeln wie "Vielen Dank fuer Ihre Nachricht" in mehr als einem Satz.
- Nenne immer den naechsten konkreten Schritt.

Antworte ausschliesslich mit JSON in exakt dieser Form:
{"reply": "...", "kategorie": "angebotsanfrage|terminanfrage|reklamation|preisfrage|support|sonstiges", "dringlichkeit": "hoch|mittel|niedrig", "naechster_schritt": "..."}`;

export class AnfrageFehler extends Error {
  constructor(message, code = "BAD_REQUEST") {
    super(message);
    this.code = code;
  }
}

export function pruefeEingang(body) {
  const nachricht = typeof body?.nachricht === "string" ? body.nachricht.trim() : "";
  if (nachricht.length < 10) throw new AnfrageFehler("nachricht fehlt oder ist zu kurz (min. 10 Zeichen)");
  if (nachricht.length > 4000) throw new AnfrageFehler("nachricht ist zu lang (max. 4000 Zeichen)");
  const absender = typeof body?.absender === "string" ? body.absender.trim().slice(0, 120) : "";
  const firma = typeof body?.firma === "string" ? body.firma.trim().slice(0, 120) : "";
  const ton = ["foermlich", "freundlich", "kurz"].includes(body?.ton) ? body.ton : "freundlich";
  return { nachricht, absender, firma, ton };
}

function baueMessages({ nachricht, absender, firma, ton }) {
  const kontext = [
    firma ? `Unternehmen: ${firma}` : null,
    absender ? `Absender der Anfrage: ${absender}` : null,
    `Gewuenschter Ton: ${ton}`,
  ].filter(Boolean).join("\n");
  return [
    { role: "system", content: SYSTEM },
    { role: "user", content: `${kontext}\n\nKundenanfrage:\n"""\n${nachricht}\n"""` },
  ];
}

export function parseAntwort(roh) {
  const text = String(roh || "").trim();
  const start = text.indexOf("{");
  const ende = text.lastIndexOf("}");
  if (start === -1 || ende === -1) throw new AnfrageFehler("Modellantwort enthielt kein JSON", "LLM_FORMAT");
  let daten;
  try {
    daten = JSON.parse(text.slice(start, ende + 1));
  } catch {
    throw new AnfrageFehler("Modellantwort war kein gueltiges JSON", "LLM_FORMAT");
  }
  const reply = typeof daten.reply === "string" ? daten.reply.trim() : "";
  if (reply.length < 20) throw new AnfrageFehler("Modellantwort enthielt keine brauchbare Antwort", "LLM_FORMAT");
  const kategorie = KATEGORIEN.includes(daten.kategorie) ? daten.kategorie : "sonstiges";
  const dringlichkeit = DRINGLICHKEIT.includes(daten.dringlichkeit) ? daten.dringlichkeit : "mittel";
  const naechsterSchritt = typeof daten.naechster_schritt === "string" && daten.naechster_schritt.trim()
    ? daten.naechster_schritt.trim()
    : "Antwort pruefen und senden";
  return { reply, kategorie, dringlichkeit, naechsterSchritt };
}

/**
 * Erzeugt die Antwort. `llm` ist eine Funktion (messages, optionen) =>
 * {inhalt, provider}; Standard ist die echte Kette.
 */
export async function beantworteAnfrage(body, { llm } = {}) {
  const eingang = pruefeEingang(body);
  if (typeof llm !== "function") throw new AnfrageFehler("LLM nicht konfiguriert", "LLM_UNAVAILABLE");
  const start = Date.now();
  let antwort;
  try {
    antwort = await llm(baueMessages(eingang), { temperature: 0.3, timeoutMs: 25000 });
  } catch (e) {
    throw new AnfrageFehler(`Sprachmodell nicht erreichbar: ${e.message}`.slice(0, 300), "LLM_UNAVAILABLE");
  }
  const geparst = parseAntwort(antwort.inhalt);
  return {
    ...geparst,
    provider: antwort.provider || "unbekannt",
    latenzMs: Date.now() - start,
  };
}
