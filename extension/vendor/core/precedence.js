/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Source precedence — the anti-clobber mechanism.
 *
 * Enrichment does not overwrite fields. Every derived attribute is a row carrying WHO
 * asserted it, and readers resolve by precedence. Nothing overwrites; sources coexist.
 *
 *   attrs( itemId, key, valueText, valueNum, valueTime, source, confidence, observedAt )
 *          UNIQUE( itemId, key, source )
 *
 * Three consequences fall out, each replacing a rule someone currently has to remember:
 *   - Enrichment cannot destroy curation. A cloud batch writes source:"cloud" rows; a user
 *     edit writes source:"user". Both persist; the user's wins on read.
 *   - Re-running anything is idempotent — the UNIQUE constraint makes a re-run an upsert of
 *     that source's own opinion.
 *   - Disagreement is inspectable: "rules say article, the model says paper, you said
 *     reference" is showable, and impossible once you have overwritten.
 *
 * STATUS: openbrowsertabs has this DDL and this precedence list, and it is dead code there —
 * `putAttr`, `attrs()`, `putEdge` and `learnTerm` have zero callers and the edges table is
 * never written. This is a strong hypothesis being implemented for the first time, not
 * tested code being ported. That is exactly why it is tested here.
 */

/** Lower index wins. */
export const SOURCE_PRECEDENCE = Object.freeze([
  'user',        // the human. Always wins.
  'connector',   // observed directly at the source
  'import',      // arrived via an interchange file
  'cloud',       // an offline batch job
  'local-model', // an on-device model
  'rules',       // deterministic heuristics
])

/**
 * An unknown source ranks LAST rather than first or throwing, so an unrecognised writer can
 * never beat a known one and a plugin from the future degrades safely.
 */
export function rank(source) {
  const i = SOURCE_PRECEDENCE.indexOf(source)
  return i < 0 ? Number.MAX_SAFE_INTEGER : i
}

/** Build a well-formed attr row. Exactly one typed value column is populated. */
export function makeAttr({ itemId, key, value, source, confidence = 1, observedAt = 0, kind }) {
  if (!itemId) throw new TypeError('makeAttr: itemId is required')
  if (!key) throw new TypeError('makeAttr: key is required')
  if (!source) throw new TypeError('makeAttr: source is required')

  const row = {
    itemId: String(itemId),
    key: String(key),
    valueText: null,
    valueNum: null,
    valueTime: null,
    source: String(source),
    confidence: Number.isFinite(Number(confidence)) ? Number(confidence) : 1,
    observedAt: Number(observedAt) || 0,
  }

  const inferred = kind || (typeof value === 'number' ? 'num' : 'text')
  // Typed columns exist so "published before 2024" and "under 30 minutes" stay comparisons
  // rather than string parsing.
  if (inferred === 'num') {
    const n = Number(value)
    if (!Number.isFinite(n)) throw new TypeError(`makeAttr: ${key} is not a finite number`)
    row.valueNum = n
  } else if (inferred === 'time') {
    row.valueTime = Number(value) || 0
  } else {
    row.valueText = value == null ? null : String(value)
  }
  return row
}

/** The single value carried by a row, whichever column holds it. */
export function attrValue(row) {
  if (!row) return undefined
  if (row.valueNum !== null && row.valueNum !== undefined) return row.valueNum
  if (row.valueTime !== null && row.valueTime !== undefined) return row.valueTime
  return row.valueText
}

/**
 * Is `candidate` a better answer than `incumbent` for the same key?
 *
 * Ties are broken by `observedAt` DESC then `confidence` DESC — never by row-iteration
 * order, which is what the reference implementation does and which makes two runs over the
 * same data disagree.
 */
export function beats(candidate, incumbent) {
  if (!incumbent) return true
  const rc = rank(candidate.source)
  const ri = rank(incumbent.source)
  if (rc !== ri) return rc < ri
  const oc = Number(candidate.observedAt) || 0
  const oi = Number(incumbent.observedAt) || 0
  if (oc !== oi) return oc > oi
  return (Number(candidate.confidence) || 0) > (Number(incumbent.confidence) || 0)
}

/**
 * Resolve rows to one winning row per key.
 * @param {Array<object>} rows
 * @returns {Map<string, object>} key → winning row
 */
export function resolveAttrs(rows) {
  const winners = new Map()
  for (const row of rows || []) {
    if (!row || !row.key) continue
    const incumbent = winners.get(row.key)
    if (beats(row, incumbent)) winners.set(row.key, row)
  }
  return winners
}

/** The resolved value for one key, or `undefined`. */
export function readAttr(rows, key) {
  return attrValue(resolveAttrs((rows || []).filter((r) => r && r.key === key)).get(key))
}

/** Resolved `{key: value}` for every key present. */
export function resolvedValues(rows) {
  const out = {}
  for (const [key, row] of resolveAttrs(rows)) out[key] = attrValue(row)
  return out
}

/**
 * Every competing opinion for one key, best first. This is what makes disagreement
 * inspectable — the honest UI that overwriting makes impossible.
 */
export function opinions(rows, key) {
  return (rows || [])
    .filter((r) => r && r.key === key)
    .sort((a, b) => (beats(a, b) ? -1 : beats(b, a) ? 1 : 0))
    .map((r) => ({ source: r.source, value: attrValue(r), confidence: r.confidence, observedAt: r.observedAt }))
}

/**
 * Idempotent upsert honouring `UNIQUE(itemId, key, source)`.
 * A re-run replaces that source's own previous opinion and touches nobody else's.
 * @returns {Array<object>} a new row array
 */
export function upsertAttrs(rows, incoming) {
  const next = (rows || []).slice()
  for (const row of Array.isArray(incoming) ? incoming : [incoming]) {
    if (!row) continue
    const i = next.findIndex(
      (r) => r.itemId === row.itemId && r.key === row.key && r.source === row.source,
    )
    if (i >= 0) next[i] = row
    else next.push(row)
  }
  return next
}
