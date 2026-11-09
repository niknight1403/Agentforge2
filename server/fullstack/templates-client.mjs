/**
 * Vorlagen der generierten Oberflaeche: React + Tailwind, modular in
 * services/ hooks/ components/ pages/. Keine erfundenen Bibliotheken - nur
 * React, Vite und Tailwind, wie im Stack des Blueprints angekuendigt.
 */

const lowerFirst = value => value.charAt(0).toLowerCase() + value.slice(1);

export const API_SERVICE = `const TOKEN_KEY = 'agentforge.token';

export function getToken() {
  return window.localStorage.getItem(TOKEN_KEY) || '';
}

export function setToken(token) {
  if (token) window.localStorage.setItem(TOKEN_KEY, token);
  else window.localStorage.removeItem(TOKEN_KEY);
}

async function request(path, options = {}) {
  const headers = { 'content-type': 'application/json' };
  const token = getToken();
  if (token) headers.authorization = 'Bearer ' + token;
  const response = await fetch((import.meta.env.VITE_API_URL || '') + path, {
    method: options.method || 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const detail = data && data.error ? data.error : {};
    const error = new Error(detail.message || 'Anfrage fehlgeschlagen (' + response.status + ')');
    error.code = detail.code || 'HTTP_' + response.status;
    error.details = detail.details || null;
    throw error;
  }
  return data;
}

/** Einziger Zugang zur API: Oberflaeche kennt keine Pfade ausserhalb dieser Datei. */
export const api = {
  health: () => request('/health'),
  login: (email, password) => request('/api/auth/login', { method: 'POST', body: { email, password } }),
  register: (name, email, password) => request('/api/auth/register', { method: 'POST', body: { name, email, password } }),
  me: () => request('/api/auth/me'),
  list: (resource, params = {}) => {
    const search = new URLSearchParams(Object.assign({ limit: '50', offset: '0' }, params)).toString();
    return request('/api/' + resource + '?' + search);
  },
  create: (resource, body) => request('/api/' + resource, { method: 'POST', body }),
  update: (resource, id, body) => request('/api/' + resource + '/' + id, { method: 'PATCH', body }),
  remove: (resource, id) => request('/api/' + resource + '/' + id, { method: 'DELETE' }),
};
`;

export const USE_AUTH_HOOK = `import { useCallback, useEffect, useState } from 'react';
import { api, getToken, setToken } from '../services/api.js';

/** Sitzung: Token im Speicher des Browsers, Benutzer aus /api/auth/me. */
export function useAuth() {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(Boolean(getToken()));

  useEffect(() => {
    if (!getToken()) return;
    let active = true;
    api.me()
      .then((result) => { if (active) setUser(result.user); })
      .catch(() => { setToken(''); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  const login = useCallback(async (email, password) => {
    const result = await api.login(email, password);
    setToken(result.token);
    setUser(result.user);
  }, []);

  const logout = useCallback(() => {
    setToken('');
    setUser(null);
  }, []);

  return { user, loading, login, logout };
}
`;

export const USE_RESOURCE_HOOK = `import { useCallback, useEffect, useState } from 'react';
import { api } from '../services/api.js';

/** Listen-Daten mit Ladezustand und einfacher Wiederholung. */
export function useResource(resource) {
  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const result = await api.list(resource);
      setItems(result.items || []);
      setTotal(typeof result.total === 'number' ? result.total : (result.items || []).length);
      setError('');
    } catch (cause) {
      setError(cause.message);
    } finally {
      setLoading(false);
    }
  }, [resource]);

  useEffect(() => { reload(); }, [reload]);

  return { items, total, error, loading, reload };
}
`;

export const BUTTON_COMPONENT = `const STYLES = {
  primary: 'bg-slate-900 text-white hover:bg-slate-700',
  secondary: 'border border-slate-300 bg-white text-slate-800 hover:bg-slate-50',
  danger: 'bg-red-600 text-white hover:bg-red-500',
};

export function Button({ variant = 'primary', className = '', ...props }) {
  return (
    <button
      {...props}
      className={'inline-flex items-center rounded-md px-4 py-2 text-sm font-medium transition ' + (STYLES[variant] || STYLES.primary) + ' ' + className}
    />
  );
}
`;

