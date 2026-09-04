/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `file-import` — the CLI's implementation of one acquisition strategy, and the reason this
 * package exists.
 *
 * The extension provides `dom-active-tab`, the test harness provides a fixture, and this file
 * provides "a page you saved to disk". The connector is identical in all three; it is a
 * description plus pure functions over strings, and nothing below asks it to know it is
 * running in Node. If a connector ever needs that, the layering is wrong.
 *
 * The saved page IS read whole, deliberately, and this is the one place in the CLI that does
 * not stream. `chunkByElement` splits a document on open tags, which needs the document —
 * there is no prefix of a 12.7 MB Watch Later page from which the 582nd row can be extracted.
 * A 13 MB string is a cost worth paying once; a streaming HTML chunker is a DOM parser with
 * extra steps.
 */

import { createItem, LIVENESS_STATES } from '../../core/src/index.js'

/** Meta tags live in `<head>`; scanning 12 MB of body markup for them is pure waste. */
const HEAD_BUDGET = 262144

/**
 * Which page is this, according to the page itself?
 *
 * A saved file has no URL of its own, but the connector's `match(url)` needs one and so does
 * `canonicalUrl`. Saved pages carry the answer in one of three places, checked in descending
 * order of trustworthiness: `og:url` (authored by the site), `<link rel=canonical>` (ditto),
 * and `<base href>` (written by the browser's save, and often just the origin).
 *
 * Returns null rather than guessing. `--url` exists for the pages that carry none of them.
 */
export function sniffUrl(html) {
  const head = String(html ?? '').slice(0, HEAD_BUDGET)
  const patterns = [
    /<meta[^>]+property=["']og:url["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:url["']/i,
    /<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i,
    /<link[^>]+href=["']([^"']+)["'][^>]+rel=["']canonical["']/i,
    /<base[^>]+href=["']([^"']+)["']/i,
  ]
  for (const re of patterns) {
    const m = head.match(re)
    if (m && /^https?:\/\//i.test(m[1])) return m[1]
  }
  return null
}

/**
 * Run a connector's list parser over a saved page.
 *
 * Per-row failures are COLLECTED, not thrown. One malformed row out of 582 must not cost you
 * the other 581 — that policy is the reason `validateItem` returns a list instead of throwing,
 * and a host that aborts on the first bad row throws the policy away.
 *
 * @param {object} connector
 * @param {string} html
 * @param {object} ctx  `{ url, list, listId, now, strategy, file }` — passed to the connector
 *                      verbatim, plus a per-row `index`
 * @returns {{items:Array, rawCount:number, problems:Array<{index:number, message:string}>}}
 */
export function runConnector(connector, html, ctx = {}) {
  const problems = []
  let raws
  try {
    raws = connector.parseList(html, ctx)
  } catch (err) {
    return { items: [], rawCount: 0, problems: [{ index: -1, message: `parseList threw: ${err.message}` }] }
  }
  if (!Array.isArray(raws)) {
    return {
      items: [],
      rawCount: 0,
      problems: [{ index: -1, message: `parseList returned ${typeof raws}, expected an array of raw items` }],
    }
  }

  const items = []
  raws.forEach((raw, index) => {
    try {
      const partial = connector.normalize(raw, { ...ctx, index })
      if (!partial) {
        problems.push({ index, message: 'normalize returned nothing' })
        return
      }
      items.push(finish(createItem(partial), connector, raw, { ...ctx, index }))
    } catch (err) {
      problems.push({ index, message: `${err.name}: ${err.message}` })
    }
  })

  return { items, rawCount: raws.length, problems }
}

/**
 * Host-owned finishing touches, applied only where the connector left a gap.
 *
 * List membership is the interesting one. It is a SCRAPED FACT, not user data, and in the
 * file-import strategy the fact lives with the host: the connector sees markup, but only the
 * host knows the operator said "this file is my watch-later page". So the list id and the
 * source's own ordering are filled in here — and a connector that already set them wins,
 * because it may have read a truer answer out of the page.
 */
function finish(item, connector, raw, ctx) {
  const next = item

  if (ctx.listId && !next.lists.includes(ctx.listId)) {
    next.lists = [...next.lists, ctx.listId]
  }
  if (ctx.listId && next.order[ctx.listId] === undefined) {
    next.order = { ...next.order, [ctx.listId]: ctx.index + 1 }
  }

  // Acquisition time is host knowledge, so it is filled when the connector left it at zero.
  // `now` is a parameter rather than a `Date.now()` call so `stashling fixture` can pin it and
  // get a byte-stable golden diff; a clock in the middle of a comparison makes CI flap.
  const now = Number(ctx.now) || 0
  if (now) {
    next.times = {
      ...next.times,
      firstSeenAt: next.times.firstSeenAt || now,
      lastSeenAt: next.times.lastSeenAt || now,
      capturedAt: next.times.capturedAt || now,
    }
  }

  // `liveness.atScrape` is the connector's own reading of "this row was on the page, so the
  // source still has it". It is called defensively and its answer is only taken when it is
  // shaped like a liveness record: the argument convention is the connector's to define, and a
  // host must degrade to `unknown` rather than invent a liveness claim it did not observe.
  if (typeof connector.liveness?.atScrape === 'function') {
    try {
      const observed = connector.liveness.atScrape(raw, ctx)
      if (observed && typeof observed === 'object' && LIVENESS_STATES.includes(observed.state)) {
        next.liveness = { ...next.liveness, ...observed, checkedAt: Number(observed.checkedAt) || now }
      }
    } catch {
      // A connector that cannot judge liveness from a saved page leaves it `unknown`, which is
      // the honest answer. It is never a reason to drop the row.
    }
  }

  return next
}
