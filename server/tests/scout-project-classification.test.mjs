import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.VF_DB = join(mkdtempSync(join(tmpdir(), 'vf-classify-')), 'test.db');
const { db, now } = await import('../db.mjs');
const { classifyProposal, approvalPlan, approveProposal, clarifyProposal, listProposals } = await import('../scout.mjs');
const {
  normalizeRepo, normalizeBranch, normalizeTargetPath, bindVillaRepo, villaRepo, villaRepoMap, villasForRepo, gitRemoteOf
} = await import('../repo-target.mjs');

function addVilla(name, sourcePath = '') {
  return Number(db.prepare('INSERT INTO villas (name, idea, status, created_at, updated_at, source_path) VALUES (?,?,?,?,?,?)')
    .run(name, `Idee ${name}`, 'RUNNING', now(), now(), sourcePath).lastInsertRowid);
}

function addProposal(fields = {}) {
  const row = {
    title: 'Erweiterung', proposed_name: 'Zielprojekt', masterprompt: 'Baue eine Erweiterung.',
    agent_count: 12, status: 'pending', project_type: 'NEW_PROJECT',
    classification_reason: 'Eigenstaendiges Produkt ohne bestehendes Repository.', ...fields
  };
  const id = Number(db.prepare(
    `INSERT INTO proposals (title, proposed_name, masterprompt, agent_count, status, created_at,
       project_type, target_repo, target_branch, target_path, classification_reason, confidence)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(row.title, row.proposed_name, row.masterprompt, row.agent_count, row.status, now(),
    row.project_type, row.target_repo || '', row.target_branch || '', row.target_path || '',
    row.classification_reason, row.confidence ?? 0.9).lastInsertRowid);
  return { id, row: db.prepare('SELECT * FROM proposals WHERE id = ?').get(id) };
}

/* ---------------- Zielnormalisierung ---------------- */

test('Repository-Angaben werden auf owner/name normalisiert', () => {
  assert.equal(normalizeRepo('https://github.com/niknight1403/Agentforge2.git'), 'niknight1403/Agentforge2');
  assert.equal(normalizeRepo('git@github.com:niknight1403/Agentforge2.git'), 'niknight1403/Agentforge2');
  assert.equal(normalizeRepo('niknight1403/Agentforge2/'), 'niknight1403/Agentforge2');
  assert.equal(normalizeRepo('https://github.com/o/r/pull/7'), '');
  assert.equal(normalizeRepo('kein repo'), '');
  assert.equal(normalizeRepo(''), '');
});

test('Branch und Unterpfad lehnen unsichere Werte ab', () => {
  assert.equal(normalizeBranch('main'), 'main');
  assert.equal(normalizeBranch('feature/datei-agent'), 'feature/datei-agent');
  assert.equal(normalizeBranch('..'), '');
  assert.equal(normalizeBranch('-x'), '');
  assert.equal(normalizeBranch(''), '');
  assert.equal(normalizeTargetPath('./apps/web'), 'apps/web');
  assert.throws(() => normalizeTargetPath('/etc/passwd'), /relativ/);
  assert.throws(() => normalizeTargetPath('apps/../../escape'), /\.\./);
});

test('Git-Remote wird ohne git-Binary aus .git/config gelesen', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vf-remote-'));
  mkdirSync(join(dir, '.git'));
  writeFileSync(join(dir, '.git', 'config'), '[core]\n\trepositoryformatversion = 0\n[remote "origin"]\n\turl = https://github.com/niknight1403/Agentforge2.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n');
  assert.equal(gitRemoteOf(dir), 'niknight1403/Agentforge2');
  assert.equal(gitRemoteOf(join(dir, 'gibt-es-nicht')), '');
});

/* ---------------- Klassifikation ---------------- */

test('NEW_PROJECT wird akzeptiert und ignoriert fremde Zielangaben', () => {
  const c = classifyProposal({ projectType: 'new project', classificationReason: 'Eigenstaendiges neues Produkt.', targetRepo: 'o/r', targetBranch: 'main' });
  assert.equal(c.projectType, 'NEW_PROJECT');
  assert.deepEqual(c.blockers, []);
  assert.equal(c.targetRepo, '');
  assert.equal(c.targetBranch, '');
});

test('Ohne Projektart oder Begruendung ist keine Freigabe moeglich', () => {
  assert.match(classifyProposal({ classificationReason: 'Irgendwas mit Projekt.' }).blockers.join(' '), /Projektart/);
  assert.match(classifyProposal({ projectType: 'NEW_PROJECT' }).blockers.join(' '), /Begruendung/);
  assert.equal(classifyProposal({ projectType: 'WELTHERRSCHAFT', classificationReason: 'Unfug mit Ansage.' }).projectType, '');
});

test('INTEGRATION braucht Repository, SUBPROJECT zusaetzlich einen Zielpfad', () => {
  assert.match(classifyProposal({ projectType: 'INTEGRATION', classificationReason: 'Erweitert ein bestehendes Projekt.' }).blockers.join(' '), /Zielrepository/);
  assert.match(classifyProposal({ projectType: 'SUBPROJECT', classificationReason: 'Teilprojekt im Monorepo.', targetRepo: 'o/r', targetBranch: 'main' }).blockers.join(' '), /Zielpfad/);
  const ok = classifyProposal({ projectType: 'SUBPROJECT', classificationReason: 'Teilprojekt im Monorepo.', targetRepo: 'https://github.com/o/r.git', targetBranch: 'main', targetPath: 'apps/web' });
  assert.deepEqual(ok.blockers, []);
  assert.equal(ok.targetRepo, 'o/r');
  assert.equal(ok.targetPath, 'apps/web');
});

/* ---------------- Freigabeplan ---------------- */

test('Freigabeplan: eigenstaendiges Projekt gruendet eine neue Villa', () => {
  const { row } = addProposal();
  assert.equal(approvalPlan(row).action, 'create_new_project');
});

test('Freigabeplan: eindeutig gebundenes Repository erweitert die vorhandene Villa', () => {
  const villaId = addVilla('Integrationsvilla');
  bindVillaRepo(villaId, { repo: 'o/bound', branch: 'main' });
  const { row } = addProposal({
    project_type: 'INTEGRATION', target_repo: 'o/bound', target_branch: '',
    classification_reason: 'Erweitert das gebundene Projekt.'
  });
  const plan = approvalPlan(row);
  assert.equal(plan.action, 'integrate');
  assert.equal(plan.villaId, villaId);
  assert.equal(plan.branch, 'main', 'Branch wird aus der belegten Bindung ergaenzt');
});

test('Freigabeplan: unbekanntes Repository erzeugt eine Integrations-Villa mit Zielbindung', () => {
  const { row } = addProposal({
    project_type: 'INTEGRATION', target_repo: 'o/neu', target_branch: 'main',
    classification_reason: 'Erweitert ein Projekt, das noch keine Villa hat.'
  });
  const plan = approvalPlan(row);
  assert.equal(plan.action, 'create_integration_villa');
  assert.equal(plan.repo, 'o/neu');
});

test('Freigabeplan: mehrdeutige Zuordnung blockiert den Vorschlag', () => {
  const a = addVilla('Dublette A'); const b = addVilla('Dublette B');
  bindVillaRepo(a, { repo: 'o/doppelt', branch: 'main' });
  bindVillaRepo(b, { repo: 'o/doppelt', branch: 'main' });
  const { row } = addProposal({
    project_type: 'INTEGRATION', target_repo: 'o/doppelt', target_branch: 'main',
    classification_reason: 'Erweitert das doppelt gebundene Projekt.'
  });
  const plan = approvalPlan(row);
  assert.equal(plan.action, 'blocked');
  assert.match(plan.blockers.join(' '), /Mehrdeutig/);
});

test('Freigabeplan: fehlender Branch blockiert eine Integration ohne Bindung', () => {
  const { row } = addProposal({
    project_type: 'INTEGRATION', target_repo: 'o/ohne-branch', target_branch: '',
    classification_reason: 'Erweitert ein Projekt ohne bekannten Branch.'
  });
  const plan = approvalPlan(row);
  assert.equal(plan.action, 'blocked');
  assert.match(plan.blockers.join(' '), /Zielbranch/);
});

/* ---------------- Freigabe ---------------- */

test('INTEGRATION erweitert die vorhandene Villa statt eine neue zu gruenden', async () => {
  const villaId = addVilla('Bestandsprojekt');
  bindVillaRepo(villaId, { repo: 'o/bestand', branch: 'main' });
  const { id } = addProposal({
    project_type: 'INTEGRATION', target_repo: 'o/bestand', target_branch: 'main',
    classification_reason: 'Erweitert das Bestandsprojekt.'
  });
  let createdVillas = 0;
  const result = await approveProposal(id, async () => { createdVillas++; return { villaId: 999 }; });
  assert.equal(createdVillas, 0, 'keine neue Greenfield-Villa fuer eine Integration');
  assert.equal(result.villaId, villaId);
  assert.equal(result.integrated, true);
  assert.equal(result.repo, 'o/bestand');
  const stored = db.prepare('SELECT status, villa_id FROM proposals WHERE id = ?').get(id);
  assert.equal(stored.status, 'approved');
  assert.equal(stored.villa_id, villaId);
  const tasks = db.prepare('SELECT title, description FROM tasks WHERE villa_id = ?').all(villaId);
  assert.equal(tasks.length, 1);
  assert.match(tasks[0].title, /^\[INTEGRATION\]/);
  assert.match(tasks[0].description, /Feature-Branch/);
});

test('Integration in ein unbekanntes Repository gruendet eine Villa mit Zielbindung', async () => {
  const { id } = addProposal({
    project_type: 'SUBPROJECT', target_repo: 'o/monorepo', target_branch: 'main', target_path: 'apps/neu',
    classification_reason: 'Teilprojekt in ein bestehendes Monorepo.'
  });
  const calls = [];
  const result = await approveProposal(id, async (args) => { calls.push(args); return { villaId: 77, name: args.name }; });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].mode, 'INTEGRATION');
  assert.equal(calls[0].sourcePath, '');
  assert.equal(result.villaId, 77);
  assert.deepEqual(villaRepo(77), { repo: 'o/monorepo', branch: 'main', path: 'apps/neu' });
});

test('blockierter Vorschlag bleibt offen, nennt den Grund und ist nach Klaerung freigebbar', async () => {
  const a = addVilla('Kollision A'); const b = addVilla('Kollision B');
  bindVillaRepo(a, { repo: 'o/kollision', branch: 'main' });
  bindVillaRepo(b, { repo: 'o/kollision', branch: 'main' });
  const { id } = addProposal({
    project_type: 'INTEGRATION', target_repo: 'o/kollision', target_branch: 'main',
    classification_reason: 'Erweitert das kollidierende Projekt.'
  });
  const tasksBefore = db.prepare('SELECT COUNT(*) c FROM tasks').get().c;
  await assert.rejects(() => approveProposal(id, async () => ({ villaId: 1 })), /blockiert/);
  const blocked = db.prepare('SELECT status, blocked_reason FROM proposals WHERE id = ?').get(id);
  assert.equal(blocked.status, 'pending');
  assert.match(blocked.blocked_reason, /Mehrdeutig/);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM tasks').get().c, tasksBefore, 'kein Auftrag trotz Blockade');

  const clarified = clarifyProposal(id, { projectType: 'NEW_PROJECT', classificationReason: 'Doch ein eigenstaendiges Produkt ohne Zielrepo.' });
  assert.equal(clarified.proposal.projectType, 'NEW_PROJECT');
  assert.equal(clarified.proposal.blockedReason, '');
  const result = await approveProposal(id, async () => ({ villaId: 55, name: 'Eigenstaendig' }));
  assert.deepEqual(result, { villaId: 55, villaName: 'Eigenstaendig' });
});

test('doppelte Freigabe legt weder Zweitvilla noch Zweitauftrag an', async () => {
  const villaId = addVilla('Idempotenz');
  bindVillaRepo(villaId, { repo: 'o/idem', branch: 'main' });
  const { id } = addProposal({
    project_type: 'INTEGRATION', target_repo: 'o/idem', target_branch: 'main',
    classification_reason: 'Erweitert das idempotente Projekt.'
  });
  await approveProposal(id, async () => ({ villaId: 1 }));
  await assert.rejects(() => approveProposal(id, async () => ({ villaId: 1 })), /nicht \(mehr\) offen/);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM tasks WHERE villa_id = ?').get(villaId).c, 1);
});

test('Vorschlagsliste liefert Projektart, Ziel und Blockadegrund mit', () => {
  const { id } = addProposal({
    project_type: 'INTEGRATION', target_repo: 'o/liste', target_branch: 'dev', target_path: 'pkg/a',
    classification_reason: 'Erweitert ein Paket im Monorepo.'
  });
  const entry = listProposals().find((p) => p.id === id);
  assert.equal(entry.projectType, 'INTEGRATION');
  assert.equal(entry.targetRepo, 'o/liste');
  assert.equal(entry.targetBranch, 'dev');
  assert.equal(entry.targetPath, 'pkg/a');
  assert.equal(entry.confidence, 0.9);
});

test('Villa-Bindung ist idempotent und hat Vorrang vor dem Git-Remote', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vf-villa-'));
  mkdirSync(join(dir, '.git'));
  writeFileSync(join(dir, '.git', 'config'), '[remote "origin"]\n\turl = git@github.com:alt/repo.git\n');
  const villaId = addVilla('Remote-Villa', dir);
  assert.deepEqual(villaRepo(villaId), { repo: 'alt/repo', branch: '', path: '' });
  assert.equal(bindVillaRepo(villaId, { repo: 'neu/repo', branch: 'main' }).created, true);
  assert.equal(bindVillaRepo(villaId, { repo: 'neu/repo', branch: 'main' }).created, false);
  assert.equal(villaRepo(villaId).repo, 'neu/repo');
  assert.deepEqual(villasForRepo('alt/repo'), [], 'die ausdrueckliche Bindung ersetzt das Remote');
  assert.equal(villasForRepo('neu/repo').length, 1);
  assert.equal(villaRepoMap().get('neu/repo')[0].id, villaId);
});
