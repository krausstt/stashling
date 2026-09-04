/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * MakerWorld — 3D print models. The second domain, and the migration proof.
 *
 * This is a port of the shipped `makerworld-suite/scraper-extension/parser.js` (0.6.2),
 * whose 50-assertion harness ran green against four real saved pages. Nothing here is
 * invented: the regexes, the `from_{scope}_index_{n}` grammar, the `prediction / 3600`
 * conversion and the `productProperyList` misspelling are all field-proven. What changed is
 * the SHAPE the parse lands in — a 23-field flat record becomes an Item with zones — and
 * that remap is the point of the file. If a 3D model with print profiles, filament BOMs,
 * plate counts and an AMS requirement fits the same record as a YouTube video without either
 * connector knowing the other exists, the contract holds.
 *
 * The one number that carries the argument: `metrics.minPrintTimeHours`. A generic range
 * facet filters "print time ≤ 4 h" here through the exact `matchesFilter()` call that filters
 * "under 30 minutes" on `metrics.durationSec` there. Same code path, no domain branch —
 * see the cross-domain test in `test/makerworld.test.js`.
 *
 * What this source CANNOT do is tell you a model is gone. See `liveness` below; it is the
 * best argument in the repo for putting these tools on one contract.
 */

import { defineConnector, ACQUISITION_STRATEGIES } from '../core/connector.js'
import { attrOf, chunkByMarker, firstOf, hrefs, stripTags } from './_shared/html.js'

const ID = 'makerworld'
const KIND = 'model'
const VERSION = '1.0.0'

/** The literal the shipped scraper split on. Not a CSS class we own — a stable page hook. */
const CARD_MARKER = 'js-design-card'

/**
 * Every listing card carries `{modelId}_from_{scope}_index_{n}`. The scope is a word for a
 * first-party list ("likes", "downloads") and a bare numeric id for a user collection, so the
 * one regex yields the item id, its list membership AND its position in a single pass over
 * raw HTML — no per-item fetch to learn which list you are looking at.
 */
const TRACKID_RE = /data-trackid="(\d+)_from_([a-z]+|\d+)_index_(\d+)"/
const UID_RE = /data-uid="(\d+)"/
const IMG_TAG_RE = /<img\b[^>]*>/gi
const ANCHOR_TAG_RE = /<a\b[^>]*>/gi

const NEXT_DATA_RE = /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/

const A1_MINI = 'A1 mini'

/**
 * The CDN transform that turned a 0.6.1 outage into a working feature. Cover images are
 * ~1.8 MB each and served as `application/octet-stream`; caching 860 of them blew the
 * IndexedDB quota and produced ZERO usable thumbnails. Asking the CDN to resize first yields
 * 15–50 KB WebP. Any host caching thumbnails must go through `deriveThumbUrl`.
 */
const THUMB_TRANSFORM = 'x-oss-process=image/resize,w_400'

// ── coercion ──────────────────────────────────────────────────────────────────

/**
 * `undefined` for anything that is not a finite number, INCLUDING `null`, `""` and booleans.
 *
 * This is the fork in the road between the old record and the Item contract. The shipped
 * `num()` coerced every miss to 0, which is right for a flat export nobody filters on and
 * wrong for `metrics`: a model with no rating and a model rated 0 must stay distinguishable,
 * because a score that averages over the channels that exist must not silently count an
 * absent channel as the worst possible one. `num()` below keeps the old behaviour for the
 * `ext` payload, where the export shape is the contract; `finite()` feeds `metrics`.
 */
function finite(v) {
  if (v === null || v === undefined || typeof v === 'boolean') return undefined
  const n = typeof v === 'string' ? Number.parseFloat(v) : Number(v)
  return Number.isFinite(n) ? n : undefined
}

/** The shipped `num()`, behaviour-for-behaviour: finite or 0. Used only inside `ext`. */
const num = (v) => finite(v) ?? 0

