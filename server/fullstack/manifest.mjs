/**
 * Full-Stack-Engine, Stufe 1: Prompt -> Projekt-Blueprint (project_manifest.json).
 *
 * Der Planner ist bewusst deterministisch und offline. Er braucht kein LLM, kein
 * Netz und keine Zufallsquelle: derselbe Prompt ergibt denselben Blueprint. Ein
 * LLM darf spaeter nur die Auswahl ergaenzen, niemals Struktur oder Rechte
 * erfinden - Rollen, Routen und Feldtypen bleiben hier definiert.
 *
 * Schutzziel: Der Originalprompt wird nie gespeichert. Nach aussen wandert nur
 * ein SHA-256-Digest (`requestDigest`), damit Auftraege wiedererkennbar bleiben,
 * ohne Kundentext zu persistieren.
 */
import { createHash } from 'node:crypto';

export const FULLSTACK_MANIFEST_VERSION = 1;

/** Rollen sind fest: jede generierte API kennt genau diese drei Ebenen. */
export const FULLSTACK_ROLES = Object.freeze(['Admin', 'Manager', 'User']);

export const FULLSTACK_STACK = Object.freeze({
  client: 'react',
  styling: 'tailwind',
  server: 'node-http',
  database: 'postgresql',
  orm: 'prisma',
  auth: 'jwt-hs256',
  password: 'scrypt',
  tests: 'node:test',
});

const FIELD_TYPES = new Set(['string', 'text', 'email', 'integer', 'decimal', 'boolean', 'datetime', 'enum']);

/**
 * Bekannte Domaenen. Jeder Eintrag ist eine Feldschablone, keine Vorlage fuer
 * Prosa: der Prompt waehlt aus, was davon gebaut wird.
 */
