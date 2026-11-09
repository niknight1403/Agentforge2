/**
 * Vorlagen fuer die fachliche Schicht der generierten App: Schema-Validierung,
 * Repository, Routen, API-Test, Prisma-Schema, Migration, Seed, README.
 *
 * Diese Datei enthaelt nur Text-Erzeuger. Nichts davon fuehrt Fremdcode aus.
 */
import { slugify } from './manifest.mjs';

const PRISMA_TYPES = {
  string: 'String',
  text: 'String',
  email: 'String',
  integer: 'Int',
  decimal: 'Decimal',
  boolean: 'Boolean',
  datetime: 'DateTime',
  enum: 'String',
};

const SQL_TYPES = {
  string: 'TEXT',
  text: 'TEXT',
  email: 'TEXT',
  integer: 'INTEGER',
  decimal: 'DECIMAL(12,2)',
  boolean: 'BOOLEAN',
  datetime: 'TIMESTAMP(3)',
  enum: 'TEXT',
};

function lowerFirst(value) {
  return value.charAt(0).toLowerCase() + value.slice(1);
}

export function sampleValue(field) {
  if (field.type === 'email') return 'beispiel@example.com';
  if (field.type === 'integer') return field.min !== undefined ? Math.max(1, field.min) : 3;
  if (field.type === 'decimal') return 19.99;
  if (field.type === 'boolean') return true;
  if (field.type === 'datetime') return '2026-01-15T10:00';
  if (field.type === 'enum') return (field.values && field.values[0]) || 'open';
  if (field.name === 'name' || field.name === 'title' || field.name === 'subject' || field.name === 'label') return field.label || 'Beispiel';
  return 'Beispiel';
}

function schemaRules(field, { partial = false } = {}) {
  const rules = [`type: '${field.type}'`];
  if (field.required && !partial) rules.push('required: true');
  if (field.min !== undefined) rules.push(`min: ${field.min}`);
  if (field.max !== undefined) rules.push(`max: ${field.max}`);
  if (field.values) rules.push(`values: [${field.values.map(value => `'${value}'`).join(', ')}]`);
  return `{ ${rules.join(', ')} }`;
}

export function schemaFile(entity) {
  const full = entity.fields.map(field => `  ${field.name}: ${schemaRules(field)},`).join('\n');
  const partial = entity.fields.map(field => `  ${field.name}: ${schemaRules(field, { partial: true })},`).join('\n');
  return `/**
 * Eingabeschema fuer ${entity.model}.
 * Das Schema ist die einzige Quelle fuer Validierung und Feldgrenzen; die
 * Routen pruefen damit jeden Schreibzugriff, bevor der Store ihn sieht.
 */
export const ${lowerFirst(entity.model)}Schema = {
${full}
};

export const ${lowerFirst(entity.model)}UpdateSchema = {
${partial}
};
`;
}

export function repositoryFile(entity) {
  const name = lowerFirst(entity.model);
  return `import { HttpError } from '../lib/http.mjs';
import { validatePayload } from '../lib/validate.mjs';
import { ${name}Schema, ${name}UpdateSchema } from '../schemas/${entity.key}.schema.mjs';

const TABLE = '${entity.table}';

/** Datenzugriff fuer ${entity.label}. Routen kennen nur diese Methoden. */
export function ${name}Repository(store) {
  const read = (id) => {
    const row = store.get(TABLE, String(id || ''));
    if (!row) throw new HttpError(404, 'NOT_FOUND', '${entity.label} nicht gefunden.');
    return row;
  };
  return {
    list(window = {}) {
      const limit = Math.min(100, Math.max(1, Number(window.limit) || 50));
      const offset = Math.max(0, Number(window.offset) || 0);
      const where = window.where && typeof window.where === 'object' ? window.where : {};
      return { items: store.list(TABLE, { limit, offset, where }), total: store.count(TABLE, where) };
    },
    read(id) {
      return read(id);
    },
    create(input, actor) {
      const value = validatePayload(${name}Schema, input);
      return store.create(TABLE, Object.assign({}, value, { createdBy: actor && actor.id ? actor.id : null }));
    },
    update(id, input) {
      const value = validatePayload(${name}UpdateSchema, input, { partial: true });
      const keys = Object.keys(value);
      if (!keys.length) throw new HttpError(400, 'EMPTY_PATCH', 'Es wurden keine Felder uebergeben.');
      read(id);
      const row = store.update(TABLE, String(id), value);
      if (!row) throw new HttpError(404, 'NOT_FOUND', '${entity.label} nicht gefunden.');
      return row;
    },
    remove(id) {
      read(id);
      if (!store.remove(TABLE, String(id))) throw new HttpError(404, 'NOT_FOUND', '${entity.label} nicht gefunden.');
    },
  };
}
`;
}

