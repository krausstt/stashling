/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import test from 'node:test'
import assert from 'node:assert/strict'
import { createItem, validateItem, makeId, parseId, normalizeMetrics, readPath } from '../src/item.js'
import { mergeItems, mergeUser, mergeLists, rearmLiveness } from '../src/merge.js'

const base = () => ({ source: 'youtube', sourceId: 'gPW_mitgosw', kind: 'video', title: 'A video' })

test('id is source:sourceId and round-trips', () => {
  assert.equal(makeId('youtube', 'abc'), 'youtube:abc')
  assert.deepEqual(parseId('youtube:abc'), { source: 'youtube', sourceId: 'abc' })
  // A sourceId may legitimately contain colons; only the FIRST colon separates.
  assert.deepEqual(parseId('urn:isbn:12345'), { source: 'urn', sourceId: 'isbn:12345' })
  assert.throws(() => makeId('you:tube', 'abc'), /must not contain/)
  assert.throws(() => parseId('nocolon'), /malformed/)
})

test('createItem fills every required field and validates clean', () => {
  const item = createItem(base())
  assert.equal(item.id, 'youtube:gPW_mitgosw')
  assert.deepEqual(validateItem(item), [])
  assert.equal(item.liveness.state, 'unknown')
  assert.equal(item.membership.state, 'listed')
  assert.deepEqual(item.user, {})
  assert.equal(item.raw, null)
})

test('metrics drop non-finite values instead of coercing them to zero', () => {
  // An absent metric must stay distinguishable from a zero one.
  const m = normalizeMetrics({ views: 612000, durationSec: '1938', bad: 'n/a', nan: NaN, inf: Infinity, zero: 0 })
  assert.deepEqual(m, { views: 612000, durationSec: 1938, zero: 0 })
  assert.equal('bad' in m, false)
  assert.equal('nan' in m, false)
})

test('byline name and url are optional — measured reality, not an error case', () => {
  // 19 of 582 real YouTube rows (3.3%) have a link-less byline anchor; 3 have no name at all.
  // Those are auto-generated/multi-owner bylines, NOT deleted videos.
  const item = createItem({ ...base(), byline: { name: 'Google DeepMind and Apptronik' } })
  assert.equal(item.byline.url, null)
  assert.deepEqual(validateItem(item), [])
})

test('THE user zone is passed through verbatim, including unknown keys', () => {
  // The regression that bit MakerWorld for real: makeUserMeta() rebuilt this object from five
  // known keys and silently deleted userTags/related/parts/links on every re-scrape.
  const user = {
    printed: true,
    userTags: ['gift'],
    related: [{ id: 'x', relation: 'goes-with', note: '' }],
    parts: [{ name: 'M3 screw', qty: 4 }],
    links: [{ label: 'BOM', url: 'https://e.x', kind: 'bom' }],
    aKeyInventedNextYear: { nested: true },
  }
  const item = createItem({ ...base(), user })
  assert.deepEqual(item.user, user)
})

test('a connector re-scrape NEVER touches the user zone', () => {
  const stored = createItem({ ...base(), user: { notes: 'mine', userTags: ['keep'] } })
  const fresh = createItem({ ...base(), title: 'A video (updated)', user: {} })
  const merged = mergeItems(stored, fresh, { writer: 'connector' })
  assert.deepEqual(merged.user, { notes: 'mine', userTags: ['keep'] })
  assert.equal(merged.title, 'A video (updated)')
})

test('an import merges user keys on top without deleting local ones', () => {
  const stored = createItem({ ...base(), user: { notes: 'mine', localOnly: 1 } })
  const incoming = createItem({ ...base(), user: { notes: 'theirs', remoteOnly: 2 } })
  const merged = mergeItems(stored, incoming, { writer: 'import' })
  assert.deepEqual(merged.user, { notes: 'theirs', localOnly: 1, remoteOnly: 2 })
})

test('mergeUser keeps keys present only on one side', () => {
  assert.deepEqual(mergeUser({ a: 1, b: 2 }, { b: 3, c: 4 }), { a: 1, b: 3, c: 4 })
  assert.deepEqual(mergeUser(undefined, undefined), {})
})

test('lists are a set union across scrapes; order merges', () => {
  assert.deepEqual(mergeLists(['likes'], ['downloads', 'likes']), ['likes', 'downloads'])
  const a = createItem({ ...base(), lists: ['likes'], order: { likes: 3 } })
  const b = createItem({ ...base(), lists: ['downloads'], order: { downloads: 1 } })
  const m = mergeItems(a, b)
  assert.deepEqual(m.lists, ['likes', 'downloads'])
  assert.deepEqual(m.order, { likes: 3, downloads: 1 })
})