const CATALOG = [
  { key: 'task', model: 'Task', table: 'tasks', label: 'Aufgabe', words: ['aufgabe', 'aufgaben', 'task', 'tasks', 'todo', 'todos', 'to-do'], fields: [
    { name: 'title', type: 'string', required: true, min: 3, max: 120 },
    { name: 'description', type: 'text', max: 2000 },
    { name: 'status', type: 'enum', values: ['open', 'in_progress', 'done'], default: 'open' },
    { name: 'dueAt', type: 'datetime' },
  ] },
  { key: 'project', model: 'Project', table: 'projects', label: 'Projekt', words: ['projekt', 'projekte', 'projekten', 'project', 'projects'], fields: [
    { name: 'name', type: 'string', required: true, min: 2, max: 120 },
    { name: 'summary', type: 'text', max: 2000 },
    { name: 'status', type: 'enum', values: ['planned', 'active', 'done'], default: 'planned' },
  ] },
  { key: 'customer', model: 'Customer', table: 'customers', label: 'Kunde', words: ['kunde', 'kunden', 'customer', 'customers', 'klient', 'client'], fields: [
    { name: 'name', type: 'string', required: true, min: 2, max: 120 },
    { name: 'email', type: 'email', required: true, unique: true },
    { name: 'phone', type: 'string', max: 40 },
    { name: 'notes', type: 'text', max: 2000 },
  ] },
  { key: 'invoice', model: 'Invoice', table: 'invoices', label: 'Rechnung', words: ['rechnung', 'rechnungen', 'invoice', 'invoices', 'abrechnung'], fields: [
    { name: 'number', type: 'string', required: true, unique: true, min: 1, max: 40 },
    { name: 'amount', type: 'decimal', required: true, min: 0 },
    { name: 'status', type: 'enum', values: ['draft', 'sent', 'paid'], default: 'draft' },
    { name: 'issuedAt', type: 'datetime' },
  ] },
  { key: 'booking', model: 'Booking', table: 'bookings', label: 'Buchung', words: ['buchung', 'buchungen', 'booking', 'bookings', 'reservierung', 'reservation', 'termin'], fields: [
    { name: 'title', type: 'string', required: true, min: 2, max: 120 },
    { name: 'startsAt', type: 'datetime', required: true },
    { name: 'status', type: 'enum', values: ['requested', 'confirmed', 'cancelled'], default: 'requested' },
  ] },
  { key: 'product', model: 'Product', table: 'products', label: 'Produkt', words: ['produkt', 'produkte', 'product', 'products', 'artikel', 'article'], fields: [
    { name: 'name', type: 'string', required: true, min: 2, max: 120 },
    { name: 'price', type: 'decimal', required: true, min: 0 },
    { name: 'description', type: 'text', max: 2000 },
    { name: 'active', type: 'boolean', default: true },
  ] },
  { key: 'order', model: 'Order', table: 'orders', label: 'Bestellung', words: ['bestellung', 'bestellungen', 'order', 'orders'], fields: [
    { name: 'reference', type: 'string', required: true, unique: true, min: 1, max: 40 },
    { name: 'total', type: 'decimal', min: 0 },
    { name: 'status', type: 'enum', values: ['new', 'paid', 'shipped', 'cancelled'], default: 'new' },
  ] },
  { key: 'ticket', model: 'Ticket', table: 'tickets', label: 'Ticket', words: ['ticket', 'tickets', 'supportfall', 'störung', 'stoerung'], fields: [
    { name: 'subject', type: 'string', required: true, min: 3, max: 140 },
    { name: 'body', type: 'text', max: 4000 },
    { name: 'priority', type: 'enum', values: ['low', 'normal', 'high'], default: 'normal' },
    { name: 'status', type: 'enum', values: ['open', 'in_progress', 'closed'], default: 'open' },
  ] },
  { key: 'event', model: 'Event', table: 'events', label: 'Veranstaltung', words: ['veranstaltung', 'veranstaltungen', 'event', 'events', 'meetup'], fields: [
    { name: 'title', type: 'string', required: true, min: 3, max: 140 },
    { name: 'startsAt', type: 'datetime', required: true },
    { name: 'location', type: 'string', max: 160 },
  ] },
  { key: 'note', model: 'Note', table: 'notes', label: 'Notiz', words: ['notiz', 'notizen', 'note', 'notes', 'memo'], fields: [
    { name: 'title', type: 'string', required: true, min: 1, max: 120 },
    { name: 'content', type: 'text', max: 8000 },
    { name: 'pinned', type: 'boolean', default: false },
  ] },
  { key: 'course', model: 'Course', table: 'courses', label: 'Kurs', words: ['kurs', 'kurse', 'course', 'courses', 'seminar'], fields: [
    { name: 'title', type: 'string', required: true, min: 3, max: 140 },
    { name: 'seats', type: 'integer', min: 0 },
    { name: 'startsAt', type: 'datetime' },
  ] },
  { key: 'employee', model: 'Employee', table: 'employees', label: 'Mitarbeiter', words: ['mitarbeiter', 'mitarbeiterin', 'employee', 'employees', 'team'], fields: [
    { name: 'name', type: 'string', required: true, min: 2, max: 120 },
    { name: 'email', type: 'email', required: true, unique: true },
    { name: 'role', type: 'string', max: 60 },
  ] },
  { key: 'review', model: 'Review', table: 'reviews', label: 'Bewertung', words: ['bewertung', 'bewertungen', 'review', 'reviews', 'feedback'], fields: [
    { name: 'rating', type: 'integer', required: true, min: 1, max: 5 },
    { name: 'comment', type: 'text', max: 2000 },
  ] },
  { key: 'comment', model: 'Comment', table: 'comments', label: 'Kommentar', words: ['kommentar', 'kommentare', 'comment', 'comments'], fields: [
    { name: 'body', type: 'text', required: true, max: 4000 },
    { name: 'author', type: 'string', max: 120 },
  ] },
  { key: 'post', model: 'Post', table: 'posts', label: 'Beitrag', words: ['beitrag', 'beitraege', 'post', 'posts', 'blog'], fields: [
    { name: 'title', type: 'string', required: true, min: 3, max: 140 },
    { name: 'body', type: 'text', max: 20000 },
    { name: 'published', type: 'boolean', default: false },
  ] },
  { key: 'recipe', model: 'Recipe', table: 'recipes', label: 'Rezept', words: ['rezept', 'rezepte', 'recipe', 'recipes'], fields: [
    { name: 'title', type: 'string', required: true, min: 2, max: 140 },
    { name: 'ingredients', type: 'text', max: 4000 },
    { name: 'minutes', type: 'integer', min: 1 },
  ] },
  { key: 'expense', model: 'Expense', table: 'expenses', label: 'Ausgabe', words: ['ausgabe', 'ausgaben', 'expense', 'expenses', 'spesen'], fields: [
    { name: 'label', type: 'string', required: true, min: 2, max: 120 },
    { name: 'amount', type: 'decimal', required: true, min: 0 },
    { name: 'spentAt', type: 'datetime' },
  ] },
  { key: 'lead', model: 'Lead', table: 'leads', label: 'Interessent', words: ['interessent', 'interessenten', 'lead', 'leads', 'anfrage'], fields: [
    { name: 'name', type: 'string', required: true, min: 2, max: 120 },
    { name: 'email', type: 'email' },
    { name: 'source', type: 'string', max: 80 },
    { name: 'status', type: 'enum', values: ['new', 'contacted', 'won', 'lost'], default: 'new' },
  ] },
];