export function routesFile(entity) {
  const name = lowerFirst(entity.model);
  return `import { queryWindow } from '../lib/query.mjs';
import { ${name}Repository } from '../repositories/${entity.key}.repository.mjs';

/**
 * REST-Routen fuer ${entity.label}. Rechte stehen an der Route, nicht im Handler:
 * Lesen darf jede angemeldete Person, Schreiben Manager/Admin, Loeschen nur Admin.
 */
export function register${entity.model}Routes(router, options) {
  const repository = ${name}Repository(options.store);
  const authenticate = options.authenticate;
  const requireRole = options.requireRole;

  router.get('/api/${entity.table}', authenticate, (ctx) => {
    const window = queryWindow(ctx);
    const result = repository.list(window);
    return { status: 200, body: { items: result.items, total: result.total, limit: window.limit, offset: window.offset } };
  });

  router.get('/api/${entity.table}/:id', authenticate, (ctx) => ({ status: 200, body: { item: repository.read(ctx.params.id) } }));

  router.post('/api/${entity.table}', authenticate, requireRole('Manager', 'Admin'), (ctx) => ({ status: 201, body: { item: repository.create(ctx.body, ctx.user) } }));

  router.patch('/api/${entity.table}/:id', authenticate, requireRole('Manager', 'Admin'), (ctx) => ({ status: 200, body: { item: repository.update(ctx.params.id, ctx.body) } }));

  router.delete('/api/${entity.table}/:id', authenticate, requireRole('Admin'), (ctx) => {
    repository.remove(ctx.params.id);
    return { status: 204, body: null };
  });
}
`;
}

