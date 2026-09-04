/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  SOURCE_PRECEDENCE, rank, makeAttr, attrValue, resolveAttrs, readAttr,
  resolvedValues, opinions, upsertAttrs,
} from '../src/precedence.js'

const attr = (source, value, extra = {}) =>
  makeAttr({ itemId: 'youtube:abc', key: 'topic', value, source, ...extra })

test('the user always wins', () => {
  const rows = [attr('rules', 'article'), attr('cloud', 'paper'), attr('user', 'reference')]
  assert.equal(readAttr(rows, 'topic'), 'reference')
})

test('an unknown source ranks last and can never beat a known one', () => {
  assert.equal(rank('user'), 0)
  assert.ok(rank('a-plugin-from-2029') > rank(SOURCE_PRECEDENCE.at(-1)))
  assert.equal(readAttr([attr('a-plugin-from-2029', 'x'), attr('rules', 'y')], 'topic'), 'y')
  // ...but it still wins when it is the only opinion. Degrade safely, do not discard.
  assert.equal(readAttr([attr('a-plugin-from-2029', 'x')], 'topic'), 'x')
})

test('ties break by observedAt DESC then confidence DESC, never by iteration order', () => {
  const older = attr('cloud', 'old', { observedAt: 100 })
  const newer = attr('cloud', 'new', { observedAt: 200 })
  assert.equal(readAttr([older, newer], 'topic'), 'new')
  assert.equal(readAttr([newer, older], 'topic'), 'new', 'result must not depend on row order')

  const low = attr('cloud', 'low', { observedAt: 100, confidence: 0.2 })
  const high = attr('cloud', 'high', { observedAt: 100, confidence: 0.9 })
  assert.equal(readAttr([low, high], 'topic'), 'high')
  assert.equal(readAttr([high, low], 'topic'), 'high')
})

test('typed value columns keep numeric and time comparisons out of string parsing', () => {
  const n = makeAttr({ itemId: 'i', key: 'wordCount', value: 1200, source: 'rules' })
  assert.equal(n.valueNum, 1200)
  assert.equal(n.valueText, null)
  const t = makeAttr({ itemId: 'i', key: 'publishedAt', value: 1750000000, source: 'connector', kind: 'time' })
  assert.equal(t.valueTime, 1750000000)
  assert.equal(attrValue(t), 1750000000)
  assert.throws(() => makeAttr({ itemId: 'i', key: 'k', value: 'x', source: 's', kind: 'num' }), /finite/)
})

test('re-running a source is idempotent — UNIQUE(itemId, key, source) is an upsert', () => {
  let rows = []
  rows = upsertAttrs(rows, attr('cloud', 'first', { observedAt: 1 }))
  rows = upsertAttrs(rows, attr('user', 'mine'))
  rows = upsertAttrs(rows, attr('cloud', 'second', { observedAt: 2 }))
  assert.equal(rows.length, 2, 'a re-run replaces that source own opinion, not everyone else')
  assert.equal(readAttr(rows, 'topic'), 'mine')
  assert.equal(rows.find((r) => r.source === 'cloud').valueText, 'second')
})

test('enrichment cannot destroy curation', () => {
  let rows = upsertAttrs([], attr('user', 'reference'))
  // A cloud batch runs three times and never dislodges the human.
  for (let i = 0; i < 3; i += 1) rows = upsertAttrs(rows, attr('cloud', `guess-${i}`, { observedAt: i }))
  assert.equal(readAttr(rows, 'topic'), 'reference')
  assert.ok(rows.some((r) => r.source === 'cloud'), 'the losing opinion still persists')
})

test('disagreement is inspectable, best first', () => {
  const rows = [attr('rules', 'article'), attr('user', 'reference'), attr('local-model', 'paper')]
  assert.deepEqual(opinions(rows, 'topic').map((o) => [o.source, o.value]), [
    ['user', 'reference'], ['local-model', 'paper'], ['rules', 'article'],
  ])
})

test('resolveAttrs and resolvedValues cover every key independently', () => {
  const rows = [
    makeAttr({ itemId: 'i', key: 'topic', value: 'article', source: 'rules' }),
    makeAttr({ itemId: 'i', key: 'topic', value: 'reference', source: 'user' }),
    makeAttr({ itemId: 'i', key: 'wordCount', value: 900, source: 'rules' }),
  ]
  assert.deepEqual(resolvedValues(rows), { topic: 'reference', wordCount: 900 })
  assert.equal(resolveAttrs(rows).size, 2)
})

test('makeAttr refuses incomplete rows', () => {
  assert.throws(() => makeAttr({ key: 'k', value: 1, source: 's' }), /itemId/)
  assert.throws(() => makeAttr({ itemId: 'i', value: 1, source: 's' }), /key/)
  assert.throws(() => makeAttr({ itemId: 'i', key: 'k', value: 1 }), /source/)
})