/** Zusatzfelder, die der Prompt global verlangt (Preis, Menge, Bild, Frist). */
const EXTRA_FIELDS = [
  { words: ['preis', 'preise', 'price', 'kosten', 'betrag', 'umsatz'], field: { name: 'price', type: 'decimal', min: 0 } },
  { words: ['menge', 'anzahl', 'quantity', 'stueck', 'stück', 'bestand'], field: { name: 'quantity', type: 'integer', min: 0, default: 1 } },
  { words: ['bild', 'foto', 'image', 'photo', 'bilder'], field: { name: 'imageUrl', type: 'string', max: 500 } },
  { words: ['frist', 'deadline', 'faellig', 'fällig', 'termin'], field: { name: 'dueAt', type: 'datetime' } },
  { words: ['prioritaet', 'priorität', 'priority'], field: { name: 'priority', type: 'enum', values: ['low', 'normal', 'high'], default: 'normal' } },
  { words: ['adresse', 'address', 'strasse', 'straße'], field: { name: 'address', type: 'string', max: 240 } },
  { words: ['telefon', 'phone', 'handy'], field: { name: 'phone', type: 'string', max: 40 } },
];

const STOPWORDS = new Set(['der', 'die', 'das', 'den', 'dem', 'des', 'ein', 'eine', 'einen', 'einem', 'einer', 'eines', 'und', 'oder', 'fuer', 'für', 'mit', 'ohne', 'von', 'vom', 'zum', 'zur', 'im', 'in', 'am', 'an', 'auf', 'zu', 'mein', 'meine', 'unser', 'unsere', 'soll', 'sollen', 'muss', 'muessen', 'müssen', 'kann', 'koennen', 'können', 'bitte', 'baue', 'bauen', 'erstelle', 'erstellen', 'generiere', 'app', 'anwendung', 'system', 'the', 'and', 'with', 'for', 'of', 'to', 'my', 'our', 'build', 'create', 'generate', 'should', 'must', 'can', 'a', 'an']);

export function normalizePrompt(prompt) {
  return String(prompt || '')
    .toLowerCase()
    .replace(/[äöüß]/g, ch => ({ ä: 'ae', ö: 'oe', ü: 'ue', ß: 'ss' }[ch]))
    .replace(/[^a-z0-9\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Worthuelle mit Komposita-Erkennung: "Projektmanagement" soll die Domaene
 * Projekt treffen, ohne dass jede Schreibweise im Katalog stehen muss.
 * Komposita gelten nur ab fuenf Zeichen Wortlaenge, damit kurze Woerter wie
 * "post" nicht in "poster" oder "note" nicht in "notebook" einrasten.
 */
function wordsMatch(text, words) {
  return words.some(word => {
    const safe = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`(?:^|[^a-z0-9])${safe}(?:$|[^a-z0-9])`).test(text)) return true;
    return word.length >= 5 && new RegExp(`(?:^|[^a-z0-9])${safe}[a-z]{2,12}(?:$|[^a-z0-9])`).test(text);
  });
}

function titleCase(value) {
  return value.split(/[\s-]+/).filter(Boolean).map(part => part.charAt(0).toUpperCase() + part.slice(1)).join(' ');
}

function pluralize(word) {
  if (/[^aeiou]y$/.test(word)) return `${word.slice(0, -1)}ies`;
  if (/(s|x|z|ch|sh)$/.test(word)) return `${word}es`;
  return `${word}s`;
}

export function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[äöüß]/g, ch => ({ ä: 'ae', ö: 'oe', ü: 'ue', ß: 'ss' }[ch]))
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'projekt';
}

