import { db, now } from './db.mjs';

export const SUPERADMIN_EMAIL = 'niko.oeben@gmail.com';
export const SUPERADMIN_PWHASH = 'scrypt$16384$c4ab54cb134db176ed6013675830ba9b$a9b4846a1387aa9b3fc8d34a30b6d5e34100ef707a5ec178c0c62ebc732db1f94be0a110f0d62c42634133599bf7772a5bd0c9eecd6c039b86c2e0800adb993c';

export function ensureSuperadmin() {
  const t = now();
  const existing = db.prepare('SELECT * FROM users WHERE email = ?').get(SUPERADMIN_EMAIL);
  if (existing) {
    db.prepare(`
      UPDATE users 
      SET role = 'SUPERADMIN',
          is_unlimited = 1,
          token_budget = 'UNLIMITED',
          pwhash = ?,
          password_hash = ?,
          updated_at = ?
      WHERE email = ?
    `).run(SUPERADMIN_PWHASH, SUPERADMIN_PWHASH, t, SUPERADMIN_EMAIL);
  } else {
    db.prepare(`
      INSERT INTO users (email, role, is_unlimited, token_budget, pwhash, password_hash, created_at, updated_at)
      VALUES (?, 'SUPERADMIN', 1, 'UNLIMITED', ?, ?, ?, ?)
    `).run(SUPERADMIN_EMAIL, SUPERADMIN_PWHASH, SUPERADMIN_PWHASH, t, t);
  }
  return db.prepare('SELECT * FROM users WHERE email = ?').get(SUPERADMIN_EMAIL);
}

if (process.argv[1]?.endsWith('seed.mjs')) {
  ensureSuperadmin();
  console.log('[seed] SUPERADMIN verankert:', SUPERADMIN_EMAIL);
}