export function apiTestFile(manifest) {
  const primary = manifest.entities[0];
  const sample = {};
  for (const field of primary.fields) {
    if (field.required) sample[field.name] = sampleValue(field);
  }
  if (!Object.keys(sample).length) sample.title = 'Beispiel';
  const missing = {};
  for (const field of primary.fields) {
    if (field.required) missing[field.name] = field.type === 'integer' || field.type === 'decimal' ? 'keine Zahl' : '';
  }
  return `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../app.mjs';
import { createMemoryStore } from '../db.mjs';

const SECRET = 'test-secret-0123456789-0123456789-abcdef';
const ROUTE = '/api/${primary.table}';
const VALID = ${JSON.stringify(sample, null, 2)};
const PASSWORD = 'geheim12345';

async function boot() {
  const store = createMemoryStore();
  const app = createApp({ store, secret: SECRET });
  const server = app.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  return { store, server, base };
}

async function call(base, path, options = {}) {
  const headers = { 'content-type': 'application/json' };
  if (options.token) headers.authorization = 'Bearer ' + options.token;
  const response = await fetch(base + path, {
    method: options.method || 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

async function register(base, store, email, role) {
  const result = await call(base, '/api/auth/register', { method: 'POST', body: { name: 'Test ' + role, email, password: PASSWORD } });
  assert.equal(result.status, 201, 'Registrierung muss 201 liefern');
  if (role !== 'User') store.update('users', result.body.user.id, { role });
  return { id: result.body.user.id, token: result.body.token };
}

test('Health-Endpunkt antwortet ohne Anmeldung', async () => {
  const { base, server } = await boot();
  try {
    const result = await call(base, '/health');
    assert.equal(result.status, 200);
    assert.equal(result.body.status, 'ok');
  } finally {
    server.close();
  }
});

test('Registrierung, Anmeldung und Selbstauskunft funktionieren', async () => {
  const { base, server } = await boot();
  try {
    const created = await call(base, '/api/auth/register', { method: 'POST', body: { name: 'Nina', email: 'nina@example.com', password: PASSWORD } });
    assert.equal(created.status, 201);
    assert.equal(created.body.user.role, 'User');
    assert.ok(created.body.token, 'Token fehlt');

    const login = await call(base, '/api/auth/login', { method: 'POST', body: { email: 'nina@example.com', password: PASSWORD } });
    assert.equal(login.status, 200);
    assert.ok(login.body.token, 'Login-Token fehlt');

    const me = await call(base, '/api/auth/me', { token: login.body.token });
    assert.equal(me.status, 200);
    assert.equal(me.body.user.email, 'nina@example.com');
  } finally {
    server.close();
  }
});

test('Falsches Passwort wird ohne Nutzerauskunft abgelehnt', async () => {
  const { base, server } = await boot();
  try {
    await register(base, { update: () => {} }, 'falsch@example.com', 'User');
    const login = await call(base, '/api/auth/login', { method: 'POST', body: { email: 'falsch@example.com', password: 'falschfalsch' } });
    assert.equal(login.status, 401);
    assert.equal(login.body.error.code, 'INVALID_CREDENTIALS');
  } finally {
    server.close();
  }
});

test('${primary.table}: Lesen ohne Token ist gesperrt, mit Token erlaubt', async () => {
  const { base, server, store } = await boot();
  try {
    const anonymous = await call(base, ROUTE);
    assert.equal(anonymous.status, 401);

    const user = await register(base, store, 'leser@example.com', 'User');
    const result = await call(base, ROUTE, { token: user.token });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.items, []);
  } finally {
    server.close();
  }
});

test('${primary.table}: Anlegen braucht Manager-Rolle', async () => {
  const { base, server, store } = await boot();
  try {
    const user = await register(base, store, 'user@example.com', 'User');
    const denied = await call(base, ROUTE, { method: 'POST', token: user.token, body: VALID });
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error.code, 'FORBIDDEN');

    const manager = await register(base, store, 'manager@example.com', 'Manager');
    const created = await call(base, ROUTE, { method: 'POST', token: manager.token, body: VALID });
    assert.equal(created.status, 201);
    assert.ok(created.body.item.id, 'Neuer Eintrag braucht eine ID');

    const list = await call(base, ROUTE, { token: manager.token });
    assert.equal(list.body.items.length, 1);
    assert.equal(list.body.total, 1);
  } finally {
    server.close();
  }
});

test('${primary.table}: Ungueltige Eingaben liefern Felddetails', async () => {
  const { base, server, store } = await boot();
  try {
    const manager = await register(base, store, 'validator@example.com', 'Manager');
    const broken = ${JSON.stringify(missing, null, 2)};
    const result = await call(base, ROUTE, { method: 'POST', token: manager.token, body: broken });
    assert.equal(result.status, 400);
    assert.equal(result.body.error.code, 'VALIDATION_FAILED');
    assert.ok(result.body.error.details, 'Felddetails fehlen');
  } finally {
    server.close();
  }
});

test('${primary.table}: Loeschen bleibt Admin vorbehalten', async () => {
  const { base, server, store } = await boot();
  try {
    const manager = await register(base, store, 'del-manager@example.com', 'Manager');
    const created = await call(base, ROUTE, { method: 'POST', token: manager.token, body: VALID });
    const id = created.body.item.id;

    const denied = await call(base, ROUTE + '/' + id, { method: 'DELETE', token: manager.token });
    assert.equal(denied.status, 403);

    const admin = await register(base, store, 'admin@example.com', 'Admin');
    const removed = await call(base, ROUTE + '/' + id, { method: 'DELETE', token: admin.token });
    assert.equal(removed.status, 204);

    const gone = await call(base, ROUTE + '/' + id, { token: admin.token });
    assert.equal(gone.status, 404);
  } finally {
    server.close();
  }
});

test('Unbekannte Route und kaputtes JSON liefern standardisierte Fehler', async () => {
  const { base, server } = await boot();
  try {
    const missingRoute = await call(base, '/api/gibt-es-nicht');
    assert.equal(missingRoute.status, 404);
    assert.equal(missingRoute.body.error.code, 'NOT_FOUND');

    const response = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{kaputt' });
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.error.code, 'INVALID_JSON');
  } finally {
    server.close();
  }
});
`;
}

