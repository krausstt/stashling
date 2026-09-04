/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Scaffold a connector.
 *
 *   node scripts/new-connector.mjs <id> [--kind <kind>] [--host <pattern>]
 *
 * Writes the connector, its test and its fixture directory, then PRINTS the one line you must
 * add by hand. It deliberately does not edit `packages/connectors/src/index.js`: that file is a
 * static import list because MV3 forbids the dynamic kind (see docs/decisions/0002), and a
 * generated static import list is exactly the sort of thing that silently breaks and is then
 * silently regenerated wrong. One line, pasted by a human who can see it, is cheaper.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  options: { kind: { type: 'string' }, host: { type: 'string' }, force: { type: 'boolean' } },
  allowPositionals: true,
})

const id = positionals[0]
if (!id) {
  process.stderr.write('usage: node scripts/new-connector.mjs <id> [--kind <kind>] [--host <pattern>]\n')
  process.exit(2)
}
if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) {
  process.stderr.write(`"${id}" must be lowercase alphanumeric with dashes — it becomes the Item id namespace\n`)
  process.exit(2)
}

const kind = values.kind ?? 'link'
const host = values.host ?? `https://*.${id}.com/*`
const Id = id.replace(/(^|-)([a-z])/g, (_, d, c) => c.toUpperCase())

const MPL = `/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */`

const connector = `${MPL}

/**
 * ${Id} connector.
 *
 * PURE. No network, no DOM, no platform APIs, no dependencies beyond core. It receives strings
 * and returns plain objects, which is what lets it run in the extension, in the Node CLI against
 * a saved page, and in a test against a fixture, with no branching.
 *
 * Before you fill this in, read docs/CONNECTOR-GUIDE.md. The rules that matter most:
 *   - scope, THEN extract — a page-wide scan picks up sidebars and recommendations
 *   - dedup on a stable source id, never on title and never on position
 *   - omit absent metrics; never write 0 as a stand-in
 *   - never write the \`user\` zone
 *   - record what you MEASURED in the selector table, so the next person can tell a deliberate
 *     fallback from a hopeful one
 */

import { defineConnector } from '../../core/src/connector.js'
import { chunkByElement, attrOfId, textOfId, stripTags, firstOf, hrefs } from './_shared/html.js'

const VERSION = '1.0.0'

/** The element the host scopes to. Splitting on it is what keeps foreign rows out. */
const ROW_ELEMENT = 'TODO-row-element'

/**
 * THE SELECTOR TABLE — the deliberate single point of repair.
 *
 * Ordered candidates: exact anchor first, structural anchor next, shape heuristic last.
 * \`why\` should carry the coverage you measured, not a guess.
 */
export const SELECTORS = Object.freeze({
  sourceId: [
    { name: 'TODO', why: 'TODO measured coverage', get: (chunk) => null },
  ],
  title: [
    { name: 'TODO', why: 'TODO measured coverage', get: (chunk) => null },
  ],
})

export function match(url) {
  // TODO: claim only the pages this connector can actually parse. Claiming a page whose markup
  // differs hands the host a scope that yields zero rows, which reads as "the connector broke".
  return /(^|\\.)${id}\\.com$/.test(new URL(url).hostname)
}

/**
 * Scope, then extract. NOTHING IS FILTERED OUT: a row that failed to parse is still returned
 * with nulls, because the coverage percentage over returned rows is the alarm. Dropping
 * failures makes coverage 100% by construction and silently under-collects instead.
 */
export function parseList(html, _ctx = {}) {
  return chunkByElement(html, ROW_ELEMENT).map((chunk, chunkIndex) => ({
    chunkIndex,
    sourceId: firstOf(SELECTORS.sourceId, (c) => c.get(chunk)),
    title: firstOf(SELECTORS.title, (c) => c.get(chunk)),
    html: chunk,
  }))
}

export const parseDetail = null

/** RawItem → partial Item. Return null when there is no identity to key on. */
export function normalize(raw, ctx = {}) {
  if (!raw?.sourceId) return null
  const capturedAt = Number.isFinite(ctx.capturedAt) ? ctx.capturedAt : 0

  // Only write a metric you actually parsed. Absent must stay distinguishable from zero.
  const metrics = {}

  return {
    source: '${id}',
    sourceId: raw.sourceId,
    kind: '${kind}',
    url: ctx.url ?? '',
    title: raw.title ?? '',
    lists: ctx.listId ? [ctx.listId] : [],
    order: {},
    metrics,
    times: { firstSeenAt: capturedAt, lastSeenAt: capturedAt, capturedAt, publishedAt: null },
    // \`unknown\` is honest when the source gives no liveness signal. Do not claim \`live\`.
    liveness: { state: 'unknown', checkedAt: capturedAt, evidence: null, attempts: 0, retryAfter: null },
    membership: { state: 'listed', checkedAt: capturedAt },
    ext: {},
    // No \`user\` key. The connector does not own that zone.
    raw: raw.html ? { body: raw.html, contentType: 'text/html', hash: null, capturedAt, connectorVersion: VERSION } : null,
  }
}

export default defineConnector({
  id: '${id}',
  kind: '${kind}',
  version: VERSION,
  priority: 0,

  match,
  hosts: ['${host}'],

  lists: [
    // { id: 'saved', label: 'Saved', match: (u) => /\\/saved/.test(u) },
  ],

  acquisition: {
    strategy: 'dom-active-tab',
    scope: ROW_ELEMENT,
    // Only if the list is virtualized. A deadline is required.
    // autoScroll: { until: 'stable', maxMs: 120000, settleMs: 1500, stableRounds: 3 },
    throttleMs: [400, 1200],
  },

  parseList,
  parseDetail,
  normalize,
  deriveThumbUrl: null,
  liveness: { atScrape: null, probe: null },

  facets: [
    // { key: 'metrics.TODO', label: 'TODO', type: 'range' },
  ],
})
`