export const CARD_COMPONENT = `export function Card({ title, actions, children }) {
  return (
    <section className="rounded-lg border border-slate-200 bg-white">
      {(title || actions) ? (
        <header className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
          <h2 className="text-sm font-semibold text-slate-800">{title}</h2>
          {actions}
        </header>
      ) : null}
      <div className="p-4">{children}</div>
    </section>
  );
}
`;

export const DATATABLE_COMPONENT = `export function DataTable({ columns, rows, empty }) {
  if (!rows || rows.length === 0) {
    return <p className="text-sm text-slate-500">{empty || 'Noch keine Eintraege.'}</p>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full divide-y divide-slate-200 text-sm">
        <thead className="bg-slate-50">
          <tr>
            {columns.map((column) => (
              <th key={column.key} className="px-3 py-2 text-left font-medium text-slate-600">{column.label}</th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {rows.map((row) => (
            <tr key={row.id}>
              {columns.map((column) => (
                <td key={column.key} className="px-3 py-2 text-slate-700">{row[column.key] === null || row[column.key] === undefined ? '' : String(row[column.key])}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
`;

export const FIELD_COMPONENT = `const INPUT = 'w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-900 focus:outline-none';

function inputType(field) {
  if (field.type === 'integer' || field.type === 'decimal') return 'number';
  if (field.type === 'email') return 'email';
  if (field.type === 'datetime') return 'datetime-local';
  return 'text';
}

export function Field({ field, value, error, onChange }) {
  return (
    <label className="block text-sm">
      <span className="mb-1 block font-medium text-slate-700">{field.name}{field.required ? ' *' : ''}</span>
      {field.values ? (
        <select className={INPUT} value={value} onChange={(event) => onChange(event.target.value)}>
          {field.values.map((option) => <option key={option} value={option}>{option}</option>)}
        </select>
      ) : (
        <input className={INPUT} type={inputType(field)} value={value} onChange={(event) => onChange(event.target.value)} />
      )}
      {error ? <span className="mt-1 block text-xs text-red-600">{error}</span> : null}
    </label>
  );
}
`;

export function loginPage() {
  return `import { useState } from 'react';
import { Button } from '../components/ui/Button.jsx';
import { Field } from '../components/ui/Field.jsx';

const EMAIL = { name: 'email', type: 'email', required: true };
const PASSWORD = { name: 'passwort', type: 'string', required: true };

export function LoginPage({ onLogin }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');

  async function submit(event) {
    event.preventDefault();
    setError('');
    try {
      await onLogin(email, password);
    } catch (cause) {
      setError(cause.message);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-100 px-4">
      <form onSubmit={submit} className="w-full max-w-sm space-y-4 rounded-lg border border-slate-200 bg-white p-6">
        <h1 className="text-lg font-semibold text-slate-900">Anmelden</h1>
        <Field field={EMAIL} value={email} onChange={setEmail} />
        <Field field={PASSWORD} value={password} onChange={setPassword} />
        {error ? <p className="text-sm text-red-600">{error}</p> : null}
        <Button type="submit" className="w-full">Anmelden</Button>
      </form>
    </div>
  );
}
`;
}

