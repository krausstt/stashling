/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import test from 'node:test'
import assert from 'node:assert/strict'
import { toJsonl, fromJsonl, shouldAccept, mergeBundle } from '../src/interchange.js'
import { createItem } from '../src/item.js'
import { makeAttr } from '../src/precedence.js'

const items = () => [
  createItem({
    source: 'youtube', sourceId: 'gPW_mitgosw', kind: 'video',
    title: 'Everything I know about 3D Printing',
    url: 'https://www.youtube.com/watch?v=gPW_mitgosw&list=WL&index=1',
    byline: { name: 'Alexandre Chappel', handle: '@achappel' },
    lists: ['watch-later'], order: { 'watch-later': 1 },
    metrics: { views: 612000, durationSec: 1938 },
    times: { firstSeenAt: 10, lastSeenAt: 20, capturedAt: 20 },
    user: { notes: 'watch before the next print', userTags: ['3dp'], futureKey: { kept: true } },
    ext: { channelId: 'UC123' },
  }),
  createItem({ source: 'makerworld', sourceId: '1234', kind: 'model', title: 'Toy Pistol' }),
]

test('ROUND TRIP: fromJsonl(toJsonl(x)) is deep-equal to x, user zone included', () => {
  // The step-one test. None of the three source tools can re-ingest its own export.
  const original = items()
  const parsed = fromJsonl(toJsonl({ items: original }))
  assert.deepEqual(parsed.items, original)
  assert.deepEqual(parsed.items[0].user, original[0].user)
  assert.equal(parsed.errors.length, 0)
})