const round2 = (n) => Math.round(n * 100) / 100

/** Drop `undefined` values so an absent metric never reaches the record as a key at all. */
function defined(obj) {
  const out = {}
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = v
  return out
}

/**
 * FNV-1a, twice with different offset bases, concatenated to 64 bits.
 *
 * `raw.hash` exists so a re-import can skip an unchanged item; it is not a security boundary
 * and must never be used as one. A connector is a pure module that also runs in an MV3
 * service worker, so `node:crypto` is not available to it and WebCrypto's digest is async —
 * neither can sit in a synchronous `normalize()`. Two 32-bit passes rather than one because a
 * single 32-bit space collides at roughly 1-in-10⁴ over a 1,000-item catalogue, which is
 * exactly the size these catalogues reach (733 likes, 860 models enriched).
 */
function fnv1a64(s) {
  let a = 0x811c9dc5
  let b = 0x01000193
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i)
    a = Math.imul(a ^ c, 0x01000193) >>> 0
    b = Math.imul(b ^ c, 0x811c9dc5) >>> 0
  }
  return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0')
}

// ── URLs ──────────────────────────────────────────────────────────────────────

const modelUrl = (modelId, slug) =>
  `https://makerworld.com/en/models/${modelId}${slug ? `-${slug}` : ''}`

/**
 * Identity, not provenance. The locale segment is dropped: every model URL on this site is
 * `/{locale}/models/{id}-{slug}` (verified on all six saved pages — canonical tags, og:url and
 * every in-card href), and `/de/models/12898-toy-pistol` is the same model as `/en/…`. Keeping
 * the locale would split one node in two the first time someone browses in another language.
 *
 * Consequence to know about: the result is a dedup KEY, and is not asserted to be fetchable.
 * The fetchable address stays in `url`. `canonicalUrl` is "what this is", `url` is "where I
 * found it" — §4 of the Item contract.
 */
const canonicalModelUrl = (modelId, slug) =>
  `https://makerworld.com/models/${modelId}${slug ? `-${slug}` : ''}`

// ── listing pages ─────────────────────────────────────────────────────────────

/** Slug out of whichever href in the card points at this model. */
function cardSlug(chunk, modelId) {
  const re = new RegExp(`/models/${modelId}-([^"?#]*)`)
  for (const href of hrefs(chunk)) {
    const m = re.exec(href)
    if (m) return m[1]
  }
  return ''
}

/** Rung 1 — the model anchor's own `title` attribute. The only exact anchor on the card. */
function titleFromModelAnchor(chunk, modelId) {
  for (const tag of chunk.match(ANCHOR_TAG_RE) ?? []) {
    const href = attrOf(tag, 'href')
    if (!href || !href.includes(`/models/${modelId}-`)) continue
    const title = attrOf(tag, 'title')
    if (title) return title
  }
  return null
}

/** Rung 2 — the first `<img alt>` that is not an avatar. */
function titleFromCoverAlt(chunk) {
  for (const tag of chunk.match(IMG_TAG_RE) ?? []) {
    if (/\bavatar\b/i.test(attrOf(tag, 'class') ?? '')) continue
    const alt = attrOf(tag, 'alt')
    if (alt) return alt
  }
  return null
}

/** Rung 3 — the shipped behaviour, kept as the last resort. */
function titleFromFirstAlt(chunk) {
  const tag = (chunk.match(IMG_TAG_RE) ?? [])[0]
  return tag ? attrOf(tag, 'alt') : null
}

/**
 * Card title, hardened against the one known weakness in the shipped parser.
 *
 * `ALT_RE = /<img[^>]*alt="([^"]*)"/` took the FIRST `<img alt>` in the chunk with no
 * anchoring to the cover element. On the pages measured that happens to be the cover, because
 * the creator avatar renders after it and carries `alt=""` — but the recon flagged it as a
 * silent time bomb: an avatar moved above the cover, or given real alt text, poisons every
 * title on the page with a creator name and nothing detects it. Titles are what a human reads,
 * so a wrong one is worse than a missing one.
 *
 * The fix is the selector-ladder shape the rest of the corpus already uses (`firstOf`): the
 * exact anchor first, a structural anchor next, the old heuristic last, so a layout change
 * degrades one rung instead of silently returning the wrong string.
 */
