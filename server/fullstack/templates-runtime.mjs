/**
 * Bausteine der generierten Anwendung: Laufzeit ohne Fremdabhaengigkeiten.
 *
 * Warum ohne Express/Prisma-Client im Kern: eine generierte App muss sich in
 * einer abgeschotteten Sandbox (kein Netz, kein npm install) pruefen lassen.
 * Der Kern laeuft deshalb nur mit node:-Modulen; Express-Kompatibilitaet,
 * Prisma-Schema und React-Oberflaeche werden zusaetzlich als vollstaendige
 * Dateien erzeugt und in Stufe 2 (mit Netz) installiert und gebaut.
 *
 * Jede Datei hier ist reiner Text. Erzeugt wird nichts durch Ausfuehren von
 * Fremdcode, nur durch Schreiben validierter Vorlagen.
 */

export const HTTP_TEMPLATE = `export class HttpError extends Error {
  constructor(status, code, message, details) {
    super(message || code);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function json(res, status, body) {
  const payload = body === null || body === undefined ? null : JSON.stringify(body);
  const headers = { 'content-type': 'application/json; charset=utf-8' };
  if (payload !== null) headers['content-length'] = String(Buffer.byteLength(payload));
  res.writeHead(status, headers);
  res.end(payload === null ? undefined : payload);
}

export async function readJsonBody(req, limit = 1000000) {
  if (req.method === 'GET' || req.method === 'DELETE') return {};
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, 'PAYLOAD_TOO_LARGE', 'Der Anfragekoerper ist zu gross.');
    chunks.push(chunk);
  }
  if (!size) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new HttpError(400, 'INVALID_JSON', 'Der Anfragekoerper ist kein gueltiges JSON.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new HttpError(400, 'INVALID_JSON', 'Erwartet wird ein JSON-Objekt.');
  return parsed;
}

export function serverErrorPayload() {
  return { error: { code: 'INTERNAL', message: 'Interner Fehler. Bitte spaeter erneut versuchen.' } };
}
`;

export const ROUTER_TEMPLATE = `function matchPattern(pattern, pathname) {
  const wanted = pattern.split('/').filter(Boolean);
  const actual = pathname.split('/').filter(Boolean);
  if (wanted.length !== actual.length) return null;
  const params = {};
  for (let index = 0; index < wanted.length; index += 1) {
    const part = wanted[index];
    if (part.startsWith(':')) {
      if (!actual[index]) return null;
      params[part.slice(1)] = decodeURIComponent(actual[index]);
    } else if (part !== actual[index]) {
      return null;
    }
  }
  return params;
}

/**
 * Minimaler Router: Schritte laufen in Reihenfolge, der letzte Schritt mit
 * Rueckgabewert beantwortet die Anfrage. Waechter werfen HttpError und brechen ab.
 */
export function createRouter() {
  const routes = [];
  const add = (method, pattern, handlers) => {
    routes.push({ method, pattern, handlers: Array.isArray(handlers) ? handlers : [handlers] });
  };
  const api = {
    get: (pattern, ...handlers) => add('GET', pattern, handlers),
    post: (pattern, ...handlers) => add('POST', pattern, handlers),
    patch: (pattern, ...handlers) => add('PATCH', pattern, handlers),
    delete: (pattern, ...handlers) => add('DELETE', pattern, handlers),
    routes: () => routes.map(route => ({ method: route.method, pattern: route.pattern, steps: route.handlers.length })),
    async handle(ctx) {
      for (const route of routes) {
        if (route.method !== ctx.method) continue;
        const params = matchPattern(route.pattern, ctx.pathname);
        if (!params) continue;
        ctx.params = params;
        for (const step of route.handlers) {
          const result = await step(ctx);
          if (result && typeof result === 'object') return result;
        }
        return { status: 204, body: null };
      }
      return null;
    },
  };
  return api;
}
`;

