/**
 * Auth & Nutzer fuer VillaForge.
 *
 * Prinzipien:
 * - Passwoerter werden NIE im Klartext gespeichert, nur als scrypt-Hash
 *   mit zufaelligem Salt (Format: scrypt$salt$hash oder scrypt$N$salt$hash).
 * - Sessions: zufaelliger Token an den Client (signiert mit API_TOKEN/SECRET),
 *   in der DB liegt nur der SHA-256-Hash des Tokens.
 * - AsyncLocalStorage: Der aktuelle Nutzer haengt am Request-Kontext.
 */
import { randomBytes, scryptSync, timingSafeEqual, createHash, createHmac } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { db, now } from './db.mjs';
import { ensureSuperadmin } from './seed.mjs';

export { ensureSuperadmin };

/** Kontext des aktuellen Nutzers (oder null = ohne Login / Hintergrundlauf). */
export const userStore = new AsyncLocalStorage();

const SESSION_DAYS = 30;
export const FREE_DAILY_TOKENS = 250_000; // Free-Plan: Tokens pro Kalendertag

/* --------------------------- Passworthashes --------------------------- */

export function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(String(password), salt, 64, { N: 16384 }).toString('hex');
  return `scrypt$16384$${salt}$${hash}`;
}

export function verifyPassword(password, stored) {
  if (!stored) return false;
  const parts = String(stored).split('$');
  if (parts.length === 3 && parts[0] === 'scrypt') {
    const [, salt, hash] = parts;
    try {
      const target = Buffer.from(hash, 'hex');
      const check = scryptSync(String(password), salt, target.length);
      return check.length === target.length && timingSafeEqual(check, target);
    } catch {
      return false;
    }
  }
  if (parts.length === 4 && parts[0] === 'scrypt') {
    const [, nStr, salt, hash] = parts;
    const N = parseInt(nStr, 10);
    try {
      const target = Buffer.from(hash, 'hex');
      const check = scryptSync(String(password), salt, target.length, { N: isNaN(N) || N <= 0 ? 16384 : N });
      return check.length === target.length && timingSafeEqual(check, target);
    } catch {
      return false;
    }
  }
  return false;
}

/* --------------------------- Nutzer --------------------------- */

export function usersExist() {
  return db.prepare('SELECT COUNT(*) c FROM users').get().c > 0;
}

export function findUser(email) {
  return db.prepare('SELECT * FROM users WHERE email = ?').get(String(email || '').toLowerCase());
}

/** Legt einen Nutzer an. Wirft bei doppelter E-Mail (UNIQUE). */
export function createUser({ email, password, role = 'user', plan = 'free', isUnlimited = false }) {
  if (!email || !password || String(password).length < 8) {
    throw new Error('E-Mail und Passwort (mindestens 8 Zeichen) sind noetig.');
  }
  const t = now();
  const hp = hashPassword(password);
  db.prepare(
    'INSERT INTO users (email, pwhash, password_hash, role, plan, tokens_used, tokens_reset_at, created_at, updated_at, is_unlimited, token_budget) VALUES (?,?,?,?,?,?,?,?,?,?,?)'
  ).run(String(email).toLowerCase(), hp, hp, role, plan, 0, t, t, t, isUnlimited ? 1 : 0, isUnlimited ? 'UNLIMITED' : 'DEFAULT');
  return findUser(email);
}

/** Legt an oder aktualisiert (Passwort/Plan/Rolle), ohne den Tokenverbrauch anzufassen. */
export function upsertUser({ email, password, role, plan, isUnlimited }) {
  const row = findUser(email);
  if (!row) return createUser({ email, password, role, plan, isUnlimited: Boolean(isUnlimited) });
  const sets = [];
  const args = [];
  const t = now();
  const currentHash = row.pwhash || row.password_hash;
  const passwordChanged = Boolean(password) && !verifyPassword(password, currentHash);
  if (passwordChanged) {
    const hp = hashPassword(password);
    sets.push('pwhash = ?', 'password_hash = ?');
    args.push(hp, hp);
  }
  if (role) { sets.push('role = ?'); args.push(role); }
  if (plan) { sets.push('plan = ?'); args.push(plan); }
  if (isUnlimited !== undefined) { sets.push('is_unlimited = ?'); args.push(isUnlimited ? 1 : 0); }
  if (isUnlimited) { sets.push("token_budget = 'UNLIMITED'"); }
  sets.push('updated_at = ?');
  args.push(t);
  if (passwordChanged) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(row.id);
  if (sets.length) db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...args, row.id);
  return db.prepare('SELECT * FROM users WHERE id = ?').get(row.id);
}

export function publicUser(row) {
  if (!row) return null;
  const isUnl = Number(row.is_unlimited) === 1 || String(row.role || '').toUpperCase() === 'SUPERADMIN' || quotaLeft(row) === Infinity;
  return {
    id: row.id,
    email: row.email,
    role: row.role,
    plan: row.plan || 'free',
    tokens_used: row.tokens_used || 0,
    unlimited: isUnl,
    isUnlimited: isUnl,
    tokenBudget: isUnl ? 'UNLIMITED' : (row.token_budget || 'DEFAULT')
  };
}

