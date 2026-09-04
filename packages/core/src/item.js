/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Item contract, v1. See `docs/ITEM-CONTRACT.md` for the reasoning.
 *
 * Zones and who may write them:
 *   identity  core       recomputed deterministically
 *   facets    connector  replaced on re-acquire
 *   ext       connector  replaced on re-acquire, opaque to core
 *   user      human      NEVER touched by a connector; open map
 *   raw       connector  replaced, previous retained by the store
 */

import { canonicalizeUrl } from './url.js'

export const SCHEMA_VERSION = 1

export const LIVENESS_STATES = Object.freeze(['live', 'gone', 'restricted', 'unknown'])
export const MEMBERSHIP_STATES = Object.freeze(['listed', 'unlisted'])

/** Which zone each top-level key belongs to. The merge rules key off this table. */
export const ZONES = Object.freeze({
  id: 'identity', source: 'identity', sourceId: 'identity', kind: 'identity',
  url: 'identity', canonicalUrl: 'identity',

  title: 'facets', summary: 'facets', byline: 'facets', thumb: 'facets',
  lists: 'facets', order: 'facets', tags: 'facets', categories: 'facets',
  metrics: 'facets', times: 'facets', sightings: 'facets',
  liveness: 'facets', membership: 'facets',

  ext: 'ext',
  user: 'user',
  raw: 'raw',
})

export const REQUIRED_KEYS = Object.freeze([
  'id', 'source', 'sourceId', 'kind', 'url', 'title',
  'lists', 'metrics', 'times', 'sightings', 'liveness', 'membership', 'ext', 'user',
])

// ── identity ──────────────────────────────────────────────────────────────────

/**
 * `${source}:${sourceId}` — global, stable, greppable, and namespaced so one store can
 * hold every domain at once without source ids colliding.
 */
export function makeId(source, sourceId) {
  const s = String(source ?? '').trim()
  const i = String(sourceId ?? '').trim()
  if (!s) throw new TypeError('makeId: source is required')
  if (!i) throw new TypeError('makeId: sourceId is required')
  if (s.includes(':')) throw new TypeError(`makeId: source must not contain ":" (got ${JSON.stringify(s)})`)
  return `${s}:${i}`
}

/** Splits on the FIRST colon only — a sourceId may legitimately contain colons. */
export function parseId(id) {
  const str = String(id ?? '')
  const idx = str.indexOf(':')
  if (idx <= 0 || idx === str.length - 1) throw new TypeError(`parseId: malformed id ${JSON.stringify(str)}`)
  return { source: str.slice(0, idx), sourceId: str.slice(idx + 1) }
}

// ── coercion helpers ──────────────────────────────────────────────────────────

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const str = (v, fallback = '') => (typeof v === 'string' ? v : v == null ? fallback : String(v))
const strOrNull = (v) => (typeof v === 'string' && v !== '' ? v : null)
const arr = (v) => (Array.isArray(v) ? v.slice() : [])
const int = (v, fallback = 0) => (Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : fallback)

/**
 * `metrics` is a flat string→finite-number map and the ONLY thing generic faceting reads.
 * A non-finite or non-numeric value is DROPPED rather than coerced to 0 — an absent metric
 * must stay distinguishable from a zero one, because scores average over the channels that
 * exist rather than penalising the ones that do not.
 */
export function normalizeMetrics(input) {
  const out = {}
  if (!isPlainObject(input)) return out
  for (const [k, v] of Object.entries(input)) {
    const n = typeof v === 'number' ? v : Number(v)
    if (Number.isFinite(n)) out[k] = n
  }
  return out
}

function normalizeByline(input) {
  if (!isPlainObject(input)) return { name: null, handle: null, url: null, id: null }
  return {
    name: strOrNull(input.name),
    handle: strOrNull(input.handle),
    url: strOrNull(input.url),
    id: strOrNull(input.id),
  }
}

function normalizeThumb(input) {
  if (!isPlainObject(input)) return null
  const url = strOrNull(input.url)
  if (!url) return null
  return { url, derived: Boolean(input.derived) }
}

function normalizeTimes(input) {
  const t = isPlainObject(input) ? input : {}
  return {
    publishedAt: t.publishedAt == null ? null : t.publishedAt,
    firstSeenAt: int(t.firstSeenAt, 0),
    lastSeenAt: int(t.lastSeenAt, 0),
    capturedAt: int(t.capturedAt, 0),
  }
}

function normalizeLiveness(input) {
  const l = isPlainObject(input) ? input : {}
  const state = LIVENESS_STATES.includes(l.state) ? l.state : 'unknown'
  return {
    state,
    checkedAt: int(l.checkedAt, 0),
    evidence: l.evidence == null ? null : l.evidence,
    attempts: int(l.attempts, 0),
    retryAfter: l.retryAfter == null ? null : int(l.retryAfter, 0),
  }
}

function normalizeMembership(input) {
  const m = isPlainObject(input) ? input : {}
  return {
    state: MEMBERSHIP_STATES.includes(m.state) ? m.state : 'listed',
    checkedAt: int(m.checkedAt, 0),
  }
}

