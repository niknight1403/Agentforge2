#!/usr/bin/env python3
"""
Erzeugt aus den Lead-CSVs ein versandfertiges Akquise-Paket.

Ausgabe je Betrieb:
  - Telefonkarte (wichtigster Kanal in Deutschland, siehe Hinweis unten)
  - E-Mail-Entwuerfe als .eml (RFC 2822), vier Stufen mit Terminvorgabe
  - Manifest-CSV fuer Nachverfolgung

Rechtlicher Hinweis (DACH): Kalt-E-Mail an Unternehmen ohne vorherigen Kontakt
ist nach § 7 UWG angreifbar. Deshalb ist der Telefonweg und LinkedIn der
bevorzugte Erstkontakt; E-Mails bitte erst nach Zustimmung im Gespraech oder
nach Opt-in (z.B. Sofort-Test, Newsletter) versenden.

Aufruf: python3 scripts/outbound.py leads_*.csv --out outbound/
"""
import argparse
import csv
import glob
import re
import sys
from datetime import date, timedelta
from email.message import EmailMessage
from email.utils import formatdate, make_msgid
from pathlib import Path

ABSENDER_NAME = "Nik"
ABSENDER_FIRMA = "AnfragePilot"
ABSENDER_MAIL = "kontakt@anfragepilot.de"
ABSENDER_TEL = ""
DEMO = "https://hub.cybersarah-ki.com/pilot/check"
SEITE = "https://hub.cybersarah-ki.com/pilot/"

SEGMENT_BEISPIEL = {
    "elektro": "Anfrage für 12 Telefonarbeitsplätze im Büro",
    "shk": "Störung: keine Warmwasserbereitung, Termin diese Woche",
    "it": "Angebotsanfrage für Wartungsvertrag über 3 Standorte",
}


def lade_leads(pfade):
    leads = []
    for pfad in pfade:
        with open(pfad, newline="", encoding="utf-8") as f:
            for zeile in csv.DictReader(f, delimiter=";"):
                firma = (zeile.get("firma") or "").strip()
                email = (zeile.get("email") or "").strip()
                if not firma:
                    continue
                if not email or "keine" in email.lower() or "@" not in email:
                    email = ""
                leads.append({
                    "firma": firma,
                    "stadt": (zeile.get("stadt") or "").strip(),
                    "website": (zeile.get("website") or "").strip(),
                    "email": email,
                    "telefon": (zeile.get("telefon") or "").strip(),
                    "impressum": (zeile.get("impressum_url") or "").strip(),
                    "formular": (zeile.get("formular") or "").strip().lower(),
                    "quelle": pfad,
                })
    return leads


def segment(pfad):
    name = Path(pfad).name.lower()
    if "elektro" in name:
        return "elektro"
    if "shk" in name:
        return "shk"
    if "it" in name:
        return "it"
    return "allgemein"


def slug(text):
    text = text.lower().replace("ä", "ae").replace("ö", "oe").replace("ü", "ue").replace("ß", "ss")
    return re.sub(r"[^a-z0-9]+", "-", text).strip("-")[:60] or "betrieb"


def mails(lead, seg, start):
    """Vier Nachrichten mit Terminvorgabe (Werktage grob per Kalendertage)."""
    ort = lead["stadt"] or "Ihrem Ort"
    beispiel = SEGMENT_BEISPIEL.get(seg, "eine typische Kundenanfrage")
    return [
        {
            "stufe": 1,
            "faellig": start,
            "betreff": f"Wie lange dauert bei {lead['firma']} die Antwort auf eine Anfrage?",
            "text": f"""Guten Tag,

ich habe auf Ihrer Website eine Anfrage gestellt, wie sie bei Ihnen täglich eingeht: {beispiel}.

AnfragePilot hat daraus in unter zwei Sekunden eine Antwort geschrieben, die man sofort senden kann. Hier können Sie das mit einer echten Anfrage aus {ort} testen, ohne Anmeldung:
{DEMO}

Bei Betrieben Ihrer Größe sind das 20 bis 60 Anfragen pro Woche, jede kostet zehn bis fünfzehn Minuten. Der Entwurf übernimmt diesen Teil, ordnet die Anfrage ein (Angebot, Termin, Reklamation) und sagt, was als Nächstes zu tun ist.

Wenn es passt, richte ich Ihnen das in 15 Minuten für Ihr Postfach ein. Ein kurzer Anruf genügt: {ABSENDER_TEL}

Mit freundlichen Grüßen
{ABSENDER_NAME} · {ABSENDER_FIRMA}
{SEITE}""",
        },
        {
            "stufe": 2,
            "faellig": start + timedelta(days=3),
            "betreff": f"Re: Wie lange dauert bei {lead['firma']} die Antwort auf eine Anfrage?",
            "text": f"""Guten Tag,

kurzes Beispiel aus der Praxis. Eingang:

"Guten Tag, wir haben gestern eine Wallbox installieren lassen. Die Rechnung ist doppelt so hoch wie im Angebot. Ich erwarte bis Freitag eine Erklärung."

Antwortentwurf nach 0,9 Sekunden: Kategorie Reklamation, Dringlichkeit hoch, nächster Schritt Rechnungsnummer und Angebot anfordern. Genau das entscheidet, ob ein Kunde bleibt.

Test mit Ihrer eigenen Anfrage: {DEMO}

Mit freundlichen Grüßen
{ABSENDER_NAME} · {ABSENDER_FIRMA}""",
        },
        {
            "stufe": 3,
            "faellig": start + timedelta(days=7),
            "betreff": f"Was kostet Sie eine unbeantwortete Anfrage, {lead['firma']}?",
            "text": f"""Guten Tag,

ein Auftrag liegt bei Ihnen im Schnitt im vierstelligen Bereich. Bleibt pro Monat nur eine Anfrage liegen, weil die Antwort zu spät kam, ist das teurer als der Tarif.

Starter: 49 Euro im Monat, 200 Anfragen. Pro: 99 Euro, 1.000 Anfragen. Monatlich kündbar, keine Einrichtungsgebühr, keine Mindestlaufzeit.

Soll ich Ihnen das zwei Wochen zum Testen einrichten?

Mit freundlichen Grüßen
{ABSENDER_NAME} · {ABSENDER_FIRMA}""",
        },
        {
            "stufe": 4,
            "faellig": start + timedelta(days=12),
            "betreff": "Letzte Nachricht von mir",
            "text": f"""Guten Tag,

ich melde mich nicht weiter, damit Ihr Postfach nicht voller wird. Falls das Thema später akut wird: Der kostenlose Test bleibt offen.
{DEMO}

Freundliche Grüße
{ABSENDER_NAME} · {ABSENDER_FIRMA}""",
        },
    ]