export const QUERY_TEMPLATE = `/** Listenfenster mit harten Grenzen: kein Client kann die API unbegrenzt abfragen. */
export function queryWindow(ctx, options = {}) {
  const defaultLimit = Number(options.defaultLimit || 50);
  const maxLimit = Number(options.maxLimit || 100);
  const requested = Number(ctx.query && ctx.query.get ? ctx.query.get('limit') : NaN);
  const offsetValue = Number(ctx.query && ctx.query.get ? ctx.query.get('offset') : NaN);
  const limit = Math.min(maxLimit, Math.max(1, Number.isFinite(requested) ? Math.trunc(requested) : defaultLimit));
  const offset = Math.max(0, Number.isFinite(offsetValue) ? Math.trunc(offsetValue) : 0);
  return { limit, offset };
}
`;

export const VALIDATE_TEMPLATE = `import { HttpError } from './http.mjs';

const EMAIL = /^[^\\s@]+@[^\\s@]+\\.[^\\s@]{2,}$/;
const DATE = /^\\d{4}-\\d{2}-\\d{2}(?:[T ]\\d{2}:\\d{2}(?::\\d{2}(?:\\.\\d{1,3})?)?(?:Z|[+-]\\d{2}:?\\d{2})?)?$/;

function checkText(name, rule, value) {
  if (typeof value !== 'string') return name + ' muss Text sein.';
  const trimmed = value.trim();
  if (rule.min !== undefined && trimmed.length < rule.min) return name + ' braucht mindestens ' + rule.min + ' Zeichen.';
  if (rule.max !== undefined && trimmed.length > rule.max) return name + ' darf hoechstens ' + rule.max + ' Zeichen haben.';
  if (rule.type === 'email' && !EMAIL.test(trimmed)) return name + ' ist keine gueltige E-Mail-Adresse.';
  return null;
}

function coerce(name, rule, raw) {
  if (rule.type === 'string' || rule.type === 'text' || rule.type === 'email') return checkText(name, rule, raw) || null;
  if (rule.type === 'integer') {
    const value = Number(raw);
    if (!Number.isFinite(value) || !Number.isInteger(value)) return name + ' muss eine ganze Zahl sein.';
    if (rule.min !== undefined && value < rule.min) return name + ' muss mindestens ' + rule.min + ' sein.';
    if (rule.max !== undefined && value > rule.max) return name + ' darf hoechstens ' + rule.max + ' sein.';
    return null;
  }
  if (rule.type === 'decimal') {
    const value = Number(raw);
    if (!Number.isFinite(value)) return name + ' muss eine Zahl sein.';
    if (rule.min !== undefined && value < rule.min) return name + ' muss mindestens ' + rule.min + ' sein.';
    return null;
  }
  if (rule.type === 'boolean') {
    if (typeof raw !== 'boolean') return name + ' muss wahr oder falsch sein.';
    return null;
  }
  if (rule.type === 'datetime') {
    if (typeof raw !== 'string' || !DATE.test(raw.trim())) return name + ' muss ein Datum (YYYY-MM-DD) sein.';
    return null;
  }
  if (rule.type === 'enum') {
    if (!Array.isArray(rule.values) || !rule.values.includes(raw)) return name + ' muss einer der Werte sein: ' + (rule.values || []).join(', ') + '.';
    return null;
  }
  return name + ' hat einen unbekannten Typ.';
}

function convert(rule, raw) {
  if (rule.type === 'string' || rule.type === 'text' || rule.type === 'email') return raw.trim();
  if (rule.type === 'integer' || rule.type === 'decimal') return Number(raw);
  if (rule.type === 'boolean') return raw === true;
  return raw;
}

/**
 * Prueft Eingaben gegen das erzeugte Schema. Wirft 400 mit Felddetails, damit
 * die Oberflaeche jeden Fehler am richtigen Feld anzeigen kann.
 */
export function validatePayload(schema, input, options = {}) {
  const partial = options.partial === true;
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const errors = {};
  const value = {};
  for (const name of Object.keys(schema)) {
    const rule = schema[name];
    const present = Object.prototype.hasOwnProperty.call(source, name);
    if (!present) {
      if (rule.required === true && !partial) errors[name] = name + ' ist erforderlich.';
      continue;
    }
    const raw = source[name];
    if (raw === null || raw === undefined || raw === '') {
      if (rule.required === true) errors[name] = name + ' darf nicht leer sein.';
      else value[name] = null;
      continue;
    }
    const message = coerce(name, rule, raw);
    if (message) {
      errors[name] = message;
      continue;
    }
    value[name] = convert(rule, raw);
  }
  if (Object.keys(errors).length) {
    throw new HttpError(400, 'VALIDATION_FAILED', 'Die Eingaben sind unvollstaendig oder ungueltig.', errors);
  }
  return value;
}
`;