const testFile = `${MPL}

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import connector, { parseList, normalize } from '../src/${id}.js'
import { createItem, validateItem, validateConnector } from '../../core/src/index.js'

const FIXTURE = fileURLToPath(new URL('../../../fixtures/${id}/list.fixture.html', import.meta.url))
const html = readFileSync(FIXTURE, 'utf8')
const CTX = { url: 'https://${id}.com/', capturedAt: 1756900000000 }

const raws = parseList(html)
const items = raws.map((r) => normalize(r, CTX)).filter(Boolean).map((p) => createItem(p))

test('the connector is structurally valid', () => {
  assert.deepEqual(validateConnector(connector), [])
})

test('scope-then-extract excludes rows outside the scoped element', () => {
  // Put decoy links OUTSIDE the row element in the fixture, or this proves nothing.
  assert.ok(raws.length > 0, 'the fixture must contain rows')
})

test('COVERAGE: assert percentages, not spot values', () => {
  const pct = (fn) => (raws.filter(fn).length / raws.length) * 100
  assert.equal(pct((r) => Boolean(r.sourceId)), 100)
  assert.equal(pct((r) => Boolean(r.title)), 100)
})

test('every produced Item passes validateItem with zero problems', () => {
  assert.deepEqual(items.flatMap((i) => validateItem(i).map((p) => \`\${i.id}: \${p}\`)), [])
})

test('the connector never writes the user zone', () => {
  assert.equal('user' in normalize(raws[0], CTX), false)
})
`

const manifest = {
  schema: 1,
  source: id,
  note: 'Committed fixtures are SYNTHETIC: hand-authored markup reproducing measured structural '
    + 'shapes with invented values. Real saved pages are local-only and gitignored — they are '
    + "somebody's personal history. See docs/FIXTURES.md.",
  files: [{
    path: 'list.fixture.html',
    role: 'committed',
    bytes: null,
    sha256: null,
    describes: 'TODO: which shapes this reproduces, and their measured frequency',
    regenerate: 'Hand-authored. Edit directly.',
  }],
}

const fixtureReadme = `# ${id} fixtures

Committed fixtures here are **synthetic**. See [docs/FIXTURES.md](../../docs/FIXTURES.md).

## Measured against real data

Record what you measured, so the numbers in the connector's selector table can be checked:

| Field | Coverage | Notes |
|---|---|---|
| sourceId | TODO | |
| title | TODO | |

Real saved pages go in \`_local/\` and are gitignored. Never commit one.
`

const targets = [
  [join(ROOT, 'packages/connectors/src', `${id}.js`), connector],
  [join(ROOT, 'packages/connectors/test', `${id}.test.js`), testFile],
  [join(ROOT, 'fixtures', id, 'MANIFEST.json'), `${JSON.stringify(manifest, null, 2)}\n`],
  [join(ROOT, 'fixtures', id, 'README.md'), fixtureReadme],
]

const existing = targets.filter(([p]) => existsSync(p))
if (existing.length && !values.force) {
  process.stderr.write('refusing to overwrite:\n')
  for (const [p] of existing) process.stderr.write(`  ${p}\n`)
  process.stderr.write('pass --force if you mean it\n')
  process.exit(2)
}

mkdirSync(join(ROOT, 'fixtures', id), { recursive: true })
for (const [p, content] of targets) writeFileSync(p, content, 'utf8')

process.stdout.write(`scaffolded connector "${id}" (kind: ${kind})\n\n`)
for (const [p] of targets) process.stdout.write(`  ${p.slice(ROOT.length + 1)}\n`)

process.stdout.write(`
Three steps left, all deliberate:

1. Add the static import to packages/connectors/src/index.js — paste these two lines:

     import ${id.replace(/-/g, '_')} from './${id}.js'
     // …then add it to the \`connectors\` array

   Not generated on purpose: that list is static because MV3 forbids dynamic import()
   (docs/decisions/0002), and a generated import list breaks silently.

2. Write fixtures/${id}/list.fixture.html by hand. Synthetic values only, and include the
   awkward rows — the ones with a missing byline, the deleted placeholder, the decoys outside
   the scoped element. A fixture containing only the happy path tests nothing you feared.

3. Fill in the selector table with what you MEASURED, then:

     node scripts/fixtures.mjs --update
     node --test
     node scripts/sync-extension.mjs
`)