export function packageJson(manifest) {
  const pkg = {
    name: manifest.slug,
    version: '0.1.0',
    private: true,
    type: 'module',
    description: `${manifest.name} - generiert von der Agentforge2 Full-Stack-Engine`,
    engines: { node: '>=22' },
    scripts: {
      start: 'node server/index.mjs',
      dev: 'node --watch server/index.mjs',
      test: 'node --test server/tests/api.test.mjs',
      'client:dev': 'vite client',
      'client:build': 'vite build client',
      'db:generate': 'prisma generate',
      'db:migrate': 'prisma migrate deploy',
      'db:seed': 'node prisma/seed.mjs',
    },
    dependencies: {
      '@prisma/client': '6.1.0',
      react: '18.3.1',
      'react-dom': '18.3.1',
    },
    devDependencies: {
      '@vitejs/plugin-react': '4.3.3',
      autoprefixer: '10.4.20',
      postcss: '8.4.47',
      prisma: '6.1.0',
      tailwindcss: '3.4.14',
      vite: '5.4.10',
    },
  };
  return `${JSON.stringify(pkg, null, 2)}\n`;
}

export function envExample() {
  return `# Kopieren nach .env und Werte ersetzen. Keine echten Geheimnisse committen.
NODE_ENV=development
PORT=3001
# Mindestens 32 Zeichen, zufaellig erzeugt (openssl rand -base64 48)
JWT_SECRET=
DATABASE_URL=postgresql://user:password@localhost:5432/appdb
# Einmaliger Admin-Start (danach Werte entfernen)
ADMIN_EMAIL=
ADMIN_PASSWORD=
`;
}

export function gitignore() {
  return `node_modules/
.env
dist/
*.log
prisma/*.db
.DS_Store
`;
}