export const PASSWORD_TEMPLATE = `import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback);
const KEY_LENGTH = 64;
const PARAMS = { N: 16384, r: 8, p: 1 };

/**
 * Passworthashing ohne native Abhaengigkeit: scrypt aus node:crypto.
 * bcrypt waere im Betrieb ebenfalls moeglich; scrypt ist hier bewusst gesetzt,
 * weil es ohne Kompilierung in jeder Sandbox laeuft und als KDF gleichwertig ist.
 */
export async function hashPassword(plain) {
  if (typeof plain !== 'string' || plain.length < 8) {
    throw Object.assign(new Error('Das Passwort braucht mindestens 8 Zeichen.'), { code: 'WEAK_PASSWORD' });
  }
  const salt = randomBytes(16);
  const derived = await scrypt(plain, salt, KEY_LENGTH, PARAMS);
  return ['scrypt', PARAMS.N, PARAMS.r, PARAMS.p, salt.toString('base64url'), derived.toString('base64url')].join('$');
}

export async function verifyPassword(plain, stored) {
  if (typeof plain !== 'string' || typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const expected = Buffer.from(parts[5], 'base64url');
  if (!expected.length) return false;
  const derived = await scrypt(plain, Buffer.from(parts[4], 'base64url'), expected.length, { N: Number(parts[1]), r: Number(parts[2]), p: Number(parts[3]) });
  return expected.length === derived.length && timingSafeEqual(expected, derived);
}
`;

export const JWT_TEMPLATE = `import { createHmac, timingSafeEqual } from 'node:crypto';

const ALGORITHM = 'HS256';

function encode(value) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function sign(data, secret) {
  return createHmac('sha256', secret).update(data).digest('base64url');
}

function fail(code, message) {
  return Object.assign(new Error(message), { code });
}

/** HS256-Token. Die Kopfzeile wird beim Pruefen strikt auf HS256 festgelegt. */
export function createToken(payload, secret, options = {}) {
  if (typeof secret !== 'string' || secret.length < 32) throw fail('JWT_SECRET_INVALID', 'JWT_SECRET braucht mindestens 32 Zeichen.');
  const now = Number.isFinite(options.now) ? options.now : Math.floor(Date.now() / 1000);
  const ttl = Math.max(60, Math.trunc(Number(options.expiresInSeconds) || 43200));
  const body = Object.assign({}, payload, { iat: now, exp: now + ttl });
  const data = encode({ alg: ALGORITHM, typ: 'JWT' }) + '.' + encode(body);
  return data + '.' + sign(data, secret);
}

export function verifyToken(token, secret, options = {}) {
  if (typeof token !== 'string' || !token) throw fail('TOKEN_MISSING', 'Kein Token uebergeben.');
  if (typeof secret !== 'string' || secret.length < 32) throw fail('JWT_SECRET_INVALID', 'JWT_SECRET braucht mindestens 32 Zeichen.');
  const parts = token.split('.');
  if (parts.length !== 3) throw fail('TOKEN_MALFORMED', 'Der Token ist unvollstaendig.');
  let header;
  try {
    header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
  } catch {
    throw fail('TOKEN_MALFORMED', 'Der Token-Kopf ist nicht lesbar.');
  }
  if (!header || header.alg !== ALGORITHM) throw fail('TOKEN_ALGORITHM', 'Nur HS256 wird akzeptiert.');
  const expected = Buffer.from(sign(parts[0] + '.' + parts[1], secret), 'utf8');
  const actual = Buffer.from(parts[2], 'utf8');
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw fail('TOKEN_SIGNATURE', 'Die Signatur passt nicht.');
  let claims;
  try {
    claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    throw fail('TOKEN_MALFORMED', 'Der Token-Inhalt ist nicht lesbar.');
  }
  const now = Number.isFinite(options.now) ? options.now : Math.floor(Date.now() / 1000);
  if (typeof claims.exp !== 'number' || claims.exp <= now) throw fail('TOKEN_EXPIRED', 'Die Sitzung ist abgelaufen.');
  return claims;
}
`;

