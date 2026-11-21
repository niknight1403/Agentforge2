/** Isolated emulator fixture: no external credentials, builds or workers. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { db, now } from '../server/db.mjs';
import { linkDeepProjectVilla } from '../server/deepagent.mjs';

if (process.env.VF_TEST !== '1' || !process.env.DEEP_DIR || !process.env.VF_DB) {
  throw new Error('Refusing to seed outside an isolated VF_TEST database and project directory');
}

const created = now();
const projectId = Number(db.prepare(
  'INSERT INTO deep_projects (title, idea, status, created_at, updated_at) VALUES (?,?,?,?,?)'
).run('Emulator-Projekt Design 3', 'Emulator-Prüfung der DeepAgent-Oberfläche', 'ACTIVE', created, created).lastInsertRowid);
const villaId = Number(db.prepare(
  'INSERT INTO villas (name, idea, status, created_at, updated_at) VALUES (?,?,?,?,?)'
).run('Emulator-Villa', 'Isolierte Oberflächenprüfung', 'CREATED', created, created).lastInsertRowid);
linkDeepProjectVilla(projectId, villaId);
db.prepare('INSERT INTO deep_messages (project_id, role, content, created_at) VALUES (?,?,?,?)')
  .run(projectId, 'assistant', 'Der isolierte DeepAgent-Arbeitsplatz ist bereit.', created);

const dist = join(process.env.DEEP_DIR, String(projectId), 'dist');
mkdirSync(dist, { recursive: true });
writeFileSync(join(dist, 'index.html'), '<!doctype html><html lang="de"><meta name="viewport" content="width=device-width,initial-scale=1"><title>VillaForge E2E</title><style>body{background:#122037;color:#fff;font:20px sans-serif;padding:24px}</style><h1>LIVE VORSCHAU TEST</h1><p>Isolierter Web-Build für den Android-Emulator.</p></html>');
console.log(JSON.stringify({ projectId, villaId, fixture: join(dist, 'index.html') }));
