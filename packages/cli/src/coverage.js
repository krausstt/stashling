/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Field coverage — the headline number of this whole tool.
 *
 * A scraper does not fail loudly when a platform redesigns; it keeps returning rows with one
 * field quietly empty. **A drop from 100% to 96% on `title` is how you find out YouTube
 * changed overnight**, and it is invisible to any check that only asks "did it throw?" or
 * "did I get 582 rows?". So coverage is computed per field, in percent, over every command
 * that touches a collection.
 *
 * PRESENCE IS NOT TRUTHINESS. `0` and `false` are PRESENT; `null`, `undefined`, `''`, `[]`
 * and `{}` are absent. This is the `metrics` rule from ITEM-CONTRACT §3 applied to reporting:
 * a metric that is absent is different from a metric that is zero, and a coverage table that
 * conflates them would report a video of 0 views as a parse failure.
 *
 * Fields that are LEGITIMATELY incomplete are the reason this reports a percentage instead of
 * a pass/fail: measured on a real 582-item Watch Later page, 3 rows (0.5%) have no channel
 * name and 19 (3.3%) have no channel URL, because auto-generated and multi-owner bylines
 * render a link-less anchor. 96.7% on `byline.url` is the correct reading of a healthy page.
 */

import { readPath, validateItem } from '../../core/src/index.js'

/** Reported for every collection, in this order, whether or not any item carries them. */
export const CORE_FIELDS = Object.freeze([
  'title',
  'canonicalUrl',
  'summary',
  'byline.name',
  'byline.handle',
  'byline.url',
  'thumb.url',
  'lists',
  'order',
  'tags',
  'categories',
  'times.publishedAt',
  'times.firstSeenAt',
  'liveness.state',
  'membership.state',
  'ext',
  'raw',
])

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

/** See the header: 0 and false count as present. Emptiness does not. */
export function isPresent(value) {
  if (value === undefined || value === null) return false
  if (typeof value === 'string') return value !== ''
  if (Array.isArray(value)) return value.length > 0
  if (isPlainObject(value)) return Object.keys(value).length > 0
  return true
}

/**
 * Every `metrics.*` key any item carries.
 * Discovered rather than declared, because the whole point is to notice the run where
 * `metrics.views` stops arriving — a hard-coded list can only report on fields someone
 * remembered to add.
 */
export function metricKeys(items) {
  const keys = new Set()
  for (const item of items ?? []) {
    if (isPlainObject(item?.metrics)) for (const k of Object.keys(item.metrics)) keys.add(`metrics.${k}`)
  }
  return [...keys].sort()
}

/**
 * @param {Array<object>} items
 * @param {object} [opts]
 * @param {string[]} [opts.fields] override the field list entirely
 * @returns {{total:number, rows:Array<{field:string, present:number, missing:number, percent:number|null}>}}
 *          `percent` is null for an empty collection — 0% would claim a measurement nobody made.
 */
export function coverage(items, opts = {}) {
  const list = items ?? []
  const fields = opts.fields ?? [...CORE_FIELDS, ...metricKeys(list)]
  const rows = fields.map((field) => {
    let present = 0
    for (const item of list) if (isPresent(readPath(item, field))) present += 1
    return {
      field,
      present,
      missing: list.length - present,
      percent: list.length ? (present / list.length) * 100 : null,
    }
  })
  return { total: list.length, rows }
}

/**
 * Fields that are not at 100%, worst first — the line you actually read in CI.
 * Sorted by percentage rather than by field order, because the interesting field is the one
 * that moved, and you should not have to scan a 25-row table to find it.
 */
export function incomplete(cov) {
  return cov.rows
    .filter((r) => r.percent !== null && r.percent < 100)
    .sort((a, b) => a.percent - b.percent || a.field.localeCompare(b.field))
}

/**
 * Coverage of `candidate` against `baseline`, aligned on the union of their fields.
 * `delta` is in percentage POINTS. A field the baseline never had reports `baseline: null`
 * rather than 0, so a newly added metric does not read as a +100 point improvement.
 */
export function coverageDelta(baselineItems, candidateItems) {
  const fields = [...new Set([
    ...CORE_FIELDS,
    ...metricKeys(baselineItems),
    ...metricKeys(candidateItems),
  ])]
  const base = new Map(coverage(baselineItems, { fields }).rows.map((r) => [r.field, r]))
  const cand = coverage(candidateItems, { fields })
  return {
    total: cand.total,
    baselineTotal: (baselineItems ?? []).length,
    rows: cand.rows.map((r) => {
      const b = base.get(r.field)
      return {
        ...r,
        baselinePercent: b?.percent ?? null,
        delta: b?.percent == null || r.percent == null ? null : r.percent - b.percent,
      }
    }),
  }
}

/**
 * Structural validation across a collection, plus the one check `validateItem` cannot make
 * because it sees a single record: duplicate ids. Two rows sharing an id means dedup broke
 * upstream, and it silently halves the collection on the next merge.
 *
 * Never throws on the first bad row — a scrape of 582 items should report the 3 bad ones.
 */
export function validateAll(items) {
  const problems = []
  const seen = new Map()
  const duplicateIds = []

  ;(items ?? []).forEach((item, index) => {
    for (const problem of validateItem(item)) {
      problems.push({ index, id: item?.id ?? null, problem })
    }
    const id = item?.id
    if (typeof id === 'string' && id) {
      if (seen.has(id)) duplicateIds.push({ id, first: seen.get(id), again: index })
      else seen.set(id, index)
    }
  })

  for (const dup of duplicateIds) {
    problems.push({
      index: dup.again,
      id: dup.id,
      problem: `duplicate id (first seen at item ${dup.first})`,
    })
  }

  return { problems, duplicateIds, checked: (items ?? []).length }
}

/** Group identical problem texts so 582 rows missing a title report as one line with a count. */
export function groupProblems(problems) {
  const groups = new Map()
  for (const p of problems ?? []) {
    const key = p.problem
    const g = groups.get(key) ?? { problem: key, count: 0, examples: [] }
    g.count += 1
    if (g.examples.length < 3) g.examples.push(p.id ?? `item ${p.index}`)
    groups.set(key, g)
  }
  return [...groups.values()].sort((a, b) => b.count - a.count || a.problem.localeCompare(b.problem))
}