export const MIDDLEWARE_TEMPLATE = `import { HttpError } from '../lib/http.mjs';
import { verifyToken } from '../lib/jwt.mjs';

/** Anmeldung und Rollenpruefung. Jede geschuetzte Route laeuft durch beide. */
export function createAuthMiddleware(options) {
  const secret = options && options.secret;
  async function authenticate(ctx) {
    const header = String(ctx.req.headers.authorization || '');
    const match = /^Bearer\\s+(.+)$/i.exec(header);
    if (!match) throw new HttpError(401, 'UNAUTHENTICATED', 'Anmeldung erforderlich.');
    let claims;
    try {
      claims = verifyToken(match[1].trim(), secret);
    } catch {
      throw new HttpError(401, 'UNAUTHENTICATED', 'Die Sitzung ist abgelaufen oder ungueltig.');
    }
    const user = ctx.store.get('users', String(claims.sub || ''));
    if (!user) throw new HttpError(401, 'UNAUTHENTICATED', 'Der Benutzer existiert nicht mehr.');
    ctx.user = { id: user.id, name: user.name, email: user.email, role: user.role };
  }
  const requireRole = (...roles) => async (ctx) => {
    if (!ctx.user) throw new HttpError(401, 'UNAUTHENTICATED', 'Anmeldung erforderlich.');
    if (!roles.includes(ctx.user.role)) throw new HttpError(403, 'FORBIDDEN', 'Diese Aktion braucht eine hoehere Rolle.');
  };
  return { authenticate, requireRole };
}
`;

export const DB_TEMPLATE = `import { randomUUID } from 'node:crypto';

function timestamp() {
  return new Date().toISOString();
}

/**
 * Speicher-Adapter fuer Entwicklung und Tests. Er hat dieselbe Oberflaeche wie
 * der Prisma-Adapter, damit Routen und Repositories nichts davon wissen muessen.
 */
export function createMemoryStore(seed = {}) {
  const collections = new Map();
  const table = (name) => {
    if (!collections.has(name)) collections.set(name, []);
    return collections.get(name);
  };
  for (const name of Object.keys(seed)) table(name).push(...seed[name]);
  const matches = (row, where) => Object.keys(where || {}).every((key) => where[key] === undefined || row[key] === where[key]);
  return {
    kind: 'memory',
    list(name, options = {}) {
      const where = options.where || {};
      const limit = Math.max(1, Math.trunc(Number(options.limit) || 50));
      const offset = Math.max(0, Math.trunc(Number(options.offset) || 0));
      const sort = options.sort || 'createdAt';
      const direction = options.direction === 'asc' ? 1 : -1;
      const rows = table(name).filter((row) => matches(row, where));
      rows.sort((a, b) => (String(a[sort] || '') < String(b[sort] || '') ? -1 : 1) * direction);
      return rows.slice(offset, offset + limit);
    },
    count(name, where = {}) {
      return table(name).filter((row) => matches(row, where)).length;
    },
    get(name, id) {
      return table(name).find((row) => row.id === id) || null;
    },
    findWhere(name, where) {
      return table(name).find((row) => matches(row, where)) || null;
    },
    create(name, data) {
      const row = Object.assign({ id: data.id || randomUUID(), createdAt: timestamp(), updatedAt: timestamp() }, data);
      table(name).push(row);
      return row;
    },
    update(name, id, patch) {
      const rows = table(name);
      const index = rows.findIndex((row) => row.id === id);
      if (index < 0) return null;
      rows[index] = Object.assign({}, rows[index], patch, { id, updatedAt: timestamp() });
      return rows[index];
    },
    remove(name, id) {
      const rows = table(name);
      const index = rows.findIndex((row) => row.id === id);
      if (index < 0) return false;
      rows.splice(index, 1);
      return true;
    },
  };
}

/**
 * Prisma-Adapter. Er wird nur aktiv, wenn DATABASE_URL gesetzt und
 * @prisma/client installiert ist - der Speicher bleibt der sichere Rueckfall.
 */
export function createPrismaStore(prisma, models) {
  if (!prisma) throw new Error('createPrismaStore braucht einen Prisma-Client.');
  const delegate = (name) => {
    const model = (models || {})[name];
    const client = model ? prisma[model] : prisma[name];
    if (!client) throw new Error('Fuer ' + name + ' gibt es kein Prisma-Modell.');
    return client;
  };
  return {
    kind: 'prisma',
    list: (name, options = {}) => delegate(name).findMany({ where: options.where || {}, take: Math.max(1, Number(options.limit) || 50), skip: Math.max(0, Number(options.offset) || 0), orderBy: { [options.sort || 'createdAt']: options.direction === 'asc' ? 'asc' : 'desc' } }),
    count: (name, where = {}) => delegate(name).count({ where }),
    get: (name, id) => delegate(name).findUnique({ where: { id } }),
    findWhere: (name, where) => delegate(name).findFirst({ where }),
    create: (name, data) => delegate(name).create({ data }),
    update: (name, id, patch) => delegate(name).update({ where: { id }, data: patch }),
    remove: async (name, id) => {
      try {
        await delegate(name).delete({ where: { id } });
        return true;
      } catch (error) {
        if (error && error.code === 'P2025') return false;
        throw error;
      }
    },
  };
}

export async function createStore(env = process.env, models = {}) {
  const connectionString = String(env.DATABASE_URL || '');
  if (connectionString && env.USE_PRISMA !== '0') {
    try {
      const { PrismaClient } = await import('@prisma/client');
      return createPrismaStore(new PrismaClient({ datasources: { db: { url: connectionString } } }), models);
    } catch {
      // Ohne installierten Client bleibt der Speicher aktiv; das ist kein Fehler.
    }
  }
  return createMemoryStore();
}
`;

