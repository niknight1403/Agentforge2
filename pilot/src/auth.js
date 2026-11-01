import bcrypt from "bcryptjs";
import { neueSession, neueApiKey, hashKey } from "./db.js";

export const COOKIE = "ap_session";
const SESSION_TAGE = 30;

export function hashPasswort(passwort) {
  return bcrypt.hashSync(String(passwort), 10);
}

export function pruefePasswort(passwort, hash) {
  return bcrypt.compareSync(String(passwort), String(hash));
}

export function emailOk(email) {
  return typeof email === "string" && /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(email.trim());
}

export function legeSessionAn(db, userId) {
  const token = neueSession();
  const expires = Date.now() + SESSION_TAGE * 864e5;
  db.prepare("INSERT INTO sessions(token, user_id, expires_at) VALUES (?,?,?)").run(token, userId, expires);
  return { token, expires };
}

export function sessionNutzer(db, token) {
  if (!token) return null;
  const row = db
    .prepare("SELECT s.token, s.expires_at, u.id, u.email, u.firma FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?")
    .get(token);
  if (!row) return null;
  if (row.expires_at < Date.now()) {
    db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
    return null;
  }
  return row;
}

export function erzeugeApiKey(db, userId) {
  const { raw, prefix, hash } = neueApiKey();
  db.prepare("INSERT INTO api_keys(user_id, prefix, key_hash, created_at) VALUES (?,?,?,?)")
    .run(userId, prefix, hash, Date.now());
  return raw;
}

export function nutzerPerApiKey(db, rawKey) {
  if (!rawKey || !rawKey.startsWith("ap_")) return null;
  const row = db
    .prepare("SELECT k.id AS key_id, k.revoked, u.id, u.email FROM api_keys k JOIN users u ON u.id = k.user_id WHERE k.key_hash = ?")
    .get(hashKey(rawKey));
  if (!row || row.revoked) return null;
  db.prepare("UPDATE api_keys SET last_used_at = ? WHERE id = ?").run(Date.now(), row.key_id);
  return row;
}