function cardTitle(chunk, modelId) {
  return firstOf(
    [titleFromModelAnchor, titleFromCoverAlt, titleFromFirstAlt],
    (rung) => rung(chunk, modelId),
  ) ?? ''
}

/**
 * A listing page → one raw card per model, deduplicated, in the source's own order.
 *
 * Ported from `parseListing()`. Structural hooks only — `data-trackid`, `data-uid`, the
 * `/models/{id}-{slug}` href, `img alt` — never an obfuscated `mw-css-*` class. Cards without
 * a trackid (skeletons, ad slots) are skipped rather than half-parsed.
 *
 * The old field was called `source`; here it is `list`, because `source` in an Item means the
 * connector id and one of the two would have had to lose.
 */
export function parseList(html, _ctx = {}) {
  const out = []
  const seen = new Set()
  for (const chunk of chunkByMarker(html, CARD_MARKER)) {
    const t = TRACKID_RE.exec(chunk)
    if (!t) continue
    const modelId = t[1]
    // First occurrence wins. A model pinned at the top and repeated in the grid keeps the
    // pinned index, which is the order the human actually saw.
    if (seen.has(modelId)) continue
    seen.add(modelId)
    const from = t[2]
    const list = /^\d+$/.test(from) ? `collection:${from}` : from
    const uid = UID_RE.exec(chunk)
    const slug = cardSlug(chunk, modelId)
    out.push({
      type: 'card',
      modelId,
      slug,
      list,
      title: cardTitle(chunk, modelId),
      authorUid: uid ? uid[1] : '',
      url: modelUrl(modelId, slug),
      index: Number.parseInt(t[3], 10),
    })
  }
  out.sort((a, b) => a.index - b.index)
  return out
}

// ── detail pages ──────────────────────────────────────────────────────────────

/** Extract and JSON-parse the `__NEXT_DATA__` blob. Throws when the page has none. */
export function extractNextData(html) {
  const m = NEXT_DATA_RE.exec(String(html ?? ''))
  if (!m) {
    const err = new Error('NO_NEXT_DATA: __NEXT_DATA__ script not found in HTML')
    err.code = 'NO_NEXT_DATA'
    throw err
  }
  return JSON.parse(m[1])
}

/**
 * Locate the design payload regardless of page template: known path first, then a
 * DISCRIMINATED deep walk.
 *
 * This two-step is why the shipped parser survived two template generations — 857 of 860
 * models were captured through the HTML path and the JSON-API fallback it was designed to
 * need was never written. Both steps require `Array.isArray(instances)`, and that requirement
 * is load-bearing rather than defensive: `props.pageProps` also carries for-you and
 * recommendation card summaries that have `id`, `title` and `likeCount` and would otherwise
 * be accepted as a full design, producing a record with every count populated and no print
 * profiles at all — a plausible-looking record that is wrong.
 */
export function findDesignObject(data) {
  const direct = data?.props?.pageProps?.design
  if (direct && Array.isArray(direct.instances)) return direct
  let found = null
  ;(function walk(o) {
    if (found || !o || typeof o !== 'object') return
    if (!Array.isArray(o) && Array.isArray(o.instances) && o.id !== undefined && o.title !== undefined) {
      found = o
      return
    }
    for (const k in o) {
      walk(o[k])
      if (found) return
    }
  })(data)
  return found
}

/**
 * A detail page → the raw design payload plus how it was found.
 *
 * `via` is not decoration: `deep-walk` on a page that used to resolve through `known-path` is
 * the earliest possible warning that the site re-templated, and it costs one comparison.
 */
