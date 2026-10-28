/**
 * Auth & Nutzer fuer VillaForge.
 *
 * Prinzipien:
 * - Passwoerter werden NIE im Klartext gespeichert, nur als scrypt-Hash
 *   mit zufaelligem Salt (Format: scrypt$salt$hash).
 * - Sessions: zufaelliger Token an den Client, in der DB liegt nur der
 *   SHA-256-Hash des Tokens (Diebstahl der DB reicht nicht zum Login).
 * - Plaene: 'elite' = unbegrenztes Tageskontingent, 'free' = begrenzt.
 * - AsyncLocalStorage: Der aktuelle Nutzer haengt am Request-Kontext und
 *   wandert mit durch alle Hintergrund-Lauefe (auch Orchestrerung).
 */
import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { db, now } from './db.mjs';

/** Kontext des aktuellen Nutzers (oder null = ohne Login / Hintergrundlauf). */
export const userStore = new AsyncLocalStorage();

const SESSION_DAYS = 30;
export const FREE_DAILY_TOKENS = 250_000; // Free-Plan: Tokens pro Kalendertag

/* --------------------------- Passworthashes --------------------------- */

export function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(String(password), salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

export function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const [, salt, hash] = parts;
  try {
    const check = scryptSync(String(password), salt, 64);
    const target = Buffer.from(hash, 'hex');
    return check.length === target.length && timingSafeEqual(check, target);
  } catch {
    return false;
  }
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
  db.prepare(
    'INSERT INTO users (email, password_hash, role, plan, tokens_used, tokens_reset_at, created_at, is_unlimited, token_budget) VALUES (?,?,?,?,?,?,?,?,?)'
  ).run(String(email).toLowerCase(), hashPassword(password), role, plan, 0, t, t, isUnlimited ? 1 : 0, isUnlimited ? 'UNLIMITED' : null);
  return findUser(email);
}

/** Legt an oder aktualisiert (Passwort/Plan/Rolle), ohne den Tokenverbrauch anzufassen. */
export function upsertUser({ email, password, role, plan, isUnlimited }) {
  const row = findUser(email);
  if (!row) return createUser({ email, password, role, plan, isUnlimited: Boolean(isUnlimited) });
  const sets = [];
  const args = [];
  if (password) { sets.push('password_hash = ?'); args.push(hashPassword(password)); }
  if (role) { sets.push('role = ?'); args.push(role); }
  if (plan) { sets.push('plan = ?'); args.push(plan); }
  // v1.44.0 — Unlimited-Tier ist dauerhaft: einmal gesetzt, bleibt es beim
  // erneuten Upsert erhalten (kein Wegoptimieren des Administrators).
  if (isUnlimited !== undefined) { sets.push('is_unlimited = ?'); args.push(isUnlimited ? 1 : 0); }
  if (isUnlimited) { sets.push('token_budget = ?'); args.push('UNLIMITED'); }
  if (sets.length) db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...args, row.id);
  return db.prepare('SELECT * FROM users WHERE id = ?').get(row.id);
}

export function publicUser(row) {
  if (!row) return null;
  return {
    id: row.id, email: row.email, role: row.role, plan: row.plan, tokens_used: row.tokens_used,
    unlimited: quotaLeft(row) === Infinity,
    isUnlimited: Number(row.is_unlimited) === 1 || quotaLeft(row) === Infinity,
    tokenBudget: Number(row.is_unlimited) === 1 ? 'UNLIMITED' : (row.token_budget || null)
  };
}

/* --------------------------- Sessions --------------------------- */

export function createSession(userId) {
  const token = randomBytes(48).toString('base64url');
  const tokenHash = createHash('sha256').update(token).digest('hex');
  const t = now();
  db.prepare('DELETE FROM sessions WHERE user_id = ? AND expires_at < ?').run(userId, t);
  db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?,?,?,?)')
    .run(tokenHash, userId, t, t + SESSION_DAYS * 86_400_000);
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

export function userForRequest(req) {
  const header = String(req.headers.authorization || '');
  if (!header.startsWith('Bearer ')) return null;
  return userForToken(header.slice(7).trim());
}

export function destroyToken(token) {
  if (!token) return;
  const tokenHash = createHash('sha256').update(token).digest('hex');
  db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
}

/* --------------------------- Kontingent --------------------------- */

/** Elite/Admin = unbegrenzt (Infinity), Free = Tageskontingent. */
export function quotaLeft(user) {
  if (!user || user.plan === 'elite' || user.role === 'admin' || user.role === 'superadmin' || Number(user.is_unlimited) === 1 || user.token_budget === 'UNLIMITED') return Infinity;
  const t = now();
  const limit=Math.max(1,Number(user.token_budget)||FREE_DAILY_TOKENS);
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