export function readme(manifest) {
  const entityLines = manifest.entities.map(entity => `- ${entity.label}: \`${entity.route}\` (${entity.fields.map(field => `${field.name}:${field.type}`).join(', ')})`).join('\n');
  return `# ${manifest.name}

Generiert von der **Agentforge2 Full-Stack-Engine** (Blueprint \`${manifest.digest.slice(0, 12)}\`).

## Sofort starten (ohne Installation)

\`\`\`bash
JWT_SECRET=...dein-secret-mit-mindestens-32-zeichen... node server/index.mjs
\`\`\`

Der API-Kern laeuft ausschliesslich mit \`node:\`-Modulen. Kein \`npm install\` noetig,
damit die Anwendung in einer abgeschotteten Sandbox pruefbar bleibt.

\`\`\`bash
node --test server/tests/api.test.mjs   # API-Tests inklusive Rollen- und Validierungspruefung
\`\`\`

## Schichten

| Schicht | Pfad |
| --- | --- |
| HTTP-Kern (Router, Fehler, Body) | \`server/lib/\` |
| Authentifizierung (JWT, scrypt) | \`server/auth/\`, \`server/lib/jwt.mjs\` |
| Routen (REST, Rechte an der Route) | \`server/routes/\` |
| Repositories (Datenzugriff) | \`server/repositories/\` |
| Validierung | \`server/schemas/\` |
| Datenbank (Prisma + Migration + Seed) | \`prisma/\` |
| Oberflaeche (React + Tailwind) | \`client/\` |

## Domaenen

${entityLines}

## Rollen

| Rolle | Rechte |
| --- | --- |
| User | Lesen |
| Manager | Lesen, Anlegen, Aendern |
| Admin | Alles, inklusive Loeschen |

## Datenbank aktivieren

\`\`\`bash
npm install
npm run db:generate
npm run db:migrate
npm run db:seed
\`\`\`

Ohne \`DATABASE_URL\` verwendet die API einen In-Memory-Store mit identischer
Schnittstelle. \`USE_PRISMA=0\` erzwingt den Speicher.

## Sicherheit

- Passwoerter: scrypt (node:crypto, N=16384) mit Zeitvergleich; optionaler
  bcrypt-Pfad in \`server/lib/bcrypt-adapter.mjs\`, sobald \`bcryptjs\` installiert ist.
- Tokens: HS256 mit strikter Algorithmuspruefung; \`alg\`-Wechsel wird abgelehnt.
- Fehlerantworten sind standardisiert (\`{ error: { code, message, details? } }\`)
  und geben keine Stacktraces preis.
- Schreibzugriffe laufen immer ueber Authentifizierung, Rollenpruefung und Schema.
`;
}

export function prismaSchema(manifest) {
  const children = manifest.entities.filter(entity => entity.key !== 'project' && entity.fields.some(field => field.name === 'projectId'));
  const models = manifest.entities.map(entity => {
    const lines = [`model ${entity.model} {`];
    lines.push('  id        String   @id @default(uuid())');
    for (const field of entity.fields) {
      const type = PRISMA_TYPES[field.type] || 'String';
      const optional = field.required ? '' : '?';
      const unique = field.unique ? ' @unique' : '';
      const def = field.default !== undefined ? ` @default(${field.type === 'boolean' ? field.default : JSON.stringify(field.default)})` : '';
      lines.push(`  ${field.name.padEnd(9)} ${type}${optional}${unique}${def}`);
    }
    if (entity.fields.some(field => field.name === 'projectId')) {
      lines.push('  project   Project? @relation(fields: [projectId], references: [id], onDelete: SetNull)');
    }
    lines.push('  createdBy String?');
    lines.push('  createdAt DateTime @default(now())');
    lines.push('  updatedAt DateTime @updatedAt');
    if (entity.key === 'project') {
      for (const child of children) lines.push(`  ${lowerFirst(child.model)}s ${child.model}[]`);
    }
    lines.push(`  @@map("${entity.table}")`);
    lines.push('}');
    return lines.join('\n');
  });
  return `// Prisma-Schema, generiert aus dem Projekt-Blueprint (${manifest.digest.slice(0, 12)}).
// PostgreSQL; Migration liegt unter prisma/migrations.

generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

model User {
  id           String   @id @default(uuid())
  name         String
  email        String   @unique
  role         String   @default("User")
  passwordHash String
  createdAt    DateTime @default(now())
  updatedAt    DateTime @updatedAt

  @@map("users")
}

${models.join('\n\n')}
`;
}

