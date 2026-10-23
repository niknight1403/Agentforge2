import { db, now } from '../db.mjs';
import { insertAgent, ROLES } from '../agents.mjs';

const normalize = (name) => String(name || '').toLocaleLowerCase('de-DE').replace(/[\s_-]+/g, '');
const villas = db.prepare("SELECT id,name,status FROM villas WHERE status != 'ARCHIVED'").all();
const matches = villas.filter((villa) => normalize(villa.name) === 'testvilla');

if (matches.length > 1) {
  console.error(JSON.stringify({ ok: false, error: 'Mehrere Villen namens Test Villa gefunden; Fokus wurde nicht geändert.', matches: matches.map(({ id, name }) => ({ id, name })) }));
  process.exitCode = 1;
} else {
  db.exec('BEGIN IMMEDIATE');
  try {
    const timestamp = now();
    let target = matches[0];
    let created = false;

    if (!target) {
      const idea = 'Baue ein professionelles, produktionsnahes Projekt-Cockpit als VillaForge-Referenzprodukt: responsive Weboberfläche und Android-App mit klarer Projektübersicht, Status- und Fortschrittsanzeige, Suche, verständlichen Leer- und Fehlerzuständen, zugänglicher Bedienung und konsistentem Designsystem. Verwende ausschließlich synthetische Beispieldaten. Keine echten Zahlungen, Kundendaten, Zugangsdaten oder öffentlichen Deployments. Liefere dokumentierte Akzeptanzkriterien, automatisierte Tests für die wichtigsten Nutzerflüsse sowie reproduzierbare Web- und Android-Release-Builds.';
      const villaId = Number(db.prepare(
        'INSERT INTO villas (name,idea,status,max_agents,autonomy,created_at,updated_at) VALUES (?,?,?,?,?,?,?)'
      ).run('Test Villa', idea, 'RUNNING', 24, 1, timestamp, timestamp).lastInsertRowid);
      const rootId = Number(insertAgent(villaId, 'DeepAgent', 'ROOT', null, 1));
      const plan = [
        ['PLANNER', 'Produktbrief und Abnahmekriterien festlegen', 'Dokumentiere Zielgruppe, Kernabläufe, Datenzustände und Abnahmekriterien. Akzeptanz: jeder Hauptablauf besitzt einen überprüfbaren Erfolgs- und Fehlerfall.'],
        ['ARCHITECT', 'Web- und Android-Struktur sowie Designsystem planen', 'Lege modulare Ansichten, Zustandsmodelle, Abstände, Typografie, Farben und Navigationsregeln fest. Akzeptanz: Web und Android verwenden konsistente Komponenten und semantische Statusfarben.'],
        ['CODER', 'Responsive Web-Cockpit implementieren', 'Baue Übersicht, Projektliste, Suche und Detailansicht mit synthetischen Daten, Tastaturbedienung und mobilen Layouts. Akzeptanz: keine kaputten Links, horizontalen Überläufe oder unbenannten Bedienelemente.'],
        ['CODER', 'Android-Cockpit implementieren', 'Setze Dashboard und Projektliste in Compose um. Akzeptanz: Suche, Zustände, Navigation und Touch-Ziele funktionieren auf schmalen und breiten Geräten.'],
        ['TESTER', 'Nutzerfluss- und Zustandsprüfungen ergänzen', 'Teste Laden, leere Daten, Suche, Detailnavigation, Fehleranzeige und Fokusstatus automatisiert. Akzeptanz: Tests reproduzieren echte Nutzeraktionen und schlagen bei kaputten Abläufen fehl.'],
        ['REVIEWER', 'Sicherheit, Barrierefreiheit und Fehlerzustände prüfen', 'Prüfe synthetische Daten, Eingaben, Kontraste, Fokusführung, Semantik und Fehlertexte. Akzeptanz: keine Secrets, keine irreführenden Erfolgsanzeigen und keine kritischen Befunde.'],
        ['INTEGRATOR', 'Produktions-Webbuild und Android-Release verifizieren', 'Erzeuge reproduzierbare Web- und Android-Release-Artefakte und dokumentiere Buildbefehle. Akzeptanz: beide Builds laufen erfolgreich und enthalten Versionsmetadaten.'],
        ['DOCUMENTER', 'Betriebs- und Projektdokumentation erstellen', 'Dokumentiere Architektur, Testbefehle, lokale Ausführung, Build, Release und bekannte Grenzen. Akzeptanz: ein neues Teammitglied kann das Projekt ohne geheime Werte starten und prüfen.']
      ];

      db.prepare('INSERT INTO memories (villa_id,agent_id,scope,kind,title,content,importance,created_at) VALUES (?,?,?,?,?,?,?,?)')
        .run(villaId, rootId, 'villa', 'DECISION', 'Produktvision und Sicherheitsgrenzen', idea, 10, timestamp);
      for (const [role, title, description] of plan) {
        db.prepare('INSERT INTO tasks (villa_id,title,description,status,priority,created_at,updated_at) VALUES (?,?,?,?,?,?,?)')
          .run(villaId, title, `${description}\nRolle: ${ROLES.includes(role) ? role : 'WORKER'}.`, 'PENDING', 4, timestamp, timestamp);
      }
      for (const role of ROLES) insertAgent(villaId, `${role}-001`, role, rootId, 0);
      target = { id: villaId, name: 'Test Villa' };
      created = true;
    }

    db.prepare('INSERT OR REPLACE INTO control_settings(key,value) VALUES (?,?)').run('villaFocusId', JSON.stringify(target.id));
    db.prepare("UPDATE villas SET autonomy=0,status=CASE WHEN status IN ('RUNNING','PLANNING','STOPPING') THEN 'PAUSED' ELSE status END,updated_at=? WHERE id != ? AND status != 'ARCHIVED'").run(timestamp, target.id);
    const open = db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE villa_id=? AND status IN ('PENDING','READY','RUNNING')").get(target.id).count;
    db.prepare("UPDATE villas SET autonomy=1,status=CASE WHEN ? > 0 AND status NOT IN ('ARCHIVED','COMPLETED') THEN 'RUNNING' ELSE status END,updated_at=? WHERE id=?").run(open, timestamp, target.id);
    const others = db.prepare("SELECT COUNT(*) AS count FROM villas WHERE id != ? AND status != 'ARCHIVED' AND autonomy=1").get(target.id).count;
    if (others) throw new Error(`${others} other Villa(s) remain autonomous; focus activation failed.`);
    db.exec('COMMIT');
    console.log(JSON.stringify({ ok: true, focusVillaId: target.id, focusVilla: target.name, created, activeVillaCount: 1, otherAutonomousVillas: others, openTasks: open }));
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    console.error(JSON.stringify({ ok: false, error: error.message }));
    process.exitCode = 1;
  }
}