function pascal(value) {
  return slugify(value).split('-').filter(Boolean).map(part => part.charAt(0).toUpperCase() + part.slice(1)).join('') || 'Record';
}

/** Projektname aus dem Prompt, ohne den Prompt selbst zu uebernehmen. */
function deriveProjectName(prompt, normalized) {
  // Nur ein kurzer Produktname, nie der Auftragstext: hoechstens drei
  // Stichwoerter, gleiche Wortstaemme nur einmal, maximal 40 Zeichen.
  const stems = [];
  for (const word of normalized.split(' ')) {
    if (word.length <= 2 || STOPWORDS.has(word) || /^\d+$/.test(word)) continue;
    const stem = word.slice(0, 5);
    if (stems.some(entry => entry.stem === stem)) continue;
    const candidate = [...stems, { stem, word }].map(entry => entry.word).join(' ');
    if (candidate.length > 40) break;
    stems.push({ stem, word });
    if (stems.length === 3) break;
  }
  if (stems.length) return titleCase(stems.map(entry => entry.word).join(' '));
  const fallback = String(prompt || '').trim().split(/\s+/).slice(0, 3).join(' ');
  return titleCase(slugify(fallback).replace(/-/g, ' '));
}

function pickEntities(normalized) {
  const scored = CATALOG.map(entry => ({
    entry,
    hits: entry.words.reduce((count, word) => count + (wordsMatch(normalized, [word]) ? 1 : 0), 0),
  })).filter(item => item.hits > 0).sort((a, b) => b.hits - a.hits || a.entry.key.localeCompare(b.entry.key));
  return scored.slice(0, 4).map(item => item.entry);
}

function fallbackEntity(normalized) {
  const candidate = normalized.split(' ').filter(word => word.length > 2 && !STOPWORDS.has(word))[0] || 'record';
  const singular = candidate.replace(/(en|er|es|s)$/, '') || candidate;
  const model = pascal(singular);
  return {
    key: singular,
    model,
    table: pluralize(slugify(singular)),
    label: titleCase(singular),
    words: [],
    fields: [
      { name: 'title', type: 'string', required: true, min: 1, max: 140 },
      { name: 'notes', type: 'text', max: 2000 },
    ],
  };
}

function entityFields(entry, normalized) {
  const fields = entry.fields.map(field => ({ ...field }));
  for (const extra of EXTRA_FIELDS) {
    if (!wordsMatch(normalized, extra.words)) continue;
    if (fields.some(field => field.name === extra.field.name)) continue;
    fields.push({ ...extra.field });
  }
  return fields;
}

/** Routen sind die einzige Rechtequelle: jeder Pfad traegt seine Zugriffsstufe. */
function entityRoutes(entity) {
  const base = `/api/${entity.table}`;
  return [
    { method: 'GET', path: base, entity: entity.model, action: 'list', access: 'authenticated', roles: [] },
    { method: 'GET', path: `${base}/:id`, entity: entity.model, action: 'read', access: 'authenticated', roles: [] },
    { method: 'POST', path: base, entity: entity.model, action: 'create', access: 'role', roles: ['Manager', 'Admin'] },
    { method: 'PATCH', path: `${base}/:id`, entity: entity.model, action: 'update', access: 'role', roles: ['Manager', 'Admin'] },
    { method: 'DELETE', path: `${base}/:id`, entity: entity.model, action: 'delete', access: 'role', roles: ['Admin'] },
  ];
}

const AUTH_ROUTES = Object.freeze([
  { method: 'GET', path: '/health', entity: null, action: 'health', access: 'public', roles: [] },
  { method: 'POST', path: '/api/auth/register', entity: 'User', action: 'register', access: 'public', roles: [] },
  { method: 'POST', path: '/api/auth/login', entity: 'User', action: 'login', access: 'public', roles: [] },
  { method: 'GET', path: '/api/auth/me', entity: 'User', action: 'me', access: 'authenticated', roles: [] },
]);

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * Digest ueber den fachlichen Inhalt. Zeitstempel und der Digest selbst
 * zaehlen nicht mit: derselbe Auftrag ergibt damit denselben Fingerabdruck und
 * kann als Idempotenzschluessel fuer Wiederholungen dienen.
 */