export function parseDetail(html, _ctx = {}) {
  const data = extractNextData(html)
  const design = findDesignObject(data)
  if (!design) {
    const err = new Error('NO_EMBEDDED_DESIGN: detail not in HTML (new-template page; needs the JSON API).')
    err.code = 'NO_EMBEDDED_DESIGN'
    throw err
  }
  return {
    type: 'design',
    modelId: String(design.id ?? ''),
    design,
    via: data?.props?.pageProps?.design === design ? 'known-path' : 'deep-walk',
  }
}

// ── design → ext payload ──────────────────────────────────────────────────────

/** True if one print-profile instance lists the A1 mini as compatible. */
function instanceSupportsA1Mini(instance) {
  const mi = instance?.extention?.modelInfo
  if (!mi) return false
  if (mi.compatibility?.devProductName === A1_MINI) return true
  const others = Array.isArray(mi.otherCompatibility) ? mi.otherCompatibility : []
  return others.some((d) => d?.devProductName === A1_MINI)
}

/**
 * One MakerWorld print-profile instance → one profile record.
 *
 * `prediction` is SECONDS. Reading it as minutes gives a plausible 826-hour print and nothing
 * downstream can tell — which is why the unit is in the key name (`printTimeHours`) rather
 * than in a comment, per §3 of the contract.
 *
 * `extention` is MakerWorld's spelling, not a typo of ours.
 */
function mapPrintProfile(inst) {
  const filamentsUsed = (inst.instanceFilaments || []).map((f) => ({
    type: f.type ?? '',
    color: f.color ?? '',
    grams: num(f.usedG),
    meters: num(f.usedM),
  }))
  const ratingCount = num(inst.ratingCount)
  return {
    profileId: String(inst.profileId ?? inst.id ?? ''),
    title: inst.title ?? '',
    // An unrated profile is null, never 0 — the same absent-is-not-zero rule as `metrics`,
    // and here it is the difference between "nobody rated it" and "everybody hated it".
    rating: ratingCount > 0 ? round2(num(inst.ratingScoreTotal) / ratingCount) : null,
    ratingCount,
    printTimeHours: round2(num(inst.prediction) / 3600),
    plates: Array.isArray(inst?.extention?.modelInfo?.plates)
      ? inst.extention.modelInfo.plates.length
      : null,
    amsRequired: Boolean(inst.needAms),
    downloads: num(inst.downloadCount),
    prints: num(inst.printCount),
    filamentsUsed,
    totalWeightGrams: round2(filamentsUsed.reduce((s, f) => s + f.grams, 0)),
  }
}

/**
 * The Bambu-store filament BOM.
 *
 * `productProperyList` is MakerWorld's own misspelling of "Property" and it is LOAD-BEARING.
 * Correcting it here reads as an obvious tidy-up and silently returns zero colours for every
 * model, with no error and no empty-result signal anywhere. Do not fix this spelling.
 */
function mapRecommendedFilaments(design) {
  const boms = design?.designExtension?.boms_of_filaments_v2 || []
  return boms.map((b) => {
    const colorProp = (b.productProperyList || []).find((p) => p.key === 'Color')
    return {
      spuName: b.spuName ?? '',
      handle: b.handle ?? '',
      sku: b.sku ?? '',
      colors: colorProp ? (colorProp.values || []).map((v) => v.value).filter(Boolean) : [],
    }
  })
}

// ── normalize ─────────────────────────────────────────────────────────────────

const unionLists = (...groups) => [
  ...new Set(groups.flat().filter((v) => typeof v === 'string' && v)),
]

function timesFrom(ctx, publishedAt) {
  const at = finite(ctx.capturedAt) ?? 0
  return { publishedAt: publishedAt || null, firstSeenAt: at, lastSeenAt: at, capturedAt: at }
}

