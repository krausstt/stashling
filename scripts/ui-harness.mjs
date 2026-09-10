/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Serve the REAL extension pages with a mocked `browser` API, so the collection page and the
 * popup can be driven in an ordinary browser without packing and loading an extension.
 *
 *   node scripts/ui-harness.mjs      then open http://localhost:5610/ui/collection.html
 *
 *   ?empty=1   the nothing-collected-yet state
 *   ?deny=1    the host permission has not been granted
 *
 * WHY THIS EXISTS: the UI was the only part of the project nothing could exercise, and "load it
 * in Chrome and look" is a step that does not happen on every change. The first run of this
 * harness found three defects in the render path, one of which turned an imported file into a
 * network beacon.
 *
 * Doc root is `extension/`, so `../vendor/core/index.js` resolves exactly as it does in the
 * packed extension — the pages under test are the shipped files, not copies. The only rewrite is
 * a classic <script> injected ahead of each page's module script; classic scripts run first, so
 * `globalThis.browser` exists before the page module touches it.
 *
 * Seed data comes from actually running the connectors over the committed fixtures, plus one
 * deliberately hostile record whose every field carries markup. If that record ever renders as
 * anything but text, the escaping has regressed.
 *
 * No dependencies, per docs/decisions/0006.
 */
import http from 'node:http'
import { readFileSync } from 'node:fs'
import { extname, join, normalize, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const REPO = fileURLToPath(new URL('..', import.meta.url))
const ROOT = join(REPO, 'extension')
const PORT = Number(process.env.PORT || 5610)

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
}

// ── seed: real connector output over the committed fixture ────────────────────

const core = await import(pathToFileURL(join(ROOT, 'vendor/core/index.js')).href)
const yt = (await import(pathToFileURL(join(ROOT, 'vendor/connectors/youtube.js')).href)).default
const mw = (await import(pathToFileURL(join(ROOT, 'vendor/connectors/makerworld.js')).href)).default

const NOW = 1757000000000
const ytHtml = readFileSync(join(REPO, 'fixtures/youtube/watch-later.fixture.html'), 'utf8')
const mwHtml = readFileSync(join(REPO, 'fixtures/makerworld/detail.fixture.html'), 'utf8')

const ytCtx = { url: 'https://www.youtube.com/playlist?list=WL', listId: 'watch-later', capturedAt: NOW }
const items = yt.parseList(ytHtml, ytCtx)
  .map((r) => yt.normalize(r, ytCtx))
  .filter(Boolean)
  .map((p) => core.createItem({ ...p, raw: null }))

items.push(core.createItem({
  ...mw.normalize(mw.parseDetail(mwHtml), { capturedAt: NOW, lists: ['likes'], order: { likes: 0 } }),
  raw: null,
}))

// One row a hostile .jsonl could contain. `mergeBundle` does not validate, so every one of these
// fields can be arbitrary. If the page renders any of it as markup, the escaping is broken.
items.push({
  ...core.createItem({ source: 'evil', sourceId: 'x1', kind: 'link', title: 'Hostile import <b>bold?</b>' }),
  url: 'javascript:document.title="XSS-EXECUTED"',
  order: { evil: '<img src=x id="order-injection">' },
  liveness: { state: '"><img src=x id="state-injection">', checkedAt: 0, evidence: null, attempts: 0, retryAfter: null },
  byline: { name: '<img src=x id="byline-injection">', handle: null, url: null, id: null },
})

const connectors = [yt, mw].map((c) => ({
  id: c.id, kind: c.kind, version: c.version,
  hosts: c.hosts ?? [], lists: (c.lists ?? []).map((l) => ({ id: l.id, label: l.label })),
  facets: c.facets ?? [],
}))

