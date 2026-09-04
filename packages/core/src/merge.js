/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Zone-scoped merge. A writer may only replace keys in the zones it owns.
 *
 *   writer: "connector"  facets/ext/raw replaced, `user` NOT TOUCHED
 *   writer: "import"     as above, plus `user` keys merged ON TOP of local ones
 *   writer: "user"       ONLY `user` is written
 *
 * The re-acquisition rules that are NOT plain replacement are each here because a shipped
 * tool got them wrong:
 *
 *  - `lists` is a set union. Membership is a scraped fact that merges across scrapes; an
 *    item seen in "likes" today and "downloads" tomorrow is in both.
 *  - `metrics` merges rather than replaces. A metric the connector did not observe this run
 *    is not a metric that became zero.
 *  - `times.firstSeenAt` takes the EARLIER value, `lastSeenAt` the LATER, `sightings` the
 *    LARGER. Re-encounter is signal, not error.
 *  - Empty incoming strings do not clear stored ones by default. Kleinanzeigen depends on
 *    this: a redirect-deleted detail page parses as `title: null`, and a naive replace would
 *    wipe the record you kept it for. The cost is that a stale title can persist, so
 *    `allowClear` exists for callers that genuinely observed a cleared value.
 */

import { canonicalizeUrl } from './url.js'
import { normalizeMetrics } from './item.js'

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const nonEmpty = (v) => v !== undefined && v !== null && v !== ''

/**
 * Merge the human-owned zone. Incoming keys win per key; keys present only in `existing`
 * SURVIVE. Never rebuild this object from a known-key list.
 */
export function mergeUser(existingUser, incomingUser) {
  return { ...(isPlainObject(existingUser) ? existingUser : {}),
           ...(isPlainObject(incomingUser) ? incomingUser : {}) }
}

/** Set union preserving first-seen order. */
export function mergeLists(a, b) {
  const out = []
  const seen = new Set()
  for (const v of [...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])]) {
    const s = String(v)
    if (!s || seen.has(s)) continue
    seen.add(s)
    out.push(s)
  }
  return out
}

function mergeTimes(a = {}, b = {}) {
  const earlier = (x, y) => {
    const xs = Number(x) || 0
    const ys = Number(y) || 0
    if (!xs) return ys
    if (!ys) return xs
    return Math.min(xs, ys)
  }
  return {
    publishedAt: nonEmpty(b.publishedAt) ? b.publishedAt : (a.publishedAt ?? null),
    firstSeenAt: earlier(a.firstSeenAt, b.firstSeenAt),
    lastSeenAt: Math.max(Number(a.lastSeenAt) || 0, Number(b.lastSeenAt) || 0),
    capturedAt: Math.max(Number(a.capturedAt) || 0, Number(b.capturedAt) || 0),
  }
}

/** Newer observation wins; a stale probe never overwrites a fresher one. */
function mergeStamped(a, b) {
  if (!isPlainObject(b)) return a
  if (!isPlainObject(a)) return b
  return (Number(b.checkedAt) || 0) >= (Number(a.checkedAt) || 0) ? b : a
}

function pick(existingValue, incomingValue, allowClear) {
  if (allowClear) return incomingValue !== undefined ? incomingValue : existingValue
  return nonEmpty(incomingValue) ? incomingValue : existingValue
}

function mergeByline(a = {}, b = {}, allowClear) {
  const out = {}
  for (const k of ['name', 'handle', 'url', 'id']) out[k] = pick(a?.[k] ?? null, b?.[k], allowClear) ?? null
  return out
}

/**
 * @param {object} existing  the stored Item (may be null for a first sighting)
 * @param {object} incoming  the newly acquired Item
 * @param {object} [opts]
 * @param {'connector'|'import'|'user'} [opts.writer='connector']
 * @param {boolean} [opts.allowClear=false]  let empty incoming values clear stored ones
 * @param {boolean} [opts.countSighting=true]
 * @returns {object} merged Item
 */
export function mergeItems(existing, incoming, opts = {}) {
  const { writer = 'connector', allowClear = false, countSighting = true } = opts
  if (!existing) return incoming
  if (!incoming) return existing

  if (writer === 'user') {
    return { ...existing, user: mergeUser(existing.user, incoming.user) }
  }

  if (existing.id && incoming.id && existing.id !== incoming.id) {
    throw new Error(`mergeItems: id mismatch "${existing.id}" vs "${incoming.id}"`)
  }

  const url = pick(existing.url, incoming.url, allowClear)

  const merged = {
    // identity — recomputed, never hand-merged
    id: existing.id || incoming.id,
    source: existing.source || incoming.source,
    sourceId: existing.sourceId || incoming.sourceId,
    kind: pick(existing.kind, incoming.kind, allowClear),
    url,
    canonicalUrl: url ? canonicalizeUrl(url, opts.urlOptions) : (existing.canonicalUrl || ''),

    // facets — connector-owned, replaced except where noted above
    title: pick(existing.title, incoming.title, allowClear),
    summary: pick(existing.summary, incoming.summary, allowClear),
    byline: mergeByline(existing.byline, incoming.byline, allowClear),
    thumb: pick(existing.thumb, incoming.thumb, allowClear) ?? null,

    lists: mergeLists(existing.lists, incoming.lists),
    order: { ...(existing.order || {}), ...(incoming.order || {}) },

    tags: incoming.tags?.length ? incoming.tags.slice() : (existing.tags || []).slice(),
    categories: incoming.categories?.length
      ? incoming.categories.slice()
      : (existing.categories || []).slice(),

    metrics: normalizeMetrics({ ...(existing.metrics || {}), ...(incoming.metrics || {}) }),

    times: mergeTimes(existing.times, incoming.times),
    sightings: countSighting
      ? Math.max(Number(existing.sightings) || 1, Number(incoming.sightings) || 1) +
        (incoming.times?.lastSeenAt && incoming.times.lastSeenAt !== existing.times?.lastSeenAt ? 1 : 0)
      : Math.max(Number(existing.sightings) || 1, Number(incoming.sightings) || 1),

    liveness: mergeStamped(existing.liveness, incoming.liveness),
    membership: mergeStamped(existing.membership, incoming.membership),

    // ext — connector owns it wholesale; an empty incoming ext does not erase a stored one
    ext: incoming.ext && Object.keys(incoming.ext).length
      ? { ...incoming.ext }
      : { ...(existing.ext || {}) },

    // user — the load-bearing line. A connector NEVER writes here.
    user: writer === 'import'
      ? mergeUser(existing.user, incoming.user)
      : { ...(existing.user || {}) },

    // raw — replaced when a new one is supplied. Retaining the displaced blob is a store
    // concern; see `docs/ARCHITECTURE.md` §Store.
    raw: incoming.raw ?? existing.raw ?? null,
  }

  return merged
}

/**
 * Re-sighting an item re-arms a terminal liveness state.
 *
 * openbrowsertabs' `unfetchable` is terminal with no retry path anywhere in the codebase,
 * so one transient failure removes an item from enrichment forever and permanently inflates
 * the inbox count. A terminal state must be re-armable.
 */
export function rearmLiveness(item, at) {
  if (!item?.liveness) return item
  if (item.liveness.state === 'live' || item.liveness.state === 'unknown') return item
  return {
    ...item,
    liveness: { ...item.liveness, state: 'unknown', attempts: 0, retryAfter: null, checkedAt: at },
  }
}
