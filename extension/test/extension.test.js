/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The extension, exercised end to end without a browser.
 *
 * Everything below runs the SHIPPED files — `extension/sw.js` and `extension/store.js` against
 * `extension/vendor/`, which is the vendored copy the browser actually loads. Testing the
 * packages instead would have missed the whole class of bug this file exists for: a call site
 * in the extension that no unit test reaches.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { installIndexedDB, installBrowser, send } from './_harness.js'

const FIXTURE = fileURLToPath(new URL('../../fixtures/youtube/watch-later.fixture.html', import.meta.url))
const html = readFileSync(FIXTURE, 'utf8')
const WL = 'https://www.youtube.com/playlist?list=WL'
const YT_ORIGIN = 'https://*.youtube.com/*'

const idb = installIndexedDB()
installBrowser({
  tabUrl: WL,
  grantedOrigins: [YT_ORIGIN],
  executeScript: async () => ({
    html, url: WL, title: 'Watch later', rowsSeen: 12,
    settled: true, stoppedBecause: 'settled', scrolledMs: 10,
  }),
})

// sw.js registers its message listener at import time, so the globals must exist first.
const store = await import('../store.js')
await import('../sw.js')

async function fresh() {
  await globalThis.browser.storage.local.clear()
  try { await store.clearAll() } catch { /* first run: no database yet */ }
  store.closeDb?.()
  idb.reset()
}

// ── the store ─────────────────────────────────────────────────────────────────

test('upsertItems stores, merges, and splits the raw blob out of the item', async () => {
  await fresh()
  const { mergeItems, createItem } = await import('../vendor/core/index.js')

  const item = createItem({
    source: 'youtube', sourceId: 'vidAAAAAAAA', kind: 'video', title: 'First',
    raw: { body: '<div>row</div>', contentType: 'text/html', capturedAt: 1 },
  })

  const first = await store.upsertItems([item], { mergeItems })
  assert.equal(first.added, 1)
  assert.equal(first.merged, 0)
  assert.equal(first.rawsStored, 1)

  // §7: the item row must not carry the blob; it lives in `raws`.
  const stored = await store.readItem('youtube:vidAAAAAAAA')
  assert.equal(stored.raw, null)
  const raw = await store.readRaw('youtube:vidAAAAAAAA')
  assert.equal(raw.body, '<div>row</div>')
  assert.match(raw.hash, /^sha256-/)

  const again = await store.upsertItems([{ ...item, title: 'Second' }], { mergeItems })
  assert.equal(again.added, 0)
  assert.equal(again.merged, 1)
  assert.equal((await store.readItem('youtube:vidAAAAAAAA')).title, 'Second')
})

test('a re-scrape cannot clobber the user zone through the store', async () => {
  await fresh()
  const { mergeItems, createItem } = await import('../vendor/core/index.js')
  const base = { source: 'youtube', sourceId: 'vidBBBBBBBB', kind: 'video', title: 'v' }

  await store.upsertItems([createItem({ ...base, user: { notes: 'mine', tags: ['keep'] } })], { mergeItems })
  await store.upsertItems([createItem({ ...base, title: 'v updated' })], { mergeItems })

  const stored = await store.readItem('youtube:vidBBBBBBBB')
  assert.deepEqual(stored.user, { notes: 'mine', tags: ['keep'] })
  assert.equal(stored.title, 'v updated')
})

test('an oversize raw is dropped and recorded, never truncated', async () => {
  await fresh()
  const { mergeItems, createItem } = await import('../vendor/core/index.js')
  const big = 'x'.repeat(store.MAX_RAW_BYTES + 1)

  const result = await store.upsertItems([createItem({
    source: 'youtube', sourceId: 'vidCCCCCCCC', kind: 'video', title: 'big',
    raw: { body: big, contentType: 'text/html' },
  })], { mergeItems })

  assert.equal(result.rawsOmitted, 1)
  assert.equal(result.rawsStored, 0)
  const raw = await store.readRaw('youtube:vidCCCCCCCC')
  assert.equal(raw.omitted, 'oversize')
  assert.equal(raw.body, undefined, 'a half-blob would be re-shredded as if it were whole')
})