export function dashboardPage(manifest) {
  const links = manifest.entities.map(entity => `        { kind: '${entity.label}', count: stats['${entity.table}'], path: '/${entity.table}' },`).join('\n');
  const loads = manifest.entities.map(entity => `      api.list('${entity.table}', { limit: '1' }).then((result) => setStats((prev) => Object.assign({}, prev, { '${entity.table}': result.total }))).catch(() => {}),`).join('\n');
  return `import { useEffect, useState } from 'react';
import { api } from '../services/api.js';
import { Card } from '../components/ui/Card.jsx';

export function DashboardPage({ user }) {
  const [stats, setStats] = useState({});

  useEffect(() => {
    Promise.all([
${loads}
    ]);
  }, []);

  const tiles = [
${links}
  ];

  return (
    <div className="space-y-6">
      <Card title={'Willkommen, ' + user.name}>
        <p className="text-sm text-slate-600">Rolle: {user.role}. Lesen ist fuer alle angemeldeten Personen offen, Schreiben braucht Manager- oder Admin-Rechte.</p>
      </Card>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {tiles.map((tile) => (
          <a key={tile.kind} href={tile.path} className="rounded-lg border border-slate-200 bg-white p-4 hover:border-slate-400">
            <p className="text-xs uppercase tracking-wide text-slate-500">{tile.kind}</p>
            <p className="mt-2 text-2xl font-semibold text-slate-900">{tile.count === undefined ? '-' : tile.count}</p>
          </a>
        ))}
      </div>
    </div>
  );
}
`;
}

export function entityPage(entity) {
  const fields = entity.fields.filter(field => field.name !== 'createdBy');
  const descriptor = fields.map(field => ({
    name: field.name,
    type: field.type,
    required: field.required === true,
    ...(field.values ? { values: field.values } : {}),
  }));
  const head = descriptor.filter(field => !['description', 'text'].includes(field.type)).slice(0, 4);
  const columns = head.length ? head : [{ name: 'id', type: 'string' }];
  const initial = fields.filter(field => field.required && field.default === undefined).map(field => field.name);
  return `import { useState } from 'react';
import { api } from '../services/api.js';
import { useResource } from '../hooks/useResource.js';
import { Button } from '../components/ui/Button.jsx';
import { Card } from '../components/ui/Card.jsx';
import { DataTable } from '../components/ui/DataTable.jsx';
import { Field } from '../components/ui/Field.jsx';

const FIELDS = ${JSON.stringify(descriptor, null, 2)};
const COLUMNS = ${JSON.stringify(columns.map(field => ({ key: field.name, label: field.name })), null, 2)};
const INITIAL = ${JSON.stringify(Object.fromEntries(initial.map(name => [name, ''])), null, 2)};

/** ${entity.label}: Liste plus Anlegeformular. Felder kommen aus dem Blueprint. */
export function ${entity.clientPage}() {
  const { items, total, error, loading, reload } = useResource('${entity.table}');
  const [draft, setDraft] = useState(INITIAL);
  const [details, setDetails] = useState({});
  const [formError, setFormError] = useState('');

  async function submit(event) {
    event.preventDefault();
    setFormError('');
    setDetails({});
    try {
      await api.create('${entity.table}', draft);
      setDraft(INITIAL);
      await reload();
    } catch (cause) {
      setFormError(cause.message);
      setDetails(cause.details || {});
    }
  }

  return (
    <div className="space-y-6">
      <Card title={'${entity.label} anlegen'}>
        <form className="grid gap-4 md:grid-cols-2" onSubmit={submit}>
          {FIELDS.map((field) => (
            <Field
              key={field.name}
              field={field}
              value={draft[field.name] === undefined ? '' : draft[field.name]}
              error={details[field.name]}
              onChange={(value) => setDraft((prev) => Object.assign({}, prev, { [field.name]: value }))}
            />
          ))}
          <div className="flex items-center gap-3 md:col-span-2">
            <Button type="submit">Speichern</Button>
            {formError ? <span className="text-sm text-red-600">{formError}</span> : null}
          </div>
        </form>
      </Card>
      <Card title={'${entity.label} (' + total + ')'}>
        {loading ? <p className="text-sm text-slate-500">Laedt...</p> : null}
        {error ? <p className="text-sm text-red-600">{error}</p> : null}
        {!loading && !error ? <DataTable columns={COLUMNS} rows={items} empty="Noch keine Eintraege." /> : null}
      </Card>
    </div>
  );
}
`;
}