const MOCK = `
globalThis.__seed = ${JSON.stringify({ items, connectors })};
(() => {
  const q = new URLSearchParams(location.search);
  if (q.has('deny')) globalThis.__denyPermission = true;
  if (q.has('empty')) globalThis.__empty = true;
  const seed = globalThis.__seed;
  let items = globalThis.__empty ? [] : seed.items.slice();
  const log = [];
  globalThis.__log = log;
  const handlers = {
    items: () => ({ total: items.length, items }),
    connectors: () => seed.connectors,
    grantedHosts: () => ['https://*.youtube.com/*', 'https://makerworld.com/*'],
    stats: () => ({ items: items.length, attrs: 0, raws: 0, annotated: 0,
      gone: items.filter(i => i.liveness && i.liveness.state === 'gone').length,
      unlisted: 0, bySource: {}, byList: {}, generation: 3, quota: null }),
    status: () => ({ running: false, phase: 'idle', total: 0, done: 0, seen: 0, lastError: null, problems: [] }),
    describeTab: ({ url }) => ({
      url,
      connector: { id: 'youtube', kind: 'video', version: '1.0.0' },
      list: { id: 'watch-later', label: 'Watch Later' },
      strategy: 'dom-active-tab', scope: 'ytd-playlist-video-renderer',
      autoScroll: true, origins: ['https://*.youtube.com/*'],
      hasPermission: !globalThis.__denyPermission,
    }),
    collect: () => ({ ok: true, connector: 'youtube', parsed: 12, added: 12, merged: 0,
      settled: globalThis.__settled !== false, stoppedBecause: globalThis.__settled === false ? 'deadline' : 'settled',
      rowsSeen: 12, problems: [] }),
    exportAll: () => ({ ok: true, filename: 'stashling-all.jsonl', text: '{"type":"meta"}', count: items.length }),
    importFile: (p) => (globalThis.__importResult ?? { ok: true, kind: 'interchange', added: 3, merged: 1, name: p.name }),
    clearAll: () => { items = []; return { ok: true } },
  };
  globalThis.browser = globalThis.chrome = {
    runtime: {
      sendMessage: async (msg) => { log.push(msg.type); const h = handlers[msg.type];
        return h ? h(msg.payload || {}) : { error: 'unknown message type: ' + msg.type }; },
      openOptionsPage: () => log.push('openOptionsPage'),
    },
    permissions: {
      contains: async () => !globalThis.__denyPermission,
      request: async () => { globalThis.__denyPermission = false; return true; },
      getAll: async () => ({ origins: ['https://*.youtube.com/*'] }),
    },
    downloads: { download: async (o) => { log.push('download:' + o.filename); return 1; } },
    tabs: { query: async () => [{ id: 1, url: 'https://www.youtube.com/playlist?list=WL' }] },
    storage: { local: { get: async () => ({}), set: async () => {} } },
  };
})();
`

// ── server ────────────────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`)
  let path = decodeURIComponent(url.pathname)

  if (path === '/__mock.js') {
    res.writeHead(200, { 'content-type': TYPES['.js'] })
    res.end(MOCK)
    return
  }

  if (path === '/') path = '/ui/collection.html'
  // The separator matters: a bare `startsWith(ROOT)` also admits a SIBLING directory whose name
  // merely begins with the root's — `/../extension-evil/x.js` escapes and is served. This is a
  // dev tool, but it is a dev tool that serves whatever it is pointed at.
  const file = normalize(join(ROOT, path))
  const root = normalize(ROOT).replace(new RegExp(`${sep === '\\' ? '\\\\' : sep}+$`), '')
  if (file !== root && !file.startsWith(root + sep)) { res.writeHead(403).end('no'); return }

  let body
  try {
    body = readFileSync(file)
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end(`not found: ${path}`)
    return
  }

  const ext = extname(file)
  if (ext === '.html') {
    body = Buffer.from(String(body).replace('<script type="module"', '<script src="/__mock.js"></script>\n<script type="module"'))
  }
  res.writeHead(200, { 'content-type': TYPES[ext] ?? 'application/octet-stream' })
  res.end(body)
})

server.listen(PORT, () => {
  process.stdout.write(`ui-harness on http://localhost:${PORT}  (${items.length} seeded items)\n`)
})