/**
 * The `user` zone, passed through VERBATIM.
 *
 * The scar this repo is named after lives here. `makeUserMeta()` rebuilt the user object from
 * a five-key whitelist and silently deleted `userTags`, `related`, `parts` and `links` on
 * every re-scrape; 0.6.2 fixed it on 2026-06-08 by collecting unknown keys into `extras` and
 * spreading them after the sanitized base. Stashling ports the FIX, and then goes further:
 * the connector does not own this zone at all, so there is no whitelist here to get wrong.
 * `mergeItems()` merges it forward. The only reason `normalize()` touches `user` is so a
 * caller replaying a stored record through the parser gets its annotations back unharmed.
 *
 * This is why the zone is an open map rather than a schema. Do not "tidy" it.
 */
function passThroughUser(raw, ctx) {
  const incoming = ctx.user ?? raw?.user
  return incoming && typeof incoming === 'object' && !Array.isArray(incoming)
    ? { user: incoming }
    : {}
}

/**
 * A listing card → a partial Item.
 *
 * Everything a card knows: which model, which list, what position, who made it, what it is
 * called. No counters at all — so `metrics` is EMPTY rather than zero-filled, and a range
 * filter correctly declines to speak about an item it has no numbers for.
 */
function normalizeCard(card, ctx = {}) {
  const slug = card.slug ?? ''
  return {
    source: ID,
    sourceId: card.modelId,
    kind: KIND,
    url: ctx.url || card.url || modelUrl(card.modelId, slug),
    canonicalUrl: canonicalModelUrl(card.modelId, slug),

    title: card.title ?? '',
    byline: { id: card.authorUid || null },
    lists: unionLists(ctx.lists ?? [], card.list ? [card.list] : []),
    order: card.list && Number.isFinite(card.index) ? { [card.list]: card.index } : {},

    metrics: {},
    times: timesFrom(ctx),

    // MakerWorld gives a listing NO liveness signal whatsoever, so `unknown` is the honest
    // state — not `live`. See the `liveness` block at the bottom of this file.
    liveness: { state: 'unknown' },
    membership: { state: 'listed', checkedAt: finite(ctx.capturedAt) ?? 0 },

    ext: { slug, detailFetched: false },
    ...passThroughUser(card, ctx),
  }
}

/**
 * A design payload → a partial Item. This is the mapping the whole file exists for.
 *
 *   identity  modelId → sourceId, `makerworld:{modelId}` → id, url, slug
 *   facets    title, summary, thumb, tags, categories, byline, times, lists, order
 *   metrics   the six counters PLUS four derived numerics, so a generic range filter has
 *             something to grip: print time, plate count, rating, file count
 *   ext       print profiles, filament BOM, licence, the three MakerWorld booleans — every
 *             field whose meaning requires knowing what a 3D printer is
 *   user      not written here
 *   raw       the design object itself, hashed, stamped with the connector version
 */