test('the meta line records schema, count and generation', () => {
  const text = toJsonl({ items: items(), meta: { generation: 3, exportedAt: 1234 } })
  const { meta } = fromJsonl(text)
  assert.equal(meta.schema, 1)
  assert.equal(meta.count, 2)
  assert.equal(meta.generation, 3)
  assert.equal(meta.exportedAt, 1234)
  assert.match(meta.generator, /^stashling\//)
})

test('attrs and signals round-trip alongside items', () => {
  const attrs = [makeAttr({ itemId: 'youtube:gPW_mitgosw', key: 'topic', value: '3d-printing', source: 'rules', confidence: 0.8 })]
  const signals = [{ itemId: 'youtube:gPW_mitgosw', action: 'kept', at: 99 }]
  const parsed = fromJsonl(toJsonl({ items: items(), attrs, signals }))
  assert.deepEqual(parsed.attrs, attrs)
  assert.deepEqual(parsed.signals, signals)
})

test('unknown record types are ignored by contract, not treated as errors', () => {
  const text = [toJsonl({ items: [] }), JSON.stringify({ type: 'from-the-future', x: 1 })].join('\n')
  const parsed = fromJsonl(text)
  assert.equal(parsed.errors.length, 0)
  assert.equal(parsed.unknown.length, 1)
})

test('a malformed line is recorded and skipped, never fatal', () => {
  const good = toJsonl({ items: items() })
  const text = good.split('\n').flatMap((l, i) => (i === 1 ? ['{ not json', l] : [l])).join('\n')
  const parsed = fromJsonl(text)
  assert.equal(parsed.items.length, 2, 'the other 2 items still import')
  assert.equal(parsed.errors.length, 1)
  assert.equal(parsed.errors[0].line, 2)
})

test('blank lines and a trailing newline are tolerated', () => {
  const parsed = fromJsonl(toJsonl({ items: items() }) + '\n\n')
  assert.equal(parsed.items.length, 2)
  assert.equal(parsed.errors.length, 0)
})

test('a stale snapshot of the SAME store is discarded rather than imported', () => {
  assert.equal(shouldAccept(5, { generation: 6 }), true)
  assert.equal(shouldAccept(5, { generation: 5 }), false)
  assert.equal(shouldAccept(5, { generation: 2 }), false)
  // Neither side tracking generations is a valid, permissive state.
  assert.equal(shouldAccept(0, { generation: 0 }), true)
  // An object form carrying the same lineage behaves identically.
  assert.equal(shouldAccept({ generation: 5, lineage: 'a' }, { generation: 2, lineage: 'a' }), false)
  assert.equal(shouldAccept({ generation: 5, lineage: 'a' }, { generation: 9, lineage: 'a' }), true)
})

test('a DIFFERENT collection always merges — the guard is not about that', () => {
  // The counter exists to stop a stale snapshot of THIS store rolling it back. A fresh scrape
  // or a second source is additive and non-destructive, and refusing it because its counter
  // starts at 1 is the guard firing on the wrong thing.
  assert.equal(shouldAccept({ generation: 9, lineage: 'my-store' }, { generation: 1, lineage: 'youtube:watch-later' }), true)
  // An unlabelled file gets the conservative reading: it might be a snapshot of this store.
  assert.equal(shouldAccept({ generation: 9, lineage: 'my-store' }, { generation: 1 }), false)
  assert.equal(shouldAccept({ generation: 9 }, { generation: 1, lineage: 'elsewhere' }), false)
})

test('lineage round-trips through the meta line, and is omitted when unset', () => {
  const withLineage = fromJsonl(toJsonl({ items: [], meta: { lineage: 'youtube:watch-later', generation: 3 } }))
  assert.equal(withLineage.meta.lineage, 'youtube:watch-later')
  assert.equal(withLineage.meta.generation, 3)
  assert.equal('lineage' in fromJsonl(toJsonl({ items: [] })).meta, false)
})

test('IMPORT IS NOT DESTRUCTIVE: a partial file never deletes local items', () => {
  // catalogue-app clears the store before ingest, so importing a filtered export permanently
  // deletes every record and annotation absent from that file. This asserts the opposite.
  const local = { items: items(), attrs: [] }
  const partial = fromJsonl(toJsonl({ items: [items()[0]] }))
  const result = mergeBundle(local, partial)
  assert.equal(result.items.length, 2, 'the item missing from the file survives')
  assert.equal(result.added, 0)
  assert.equal(result.merged, 1)
})

test('import merges user keys on top of local ones without deleting any', () => {
  const local = { items: [createItem({ source: 'a', sourceId: '1', user: { localOnly: 1, notes: 'local' } })] }
  const incoming = fromJsonl(toJsonl({
    items: [createItem({ source: 'a', sourceId: '1', user: { remoteOnly: 2, notes: 'remote' } })],
  }))
  const { items: merged } = mergeBundle(local, incoming)
  assert.deepEqual(merged[0].user, { localOnly: 1, notes: 'remote', remoteOnly: 2 })
})

test('imported attrs are stamped source:"import" and cannot outrank the user', async () => {
  const local = {
    items: [],
    attrs: [makeAttr({ itemId: 'a:1', key: 'topic', value: 'mine', source: 'user' })],
  }
  const incoming = fromJsonl(toJsonl({
    items: [],
    attrs: [{ itemId: 'a:1', key: 'topic', valueText: 'theirs', valueNum: null, valueTime: null, confidence: 1, observedAt: 99 }],
  }))
  const { attrs } = mergeBundle(local, incoming)
  assert.equal(attrs.length, 2)
  assert.ok(attrs.some((r) => r.source === 'import' && r.valueText === 'theirs'))
  const { readAttr } = await import('../src/precedence.js')
  assert.equal(readAttr(attrs, 'topic'), 'mine')
})

test('importing new items adds them', () => {
  const incoming = fromJsonl(toJsonl({ items: items() }))
  const result = mergeBundle({ items: [] }, incoming)
  assert.equal(result.added, 2)
  assert.equal(result.merged, 0)
})

test('an empty file parses to an empty bundle rather than throwing', () => {
  const parsed = fromJsonl('')
  assert.deepEqual(parsed.items, [])
  assert.equal(parsed.meta, null)
  assert.equal(parsed.errors.length, 0)
})