test('the generation survives a wipe, so a stale file cannot overwrite a fresh collection', async () => {
  await fresh()
  await store.bumpGeneration()
  await store.bumpGeneration()
  assert.equal(await store.readGeneration(), 2)
  await store.clearAll()
  assert.equal(await store.readGeneration(), 2)
})

// ── the message hub ───────────────────────────────────────────────────────────

test('describeTab reports the connector, the list and the permission state', async () => {
  await fresh()
  const described = await send('describeTab', { url: WL })
  assert.equal(described.connector.id, 'youtube')
  assert.equal(described.list.id, 'watch-later')
  assert.equal(described.strategy, 'dom-active-tab')
  assert.equal(described.hasPermission, true)
  assert.deepEqual(described.origins, [YT_ORIGIN])
})

test('an unknown message type is answered, not dropped', async () => {
  const reply = await send('nonsense')
  assert.match(reply.error, /unknown message type/)
})

// ── THE REGRESSION THIS HARNESS WAS BUILT FOR ────────────────────────────────

test('COLLECT actually stores what it parsed', async () => {
  // This is the whole product. Before this test existed, `collect` threw
  // `TypeError: upsertItems: opts.mergeItems is required` on every single run — the call site
  // passed `{ merge: … }` and the function destructures `{ mergeItems }`. Nothing caught it,
  // because no test ever called it and the throw was swallowed into a status field.
  await fresh()

  const result = await send('collect', { tabId: 1, url: WL, connectorId: 'youtube' })

  assert.equal(result.ok, true, `collect failed: ${result.error ?? result.reason}`)
  assert.equal(result.parsed, 12)
  assert.equal(result.added, 12)
  assert.equal(result.merged, 0)

  const stored = await store.readItems()
  assert.equal(stored.length, 12, 'items must be in the store, not merely parsed')
  assert.ok(stored.every((i) => i.source === 'youtube'))
  assert.ok(stored.some((i) => i.liveness.state === 'gone'), 'the two placeholder rows')

  const status = await store.readStatus()
  assert.equal(status.running, false)
  assert.equal(status.phase, 'done')
  assert.equal(status.lastError, null)
})

test('collecting twice merges rather than duplicating', async () => {
  await fresh()
  await send('collect', { tabId: 1, url: WL, connectorId: 'youtube' })
  const second = await send('collect', { tabId: 1, url: WL, connectorId: 'youtube' })

  assert.equal(second.ok, true)
  assert.equal(second.added, 0)
  assert.equal(second.merged, 12)
  assert.equal((await store.readItems()).length, 12)
})

test('collect refuses without the host permission, and reads nothing', async () => {
  await fresh()
  await globalThis.browser.permissions.remove({ origins: [YT_ORIGIN] })

  const result = await send('collect', { tabId: 1, url: WL, connectorId: 'youtube' })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'needs-permission')
  assert.equal((await store.readItems()).length, 0)

  await globalThis.browser.permissions.request({ origins: [YT_ORIGIN] })
})

// ── import / export ───────────────────────────────────────────────────────────

test('EXPORT then IMPORT round-trips through the extension', async () => {
  await fresh()
  await send('collect', { tabId: 1, url: WL, connectorId: 'youtube' })

  const exported = await send('exportAll')
  assert.equal(exported.ok, true)
  assert.equal(exported.count, 12)

  await fresh()
  const imported = await send('importFile', { text: exported.text, name: 'backup.jsonl' })
  assert.equal(imported.ok, true, `import failed: ${imported.reason ?? imported.error}`)
  assert.equal(imported.kind, 'interchange')
  assert.equal((await store.readItems()).length, 12)
})

test('IMPORTING A SAVED PAGE stores it', async () => {
  // The second call site of the same TypeError.
  await fresh()
  const result = await send('importFile', {
    text: html, name: 'watch-later.html', connectorId: 'youtube', url: WL,
  })

  assert.equal(result.ok, true, `import failed: ${result.reason ?? result.error}`)
  assert.equal(result.kind, 'saved-page')
  assert.equal(result.connector, 'youtube')
  assert.equal((await store.readItems()).length, 12)
})

