import test from "node:test";
import assert from "node:assert/strict";
import { pruefeEingang, parseAntwort, beantworteAnfrage, AnfrageFehler } from "../src/product.js";

const gueltig = '{"reply":"Guten Tag, fuer 12 Arbeitsplaetze benoetige ich die Anzahl der Nebenstellen und zwei Terminvorschlaege.","kategorie":"angebotsanfrage","dringlichkeit":"hoch","naechster_schritt":"Terminvorschlaege erfragen"}';

test("pruefeEingang akzeptiert eine normale Anfrage", () => {
  const e = pruefeEingang({ nachricht: "Wir brauchen ein Angebot fuer 12 Telefone." });
  assert.equal(e.ton, "freundlich");
  assert.match(e.nachricht, /Angebot/);
});

test("pruefeEingang weist zu kurze Nachrichten ab", () => {
  assert.throws(() => pruefeEingang({ nachricht: "Hallo" }), (err) => err instanceof AnfrageFehler && err.code === "BAD_REQUEST");
});

test("pruefeEingang weist fehlende Nachricht ab", () => {
  assert.throws(() => pruefeEingang({}), AnfrageFehler);
});

test("pruefeEingang begrenzt die Laenge auf 4000 Zeichen", () => {
  assert.throws(() => pruefeEingang({ nachricht: "a".repeat(4001) }), /zu lang/);
});

test("parseAntwort liest gueltiges JSON", () => {
  const a = parseAntwort(gueltig);
  assert.equal(a.kategorie, "angebotsanfrage");
  assert.equal(a.dringlichkeit, "hoch");
  assert.match(a.naechsterSchritt, /Termin/);
});

test("parseAntwort kommt mit Vor- und Nachtext zurecht", () => {
  const a = parseAntwort("Hier das Ergebnis:\n" + gueltig + "\nEnde.");
  assert.equal(a.kategorie, "angebotsanfrage");
});

test("parseAntwort ersetzt unbekannte Kategorien durch sonstiges", () => {
  const a = parseAntwort('{"reply":"Bitte senden Sie uns weitere Angaben zu Ihrem Vorhaben.","kategorie":"unbekannt","dringlichkeit":"extrem"}');
  assert.equal(a.kategorie, "sonstiges");
  assert.equal(a.dringlichkeit, "mittel");
});

test("parseAntwort lehnt Antworten ohne JSON ab", () => {
  assert.throws(() => parseAntwort("Nur Text ohne Struktur"), /kein JSON/);
});

test("beantworteAnfrage nutzt das injizierte Modell", async () => {
  const llm = async () => ({ inhalt: gueltig, provider: "test" });
  const r = await beantworteAnfrage({ nachricht: "Wir brauchen ein Angebot fuer 12 Telefone." }, { llm });
  assert.equal(r.kategorie, "angebotsanfrage");
  assert.equal(r.provider, "test");
  assert.ok(r.latenzMs >= 0);
});

test("beantworteAnfrage reicht den Ton an das Modell weiter", async () => {
  let gesehen = "";
  const llm = async (messages) => {
    gesehen = messages.map((m) => m.content).join("\n");
    return { inhalt: gueltig, provider: "test" };
  };
  await beantworteAnfrage({ nachricht: "Wir brauchen ein Angebot fuer 12 Telefone.", ton: "kurz", firma: "Muster GmbH" }, { llm });
  assert.match(gesehen, /Muster GmbH/);
  assert.match(gesehen, /Ton: kurz/);
});

test("beantworteAnfrage ohne Modell meldet LLM_UNAVAILABLE", async () => {
  await assert.rejects(() => beantworteAnfrage({ nachricht: "Wir brauchen ein Angebot fuer 12 Telefone." }), (err) => err.code === "LLM_UNAVAILABLE");
});
