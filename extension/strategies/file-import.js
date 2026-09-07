/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `file-import` — a saved page, or a previous export.
 *
 * The second half is the one that matters. Every tool this design was distilled from can
 * export and none can re-ingest; the single importer that exists clears its store first, so
 * importing a filtered export permanently deletes every record and annotation absent from that
 * file, with no prompt and no undo. A portability architecture whose data only flows one way is
 * not portable, so reading an export back is a first-class strategy here, not a later feature.
 *
 * Both paths end in the same place — a merge governed by the zone rules — so an item that
 * arrives from a file is indistinguishable from one that arrived from a live tab, except in its
 * provenance.
 */

import { fromJsonl, shouldAccept, mergeBundle, createItem } from '../vendor/core/index.js'
import { connectorFor, getConnector, listFor } from '../vendor/connectors/index.js'

/** JSONL if the first non-blank line parses as an object with a known `type`. */
export function looksLikeInterchange(text) {
  const firstLine = String(text ?? '').split(/\r?\n/).find((l) => l.trim())
  if (!firstLine) return false
  try {
    const rec = JSON.parse(firstLine)
    return Boolean(rec) && typeof rec === 'object'
      && ['meta', 'item', 'attr', 'signal'].includes(rec.type)
  } catch {
    return false
  }
}

/**
 * Read an interchange file and merge it into what is already held.
 *
 * @param {string} text
 * @param {{items:Array, attrs:Array}} local
 * @param {{generation:number, lineage?:string, force?:boolean}} state
 */
export function importInterchange(text, local, state = {}) {
  const bundle = fromJsonl(text)

  if (!bundle.items.length && bundle.errors.length) {
    return { ok: false, reason: 'not-interchange', errors: bundle.errors.length }
  }

  if (!state.force && !shouldAccept({ generation: state.generation, lineage: state.lineage }, bundle.meta)) {
    // Refused, not merged. A stale snapshot of this same store would roll it back.
    return {
      ok: false,
      reason: 'stale',
      incomingGeneration: Number(bundle.meta?.generation) || 0,
      localGeneration: Number(state.generation) || 0,
    }
  }

  const merged = mergeBundle(local, bundle)
  return {
    ok: true,
    ...merged,
    meta: bundle.meta,
    malformed: bundle.errors.length,
    // Unknown record types are ignored BY CONTRACT — that is what lets the format grow without
    // breaking readers that predate the addition.
    ignored: bundle.unknown.length,
  }
}

/**
 * Run a connector over a saved page.
 *
 * @param {string} html
 * @param {{url?:string, connectorId?:string, listId?:string, now?:number}} opts
 */
export function importSavedPage(html, opts = {}) {
  const url = opts.url ?? sniffUrl(html)
  const connector = opts.connectorId ? getConnector(opts.connectorId) : (url ? connectorFor(url) : null)
  if (!connector) {
    return { ok: false, reason: 'no-connector', url }
  }

  const listId = opts.listId
    ?? (url ? listFor(connector, url)?.instanceId?.(url) ?? listFor(connector, url)?.id : null)
    ?? null

  // Both names, for the same reason as the collect path: connectors read `capturedAt` while the
  // CLI host passes `now`, and supplying only one leaves every item with zero provenance times.
  const now = opts.now ?? 0
  const ctx = { url, list: listId, listId, now, capturedAt: now, strategy: 'file-import' }
  const raws = connector.parseList(html, ctx)

  const items = []
  const problems = []
  raws.forEach((raw, index) => {
    try {
      const partial = connector.normalize(raw, { ...ctx, index })
      if (partial) items.push(createItem(partial))
    } catch (err) {
      problems.push({ index, message: err?.message ?? String(err) })
    }
  })

  return { ok: true, connector: connector.id, listId, url, items, rawCount: raws.length, problems }
}

/** A saved file has no URL of its own; the page usually says. Returns null rather than guessing. */
export function sniffUrl(html) {
  const head = String(html ?? '').slice(0, 262144)
  const patterns = [
    /<meta[^>]+property=["']og:url["'][^>]+content=["']([^"']+)["']/i,
    /<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i,
    /<base[^>]+href=["']([^"']+)["']/i,
  ]
  for (const re of patterns) {
    const m = head.match(re)
    if (m && /^https?:\/\//i.test(m[1])) return m[1]
  }
  return null
}
