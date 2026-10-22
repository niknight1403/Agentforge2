import { createHmac, timingSafeEqual } from 'node:crypto';

const clean = (value, limit = 180) => String(value ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, limit);

/** GitHub webhook signature check over the untouched request body. */
export function verifyGitHubSignature(rawBody, signature, secret) {
  if (!secret) return { ok: false, error: 'GITHUB_WEBHOOK_SECRET nicht konfiguriert' };
  const match = /^sha256=([a-f0-9]{64})$/i.exec(String(signature ?? ''));
  if (!match) return { ok: false, error: 'X-Hub-Signature-256 fehlt oder ist ungueltig' };
  const expected = createHmac('sha256', secret).update(rawBody).digest();
  const received = Buffer.from(match[1], 'hex');
  return expected.length === received.length && timingSafeEqual(expected, received)
    ? { ok: true }
    : { ok: false, error: 'GitHub-Signatur stimmt nicht ueberein' };
}

/** Deterministic, free fallback changelog based only on verified push data. */
export function buildCommitChangelog(payload) {
  const repo = clean(payload?.repository?.full_name, 120) || 'Unbekanntes Repository';
  const branch = clean(String(payload?.ref ?? '').replace(/^refs\/heads\//, ''), 100) || 'unbekannter Branch';
  const commits = Array.isArray(payload?.commits) ? payload.commits : [];
  const categories = new Map([
    ['Neue Funktionen', []], ['Fehlerbehebungen', []], ['Leistung', []],
    ['Dokumentation und Wartung', []], ['Weitere Änderungen', []]
  ]);
  for (const commit of commits.slice(0, 80)) {
    const message = clean(commit?.message?.split('\n')[0], 180);
    if (!message) continue;
    const type = /^(feat|feature)(\([^)]+\))?!?:/i.test(message) ? 'Neue Funktionen'
      : /^(fix|bugfix)(\([^)]+\))?!?:/i.test(message) ? 'Fehlerbehebungen'
      : /^(perf|performance)(\([^)]+\))?!?:/i.test(message) ? 'Leistung'
      : /^(docs|doc|chore|refactor|test|build|ci)(\([^)]+\))?!?:/i.test(message) ? 'Dokumentation und Wartung'
      : 'Weitere Änderungen';
    const shortSha = clean(commit?.id, 40).slice(0, 7);
    const url = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/commit\/[a-f0-9]{7,40}$/i.test(String(commit?.url ?? '')) ? commit.url : '';
    categories.get(type).push(`• ${message}${shortSha ? ` (${shortSha})` : ''}${url ? `\n  ${url}` : ''}`);
  }
  const sections = [...categories].filter(([, lines]) => lines.length)
    .map(([title, lines]) => `${title}\n${lines.join('\n')}`);
  if (!sections.length) sections.push('Keine Commit-Nachrichten im Push enthalten.');
  if (commits.length > 80) sections.push(`Weitere ${commits.length - 80} Commits sind im Push enthalten; die Nachricht zeigt die ersten 80.`);
  return [`🧩 Update: ${repo}`, `Branch: ${branch}`, '', ...sections].join('\n').slice(0, 3900);
}

/** Posts plain text (no parse_mode) to Telegram's Bot API. */
export async function sendTelegramChangelog(text, { token = process.env.TELEGRAM_BOT_TOKEN, chatId = process.env.TELEGRAM_CHAT_ID, fetchFn = fetch } = {}) {
  if (!token || !chatId) return { sent: false, reason: 'TELEGRAM_BOT_TOKEN oder TELEGRAM_CHAT_ID nicht konfiguriert' };
  const message = String(text ?? '').slice(0, 3900);
  if (!message.trim()) return { sent: false, reason: 'Changelog ist leer' };
  try {
    const response = await fetchFn(`https://api.telegram.org/bot${encodeURIComponent(token)}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: message, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(8000)
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.ok !== true) return { sent: false, reason: clean(body.description || `Telegram HTTP ${response.status}`, 240).replaceAll(token, '[redacted]') };
    return { sent: true, messageId: body.result?.message_id ?? null };
  } catch (error) {
    return { sent: false, reason: clean(error?.message || error, 240).replaceAll(token, '[redacted]') };
  }
}