function normalizeOrder(input) {
  const out = {}
  if (!isPlainObject(input)) return out
  for (const [k, v] of Object.entries(input)) {
    const n = Number(v)
    if (Number.isFinite(n)) out[k] = Math.trunc(n)
  }
  return out
}

function normalizeRaw(input) {
  if (!isPlainObject(input)) return null
  const body = typeof input.body === 'string' ? input.body : null
  if (body == null) return null
  return {
    body,
    contentType: str(input.contentType, 'text/html'),
    hash: strOrNull(input.hash),
    capturedAt: int(input.capturedAt, 0),
    connectorVersion: strOrNull(input.connectorVersion),
  }
}

/**
 * The `user` zone. Passed through VERBATIM — no whitelist, no coercion, no key filtering.
 *
 * This is the single most important line in the file. MakerWorld's `makeUserMeta()` rebuilt
 * this object from five known keys and silently deleted `userTags`, `related`, `parts` and
 * `links` on every re-scrape until 0.6.2. Do not "tidy" this function.
 */
function normalizeUser(input) {
  return isPlainObject(input) ? { ...input } : {}
}

// ── construction ──────────────────────────────────────────────────────────────

/**
 * Build a complete, valid Item from a connector's partial output.
 *
 * @param {object} partial
 * @param {object} [opts]
 * @param {object} [opts.urlOptions] forwarded to `canonicalizeUrl`
 * @returns {object} a fully-populated Item
 */
export function createItem(partial, opts = {}) {
  if (!isPlainObject(partial)) throw new TypeError('createItem: expected an object')

  const source = str(partial.source).trim()
  const sourceId = str(partial.sourceId).trim()
  const id = partial.id ? str(partial.id) : makeId(source, sourceId)
  const url = str(partial.url)

  return {
    id,
    source,
    sourceId,
    kind: str(partial.kind, 'link'),
    url,
    canonicalUrl: partial.canonicalUrl != null
      ? str(partial.canonicalUrl)
      : (url ? canonicalizeUrl(url, opts.urlOptions) : ''),

    title: str(partial.title),
    summary: str(partial.summary),
    byline: normalizeByline(partial.byline),
    thumb: normalizeThumb(partial.thumb),

    lists: arr(partial.lists).map((v) => str(v)).filter(Boolean),
    order: normalizeOrder(partial.order),

    tags: arr(partial.tags).map((v) => str(v)).filter(Boolean),
    categories: arr(partial.categories).map((v) => str(v)).filter(Boolean),

    metrics: normalizeMetrics(partial.metrics),

    times: normalizeTimes(partial.times),
    sightings: Math.max(1, int(partial.sightings, 1)),

    liveness: normalizeLiveness(partial.liveness),
    membership: normalizeMembership(partial.membership),

    ext: isPlainObject(partial.ext) ? { ...partial.ext } : {},
    user: normalizeUser(partial.user),
    raw: normalizeRaw(partial.raw),
  }
}

/**
 * Structural validation. Returns a list of human-readable problems; empty means valid.
 * Deliberately not a throwing API — a scrape of 582 items should report the 3 bad rows,
 * not abort on the first.
 */
export function validateItem(item) {
  const problems = []
  if (!isPlainObject(item)) return ['item is not an object']

  for (const key of REQUIRED_KEYS) {
    if (item[key] === undefined || item[key] === null) problems.push(`missing required field: ${key}`)
  }
  if (typeof item.id === 'string' && typeof item.source === 'string' && typeof item.sourceId === 'string') {
    if (item.id !== `${item.source}:${item.sourceId}`) {
      problems.push(`id "${item.id}" does not match source/sourceId ("${item.source}:${item.sourceId}")`)
    }
  }
  if (item.metrics !== undefined && item.metrics !== null) {
    if (!isPlainObject(item.metrics)) problems.push('metrics must be an object')
    else {
      for (const [k, v] of Object.entries(item.metrics)) {
        if (!Number.isFinite(v)) problems.push(`metrics.${k} is not a finite number (${JSON.stringify(v)})`)
      }
    }
  }
  if (item.liveness && !LIVENESS_STATES.includes(item.liveness.state)) {
    problems.push(`liveness.state "${item.liveness.state}" is not one of ${LIVENESS_STATES.join('|')}`)
  }
  if (item.membership && !MEMBERSHIP_STATES.includes(item.membership.state)) {
    problems.push(`membership.state "${item.membership.state}" is not one of ${MEMBERSHIP_STATES.join('|')}`)
  }
  if (item.user !== undefined && item.user !== null && !isPlainObject(item.user)) {
    problems.push('user must be an object (it is an open map)')
  }
  if (item.ext !== undefined && item.ext !== null && !isPlainObject(item.ext)) {
    problems.push('ext must be an object')
  }
  if (!Array.isArray(item.lists)) problems.push('lists must be an array')
  return problems
}

/** Read a dotted path such as `metrics.durationSec` or `byline.name`. */
export function readPath(item, path) {
  let node = item
  for (const seg of String(path).split('.')) {
    if (node == null || typeof node !== 'object') return undefined
    node = node[seg]
  }
  return node
}
