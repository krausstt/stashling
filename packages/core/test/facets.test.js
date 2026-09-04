/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  validateFacetManifest, facetValue, facetRange, termCounts,
  matchesFilter, applyFilters, logGauge,
} from '../src/facets.js'
import { createItem } from '../src/item.js'
import { validateConnector, ACQUISITION_STRATEGIES } from '../src/connector.js'

const LENGTH = { key: 'metrics.durationSec', label: 'Length', type: 'range', unit: 'min', scale: 60, cap: 60, capOpen: true }
const CHANNEL = { key: 'byline.name', label: 'Channel', type: 'term' }
const TAGS = { key: 'tags', label: 'Tags', type: 'term' }

const video = (id, sec, channel, tags = []) =>
  createItem({ source: 'youtube', sourceId: id, kind: 'video', title: id,
    metrics: sec == null ? {} : { durationSec: sec }, byline: { name: channel }, tags })

test('the same range facet expresses "print time <= 4h" and "under 30 minutes"', () => {
  // One code path, two domains. That is the whole point of the flat metrics map.
  const PRINT = { key: 'metrics.printTimeHours', label: 'Print time', type: 'range', unit: 'h' }
  const model = createItem({ source: 'makerworld', sourceId: '1', metrics: { printTimeHours: 3.5 } })
  assert.equal(matchesFilter(model, PRINT, { max: 4 }), true)
  assert.equal(matchesFilter(video('a', 1800), LENGTH, { max: 30 }), true)
  assert.equal(matchesFilter(video('b', 2400), LENGTH, { max: 30 }), false)
})

test('scale converts to display units', () => {
  assert.equal(facetValue(video('a', 1938), LENGTH), 32.3)
  // A null byline.name reads as ABSENT (undefined), not as the value null — same rule as a
  // missing metric, so a term filter narrows rather than matching an empty string.
  assert.equal(facetValue(video('a', 1938), CHANNEL), undefined)
  assert.equal(facetValue(video('a', 1938, 'Alexandre Chappel'), CHANNEL), 'Alexandre Chappel')
})

test('an item that LACKS the facet does not match a filter on it', () => {
  // Absent is not zero. A mixed-source collection narrows to the items the filter can speak
  // about, instead of silently ranking absent values as the minimum.
  const noDuration = video('x', null, 'Someone')
  assert.equal(facetValue(noDuration, LENGTH), undefined)
  assert.equal(matchesFilter(noDuration, LENGTH, { max: 30 }), false)
  assert.equal(matchesFilter(noDuration, LENGTH, { min: 0 }), false)
})

test('capOpen means the top of the slider is "60+ min" and passes everything above', () => {
  const long = video('long', 7200) // 120 min
  assert.equal(matchesFilter(long, LENGTH, { max: 60 }), true, 'at the open cap, longer still matches')
  assert.equal(matchesFilter(long, LENGTH, { max: 45 }), false, 'below the cap it is a real bound')
})

test('facetRange reports null when no item carries the facet', () => {
  assert.equal(facetRange([video('a', null), video('b', null)], LENGTH), null)
  const r = facetRange([video('a', 60), video('b', 3600), video('c', null)], LENGTH)
  assert.deepEqual({ min: r.min, max: r.max, count: r.count }, { min: 1, max: 60, count: 2 })
})

test('term facets count arrays element-wise, most frequent first', () => {
  const items = [video('a', 10, 'X', ['diy', '3dp']), video('b', 10, 'Y', ['3dp'])]
  assert.deepEqual(termCounts(items, TAGS), [{ value: '3dp', count: 2 }, { value: 'diy', count: 1 }])
  assert.deepEqual(termCounts(items, CHANNEL), [{ value: 'X', count: 1 }, { value: 'Y', count: 1 }])
})

test('applyFilters is AND across facets, OR within one', () => {
  const items = [video('a', 600, 'X', ['3dp']), video('b', 600, 'Y', ['diy']), video('c', 9000, 'X', ['3dp'])]
  const out = applyFilters(items, [LENGTH, CHANNEL], { 'metrics.durationSec': { max: 30 }, 'byline.name': { any: ['X', 'Z'] } })
  assert.deepEqual(out.map((i) => i.sourceId), ['a'])
  assert.equal(applyFilters(items, [LENGTH, CHANNEL], {}).length, 3)
})

test('logGauge normalizes power-law counts against the dataset maximum', () => {
  assert.equal(logGauge(0, 1000), 0)
  assert.equal(Math.round(logGauge(1000, 1000)), 100)
  assert.ok(logGauge(100, 1_000_000) > 30, 'a linear scale would render this as a sliver')
  assert.equal(logGauge(5, 0), 0)
  assert.equal(logGauge('nope', 10), 0)
})

test('the facet manifest is validated, including duplicate keys', () => {
  assert.deepEqual(validateFacetManifest([LENGTH, CHANNEL]), [])
  const problems = validateFacetManifest([{ key: 'a', label: 'A', type: 'nope' }, LENGTH, LENGTH])
  assert.ok(problems.some((p) => p.includes('type must be one of')))
  assert.ok(problems.some((p) => p.includes('duplicate facet key')))
})

test('a dom-active-tab connector MUST declare a scope', () => {
  // Scope-then-extract is mandatory, not stylistic: a real Watch Later page holds 639 unique
  // watch?v= ids but only 582 real rows. The surplus leaks in from sidebars.
  const bad = {
    id: 'x', kind: 'video', version: '1.0.0', match: () => true, lists: [], facets: [],
    acquisition: { strategy: ACQUISITION_STRATEGIES.DOM_ACTIVE_TAB },
    parseList: () => [], normalize: () => ({}),
  }
  assert.ok(validateConnector(bad).some((p) => p.includes('acquisition.scope is required')))
  assert.deepEqual(validateConnector({ ...bad, acquisition: { ...bad.acquisition, scope: 'x-row' } }), [])
})

test('validateConnector catches the ordinary mistakes', () => {
  const problems = validateConnector({ id: 'Bad Id', lists: 'no', facets: 'no', acquisition: { strategy: 'telepathy' } })
  assert.ok(problems.some((p) => p.includes('must be lowercase')))
  assert.ok(problems.some((p) => p.includes('kind is required')))
  assert.ok(problems.some((p) => p.includes('version is required')))
  assert.ok(problems.some((p) => p.includes('match(url)')))
  assert.ok(problems.some((p) => p.includes('lists must be an array')))
  assert.ok(problems.some((p) => p.includes('is not one of')))
  assert.ok(problems.some((p) => p.includes('parseList')))
  assert.ok(problems.some((p) => p.includes('normalize')))
})
