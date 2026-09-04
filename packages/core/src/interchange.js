/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The interchange format — and, crucially, BOTH directions.
 *
 * A portability architecture whose data only flows one way is not portable. None of the
 * three tools this design is distilled from can re-ingest its own export: Kleinanzeigen has
 * no importer at all, today-app's exporter has zero callers, and catalogue-app's importer is
 * destructive (it clears the store first, so importing a filtered export permanently deletes
 * every record and annotation absent from that file, with no prompt and no undo).
 *
 * So `fromJsonl(toJsonl(x)) === x` is a step-one test here, not a later feature.
 *
 * Line-delimited JSON. One typed record per line. Unknown `type` values are IGNORED by
 * contract, which is what lets the format grow without breaking old readers.
 */

import { mergeItems } from './merge.js'
import { upsertAttrs } from './precedence.js'
import { SCHEMA_VERSION } from './item.js'

export const GENERATOR = 'stashling'

/**
 * @param {object} bundle
 * @param {Array<object>} bundle.items
 * @param {Array<object>} [bundle.attrs]
 * @param {Array<object>} [bundle.signals]
 * @param {object} [bundle.meta]  extra meta fields; `generation` is the important one
 * @returns {string} JSONL, LF-separated, no trailing newline
 */
export function toJsonl(bundle) {
  const items = bundle?.items ?? []
  const attrs = bundle?.attrs ?? []
  const signals = bundle?.signals ?? []
  const meta = {
    type: 'meta',
    schema: SCHEMA_VERSION,
    generator: `${GENERATOR}/${bundle?.meta?.version ?? '0.1.0'}`,
    exportedAt: Number(bundle?.meta?.exportedAt) || 0,
    count: items.length,
    // Monotonic WITHIN a lineage. A consumer discards a payload whose generation is not newer
    // than its own, so a stale snapshot cannot silently roll state back. openbrowsertabs
    // specified this for sync and never implemented it.
    generation: Number(bundle?.meta?.generation) || 0,
    // Which collection this file is a snapshot OF. Omitted when unknown — see `shouldAccept`
    // for why an unlabelled file gets the conservative reading rather than a free pass.
    ...(bundle?.meta?.lineage ? { lineage: String(bundle.meta.lineage) } : {}),
    ...(bundle?.meta?.extra ?? {}),
  }

  const lines = [JSON.stringify(meta)]
  for (const item of items) lines.push(JSON.stringify({ type: 'item', ...item }))
  for (const attr of attrs) lines.push(JSON.stringify({ type: 'attr', ...attr }))
  for (const signal of signals) lines.push(JSON.stringify({ type: 'signal', ...signal }))
  return lines.join('\n')
}

/**
 * Parse an interchange file.
 *
 * A malformed line is recorded and skipped, never fatal — the same policy that lets a
 * thumbnail bundle survive one bad row instead of aborting a 582-item import.
 *
 * @returns {{meta:object|null, items:Array, attrs:Array, signals:Array,
 *            unknown:Array, errors:Array<{line:number, message:string, text:string}>}}
 */
export function fromJsonl(text) {
  const out = { meta: null, items: [], attrs: [], signals: [], unknown: [], errors: [] }
  const lines = String(text ?? '').split(/\r?\n/)

  lines.forEach((line, i) => {
    const trimmed = line.trim()
    if (!trimmed) return
    let record
    try {
      record = JSON.parse(trimmed)
    } catch (err) {
      out.errors.push({ line: i + 1, message: err.message, text: trimmed.slice(0, 200) })
      return
    }
    if (!record || typeof record !== 'object') {
      out.errors.push({ line: i + 1, message: 'not an object', text: trimmed.slice(0, 200) })
      return
    }
    const { type, ...rest } = record
    switch (type) {
      case 'meta': out.meta = rest; break
      case 'item': out.items.push(rest); break
      case 'attr': out.attrs.push(rest); break
      case 'signal': out.signals.push(rest); break
      default: out.unknown.push(record)
    }
  })

  return out
}

/**
 * Should this payload be applied at all?
 *
 * The generation counter exists for exactly one hazard: a STALE SNAPSHOT OF THE SAME STORE
 * being imported over a newer one and rolling state back. Two devices holding the same
 * collection, one of them behind.
 *
 * It has nothing to say about merging a DIFFERENT collection in — a fresh scrape, a second
 * source, someone else's export. Those are additive and non-destructive by construction, and
 * refusing them because their counter happens to start at 1 is a guard firing on the wrong
 * thing. `lineage` is what tells the two cases apart: a stable id for the collection a file is
 * a snapshot of.
 *
 * @param {number|{generation?:number, lineage?:string}} local  the store's own meta
 * @param {object} incomingMeta
 */
export function shouldAccept(local, incomingMeta) {
  const localMeta = local && typeof local === 'object' ? local : { generation: local }
  const localLineage = localMeta.lineage ?? null
  const incomingLineage = incomingMeta?.lineage ?? null

  // Declared, and different: not a snapshot of this store. Merge it.
  if (localLineage && incomingLineage && localLineage !== incomingLineage) return true

  // Same lineage, or neither side says. Unlabelled files get the conservative reading —
  // a file that does not identify its collection is treated as possibly being this one.
  const localGeneration = Number(localMeta.generation) || 0
  const incomingGeneration = Number(incomingMeta?.generation) || 0
  if (incomingGeneration === 0 && localGeneration === 0) return true // neither tracks generations
  return incomingGeneration > localGeneration
}

/**
 * Merge an imported bundle into an existing collection.
 *
 * Merge policy is the zone rule, not a new invention:
 *   - facets / ext / raw     incoming replaces
 *   - user                   incoming keys merge ON TOP of local ones, deleting nothing
 *   - times.firstSeenAt      the EARLIER of the two wins
 *   - sightings              the LARGER wins
 *   - attrs                  imported rows are written with their own source, so an import
 *                            is just another precedence writer and can never outrank the user
 *
 * @param {{items?:Array, attrs?:Array}} local
 * @param {{items?:Array, attrs?:Array}} bundle  as returned by `fromJsonl`
 * @param {object} [opts]
 * @param {string} [opts.attrSource='import'] source stamped on attr rows lacking one
 * @returns {{items:Array, attrs:Array, added:number, merged:number}}
 */
export function mergeBundle(local, bundle, opts = {}) {
  const { attrSource = 'import' } = opts
  const byId = new Map((local?.items ?? []).map((it) => [it.id, it]))
  let added = 0
  let merged = 0

  for (const incoming of bundle?.items ?? []) {
    if (!incoming?.id) continue
    const existing = byId.get(incoming.id)
    if (!existing) {
      byId.set(incoming.id, incoming)
      added += 1
    } else {
      byId.set(incoming.id, mergeItems(existing, incoming, { writer: 'import', countSighting: false }))
      merged += 1
    }
  }

  const attrs = upsertAttrs(
    local?.attrs ?? [],
    (bundle?.attrs ?? []).map((row) => ({ ...row, source: row.source || attrSource })),
  )

  return { items: [...byId.values()], attrs, added, merged }
}