test('metrics merge rather than replace — an unobserved metric did not become zero', () => {
  const a = createItem({ ...base(), metrics: { views: 100, durationSec: 60 } })
  const b = createItem({ ...base(), metrics: { views: 150 } })
  assert.deepEqual(mergeItems(a, b).metrics, { views: 150, durationSec: 60 })
})

test('firstSeenAt takes the earlier value; lastSeenAt the later', () => {
  const a = createItem({ ...base(), times: { firstSeenAt: 500, lastSeenAt: 500 } })
  const b = createItem({ ...base(), times: { firstSeenAt: 900, lastSeenAt: 900 } })
  const m = mergeItems(a, b)
  assert.equal(m.times.firstSeenAt, 500)
  assert.equal(m.times.lastSeenAt, 900)
  assert.equal(m.sightings, 2)
})

test('an empty incoming title does not wipe a stored one', () => {
  // Kleinanzeigen depends on this: a redirect-deleted detail page parses as title:null, and a
  // naive replace would erase the record you kept it for.
  const stored = createItem({ ...base(), title: 'Real title' })
  const blank = createItem({ ...base(), title: '' })
  assert.equal(mergeItems(stored, blank).title, 'Real title')
  // ...unless the caller genuinely observed a cleared value.
  assert.equal(mergeItems(stored, blank, { allowClear: true }).title, '')
})

test('a stale liveness probe never overwrites a fresher one', () => {
  const fresh = createItem({ ...base(), liveness: { state: 'gone', checkedAt: 900, evidence: 'redirect' } })
  const stale = createItem({ ...base(), liveness: { state: 'live', checkedAt: 100 } })
  assert.equal(mergeItems(fresh, stale).liveness.state, 'gone')
  assert.equal(mergeItems(stale, fresh).liveness.state, 'gone')
})

test('liveness and membership are two independent axes', () => {
  // An item can be live on the site AND removed from your collection. Collapsing these loses
  // the difference between "the platform deleted it" and "I removed it".
  const item = createItem({
    ...base(),
    liveness: { state: 'live', checkedAt: 10 },
    membership: { state: 'unlisted', checkedAt: 10 },
  })
  assert.deepEqual(validateItem(item), [])
  assert.equal(item.liveness.state, 'live')
  assert.equal(item.membership.state, 'unlisted')
})

test('re-sighting re-arms a terminal liveness state', () => {
  const dead = createItem({ ...base(), liveness: { state: 'gone', checkedAt: 1, attempts: 4 } })
  const rearmed = rearmLiveness(dead, 99)
  assert.equal(rearmed.liveness.state, 'unknown')
  assert.equal(rearmed.liveness.attempts, 0)
  // A live item is left alone.
  const live = createItem({ ...base(), liveness: { state: 'live', checkedAt: 1 } })
  assert.equal(rearmLiveness(live, 99), live)
})

test('ext is connector-owned and replaced wholesale, but an empty ext does not erase one', () => {
  const a = createItem({ ...base(), ext: { printProfiles: [1, 2] } })
  const b = createItem({ ...base(), ext: { printProfiles: [3] } })
  assert.deepEqual(mergeItems(a, b).ext, { printProfiles: [3] })
  assert.deepEqual(mergeItems(a, createItem(base())).ext, { printProfiles: [1, 2] })
})

test('merging two different ids is a programming error, not a silent join', () => {
  const a = createItem(base())
  const b = createItem({ ...base(), sourceId: 'other' })
  assert.throws(() => mergeItems(a, b), /id mismatch/)
})

test('validateItem reports problems instead of throwing on the first bad row', () => {
  const problems = validateItem({ id: 'a:b', source: 'a', sourceId: 'c', kind: 'x', url: '', title: '',
    lists: 'nope', metrics: { bad: 'x' }, times: {}, sightings: 1,
    liveness: { state: 'ghost' }, membership: { state: 'maybe' }, ext: {}, user: [] })
  assert.ok(problems.some((p) => p.includes('does not match source/sourceId')))
  assert.ok(problems.some((p) => p.includes('lists must be an array')))
  assert.ok(problems.some((p) => p.includes('metrics.bad')))
  assert.ok(problems.some((p) => p.includes('liveness.state')))
  assert.ok(problems.some((p) => p.includes('membership.state')))
  assert.ok(problems.some((p) => p.includes('user must be an object')))
})

test('readPath walks dotted facet keys', () => {
  const item = createItem({ ...base(), metrics: { durationSec: 1938 }, byline: { name: 'X' } })
  assert.equal(readPath(item, 'metrics.durationSec'), 1938)
  assert.equal(readPath(item, 'byline.name'), 'X')
  assert.equal(readPath(item, 'nope.nope'), undefined)
})
