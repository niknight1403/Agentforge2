#!/usr/bin/env node
// Live-Smoke fuer Sprint 8 (Publishing-Sandbox + Revenue-Light) und Sprint 9
// (Rate-Limit-Haertung). Legt eine Wegwerf-Villa an, prueft die Endpunkte und
// loescht die Villa kaskadierend wieder. Keine Secrets in der Ausgabe.
const HUB = process.env.VF_HUB || 'https://hub.cybersarah-ki.com';
const EMAIL = process.env.VF_ADMIN_EMAIL || '';
const PASSWORD = process.env.VF_ADMIN_PASSWORD || '';
const out = { checked_at: new Date().toISOString(), steps: {}, errors: [] };

function record(name, value) {
  out.steps[name] = value;
  console.log(`${name}: ${typeof value === 'string' ? value : JSON.stringify(value)}`);
}

async function call(path, { method = 'GET', token, body, ip, raw = false } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (ip) headers['x-forwarded-for'] = ip;
  let payload;
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
    payload = raw ? body : JSON.stringify(body);
  }
  const res = await fetch(HUB + path, { method, headers, body: payload, signal: AbortSignal.timeout(180000) });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 200) }; }
  return { status: res.status, data };
}

let villaId = null;
let token = null;
try {
  if (!EMAIL || !PASSWORD) throw new Error('Admin-Zugangsdaten fehlen');

  const login = await call('/api/auth/login', { method: 'POST', body: { email: EMAIL, password: PASSWORD } });
  record('login', login.status);
  token = login.data?.token;
  if (!token) throw new Error(`Login fehlgeschlagen (${login.status})`);

  const name = `Sprint-Smoke ${Date.now().toString().slice(-6)}`;
  const created = await call('/api/villas', {
    method: 'POST', token,
    body: { name, idea: 'Ein Ein-Seiten-Smoke-Test fuer Publishing und Revenue.' }
  });
  record('villa_create', created.status);
  villaId = created.data?.villaId || created.data?.id || null;
  if (!villaId) throw new Error(`Villa nicht angelegt: ${JSON.stringify(created.data).slice(0, 300)}`);

  const publish = await call(`/api/villas/${villaId}/publish`, {
    method: 'POST', token, body: { text: 'Smoke-Test Beitrag', platforms: ['x', 'linkedin'] }
  });
  record('publish_post', publish.status);
  const posts = [].concat(publish.data?.posts || publish.data?.post || []);
  const sandboxOk = publish.data?.sandbox === true && posts.length > 0 && posts[0]?.state === 'SANDBOX';
  record('publish_sandbox_state', posts[0]?.state || null);
  if (!sandboxOk) throw new Error(`Publishing-Sandbox nicht bestaetigt: ${JSON.stringify(publish.data).slice(0, 300)}`);

  const list = await call(`/api/villas/${villaId}/publish`, { token });
  record('publish_list', list.status);

  const revenue = await call(`/api/villas/${villaId}/revenue`, { token });
  record('revenue', revenue.status);
  const ideas = revenue.data?.ideas || [];
  record('revenue_idea_count', ideas.length);
  if (ideas.length !== 3 || ideas.some((i) => !(Number(i.price_eur) > 0))) {
    throw new Error(`Revenue-Light unvollstaendig: ${JSON.stringify(revenue.data).slice(0, 300)}`);
  }

  const del = await call(`/api/villas/${villaId}`, { method: 'DELETE', token });
  record('villa_delete', del.status);
  villaId = null;

  const longUrl = `/api/villas?q=${'a'.repeat(2200)}`;
  const urlRes = await call(longUrl);
  record('url_length', urlRes.status);

  const bigBody = JSON.stringify({ text: 'x'.repeat(600 * 1024) });
  const bodyRes = await call('/api/auth/login', {
    method: 'POST', raw: true, body: bigBody, ip: '203.0.113.77'
  });
  record('body_limit', bodyRes.status);

  const burstCodes = [];
  for (let i = 0; i < 24; i += 1) {
    const r = await call('/api/auth/login', {
      method: 'POST', body: { email: 'burst@example.invalid', password: 'x' }, ip: '203.0.113.78'
    });
    burstCodes.push(r.status);
    if (r.status === 429) break;
  }
  record('burst_codes', burstCodes.join(','));

  out.ok = urlRes.status === 414 && bodyRes.status === 413 && burstCodes.includes(429)
    && publish.status === 200 && revenue.status === 200;
} catch (err) {
  out.errors.push(String(err.message || err));
  out.ok = false;
} finally {
  if (villaId) {
    try {
      const cleanup = await call(`/api/villas/${villaId}`, { method: 'DELETE', token });
      record('cleanup_attempt', cleanup.status);
    } catch (err) {
      out.errors.push(`cleanup: ${String(err.message || err)}`);
    }
  }
}

console.log(JSON.stringify(out, null, 2));
if (!out.ok) process.exit(1);
