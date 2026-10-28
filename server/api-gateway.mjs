import { createHmac, createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { db, now } from './db.mjs';
import { redisTrySetNx, redisTryDel } from './redis.mjs';

const ISSUER = 'agentforge2';
const AUDIENCE = 'agentforge2-api';
const ROLE_SCOPES = Object.freeze({
  reader: ['villas:read'],
  operator: ['villas:read', 'villas:write', 'tasks:write'],
  admin: ['villas:read', 'villas:write', 'tasks:write', 'metrics:read', 'billing:read']
});
const b64url = (value) => Buffer.from(value).toString('base64url');

function signingSecret(secret) {
  const value = String(secret ?? process.env.VF_GATEWAY_JWT_SECRET ?? '');
  if (Buffer.byteLength(value) < 32) throw Object.assign(new Error('VF_GATEWAY_JWT_SECRET must contain at least 32 bytes.'), { code: 'JWT_NOT_CONFIGURED', statusCode: 503 });
  return value;
}

export function issueGatewayToken({ subject, role = 'reader', villaIds = [], ttlSeconds = 900 }, secret, nowSeconds = Math.floor(Date.now() / 1000)) {
  const key = signingSecret(secret);
  if (typeof subject !== 'string' || !subject.trim() || subject.length > 180) throw new TypeError('A valid token subject is required.');
  if (!Object.hasOwn(ROLE_SCOPES, role)) throw new TypeError('Role must be reader, operator, or admin.');
  if (!Array.isArray(villaIds) || villaIds.length > 1000 || villaIds.some(id => !Number.isSafeInteger(Number(id)) || Number(id) < 1)) throw new TypeError('villaIds must contain at most 1000 positive integer IDs.');
  if (role !== 'admin' && villaIds.length === 0) throw new TypeError('Non-admin API clients require an explicit villa allowlist.');
  const ttl = Math.max(60, Math.min(3600, Math.trunc(Number(ttlSeconds) || 900)));
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({
    iss: ISSUER, aud: AUDIENCE, sub: subject.trim(), role,
    scopes: ROLE_SCOPES[role], villas: [...new Set(villaIds.map(Number))],
    iat: nowSeconds, exp: nowSeconds + ttl, jti: randomUUID()
  }));
  const input = `${header}.${payload}`;
  return `${input}.${createHmac('sha256', key).update(input).digest('base64url')}`;
}

export function verifyGatewayToken(token, secret, nowSeconds = Math.floor(Date.now() / 1000)) {
  try {
    const key = signingSecret(secret);
    if (typeof token !== 'string' || token.length > 8192) return { ok: false, error: 'invalid_token' };
    const parts = token.split('.');
    if (parts.length !== 3) return { ok: false, error: 'invalid_token' };
    const [headerPart, payloadPart, signaturePart] = parts;
    const header = JSON.parse(Buffer.from(headerPart, 'base64url').toString('utf8'));
    const claims = JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8'));
    if (header.alg !== 'HS256' || header.typ !== 'JWT') return { ok: false, error: 'invalid_algorithm' };
    const expected = createHmac('sha256', key).update(`${headerPart}.${payloadPart}`).digest();
    const supplied = Buffer.from(signaturePart, 'base64url');
    if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) return { ok: false, error: 'invalid_signature' };
    if (claims.iss !== ISSUER || claims.aud !== AUDIENCE || typeof claims.sub !== 'string' || !claims.sub || !Object.hasOwn(ROLE_SCOPES, claims.role)) return { ok: false, error: 'invalid_claims' };
    if (!Number.isSafeInteger(claims.iat) || !Number.isSafeInteger(claims.exp) || claims.iat > nowSeconds + 30 || claims.exp <= nowSeconds || claims.exp - claims.iat > 3600) return { ok: false, error: 'expired_token' };
    if (!Array.isArray(claims.scopes) || claims.scopes.some(scope => !ROLE_SCOPES[claims.role].includes(scope))) return { ok: false, error: 'invalid_scopes' };
    if (!Array.isArray(claims.villas) || claims.villas.some(id => !Number.isSafeInteger(id) || id < 1)) return { ok: false, error: 'invalid_villa_scope' };
    return { ok: true, claims };
  } catch (error) {
    if (error?.code === 'JWT_NOT_CONFIGURED') return { ok: false, error: 'not_configured', statusCode: 503 };
    return { ok: false, error: 'invalid_token' };
  }
}

export async function gatewayPrincipal(req, secret) {
  const keyHeader = String(req?.headers?.['x-api-key'] ?? '');
  if (keyHeader) return await apiKeyPrincipal(keyHeader);
  const header = String(req?.headers?.authorization ?? '');
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match) return { ok: false, error: 'bearer_token_required', statusCode: 401 };
  const verified = verifyGatewayToken(match[1].trim(), secret);
  if (!verified.ok) return { ...verified, statusCode: verified.statusCode || 401 };
  const actor=db.prepare('SELECT id,role FROM users WHERE id=?').get(Number(verified.claims.sub));
  if(!actor || (verified.claims.role==='admin' && actor.role!=='superadmin'))return {ok:false,error:'invalid_token_subject',statusCode:401};
  return verified;
}