/* --------------------------- Helper: isAdmin --------------------------- */

export function isAdmin(req) {
  if (!req) return false;
  const user = req.user || userForRequest(req) || userStore.getStore();
  if (!user) return false;
  const role = String(user.role || '').toUpperCase();
  return role === 'ADMIN' || role === 'SUPERADMIN' || Number(user.is_unlimited) === 1 || user.token_budget === 'UNLIMITED';
}

/* --------------------------- Sessions --------------------------- */

export function createSession(userId, ttlMs = 24 * 3600 * 1000) {
  const secret = process.env.API_TOKEN || process.env.SECRET || process.env.VF_SECRET || process.env.VF_GATEWAY_JWT_SECRET || 'agentforge-secret-key-32-bytes-min';
  const tokenRaw = randomBytes(32).toString('base64url');
  const sig = createHmac('sha256', secret).update(`${userId}:${tokenRaw}`).digest('base64url');
  const token = `${tokenRaw}.${sig}`;
  const tokenHash = createHash('sha256').update(token).digest('hex');
  const t = now();
  db.prepare('DELETE FROM sessions WHERE user_id = ? AND expires_at < ?').run(userId, t);
  db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?,?,?,?)')
    .run(tokenHash, userId, t, t + ttlMs);
  return token;
}

export function userForToken(token) {
  if (!token) return null;
  const tokenHash = createHash('sha256').update(token).digest('hex');
  const row = db.prepare(
    'SELECT u.*, s.expires_at AS session_expires_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?'
  ).get(tokenHash);
  if (!row) return null;
  if (Number(row.session_expires_at) < now()) {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
    return null;
  }
  return row;
}

/* ---- Login-Bremse (Brute-Force-Schutz, In-Memory) ---- */
const LOGIN_MAX_FAILURES = 5;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_BLOCK_MS = 15 * 60 * 1000;
const loginFailures = new Map();

/** Verbleibende Sperrzeit in ms fuer einen Schluessel (E-Mail|IP). */
export function loginBlockedFor(key, at = now()) {
  const e = loginFailures.get(key);
  if (!e) return 0;
  return e.blockedUntil > at ? e.blockedUntil - at : 0;
}

/** Fehlversuch zaehlen; ab LOGIN_MAX_FAILURES im Fenster wird gesperrt. */
export function recordLoginFailure(key, at = now()) {
  const e = loginFailures.get(key) || { count: 0, first: at, blockedUntil: 0 };
  if (at - e.first > LOGIN_WINDOW_MS) { e.count = 0; e.first = at; }
  e.count += 1;
  if (e.count >= LOGIN_MAX_FAILURES) { e.blockedUntil = at + LOGIN_BLOCK_MS; e.count = 0; e.first = at; }
  loginFailures.set(key, e);
  return { count: e.count, blockedUntil: e.blockedUntil };
}

export function clearLoginFailures(key) { loginFailures.delete(key); }

export function userForRequest(req) {
  if (!req) return null;
  const header = String(req.headers?.authorization || '');
  if (!header.startsWith('Bearer ')) return null;
  return userForToken(header.slice(7).trim());
}

export function destroyToken(token) {
  if (!token) return;
  const tokenHash = createHash('sha256').update(token).digest('hex');
  db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
}

/* --------------------------- Kontingent --------------------------- */

/** SUPERADMIN/Elite/Admin/Unlimited = unbegrenzt (Infinity), Free = Tageskontingent. */
export function quotaLeft(user) {
  if (!user) return 0;
  const role = String(user.role || '').toUpperCase();
  if (
    role === 'SUPERADMIN' ||
    role === 'ADMIN' ||
    user.plan === 'elite' ||
    Number(user.is_unlimited) === 1 ||
    user.token_budget === 'UNLIMITED'
  ) {
    return Infinity;
  }
  const t = now();
  const limit = Math.max(1, Number(user.token_budget) || FREE_DAILY_TOKENS);
  if (t - Number(user.tokens_reset_at || 0) > 86_400_000) return limit;
  return Math.max(0, limit - Number(user.tokens_used || 0));
}

/** Zaehlt Verbrauch; rollt das Kontingent bei Tageswechsel automatisch um. */
export function chargeTokens(userId, n) {
  if (!userId || !(Number(n) > 0)) return;
  const t = now();
  const row = db.prepare('SELECT tokens_used, tokens_reset_at FROM users WHERE id = ?').get(userId);
  if (!row) return;
  if (t - Number(row.tokens_reset_at || 0) > 86_400_000) {
    db.prepare('UPDATE users SET tokens_used = ?, tokens_reset_at = ? WHERE id = ?').run(Math.round(n), t, userId);
  } else {
    db.prepare('UPDATE users SET tokens_used = tokens_used + ? WHERE id = ?').run(Math.round(n), userId);
  }
  import('./billing.mjs').then(({enqueueStripeUsage})=>enqueueStripeUsage(userId,n)).catch(()=>{});
}