export function digestManifest(manifest) {
  const { digest: _ignored, generatedAt: _timestamp, ...rest } = manifest || {};
  return digest(JSON.stringify(rest));
}

/**
 * Prompt -> Blueprint. Reine Funktion; wirft bei zu kurzen oder zu langen
 * Eingaben, damit kein leerer Bauauftrag durchlaeuft.
 */
export function deriveManifest(prompt, { name, now = () => Date.now() } = {}) {
  const raw = String(prompt || '').trim();
  if (raw.length < 10) throw Object.assign(new Error('Der Bauauftrag braucht mindestens 10 Zeichen Beschreibung.'), { code: 'FULLSTACK_PROMPT_TOO_SHORT' });
  if (raw.length > 20_000) throw Object.assign(new Error('Der Bauauftrag ist auf 20000 Zeichen begrenzt.'), { code: 'FULLSTACK_PROMPT_TOO_LONG' });

  const normalized = normalizePrompt(raw);
  const picked = pickEntities(normalized);
  const selected = picked.length ? picked : [fallbackEntity(normalized)];
  const projectName = name ? String(name) : deriveProjectName(raw, normalized);
  const slug = slugify(projectName) || 'projekt';
  const requestDigest = digest(raw);

  const entities = selected.map(entry => {
    const fields = entityFields(entry, normalized);
    return {
      key: entry.key,
      model: entry.model,
      table: entry.table,
      label: entry.label,
      route: `/api/${entry.table}`,
      clientPage: `${entry.model}Page`,
      fields: fields.map(field => ({ ...field, type: FIELD_TYPES.has(field.type) ? field.type : 'string' })),
    };
  });

  // Beziehungen: gibt es ein Projekt, haengen alle anderen Domaenen daran.
  const anchor = entities.find(entity => entity.key === 'project');
  if (anchor) {
    for (const entity of entities) {
      if (entity.model === anchor.model) continue;
      if (entity.fields.some(field => field.name === 'projectId')) continue;
      entity.fields.push({ name: 'projectId', type: 'string', max: 40, reference: anchor.model });
    }
  }

  const routes = [...AUTH_ROUTES, ...entities.flatMap(entityRoutes)];
  const pages = [
    { name: 'Login', path: '/login', kind: 'auth', entity: null },
    { name: 'Dashboard', path: '/', kind: 'dashboard', entity: null },
    ...entities.map(entity => ({ name: `${entity.label}-Liste`, path: `/${entity.table}`, kind: 'list', entity: entity.model })),
  ];
  const components = ['Button', 'Card', 'DataTable', 'Field'];

  const manifest = {
    version: FULLSTACK_MANIFEST_VERSION,
    name: projectName,
    slug,
    generatedAt: new Date(now()).toISOString(),
    requestDigest,
    stack: { ...FULLSTACK_STACK },
    roles: [...FULLSTACK_ROLES],
    entities,
    routes,
    pages,
    components,
    env: ['NODE_ENV', 'PORT', 'JWT_SECRET', 'DATABASE_URL', 'ADMIN_EMAIL', 'ADMIN_PASSWORD'],
    deliverables: [
      'client/components',
      'client/pages',
      'client/services',
      'client/hooks',
      'server/routes',
      'server/repositories',
      'server/schemas',
      'server/auth',
      'prisma/schema.prisma',
      'prisma/seed.mjs',
      'prisma/migrations',
      'tests',
    ],
  };
  manifest.digest = digestManifest(manifest);
  return manifest;
}

/** Fasst den Blueprint fuer Events/Checkpoints zusammen (ohne Prompt, ohne Feldlisten-Dump). */
export function summarizeManifest(manifest) {
  if (!manifest?.digest) throw new Error('Ein gueltiger Blueprint wird benoetigt.');
  return {
    project: manifest.name,
    slug: manifest.slug,
    blueprintDigest: manifest.digest,
    requestDigest: manifest.requestDigest,
    entities: manifest.entities.length,
    routes: manifest.routes.length,
    pages: manifest.pages.length,
    roles: manifest.roles.join(','),
  };
}