export const AUTH_ROUTES_TEMPLATE = `import { HttpError } from '../lib/http.mjs';
import { validatePayload } from '../lib/validate.mjs';
import { hashPassword, verifyPassword } from '../lib/password.mjs';
import { createToken } from '../lib/jwt.mjs';

const registerSchema = {
  name: { type: 'string', required: true, min: 2, max: 120 },
  email: { type: 'email', required: true, max: 180 },
  password: { type: 'string', required: true, min: 8, max: 200 },
};

const loginSchema = {
  email: { type: 'email', required: true, max: 180 },
  password: { type: 'string', required: true, min: 1, max: 200 },
};

function publicUser(user) {
  return { id: user.id, name: user.name, email: user.email, role: user.role };
}

/** Registrierung, Anmeldung, Selbstauskunft und Health - die public-Flaeche der API. */
export function registerAuthRoutes(router, options) {
  const store = options.store;
  const authenticate = options.authenticate;
  const secret = options.secret;

  router.get('/health', () => ({ status: 200, body: { status: 'ok', service: 'api' } }));

  router.post('/api/auth/register', async (ctx) => {
    const input = validatePayload(registerSchema, ctx.body);
    const email = input.email.toLowerCase();
    if (store.findWhere('users', { email })) throw new HttpError(409, 'EMAIL_TAKEN', 'Diese E-Mail ist bereits registriert.');
    const user = store.create('users', { name: input.name.trim(), email, role: 'User', passwordHash: await hashPassword(input.password) });
    return { status: 201, body: { user: publicUser(user), token: createToken({ sub: user.id, role: user.role }, secret) } };
  });

  router.post('/api/auth/login', async (ctx) => {
    const input = validatePayload(loginSchema, ctx.body);
    const user = store.findWhere('users', { email: input.email.toLowerCase() });
    const valid = user ? await verifyPassword(input.password, user.passwordHash) : false;
    if (!valid) throw new HttpError(401, 'INVALID_CREDENTIALS', 'E-Mail oder Passwort stimmt nicht.');
    return { status: 200, body: { user: publicUser(user), token: createToken({ sub: user.id, role: user.role }, secret) } };
  });

  router.get('/api/auth/me', authenticate, (ctx) => {
    const user = store.get('users', ctx.user.id);
    if (!user) throw new HttpError(401, 'UNAUTHENTICATED', 'Der Benutzer existiert nicht mehr.');
    return { status: 200, body: { user: publicUser(user) } };
  });
}
`;

