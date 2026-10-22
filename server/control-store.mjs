import { db, now } from './db.mjs';
import https from 'node:https';
import dns from 'node:dns';
import { isIP } from 'node:net';

db.exec(`
CREATE TABLE IF NOT EXISTS control_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS control_skills (id TEXT PRIMARY KEY, title TEXT NOT NULL, instructions TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS control_connectors (id TEXT PRIMARY KEY, title TEXT NOT NULL, endpoint TEXT NOT NULL, secret_env TEXT NOT NULL DEFAULT '', enabled INTEGER NOT NULL DEFAULT 1, last_status TEXT NOT NULL DEFAULT 'configured');
CREATE TABLE IF NOT EXISTS control_tools (name TEXT PRIMARY KEY, enabled INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS control_archives (villa_id INTEGER PRIMARY KEY, canonical_id INTEGER, previous_status TEXT NOT NULL, previous_autonomy INTEGER NOT NULL, archived_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS control_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, role TEXT NOT NULL, content TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS control_turns (request_id TEXT PRIMARY KEY, message TEXT NOT NULL, status TEXT NOT NULL, response TEXT, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS control_dismissals (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL);
`);
export const SETTING_RULES = { defaultAgentCount: [3, 1000, 24], villaSlots: [3, 4, 3], suggestionCount: [1, 8, 4] };
export function getSetting(key, fallback = SETTING_RULES[key]?.[2]) {
  const row = db.prepare('SELECT value FROM control_settings WHERE key=?').get(key);
  const value = row ? JSON.parse(row.value) : fallback;
  // Older installations may have persisted the former 1–2 villa limit.
  // Keep the displayed and effective setting aligned with the supported floor.
  if (key === 'villaSlots') return Math.max(3, Math.min(4, Number(value) || 3));
  return value;
}
export function setSetting(key, value) {
  const rule = SETTING_RULES[key];
  if (!rule || !Number.isInteger(value) || value < rule[0] || value > rule[1]) throw new Error(`Ungültige Einstellung: ${key}`);
  db.prepare('INSERT OR REPLACE INTO control_settings VALUES (?,?)').run(key, JSON.stringify(value));
  return { key, value };
}
export function toolEnabled(name) { return db.prepare('SELECT enabled FROM control_tools WHERE name=?').get(name)?.enabled !== 0; }
export function skillInstructions() {
  return db.prepare('SELECT title, instructions FROM control_skills WHERE enabled=1 ORDER BY id').all()
    .map(s => `${s.title}: ${s.instructions}`).join('\n').slice(0, 12000);
}
export function controlCatalog() {
  return {
    settings: Object.fromEntries(Object.keys(SETTING_RULES).map(k => [k, getSetting(k)])),
    skills: db.prepare('SELECT * FROM control_skills ORDER BY id').all(),
    connectors: db.prepare('SELECT id,title,endpoint,secret_env,enabled,last_status FROM control_connectors ORDER BY id').all(),
    toolOverrides: db.prepare('SELECT * FROM control_tools').all()
  };
}
export function validEndpoint(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') || !url.hostname.includes('.') || /localhost|\.local$|\.internal$/i.test(url.hostname) || isIP(url.hostname.replace(/[\[\]]/g, ''))) throw new Error('Connector benötigt einen öffentlichen HTTPS-Host ohne Zugangsdaten in der URL.');
  url.hash = '';
  if (url.search) throw new Error('Keine Zugangsdaten oder Parameter in der Connector-URL; nutze eine Secret-Referenz.');
  return url.toString();
}
export function publicAddress(ip) {
  if (isIP(ip) === 4) {
    const [a,b] = ip.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && [0,168].includes(b) || a === 100 && b >= 64 && b <= 127 || a === 198 && [18,19,51].includes(b) || a === 203 && b === 0 || a >= 224);
  }
  return isIP(ip) === 6 && /^[23]/i.test(ip) && !/^2001:db8:/i.test(ip);
}
/** GET-only JSON adapter. DNS is checked at the socket lookup; redirects are never followed. */
export async function readConnector(id) {
  const c = db.prepare('SELECT * FROM control_connectors WHERE id=? AND enabled=1').get(id);
  if (!c) throw new Error('Connector fehlt oder ist deaktiviert.');
  const endpoint = validEndpoint(c.endpoint);
  const headers = { Accept: 'application/json', 'User-Agent': 'VillaForge-Master/1' };
  if (c.secret_env) {
    const secret = db.prepare('SELECT value FROM secrets WHERE name=?').get(c.secret_env)?.value || process.env[c.secret_env];
    if (!secret) throw new Error(`Secret ${c.secret_env} ist noch nicht hinterlegt.`);
    headers.Authorization = `Bearer ${secret}`;
  }
  try {
    const result = await new Promise((resolve, reject) => {
      const req = https.get(endpoint, { headers, signal: AbortSignal.timeout(8000), lookup(host, options, callback) {
        dns.lookup(host, { all: true }, (error, addresses) => {
          if (error) return callback(error);
          if (!addresses.length || addresses.some(a => !publicAddress(a.address))) return callback(new Error('Privates Netzwerk ist für Connectoren gesperrt.'));
          const chosen = addresses.find(a => a.family === 4) || addresses[0];
          callback(null, options?.all ? [chosen] : chosen.address, chosen.family);
        });
      } }, res => {
        if (res.statusCode < 200 || res.statusCode >= 300) { res.resume(); reject(new Error(`Connector antwortet mit HTTP ${res.statusCode}`)); return; }
        if (!String(res.headers['content-type']).includes('json')) { res.resume(); reject(new Error('Connector liefert kein JSON.')); return; }
        let body = ''; let bytes = 0;
        res.on('data', chunk => { bytes += chunk.length; if (bytes > 64000) req.destroy(new Error('Connector-Antwort zu groß.')); else body += chunk; });
        res.on('end', () => { try { resolve(JSON.parse(body)); } catch { reject(new Error('Ungültige JSON-Antwort.')); } });
        res.on('error', reject);
      });
      req.on('error', reject);
    });
    db.prepare("UPDATE control_connectors SET last_status='connected' WHERE id=?").run(id);
    return result;
  } catch (error) {
    db.prepare("UPDATE control_connectors SET last_status='error' WHERE id=?").run(id);
    throw error;
  }
}
export function recordControl(role, content) {
  db.prepare('INSERT INTO control_messages(role,content,created_at) VALUES (?,?,?)').run(role, String(content).slice(0, 20000), now());
}