export function initGatewayStore() {
  db.exec(`CREATE TABLE IF NOT EXISTS gateway_api_keys (
    id TEXT PRIMARY KEY, key_hash TEXT NOT NULL UNIQUE, user_id INTEGER NOT NULL,
    label TEXT NOT NULL, role TEXT NOT NULL, villas TEXT NOT NULL DEFAULT '[]',
    created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, revoked_at INTEGER,
    last_used_at INTEGER
  ); CREATE INDEX IF NOT EXISTS idx_gateway_keys_user ON gateway_api_keys(user_id,created_at DESC);`);
}
const digestKey = value => createHash('sha256').update(value).digest('hex');
export async function createGatewayApiKey({ userId, label, role='reader', villaIds=[], ttlSeconds=30*86400 }) {
  initGatewayStore();
  if (!Object.hasOwn(ROLE_SCOPES, role)) throw new TypeError('Role must be reader, operator, or admin.');
  if (!Array.isArray(villaIds) || villaIds.length > 1000 || villaIds.some(id => !Number.isSafeInteger(Number(id)) || Number(id)<1)) throw new TypeError('Invalid villa allowlist.');
  if (role !== 'admin' && !villaIds.length) throw new TypeError('Non-admin API keys need a villa allowlist.');
  const raw = `vf_live_${randomBytes(32).toString('base64url')}`, hash=digestKey(raw), id=randomUUID();
  const expiresAt=now()+Math.max(60,Math.min(365*86400,Math.trunc(Number(ttlSeconds)||30*86400)))*1000;
  const row={ id, userId:Number(userId), label:String(label||'API key').slice(0,100), role, villas:[...new Set(villaIds.map(Number))], expiresAt };
  db.prepare('INSERT INTO gateway_api_keys(id,key_hash,user_id,label,role,villas,created_at,expires_at) VALUES (?,?,?,?,?,?,?,?)').run(id,hash,row.userId,row.label,role,JSON.stringify(row.villas),now(),expiresAt);
  await redisTrySetNx(`vf:gateway:key:${hash}`,JSON.stringify(row),Math.ceil((expiresAt-now())/1000));
  return { id, key:raw, label:row.label, role, villas:row.villas, expiresAt };
}
async function apiKeyPrincipal(raw) {
  if (!raw.startsWith('vf_live_') || raw.length > 256) return {ok:false,error:'invalid_api_key',statusCode:401};
  initGatewayStore();
  const hash=digestKey(raw), row=db.prepare('SELECT * FROM gateway_api_keys WHERE key_hash=?').get(hash);
  if (!row || row.revoked_at || Number(row.expires_at)<=now()) return {ok:false,error:'invalid_api_key',statusCode:401};
  if(!db.prepare('SELECT id FROM users WHERE id=?').get(row.user_id))return {ok:false,error:'invalid_api_key',statusCode:401};
  const claims={sub:String(row.user_id), role:row.role, scopes:ROLE_SCOPES[row.role], villas:JSON.parse(row.villas), keyId:row.id};
  if (!row.last_used_at || now()-row.last_used_at>60_000) db.prepare('UPDATE gateway_api_keys SET last_used_at=? WHERE id=?').run(now(),row.id);
  return {ok:true,claims};
}
export function listGatewayApiKeys(userId) { initGatewayStore(); return db.prepare('SELECT id,label,role,villas,created_at,expires_at,revoked_at,last_used_at FROM gateway_api_keys WHERE user_id=? ORDER BY created_at DESC').all(userId).map(r=>({...r,villas:JSON.parse(r.villas)})); }
export async function revokeGatewayApiKey(id,userId,admin=false) { initGatewayStore(); const row=db.prepare('SELECT id,key_hash,user_id FROM gateway_api_keys WHERE id=?').get(id); if(!row||(!admin&&row.user_id!==userId))return false; db.prepare('UPDATE gateway_api_keys SET revoked_at=? WHERE id=? AND revoked_at IS NULL').run(now(),id); await redisTryDel(`vf:gateway:key:${row.key_hash}`); return true; }

export function hasGatewayScope(claims, scope) {
  return !!claims && Array.isArray(claims.scopes) && claims.scopes.includes(scope);
}

export function canAccessVilla(claims, villaId) {
  return claims?.role === 'admin' || claims?.villas?.includes(Number(villaId)) === true;
}

export function gatewayRoleScopes(role) {
  return ROLE_SCOPES[role] ? [...ROLE_SCOPES[role]] : null;
}