export function migrationSql(manifest) {
  const statements = [`-- Migration 0001_init, generiert aus Blueprint ${manifest.digest.slice(0, 12)}`];
  statements.push(`CREATE TABLE "users" (
  "id" TEXT PRIMARY KEY,
  "name" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "role" TEXT NOT NULL DEFAULT 'User',
  "passwordHash" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);`);
  statements.push('CREATE UNIQUE INDEX "users_email_key" ON "users"("email");');
  for (const entity of manifest.entities) {
    const columns = ['  "id" TEXT PRIMARY KEY'];
    for (const field of entity.fields) {
      const sqlType = SQL_TYPES[field.type] || 'TEXT';
      const nullable = field.required ? ' NOT NULL' : '';
      const fallback = field.default !== undefined
        ? ` DEFAULT ${field.type === 'boolean' ? (field.default ? 'TRUE' : 'FALSE') : typeof field.default === 'number' ? field.default : `'${String(field.default).replace(/'/g, "''")}'`}`
        : '';
      columns.push(`  "${field.name}" ${sqlType}${nullable}${fallback}`);
    }
    columns.push('  "createdBy" TEXT');
    columns.push('  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP');
    columns.push('  "updatedAt" TIMESTAMP(3) NOT NULL');
    statements.push(`CREATE TABLE "${entity.table}" (\n${columns.join(',\n')}\n);`);
    statements.push(`CREATE INDEX "${entity.table}_createdAt_idx" ON "${entity.table}"("createdAt");`);
    for (const field of entity.fields) {
      if (field.unique) statements.push(`CREATE UNIQUE INDEX "${entity.table}_${field.name}_key" ON "${entity.table}"("${field.name}");`);
    }
  }
  return `${statements.join('\n\n')}\n`;
}

export function prismaSeed(manifest) {
  const primary = manifest.entities[0];
  const sample = {};
  for (const field of primary.fields) {
    if (field.required) sample[field.name] = sampleValue(field);
  }
  if (!Object.keys(sample).length) sample.title = 'Beispiel';
  return `import { PrismaClient } from '@prisma/client';
import { hashPassword } from '../server/lib/password.mjs';

const prisma = new PrismaClient();
const adminEmail = String(process.env.ADMIN_EMAIL || 'admin@example.com').toLowerCase();
const adminPassword = String(process.env.ADMIN_PASSWORD || 'bitte-aendern-12345');

async function main() {
  const existing = await prisma.user.findUnique({ where: { email: adminEmail } });
  if (!existing) {
    await prisma.user.create({ data: { name: 'Administrator', email: adminEmail, role: 'Admin', passwordHash: await hashPassword(adminPassword) } });
  }
  const count = await prisma.${lowerFirst(primary.model)}.count();
  if (count === 0) {
    await prisma.${lowerFirst(primary.model)}.create({ data: ${JSON.stringify(sample, null, 4)} });
  }
  console.log('[seed] fertig: ' + adminEmail + ', ' + '${primary.label}' + '-Beispiel angelegt');
}

main().finally(() => prisma.$disconnect());
`;
}

export function bcryptAdapterFile() {
  return `/**
 * Optionaler bcrypt-Pfad. Aktiv nur, wenn \`bcryptjs\` installiert ist
 * (\`npm i bcryptjs\`). Die Funktionssignatur entspricht password.mjs, ein
 * Wechsel ist damit ohne Aenderung an Routen oder Repositories moeglich.
 */
export async function loadBcryptAdapter() {
  try {
    const bcrypt = await import('bcryptjs');
    return {
      kind: 'bcrypt',
      hash: (plain) => bcrypt.hash(plain, 12),
      verify: (plain, stored) => bcrypt.compare(plain, stored),
    };
  } catch {
    return null;
  }
}
`;
}

export function deployManifest(manifest, { files, commit, checks }) {
  return `${JSON.stringify({
    project: manifest.name,
    slug: manifest.slug,
    blueprintDigest: manifest.digest,
    requestDigest: manifest.requestDigest,
    generatedAt: manifest.generatedAt,
    stack: manifest.stack,
    files: files.length,
    checks,
    commit,
    start: 'node server/index.mjs',
    test: 'node --test server/tests/api.test.mjs',
    env: manifest.env,
    entities: manifest.entities.map(entity => ({ model: entity.model, table: entity.table, route: entity.route })),
  }, null, 2)}\n`;
}

export function projectManifestFile(manifest) {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

export function slugFor(value) {
  return slugify(value);
}