function normalizeDesign(raw, ctx = {}) {
  const design = raw.design
  const modelId = String(design.id ?? '')
  const slug = design.slug ?? ''
  const instances = Array.isArray(design.instances) ? design.instances : []
  const printProfiles = instances.map(mapPrintProfile)

  // The A1 mini / AMS pair is the whole reason this catalogue exists: "can I actually print
  // this on the machine I own, without the multi-material unit I do not own".
  const a1miniCompatible = instances.some(instanceSupportsA1Mini)
  const printableWithoutAms = printProfiles.length > 0 && printProfiles.some((p) => !p.amsRequired)

  // Derived numerics live in `metrics`, not `ext`, precisely because they are the ones worth
  // filtering on — and `metrics` is the only zone generic faceting reads. MIN print time, not
  // average: the question is "is there a way to print this in under four hours", and a fast
  // draft profile alongside a 14-hour showpiece answers yes.
  const printTimes = instances
    .map((i) => finite(i.prediction))
    .filter((v) => v !== undefined)
    .map((seconds) => round2(seconds / 3600))
  const plateCounts = printProfiles.map((p) => p.plates).filter((v) => v !== null)
  const ratings = printProfiles.map((p) => p.rating).filter((v) => v !== null)

  const body = JSON.stringify(design)

  return {
    source: ID,
    sourceId: modelId,
    kind: KIND,
    url: ctx.url || raw.url || modelUrl(modelId, slug),
    canonicalUrl: canonicalModelUrl(modelId, slug),

    title: design.title ?? '',
    summary: stripTags(design.summary),
    byline: {
      name: design.designCreator?.name ?? null,
      handle: design.designCreator?.handle ?? null,
      url: design.designCreator?.handle
        ? `https://makerworld.com/en/@${design.designCreator.handle}`
        : null,
      id: design.designCreator?.uid != null ? String(design.designCreator.uid) : null,
    },
    // `derived: false` — this URL was read from the payload. `deriveThumbUrl()` is what
    // constructs one, and a host that caches thumbnails must go through it.
    thumb: design.coverUrl ? { url: design.coverUrl, derived: false } : null,

    lists: unionLists(ctx.lists ?? []),
    order: { ...(ctx.order ?? {}) },
    tags: Array.isArray(design.tags) ? design.tags : [],
    // Categories arrive as objects here and as strings on some templates. Both flatten to the
    // display name; the numeric category id is not something any plugin can use generically.
    categories: (design.categories || []).map((c) => (typeof c === 'string' ? c : c?.name ?? '')),

    metrics: defined({
      likes: finite(design.likeCount),
      downloads: finite(design.downloadCount),
      prints: finite(design.printCount),
      collections: finite(design.collectionCount),
      boosts: finite(design.boostInfo?.total),
      comments: finite(design.commentCount),

      minPrintTimeHours: printTimes.length ? Math.min(...printTimes) : undefined,
      maxPlates: plateCounts.length ? Math.max(...plateCounts) : undefined,
      bestRating: ratings.length ? Math.max(...ratings) : undefined,
      // A design whose payload carries no `model_files` at all is UNKNOWN, not zero-file. The
      // shipped exporter wrote 0 for both and a "models with no files" filter would have been
      // wrong on every model MakerWorld served without a designExtension.
      modelFileCount: Array.isArray(design.designExtension?.model_files)
        ? design.designExtension.model_files.length
        : undefined,
    }),

    times: timesFrom(ctx, design.createTime),

    liveness: { state: 'unknown' },
    membership: { state: 'listed', checkedAt: finite(ctx.capturedAt) ?? 0 },

    ext: {
      slug,
      license: design.license ?? '',
      updateTime: design.updateTime ?? '',
      a1miniCompatible,
      printableWithoutAms,
      cyberBrick: Boolean(design.cyberBrickNeeded),
      printProfiles,
      recommendedFilaments: mapRecommendedFilaments(design),
      detailFetched: true,
      foundVia: raw.via ?? null,
    },

    // The design object, not the 1.5 MB page. §7: never reconstruct a record from parsed
    // columns — and the design object IS the payload, so keeping the HTML wrapper around it
    // buys nothing and costs 60× the bytes. `connectorVersion` travels with the blob so an
    // older capture can be re-shredded by a newer parser.
    raw: {
      body,
      contentType: 'application/json',
      hash: `fnv1a64-${fnv1a64(body)}`,
      capturedAt: finite(ctx.capturedAt) ?? 0,
      connectorVersion: VERSION,
    },

    ...passThroughUser(raw, ctx),
  }
}

/**
 * Raw record → partial Item. Both raw shapes this connector produces land here.
 *
 * @param {object} raw   a `parseList` card or a `parseDetail` design
 * @param {object} [ctx] `{ url, lists, order, capturedAt, user }` — the listing-derived facts
 *                       a detail fetch cannot see, plus the user zone to carry forward
 */