def telefonkarte(lead, seg):
    beispiel = SEGMENT_BEISPIEL.get(seg, "eine typische Kundenanfrage")
    return f"""# Telefonkarte — {lead['firma']}

- **Ort:** {lead['stadt'] or 'unbekannt'}
- **Telefon:** {lead['telefon'] or 'nicht gefunden'}
- **Website:** {lead['website'] or '-'}
- **Kontaktformular:** {'ja' if lead['formular'].startswith('ja') else 'nein/unklar'}

## Einstieg (30 Sekunden)

"Guten Tag, [Name] von AnfragePilot. Ich rufe wegen Ihrer Kundenanfragen an: Wie lange dauert es bei Ihnen, bis ein Interessent eine Antwort bekommt?"

## Zuhören, dann spiegeln

- Bei "ein bis zwei Tage": "Genau da setzen wir an. Im Schnitt sind das zwölf Minuten pro Anfrage."
- Bei "läuft gut": "Wie viele Anfragen pro Woche sind es ungefähr? ... Bei {beispiel} wären das schon mehrere Stunden im Monat."

## Angebot im Gespräch

"Wir schreiben den Antwortentwurf in Sekunden, sortieren die Anfrage ein und sagen, was der nächste Schritt ist. Sie prüfen nur noch und senden. Darf ich Ihnen den Testlink schicken?"
{DEMO}

## Abschluss

- Ziel A: Zustimmung zum Mailversand ("Dann schicke ich Ihnen die zwei Zeilen, ja?") → E-Mail Stufe 1 senden.
- Ziel B: Termin für Einrichtung (15 Minuten).
- Ziel C: Absage notieren, in 3 Monaten erneut.

## Nicht tun

- Keine Preise ungefragt nennen.
- Keine Referenzen nennen, die es nicht gibt.
"""


def baue_eml(lead, mail, absender=ABSENDER_MAIL):
    msg = EmailMessage()
    msg["From"] = f"{ABSENDER_NAME} · {ABSENDER_FIRMA} <{absender}>"
    msg["To"] = lead["email"]
    msg["Subject"] = mail["betreff"]
    msg["Date"] = formatdate(localtime=True)
    msg["Message-ID"] = make_msgid(domain="anfragepilot.de")
    msg.set_content(mail["text"])
    return msg


def main():
    p = argparse.ArgumentParser()
    p.add_argument("leads", nargs="+")
    p.add_argument("--out", default="outbound")
    p.add_argument("--start", default=None, help="Startdatum JJJJ-MM-TT (Standard: morgen)")
    args = p.parse_args()

    dateien = []
    for muster in args.leads:
        dateien.extend(glob.glob(muster))
    if not dateien:
        sys.exit("Keine Lead-Dateien gefunden.")

    start = date.fromisoformat(args.start) if args.start else date.today() + timedelta(days=1)
    aus = Path(args.out)
    (aus / "telefon").mkdir(parents=True, exist_ok=True)
    (aus / "emails").mkdir(parents=True, exist_ok=True)

    leads = lade_leads(dateien)
    manifest = []
    for lead in leads:
        seg = segment(lead["quelle"])
        name = slug(lead["firma"])
        (aus / "telefon" / f"{name}.md").write_text(telefonkarte(lead, seg), encoding="utf-8")
        if lead["email"]:
            for mail in mails(lead, seg, start):
                datei = aus / "emails" / f"{name}-stufe{mail['stufe']}.eml"
                datei.write_text(baue_eml(lead, mail).as_string(), encoding="utf-8")
                manifest.append({
                    "firma": lead["firma"], "stadt": lead["stadt"], "email": lead["email"],
                    "segment": seg, "stufe": mail["stufe"], "faellig_am": mail["faellig"].isoformat(),
                    "betreff": mail["betreff"], "datei": str(datei),
                    "telefon": lead["telefon"], "website": lead["website"],
                })

    with open(aus / "manifest.csv", "w", newline="", encoding="utf-8") as f:
        schreiber = csv.DictWriter(f, fieldnames=list(manifest[0].keys()) if manifest else ["firma"])
        schreiber.writeheader()
        schreiber.writerows(manifest)

    mit_mail = sum(1 for l in leads if l["email"])
    mit_tel = sum(1 for l in leads if l["telefon"])
    print(f"Betriebe: {len(leads)} | mit E-Mail: {mit_mail} | mit Telefon: {mit_tel}")
    print(f"E-Mail-Entwuerfe: {len(manifest)} | Telefonkarten: {len(leads)}")
    print(f"Ausgabe: {aus.resolve()}")


if __name__ == "__main__":
    main()