export const APP_TEMPLATE = (routeImports, routeRegistrations) => `import { createServer } from 'node:http';
import { HttpError, json, readJsonBody, serverErrorPayload } from './lib/http.mjs';
import { createRouter } from './lib/router.mjs';
import { createAuthMiddleware } from './auth/middleware.mjs';
import { registerAuthRoutes } from './routes/auth.routes.mjs';
${routeImports}
/**
 * Setzt die Anwendung zusammen: Router, Middleware, Routen, Fehlerbehandlung.
 * Der Handler ist eine reine Funktion von Anfrage zu Antwort und damit testbar
 * ohne offenen Port.
 */
export function createApp(options) {
  const store = options.store;
  const secret = options.secret || (options.env && options.env.JWT_SECRET);
  if (!store) throw new Error('createApp braucht einen Store.');
  if (!secret) throw new Error('createApp braucht ein JWT_SECRET.');
  const router = createRouter();
  const auth = createAuthMiddleware({ secret });
  registerAuthRoutes(router, { store, authenticate: auth.authenticate, secret });
${routeRegistrations}
  const handler = async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://localhost');
      const pathname = url.pathname.replace(/\\/+$/, '') || '/';
      const ctx = {
        req, res, url, pathname, query: url.searchParams,
        method: String(req.method || 'GET').toUpperCase(),
        store, secret, user: null, params: {}, body: null,
      };
      ctx.body = await readJsonBody(req);
      const result = await router.handle(ctx);
      if (!result) throw new HttpError(404, 'NOT_FOUND', 'Diese Route existiert nicht.');
      json(res, result.status === undefined ? 200 : result.status, result.body === undefined ? null : result.body);
    } catch (error) {
      const known = error instanceof HttpError;
      const body = known
        ? { error: Object.assign({ code: error.code, message: error.message }, error.details ? { details: error.details } : {}) }
        : serverErrorPayload();
      if (!known) console.error('[api] Unerwarteter Fehler:', error && error.message ? error.message : error);
      json(res, known ? error.status : 500, body);
    }
  };
  return { handler, router, store, createServer: () => createServer(handler) };
}
`;

export const INDEX_TEMPLATE = `import { createStore } from './db.mjs';
import { createApp } from './app.mjs';
import { models } from './models.mjs';
import { hashPassword } from './lib/password.mjs';

const env = process.env;
const secret = String(env.JWT_SECRET || '');
if (!secret) {
  console.error('[start] JWT_SECRET fehlt. Bitte .env.example nach .env kopieren und fuellen.');
  process.exit(1);
}
if (env.NODE_ENV === 'production' && secret.length < 32) {
  console.error('[start] JWT_SECRET braucht im Produktivbetrieb mindestens 32 Zeichen.');
  process.exit(1);
}

const store = await createStore(env, models);

if (env.ADMIN_EMAIL && env.ADMIN_PASSWORD) {
  const email = String(env.ADMIN_EMAIL).toLowerCase();
  if (!store.findWhere('users', { email })) {
    store.create('users', { name: 'Administrator', email, role: 'Admin', passwordHash: await hashPassword(String(env.ADMIN_PASSWORD)) });
    console.log('[start] Admin-Konto angelegt: ' + email);
  }
}

const app = createApp({ store, secret, env });
const port = Number(env.PORT || 3001);
app.createServer().listen(port, () => {
  console.log('[start] API bereit auf http://127.0.0.1:' + port + ' (' + store.kind + ')');
});
`;

export const MODELS_TEMPLATE = models => `/** Zuordnung Tabelle -> Prisma-Modell (Delegate-Name). */
export const models = ${JSON.stringify(models, null, 2)};
`;
