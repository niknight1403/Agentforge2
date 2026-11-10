/*
 * integration-publish (Issue #135): Veroeffentlichung in ein BESTEHENDES
 * Repository. Eine Villa, die an ein fremdes Projekt gebunden ist, darf dort
 * niemals direkt auf den Zielbranch schreiben. Der Weg ist immer derselbe:
 * Feature-Branch -> Commit -> Push nur dieses Branches -> Pull Request gegen
 * den Zielbranch. Alles ohne --force und ohne neues Repository.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeBranch, normalizeRepo } from './repo-target.mjs';

const GH = 'https://api.github.com';

/** Entfernt Zugangsdaten aus Git-/HTTP-Ausgaben, bevor sie irgendwo landen. */
export function redactSecrets(text) {
  return String(text ?? '')
    .replace(/x-access-token:[^@\s]+@/gi, 'x-access-token:[redacted]@')
    .replace(/\b(?:ghp_|gho_|ghu_|ghs_|github_pat_)[A-Za-z0-9_-]{10,}\b/g, '[redacted]');
}

export function slugify(value, max = 40) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/g, '');
}

/**
 * Deterministischer Feature-Branch: ein Wiederanlauf fuehrt denselben Branch
 * weiter, statt fuer denselben Auftrag einen zweiten anzulegen.
 */
export function integrationBranchName(villaId, name = '') {
  const id = Number(villaId);
  if (!Number.isSafeInteger(id) || id < 1) throw new Error('Ungueltige Villa-ID fuer den Integrationsbranch.');
  const slug = slugify(name);
  return `villaforge/integration-${id}${slug ? `-${slug}` : ''}`;
}

function command(root, args) {
  return `git -C ${JSON.stringify(root)} ${args}`;
}

/**
 * Veroeffentlicht einen Projektstand als Pull Request im Zielrepository.
 * `exec(cmd)` liefert null bei Erfolg oder eine Fehlermeldung.
 * `fetchFn` ist injizierbar, damit die Logik ohne Netz pruefbar bleibt.
 */
export async function publishIntegration({
  villaId,
  root,
  repo,
  baseBranch,
  featureBranch,
  title,
  message,
  body = '',
  token,
  exec,
  fetchFn,
  gates = null
} = {}) {
  const run = exec;
  if (typeof run !== 'function') return { ok: false, stage: 'config', error: 'Kein Ausfuehrungsweg fuer Git uebergeben.' };
  const doFetch = fetchFn || ((...a) => fetch(...a));

  const target = normalizeRepo(repo);
  if (!target) return { ok: false, stage: 'config', error: 'Zielrepository fehlt oder ist ungueltig (erwartet owner/name).' };
  const base = normalizeBranch(baseBranch);
  if (!base) return { ok: false, stage: 'config', error: 'Zielbranch fehlt oder ist ungueltig.' };
  let feature;
  try {
    feature = normalizeBranch(featureBranch || integrationBranchName(villaId, title));
  } catch (err) {
    return { ok: false, stage: 'config', error: redactSecrets(err.message) };
  }
  if (!feature) return { ok: false, stage: 'config', error: 'Feature-Branch fehlt oder ist ungueltig.' };
  // Harte Sperre: der Zielbranch ist kein Arbeitsbranch.
  if (feature === base) {
    return { ok: false, stage: 'guard', error: `Feature-Branch darf nicht der Zielbranch ${base} sein.` };
  }
  if (!token) return { ok: false, stage: 'config', error: 'Kein GITHUB_TOKEN im Secrets-Store hinterlegt.' };
  if (!root || !existsSync(root)) return { ok: false, stage: 'checkout', error: 'Projektordner ist leer — nichts zu veroeffentlichen.' };
  if (!existsSync(join(root, '.git'))) {
    return { ok: false, stage: 'checkout', error: 'Kein Git-Checkout im Projektordner — bitte zuerst das Zielrepository auschecken.' };
  }

  if (typeof gates === 'function') {
    const gate = await gates().catch((err) => ({ passed: false, output: String(err?.message || err) }));
    if (!gate?.passed) {
      return {
        ok: false,
        stage: 'gates',
        error: 'Qualitaetstor nicht bestanden: ' + redactSecrets(String(gate?.output || 'ohne Nachweis')).slice(0, 300)
      };
    }
  }

  const step = (args, stage) => {
    const failure = run(command(root, args));
    return failure ? { ok: false, stage, error: redactSecrets(String(failure)).slice(0, 400) } : null;
  };

  const checkedOut = step(`checkout -q -B ${feature}`, 'branch');
  if (checkedOut) return checkedOut;
  const added = step('add -A', 'commit');
  if (added) return added;
  const commitMessage = String(message || title || 'Integration').replace(/\s+/g, ' ').slice(0, 120);
  const commitFailure = run(command(root, `-c user.name=VillaForge-Hub -c user.email=hub@villaforge.local commit -q -m ${JSON.stringify(commitMessage)}`));
  if (commitFailure) {
    const text = redactSecrets(String(commitFailure));
    if (/nothing to commit|nichts zu committen|no changes added/i.test(text)) {
      return { ok: false, stage: 'commit', error: 'Keine Aenderungen zu veroeffentlichen.' };
    }
    return { ok: false, stage: 'commit', error: text.slice(0, 400) };
  }

  // Explizites Refspec, kein --force: nur der Feature-Branch kann den Server erreichen.
  const remoteUrl = `https://x-access-token:${token}@github.com/${target}.git`;
  const pushFailure = run(command(root, `push ${JSON.stringify(remoteUrl)} refs/heads/${feature}:refs/heads/${feature}`));
  if (pushFailure) return { ok: false, stage: 'push', error: redactSecrets(String(pushFailure)).slice(0, 400) };

  const payload = {
    title: String(title || `Integration: ${feature}`).slice(0, 200),
    head: feature,
    base,
    body: String(body || `Automatischer Integrationsstand der Villa #${villaId}.`).slice(0, 6000)
  };
  let response;
  try {
    response = await doFetch(`${GH}/repos/${target}/pulls`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(20000)
    });
  } catch (err) {
    return { ok: false, stage: 'pull_request', error: 'GitHub nicht erreichbar: ' + redactSecrets(String(err?.message || err)).slice(0, 200) };
  }
  if (response.status === 422) {
    return { ok: false, stage: 'pull_request', error: `Es existiert bereits ein Pull Request fuer ${feature} gegen ${base}.` };
  }
  if (!response.ok) {
    return { ok: false, stage: 'pull_request', error: `Pull-Request-Anlage HTTP ${response.status}` };
  }
  let created = {};
  try { created = await response.json(); } catch { created = {}; }
  return {
    ok: true,
    repo: target,
    base,
    feature,
    number: Number(created.number) || null,
    url: created.html_url || `https://github.com/${target}/compare/${base}...${feature}`
  };
}