export function appFile(manifest) {
  const imports = manifest.entities.map(entity => `import { ${entity.clientPage} } from './pages/${entity.clientPage}.jsx';`).join('\n');
  const navItems = manifest.entities.map(entity => `  { path: '/${entity.table}', label: '${entity.label}', page: <${entity.clientPage} /> },`).join('\n');
  return `import { useState } from 'react';
import { useAuth } from './hooks/useAuth.js';
import { LoginPage } from './pages/LoginPage.jsx';
import { DashboardPage } from './pages/DashboardPage.jsx';
${imports}
import { Button } from './components/ui/Button.jsx';

export default function App() {
  const auth = useAuth();
  const [path, setPath] = useState(window.location.pathname);

  const navigate = (next) => {
    window.history.pushState({}, '', next);
    setPath(next);
  };

  if (auth.loading) return <div className="p-8 text-sm text-slate-500">Laedt...</div>;
  if (!auth.user) return <LoginPage onLogin={auth.login} />;

  const routes = [
    { path: '/', label: 'Dashboard', page: <DashboardPage user={auth.user} /> },
${navItems}
  ];
  const active = routes.find((route) => route.path === path) || routes[0];

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-3 px-4 py-3">
          <span className="mr-4 text-sm font-semibold text-slate-900">${manifest.name}</span>
          {routes.map((route) => (
            <button
              key={route.path}
              onClick={() => navigate(route.path)}
              className={'rounded-md px-2 py-1 text-sm ' + (route.path === active.path ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-100')}
            >
              {route.label}
            </button>
          ))}
          <span className="ml-auto text-xs text-slate-500">{auth.user.email} ({auth.user.role})</span>
          <Button variant="secondary" onClick={auth.logout}>Abmelden</Button>
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-4 py-8">{active.page}</main>
    </div>
  );
}
`;
}

export const MAIN_FILE = `import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './styles.css';

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>
);
`;

export const INDEX_HTML = name => `<!doctype html>
<html lang="de">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${name}</title>
  </head>
  <body class="bg-slate-50 text-slate-900">
    <div id="root"></div>
    <script type="module" src="/src/main.jsx"></script>
  </body>
</html>
`;

export const STYLES = `@tailwind base;
@tailwind components;
@tailwind utilities;

body {
  font-family: ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif;
}
`;

export const TAILWIND_CONFIG = `/** Tailwind scannt nur die eigenen Quellen, damit der Build klein bleibt. */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: { extend: {} },
  plugins: [],
};
`;

export const POSTCSS_CONFIG = `export default {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
};
`;

export function clientFileMap(manifest) {
  const files = new Map();
  files.set('client/index.html', INDEX_HTML(manifest.name));
  files.set('client/src/main.jsx', MAIN_FILE);
  files.set('client/src/App.jsx', appFile(manifest));
  files.set('client/src/styles.css', STYLES);
  files.set('client/src/services/api.js', API_SERVICE);
  files.set('client/src/hooks/useAuth.js', USE_AUTH_HOOK);
  files.set('client/src/hooks/useResource.js', USE_RESOURCE_HOOK);
  files.set('client/src/components/ui/Button.jsx', BUTTON_COMPONENT);
  files.set('client/src/components/ui/Card.jsx', CARD_COMPONENT);
  files.set('client/src/components/ui/DataTable.jsx', DATATABLE_COMPONENT);
  files.set('client/src/components/ui/Field.jsx', FIELD_COMPONENT);
  files.set('client/src/pages/LoginPage.jsx', loginPage());
  files.set('client/src/pages/DashboardPage.jsx', dashboardPage(manifest));
  for (const entity of manifest.entities) {
    files.set(`client/src/pages/${entity.clientPage}.jsx`, entityPage(entity));
  }
  files.set('client/tailwind.config.js', TAILWIND_CONFIG);
  files.set('client/postcss.config.js', POSTCSS_CONFIG);
  files.set('client/vite.config.js', `import { defineConfig } from 'vite';\nimport react from '@vitejs/plugin-react';\n\nexport default defineConfig({\n  plugins: [react()],\n  server: { proxy: { '/api': 'http://127.0.0.1:3001' } },\n});\n`);
  return files;
}

export { lowerFirst };