test('a saved page that does not identify itself is refused, actionably', async () => {
  // Real saved pages usually say what they are — the measured Watch Later capture carries
  // <link rel="canonical">. This fixture does not, which is the case the UI has to handle: the
  // worker CAN be told which connector to use, but the collection page does not yet ask.
  await fresh()
  const result = await send('importFile', { text: html, name: 'anonymous.html' })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'no-connector')
  assert.equal((await store.readItems()).length, 0)
})

test('import is not destructive: items absent from the file survive', async () => {
  await fresh()
  const { createItem } = await import('../vendor/core/index.js')
  const { mergeItems } = await import('../vendor/core/index.js')

  await send('collect', { tabId: 1, url: WL, connectorId: 'youtube' })
  await store.upsertItems([createItem({
    source: 'makerworld', sourceId: '9000001', kind: 'model', title: 'Hex Bit Caddy',
  })], { mergeItems })
  assert.equal((await store.readItems()).length, 13)

  const partial = await send('exportAll', { source: 'youtube' })
  assert.equal(partial.count, 12)

  const imported = await send('importFile', { text: partial.text, name: 'partial.jsonl', force: true })
  assert.equal(imported.ok, true)
  assert.equal((await store.readItems()).length, 13, 'the MakerWorld item was not in the file')
})

test('an imported item keeps its raw OUT of the items store', async () => {
  // The interchange format carries `raw` inline. Writing those records straight into `items`
  // put verbatim page bodies in the hot path of every read and skipped MAX_RAW_BYTES entirely.
  await fresh()
  const { createItem, toJsonl } = await import('../vendor/core/index.js')

  const withRaw = createItem({
    source: 'youtube', sourceId: 'vidDDDDDDDD', kind: 'video', title: 'has a raw',
    raw: { body: '<div>a body</div>', contentType: 'text/html', capturedAt: 5 },
  })
  const oversize = createItem({
    source: 'youtube', sourceId: 'vidEEEEEEEE', kind: 'video', title: 'too big',
    raw: { body: 'y'.repeat(store.MAX_RAW_BYTES + 1), contentType: 'text/html' },
  })

  const result = await send('importFile', {
    text: toJsonl({ items: [withRaw, oversize], meta: { generation: 99, lineage: 'elsewhere' } }),
    name: 'shared.jsonl',
  })
  assert.equal(result.ok, true, `import failed: ${result.reason ?? result.error}`)

  for (const item of await store.readItems()) {
    assert.equal(item.raw, null, `${item.id} carried its raw into the items store`)
  }
  assert.equal((await store.readRaw('youtube:vidDDDDDDDD')).body, '<div>a body</div>')
  assert.equal((await store.readRaw('youtube:vidEEEEEEEE')).omitted, 'oversize')
})

test('a stale snapshot of this same store is refused', async () => {
  await fresh()
  await send('collect', { tabId: 1, url: WL, connectorId: 'youtube' })
  const snapshot = await send('exportAll')

  // exportAll stamps the store's own lineage, so re-importing it at an older generation is
  // exactly the rollback the counter exists to stop.
  await send('collect', { tabId: 1, url: WL, connectorId: 'youtube' })

  const refused = await send('importFile', { text: snapshot.text, name: 'old.jsonl' })
  assert.equal(refused.ok, false)
  assert.equal(refused.reason, 'stale')

  const forced = await send('importFile', { text: snapshot.text, name: 'old.jsonl', force: true })
  assert.equal(forced.ok, true, 'the user must be able to override, or a wipe is unrecoverable')
})

test('stats counts what the collection page shows', async () => {
  await fresh()
  await send('collect', { tabId: 1, url: WL, connectorId: 'youtube' })

  const s = await send('stats')
  assert.equal(s.items, 12)
  assert.equal(s.gone, 2)
  assert.equal(s.bySource.youtube, 12)
  assert.ok(s.generation >= 1)
})
