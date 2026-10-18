#!/usr/bin/env node
/**
 * Legt einen Administrator fuer den VillaForge-Hub an (oder aktualisiert ihn).
 *
 * Nutzung (aus dem Repo-Stammverzeichnis):
 *   node server/scripts/add-admin.mjs <email> <passwort> [--plan elite] [--role admin]
 *
 * Beispiel:
 *   node server/scripts/add-admin.mjs niko.oeben@gmail.com 'MeinSicheresPasswort!'
 *
 * Das Passwort wird NUR als scrypt-Hash in der lokalen Datenbank gespeichert.
 * Es erscheint nicht im Log und wird nicht ins Git uebernommen.
 */
import { upsertUser, publicUser, usersExist } from '../auth.mjs';

const args = process.argv.slice(2);
const positional = args.filter((a) => !a.startsWith('--'));
const flag = (name, fallback) => {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const [email, password] = positional;
if (!email || !password) {
  console.error('Nutzung: node server/scripts/add-admin.mjs <email> <passwort> [--plan elite] [--role admin]');
  process.exit(1);
}
if (String(password).length < 8) {
  console.error('Das Passwort muss mindestens 8 Zeichen haben.');
  process.exit(1);
}

const existed = usersExist();
const u = upsertUser({
  email,
  password,
  role: flag('role', 'admin'),
  plan: flag('plan', 'elite')
});

console.log('OK:', JSON.stringify(publicUser(u), null, 2));
console.log(existed
  ? 'Konto aktualisiert. Passwort steht nur als scrypt-Hash in der Datenbank.'
  : 'Admin-Konto angelegt. Ab jetzt verlangt der Hub einen Login (VF_OPEN_MODE=1 erzwingt den offenen Modus).');