export function normalize(raw, ctx = {}) {
  if (!raw || typeof raw !== 'object') throw new TypeError('normalize: expected a raw record')
  if (raw.type === 'design') return normalizeDesign(raw, ctx)
  if (raw.type === 'card') return normalizeCard(raw, ctx)
  throw new TypeError(`normalize: unknown raw type ${JSON.stringify(raw.type)}`)
}

/** Cover URL → the resized CDN variant. See `THUMB_TRANSFORM`. */
export function deriveThumbUrl(item) {
  const url = typeof item === 'string' ? item : item?.thumb?.url
  if (!url) return null
  return url + (url.includes('?') ? '&' : '?') + THUMB_TRANSFORM
}

// ── the connector ─────────────────────────────────────────────────────────────

export default defineConnector({
  id: ID,
  kind: KIND,
  version: VERSION,

  match: (url) => /^https?:\/\/(www\.)?makerworld\.com\//i.test(String(url ?? '')),

  hosts: ['https://makerworld.com/*', 'https://*.bblmw.com/*'],

  /**
   * Three lists, one of which is a family. `collection` matches any collection page and
   * `resolveId` produces the per-collection id, because a user has many collections and the
   * trackid already carries which one — the list id `collection:{id}` is data, not a constant.
   */
  lists: [
    {
      id: 'likes',
      label: 'Likes',
      match: (url) => /\/@[^/]+\/likes\b/i.test(String(url ?? '')),
      resolveId: () => 'likes',
    },
    {
      // Not a wishlist — a printed-approximation. A model you downloaded is strong evidence
      // you printed it, which is why this list is worth scraping at all. It stays a SCRAPED
      // fact in `lists`; turning it into "printed" is a user-zone decision no connector makes.
      id: 'downloads',
      label: 'Downloads',
      match: (url) => /\/@[^/]+\/downloads\b/i.test(String(url ?? '')),
      resolveId: () => 'downloads',
    },
    {
      id: 'collection',
      label: 'Collection',
      match: (url) => /\/collections\/\d+/i.test(String(url ?? '')),
      resolveId: (url) => {
        const m = /\/collections\/(\d+)/.exec(String(url ?? ''))
        return m ? `collection:${m[1]}` : null
      },
    },
  ],

  acquisition: {
    strategy: ACQUISITION_STRATEGIES.DOM_ACTIVE_TAB,
    scope: CARD_MARKER,

    // No autoScroll. The shipped scraper deliberately read whatever the user had already
    // scrolled into the page and relied on re-scan merge to pick up the rest — a 733-item
    // Likes page is an infinite scroll, and an unattended auto-scroll over it is exactly the
    // traffic pattern that gets a session rate-limited. Re-scanning is cheap; the scan pass
    // costs one page read and merges list membership without re-fetching anything.

    /**
     * The listing pass yields ids and list membership; everything else needs a per-item fetch.
     *
     * `retryOn: [403, 429]` — and 403 here means RATE LIMITED, not forbidden. That is
     * correct for this CDN and wrong for most sources, where retrying a 403 four times is
     * how you get an IP banned. It is per-connector for exactly this reason. Measured budget:
     * 4 retries × exponential backoff over a 400–1200 ms jitter is ~0.8 s best case to
     * ~19.2 s worst case per item; a full 733-model run is 8–18 minutes, which is why the
     * shipped tool never re-fetched an already-catalogued model.
     */
    detail: {
      strategy: ACQUISITION_STRATEGIES.DETAIL_FETCH,
      throttleMs: [400, 1200],
      // The user's own session cookies. Anonymous fetches hit the bot wall.
      credentials: 'include',
      retry: {
        retryOn: [403, 429],
        maxRetries: 4,
        backoff: 'exponential',
        networkBackoff: 'linear',
      },
    },
  },

  parseList,
  parseDetail,
  normalize,
  deriveThumbUrl,

  /**
   * MakerWorld has NO liveness signal. This is the single strongest argument in the repo for
   * putting these tools on one contract.
   *
   * `atScrape: null` is not an omission. A listing card carries an id, a scope, an index, a
   * cover and a name — and nothing whatsoever that changes when a model is deleted, made
   * private, or taken down. The shipped extension went further and never re-fetched an
   * already-catalogued model at all, so nothing in that codebase could ever observe a model
   * becoming unavailable: no dead flag, no status interpretation beyond retry, no
   * re-validation pass. A tool whose entire premise is surviving platform loss cannot tell
   * you that the loss happened.
   *
   * So the connector DESCRIBES a probe instead of implementing one. It returns a request
   * descriptor and an ordered interpretation table; the host owns the fetch, the budget and
   * the backoff, and the same descriptor works from a service worker, a CLI or a test double.
   *
   * The `bodyMissing` rung matters more than the status rungs: Kleinanzeigen proved deleted
   * items frequently answer 200-with-a-redirect rather than 404, so a status-only probe
   * reports every deleted item as alive. Here the equivalent tell is a 200 whose HTML has no
   * `__NEXT_DATA__` design payload.
   */
  liveness: {
    atScrape: null,
    probe: (item) => ({
      method: 'GET',
      url: item?.url ?? item?.canonicalUrl ?? null,
      credentials: 'include',
      accept: 'text/html',
      cost: 'full-page-fetch',
      // First match wins, so the specific rungs come before the 200 catch-all.
      interpret: [
        { when: { status: 404 }, state: 'gone', outcome: 'terminal' },
        { when: { status: 410 }, state: 'gone', outcome: 'terminal' },
        // 403/429 are this CDN's rate limiter, NOT a verdict about the model.
        { when: { status: 403 }, state: 'unknown', outcome: 'retryable' },
        { when: { status: 429 }, state: 'unknown', outcome: 'retryable' },
        { when: { status: 401 }, state: 'restricted', outcome: 'terminal' },
        { when: { statusRange: [500, 599] }, state: 'unknown', outcome: 'retryable' },
        { when: { bodyMissing: '__NEXT_DATA__' }, state: 'unknown', outcome: 'terminal' },
        { when: { status: 200 }, state: 'live', outcome: 'success' },
      ],
    }),
  },

  /**
   * The facet manifest — the migration proof in declarative form.
   *
   * Every key here is a dotted path into a record a generic UI has never heard of, and the
   * range entries go through the identical `matchesFilter()` the YouTube connector's "under
   * 30 minutes" uses. `cap: 12` with `capOpen: true` because print times are long-tailed:
   * without the open cap one 60-hour showpiece stretches the slider until every real filter
   * lives in its first two pixels.
   *
   * `log: true` on downloads and likes for the same reason in the other direction — these
   * counts are power-law distributed (3,958 downloads next to a handful in the tens), and a
   * linear axis renders the whole collection as one bar and 700 slivers.
   *
   * The two bool facets read out of `ext`. Core still never INSPECTS `ext` — it follows a
   * path the connector handed it, which is the connector saying "this opaque blob has a
   * boolean here and it is worth a checkbox".
   */
  facets: [
    {
      key: 'metrics.minPrintTimeHours',
      label: 'Print time',
      type: 'range',
      unit: 'h',
      cap: 12,
      capOpen: true,
    },
    { key: 'metrics.downloads', label: 'Downloads', type: 'range', log: true },
    { key: 'metrics.likes', label: 'Likes', type: 'range', log: true },
    { key: 'metrics.bestRating', label: 'Rating', type: 'range', unit: 'star', cap: 5 },
    { key: 'tags', label: 'Tags', type: 'term' },
    { key: 'byline.name', label: 'Creator', type: 'term' },
    { key: 'ext.a1miniCompatible', label: 'A1 mini', type: 'bool' },
    { key: 'ext.printableWithoutAms', label: 'Prints without AMS', type: 'bool' },
  ],
})
