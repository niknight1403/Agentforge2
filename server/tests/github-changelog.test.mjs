import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { buildCommitChangelog, sendTelegramChangelog, verifyGitHubSignature } from '../github-changelog.mjs';

test('GitHub webhook signature validates raw bytes and rejects tampering', () => {
  const raw = Buffer.from('{"ref":"refs/heads/main"}');
  const secret = 'github-secret';
  const signature = `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;
  assert.equal(verifyGitHubSignature(raw, signature, secret).ok, true);
  assert.equal(verifyGitHubSignature(Buffer.from('{}'), signature, secret).ok, false);
  assert.match(verifyGitHubSignature(raw, signature, '').error, /nicht konfiguriert/);
});

test('Changelog groups conventional commit types and only links GitHub commit URLs', () => {
  const changelog = buildCommitChangelog({
    repository: { full_name: 'owner/product' }, ref: 'refs/heads/main',
    commits: [
      { id: 'abcdef1234567890', message: 'feat: Export hinzufügen', url: 'https://github.com/owner/product/commit/abcdef1234567890' },
      { id: '1234567890abcdef', message: 'fix: Anmeldung reparieren', url: 'https://evil.example/track' },
      { id: 'deadcafe12345678', message: 'Refactor module' }
    ]
  });
  assert.match(changelog, /owner\/product/);
  assert.match(changelog, /Neue Funktionen/);
  assert.match(changelog, /Fehlerbehebungen/);
  assert.match(changelog, /Dokumentation und Wartung|Weitere Änderungen/);
  assert.match(changelog, /https:\/\/github\.com\/owner\/product\/commit\/abcdef/);
  assert.doesNotMatch(changelog, /evil\.example/);
});

test('Telegram sender omits Markdown, clips long messages and reports API errors', async () => {
  let request;
  const ok = await sendTelegramChangelog('A'.repeat(5000), {
    token: 'bot-token', chatId: '123', fetchFn: async (url, init) => {
      request = { url, init };
      return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 9 } }) };
    }
  });
  assert.equal(ok.sent, true);
  assert.equal(ok.messageId, 9);
  assert.equal(JSON.parse(request.init.body).text.length, 3900);
  assert.equal(JSON.parse(request.init.body).parse_mode, undefined);
  assert.match(request.url, /sendMessage$/);

  const failed = await sendTelegramChangelog('Update', {
    token: 'bot-token', chatId: '123', fetchFn: async () => ({ ok: false, status: 429, json: async () => ({ ok: false, description: 'Too Many Requests' }) })
  });
  assert.deepEqual(failed, { sent: false, reason: 'Too Many Requests' });
  assert.match((await sendTelegramChangelog('Update', { token: '', chatId: '' })).reason, /nicht konfiguriert/);
});
