import { randomBytes, scryptSync } from 'node:crypto';
import { db, now } from './db.mjs';

/**
 * Erstellt den initialen Superadmin ausschliesslich mit explizit gesetzten
 * Deployment-Secrets. Bestehende Passwoerter werden bei Neustarts nie ersetzt.
 */
export function ensureSuperadmin() {
  const email = String(process.env.VF_ADMIN_EMAIL || '').trim().toLowerCase();
  const password = String(process.env.VF_ADMIN_PASSWORD || '');
  if (!email || !password) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || password.length < 12) {
    throw new Error('VF_ADMIN_EMAIL muss gueltig sein und VF_ADMIN_PASSWORD mindestens 12 Zeichen haben.');
  }

  const t = now();
  const existing = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (existing) {
    db.prepare(`
      UPDATE users
      SET role = 'SUPERADMIN', is_unlimited = 1, token_budget = 'UNLIMITED', updated_at = ?
      WHERE id = ?
    `).run(t, existing.id);
  } else {
    const salt = randomBytes(16).toString('hex');
    const hash = scryptSync(password, salt, 64, { N: 16384 }).toString('hex');
    const pwhash = `scrypt$16384$${salt}$${hash}`;
    db.prepare(`
      INSERT INTO users (email, role, plan, is_unlimited, token_budget, pwhash, password_hash, tokens_used, tokens_reset_at, created_at, updated_at)
      VALUES (?, 'SUPERADMIN', 'elite', 1, 'UNLIMITED', ?, ?, 0, ?, ?, ?)
    `).run(email, pwhash, pwhash, t, t, t);
  }
  return db.prepare('SELECT * FROM users WHERE email = ?').get(email);
}

if (process.argv[1]?.endsWith('seed.mjs')) {
  const admin = ensureSuperadmin();
  console.log(admin ? '[seed] Superadmin aus Deployment-Secrets initialisiert.' : '[seed] Kein Admin angelegt: VF_ADMIN_EMAIL/VF_ADMIN_PASSWORD fehlen.');
}
