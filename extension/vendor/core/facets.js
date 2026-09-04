/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Generic faceting. This is the payoff of the `metrics` design: a connector supplies a
 * facet manifest (label, unit, scale, cap, log) and a UI that knows nothing about 3D
 * printing or video renders a working filter for both. "Print time ≤ 4 h" and "under 30
 * minutes" become the same code path.
 *
 * Facet descriptor:
 *   { key, label, type: "range"|"term"|"bool", unit?, scale?, cap?, capOpen?, log? }
 *
 *   scale    divide the raw value by this for display (durationSec → minutes: 60)
 *   cap      clamp the slider's upper bound to this DISPLAY value
 *   capOpen  the cap is open-ended ("60+ min"), so a value above it still matches
 *   log      the distribution is power-law; render on a log axis
 */

import { readPath } from './item.js'

const FACET_TYPES = new Set(['range', 'term', 'bool'])

export function validateFacet(facet) {
  const problems = []
  if (!facet || typeof facet !== 'object') return ['facet is not an object']
  if (!facet.key) problems.push('facet.key is required')
  if (!facet.label) problems.push(`facet ${facet.key}: label is required`)
  if (!FACET_TYPES.has(facet.type)) {
    problems.push(`facet ${facet.key}: type must be one of ${[...FACET_TYPES].join('|')}`)
  }
  if (facet.type === 'range') {
    if (facet.scale !== undefined && !(Number(facet.scale) > 0)) {
      problems.push(`facet ${facet.key}: scale must be a positive number`)
    }
    if (facet.cap !== undefined && !Number.isFinite(Number(facet.cap))) {
      problems.push(`facet ${facet.key}: cap must be a number`)
    }
  }
  return problems
}

export function validateFacetManifest(facets) {
  const problems = []
  const seen = new Set()
  for (const f of facets ?? []) {
    problems.push(...validateFacet(f))
    if (f?.key) {
      if (seen.has(f.key)) problems.push(`duplicate facet key: ${f.key}`)
      seen.add(f.key)
    }
  }
  return problems
}

/** Display value for a facet, honouring `scale`. `undefined` when the item lacks it. */
export function facetValue(item, facet) {
  const raw = readPath(item, facet.key)
  if (raw === undefined || raw === null) return undefined
  if (facet.type === 'range') {
    const n = Number(raw)
    if (!Number.isFinite(n)) return undefined
    return facet.scale ? n / Number(facet.scale) : n
  }
  return raw
}

/**
 * Observed range across a collection, in display units.
 * Returns `null` when NO item carries the facet — which the UI must render as "this filter
 * does not apply here", not as an empty 0–0 slider.
 */
export function facetRange(items, facet) {
  let min = Infinity
  let max = -Infinity
  let count = 0
  for (const item of items ?? []) {
    const v = facetValue(item, facet)
    if (v === undefined) continue
    count += 1
    if (v < min) min = v
    if (v > max) max = v
  }
  if (!count) return null
  return { min, max, count, capped: facet.cap !== undefined && max > Number(facet.cap) }
}

/** Term facet: value → count, most frequent first. Arrays contribute each element. */
export function termCounts(items, facet) {
  const counts = new Map()
  for (const item of items ?? []) {
    const v = facetValue(item, facet)
    if (v === undefined) continue
    for (const term of Array.isArray(v) ? v : [v]) {
      const key = String(term)
      if (!key) continue
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
  }
  return [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value))
}

/**
 * Does an item pass one filter?
 *
 * An item that LACKS the facet does not match a filter on it. That is deliberate and it is
 * the same rule as `metrics` omission: absent is not zero. A collection mixing sources
 * therefore narrows to the items the filter can actually speak about, rather than silently
 * ranking absent values as the minimum.
 */
export function matchesFilter(item, facet, filter) {
  if (!filter) return true
  const v = facetValue(item, facet)

  if (facet.type === 'range') {
    if (v === undefined) return false
    const { min, max } = filter
    if (min !== undefined && min !== null && v < Number(min)) return false
    if (max !== undefined && max !== null) {
      const cap = facet.cap !== undefined ? Number(facet.cap) : undefined
      // An open-ended cap means "60+ min": at the top of the slider, everything above passes.
      const atOpenCap = facet.capOpen && cap !== undefined && Number(max) >= cap
      if (!atOpenCap && v > Number(max)) return false
    }
    return true
  }

  if (facet.type === 'bool') return v === undefined ? false : Boolean(v) === Boolean(filter.value)

  // term
  const wanted = filter.any ?? filter.values ?? (filter.value !== undefined ? [filter.value] : [])
  if (!wanted.length) return true
  if (v === undefined) return false
  const have = new Set((Array.isArray(v) ? v : [v]).map(String))
  return wanted.some((w) => have.has(String(w)))
}

/**
 * Apply a whole filter set. `filters` is `{ [facet.key]: filterSpec }`.
 * AND across facets, OR within a facet's `any`.
 */
export function applyFilters(items, facets, filters) {
  const active = (facets ?? []).filter((f) => filters?.[f.key] !== undefined)
  if (!active.length) return (items ?? []).slice()
  return (items ?? []).filter((item) => active.every((f) => matchesFilter(item, f, filters[f.key])))
}

/**
 * 0–100 gauge, log-normalized against the dataset maximum.
 *
 * Counts in these collections are power-law distributed: linear normalization renders every
 * item as a sliver next to one outlier. Comparability is WITHIN the loaded dataset only —
 * these numbers mean nothing across two different collections, and a UI should not imply
 * otherwise.
 */
export function logGauge(value, datasetMax) {
  const v = Number(value)
  const m = Number(datasetMax)
  if (!Number.isFinite(v) || !Number.isFinite(m) || m <= 0) return 0
  return (Math.log10(v + 1) / Math.log10(m + 1)) * 100
}
