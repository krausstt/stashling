/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The MakerWorld connector — the migration proof.
 *
 * Its job is not only to parse MakerWorld. It is to demonstrate that the Item contract holds
 * for a domain that is nothing like a video: a 3D model with print profiles, filament BOMs,
 * plate counts and printer-compatibility flags. If the contract were secretly video-shaped,
 * this is the file where that would show.
 *
 * The last test in this file is the actual proof: the SAME generic range-filter call shape
 * answers "print time under 4 hours" for a model and "under 30 minutes" for a video.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import mw, { parseList, parseDetail, normalize, findDesignObject, extractNextData, deriveThumbUrl }
  from '../src/makerworld.js'
import youtube from '../src/youtube.js'
import { createItem, validateItem, validateConnector, matchesFilter, mergeItems }
  from '../../core/src/index.js'

const fx = (name) => readFileSync(fileURLToPath(new URL(`../../../fixtures/makerworld/${name}`, import.meta.url)), 'utf8')
const listingHtml = fx('listing.fixture.html')
const detailHtml = fx('detail.fixture.html')
const movedHtml = fx('detail-moved.fixture.html')

const CTX = { capturedAt: 1756900000000 }
const cards = parseList(listingHtml)
const byModel = new Map(cards.map((c) => [c.modelId, c]))

const design = parseDetail(detailHtml)
const item = createItem(normalize(design, { ...CTX, lists: ['likes'], order: { likes: 0 } }))

// ── the connector ─────────────────────────────────────────────────────────────

test('the connector is structurally valid', () => {
  assert.deepEqual(validateConnector(mw), [])
  assert.equal(mw.id, 'makerworld')
  assert.equal(mw.kind, 'model')
  assert.equal(mw.acquisition.scope, 'js-design-card')
})

// ── listing ───────────────────────────────────────────────────────────────────

test('listing: one card per model, deduplicated, in the source order', () => {
  assert.equal(cards.length, 6, '8 card divs: one is a skeleton, one is a duplicate')
  // Indices repeat across lists — the `likes` grid and the `downloads` grid each start at 0.
  // They are per-list positions, not a global sequence, which is why `order` is keyed by list.
  assert.deepEqual(cards.map((c) => c.index), [0, 0, 1, 2, 3, 4], 'sorted by the source index')
  assert.equal(new Set(cards.map((c) => c.modelId)).size, cards.length)
})

test('listing: first occurrence wins, so the pinned position survives', () => {
  // 9000001 appears at index 0 and again at index 47 further down the grid.
  assert.equal(byModel.get('9000001').index, 0)
  assert.equal(cards.filter((c) => c.modelId === '9000001').length, 1)
})

test('listing: a numeric from-token becomes collection:{id}', () => {
  assert.equal(byModel.get('9000001').list, 'likes')
  assert.equal(byModel.get('9000003').list, 'downloads')
  assert.equal(byModel.get('9000004').list, 'collection:10129261')
})

test('listing: a card with no data-trackid is skipped, not half-parsed', () => {
  assert.ok(listingHtml.includes('mw-css-skeleton'), 'the fixture contains a skeleton card')
  assert.equal(cards.some((c) => !c.modelId), false)
})

test('listing: THE TIME BOMB — an avatar with alt text must not become the title', () => {
  // The shipped parser took the first <img alt> in the chunk with no anchoring to the cover.
  // On this card the avatar renders FIRST and carries a real creator name, so that heuristic
  // titles the model "Nadia Okonkwo" and nothing detects it. Titles are what a human reads.
  const naive = /<img[^>]*alt="([^"]*)"/.exec(listingHtml.split('js-design-card')[6])
  assert.equal(naive[1], 'Nadia Okonkwo', 'the naive heuristic really does pick the avatar')
  assert.equal(byModel.get('9000005').title, 'Spool Hub Adapter', 'the ladder titles it correctly')
})

test('listing: falls back to the cover alt when the anchor has no title attribute', () => {
  assert.equal(byModel.get('9000006').title, 'Filament Clip')
})

test('listing: nothing depends on the obfuscated class names', () => {
  const stripped = listingHtml.replace(/mw-css-[a-z0-9-]+/g, 'x')
  assert.equal(parseList(stripped).length, cards.length)
  assert.equal(parseList(stripped)[0].title, cards[0].title)
})

test('listing: a card carries no counters, so metrics is EMPTY rather than zero-filled', () => {
  // A range filter must decline to speak about an item it has no numbers for, instead of
  // ranking it at the bottom as if it genuinely had zero downloads.
  const carded = createItem(normalize(byModel.get('9000001'), CTX))
  assert.deepEqual(carded.metrics, {})
  assert.equal(matchesFilter(carded, { key: 'metrics.downloads', type: 'range' }, { min: 0 }), false)
  assert.equal(carded.liveness.state, 'unknown', 'a listing gives no liveness signal at all')
})

// ── detail ────────────────────────────────────────────────────────────────────

test('detail: resolves through the known path and reports it', () => {
  assert.equal(design.via, 'known-path')
  assert.equal(design.modelId, '9000001')
})

test('detail: THE DEEP WALK fires when the template moves, and says so', () => {
  const moved = parseDetail(movedHtml)
  assert.equal(moved.via, 'deep-walk', 'the earliest possible warning that the site re-templated')
  assert.equal(moved.modelId, '9000005')
  assert.equal(moved.design.title, 'Spool Hub Adapter')
})

test('detail: the discriminator REFUSES summaries that lack an instances array', () => {
  // Both decoys carry id and title and would otherwise produce a record with counters and no
  // print profiles — plausible, and wrong.
  const data = extractNextData(movedHtml)
  const found = findDesignObject(data)
  assert.equal(found.id, 9000005)
  assert.equal(found.title, 'Spool Hub Adapter')
  assert.equal(findDesignObject({ props: { pageProps: { design: { id: 1, title: 'x', likeCount: 9 } } } }), null)
  assert.equal(findDesignObject({ a: { id: 1, title: 'x', instances: { 0: {} } } }), null,
    'instances must be an ARRAY, not merely present')
})

test('detail: a page with no __NEXT_DATA__ throws a coded error', () => {
  assert.throws(() => extractNextData('<html><body>nothing</body></html>'), /NO_NEXT_DATA/)
  assert.throws(() => parseDetail('<script id="__NEXT_DATA__" type="application/json">{"props":{}}</script>'),
    /NO_EMBEDDED_DESIGN/)
})

// ── the zone mapping ──────────────────────────────────────────────────────────

test('identity and facets land where the contract says', () => {
  assert.equal(item.id, 'makerworld:9000001')
  assert.equal(item.kind, 'model')
  assert.equal(item.title, 'Hex Bit Caddy')
  assert.equal(item.summary, 'A caddy for hex bits.', 'HTML stripped')
  assert.deepEqual(item.byline, {
    name: 'Fern Makes', handle: 'fern_makes',
    url: 'https://makerworld.com/en/@fern_makes', id: '510000001',
  })
  assert.deepEqual(item.tags, ['tools', 'organizer', 'hex', 'workshop'])
  assert.deepEqual(item.categories, ['Tool Organizers', 'Hobby & DIY'], 'objects and strings both flatten')
  assert.deepEqual(item.lists, ['likes'])
  assert.deepEqual(item.order, { likes: 0 })
  assert.deepEqual(validateItem(item), [])
})

test('metrics carries the six counters PLUS the four derived numerics', () => {
  assert.deepEqual(item.metrics, {
    likes: 1919, downloads: 3958, prints: 742, collections: 3866, boosts: 86, comments: 110,
    minPrintTimeHours: 3, maxPlates: 6, bestRating: 5, modelFileCount: 3,
  })
})

test('prediction is SECONDS — 49536 is 13.76 h, not 826 h', () => {
  const [full, draft] = item.ext.printProfiles
  assert.equal(full.printTimeHours, 13.76)
  assert.equal(draft.printTimeHours, 3)
  // MIN, not average: the question is "is there a way to print this in under four hours".
  assert.equal(item.metrics.minPrintTimeHours, 3)
})

test('an unrated profile has rating null, never 0', () => {
  const [full, draft] = item.ext.printProfiles
  assert.equal(full.rating, 5)
  assert.equal(full.ratingCount, 2)
  assert.equal(draft.rating, null, '"nobody rated it" is not "everybody hated it"')
  assert.equal(draft.ratingCount, 0)
  assert.equal(item.metrics.bestRating, 5, 'the null is excluded rather than counted as 0')
})

test('ext holds everything whose meaning requires knowing what a 3D printer is', () => {
  assert.equal(item.ext.a1miniCompatible, true)
  assert.equal(item.ext.printableWithoutAms, true, 'the draft profile needs no AMS')
  assert.equal(item.ext.cyberBrick, false)
  assert.equal(item.ext.license, 'CC BY-NC 4.0')
  assert.equal(item.ext.printProfiles.length, 2)
  assert.equal(item.ext.foundVia, 'known-path')
  assert.equal(item.ext.printProfiles[0].totalWeightGrams, 288)
  assert.deepEqual(item.ext.printProfiles[0].filamentsUsed.map((f) => f.type), ['PLA', 'TPU'])
})

test('A1 mini compatibility is read from BOTH spellings', () => {
  // Profile 1 declares it via compatibility.devProductName; profile 2 via otherCompatibility[].
  const onlyOther = { type: 'design', design: { ...design.design, instances: [design.design.instances[1]] } }
  assert.equal(normalize(onlyOther, CTX).ext.a1miniCompatible, true)
})

test('productProperyList is MakerWorld\'s misspelling and is LOAD-BEARING', () => {
  // Correcting it here reads as an obvious tidy-up and silently returns zero colours for every
  // model, with no error and no empty-result signal anywhere.
  assert.ok(detailHtml.includes('productProperyList'))
  assert.equal(detailHtml.includes('productPropertyList'), false)
  assert.deepEqual(item.ext.recommendedFilaments[0].colors, ['Black', 'Matte Ivory'])
  assert.deepEqual(item.ext.recommendedFilaments[1].colors, ['Clear'])
})

test('raw is the design payload, hashed and version-stamped — not the 1.5 MB page', () => {
  assert.equal(item.raw.contentType, 'application/json')
  assert.equal(item.raw.connectorVersion, mw.version)
  assert.match(item.raw.hash, /^fnv1a64-/)
  assert.equal(JSON.parse(item.raw.body).id, 9000001)
  assert.ok(item.raw.body.length < detailHtml.length, 'the HTML wrapper buys nothing')
})

test('modelFileCount is UNKNOWN, not zero, when the payload carries no designExtension', () => {
  const bare = { type: 'design', design: { ...design.design, designExtension: undefined } }
  assert.equal('modelFileCount' in normalize(bare, CTX).metrics, false)
})

test('thumb comes from the payload; deriveThumbUrl builds the resized CDN variant', () => {
  assert.equal(item.thumb.derived, false, 'this URL was read, not constructed')
  assert.equal(deriveThumbUrl(item), 'https://makerworld.bblmw.com/cover/9000001.webp?x-oss-process=image/resize,w_400')
})

// ── the user zone ─────────────────────────────────────────────────────────────

test('THE SCAR: unknown user keys survive normalize verbatim', () => {
  // makeUserMeta() rebuilt this object from a five-key whitelist and silently deleted
  // userTags/related/parts/links on every re-scrape until 0.6.2. Stashling ports the fix and
  // goes further — the connector does not own this zone, so there is no whitelist to get wrong.
  const user = {
    printed: true, notes: 'printed in PETG',
    userTags: ['gift'], related: [{ id: 'makerworld:9000002', relation: 'goes-with' }],
    parts: [{ name: 'M3x8', qty: 4 }], links: [{ label: 'BOM', url: 'https://e.x', kind: 'bom' }],
    aKeyInventedNextYear: { nested: true },
  }
  assert.deepEqual(createItem(normalize(design, { ...CTX, user })).user, user)
})

test('a re-scrape cannot clobber the user zone', () => {
  const stored = createItem(normalize(design, { ...CTX, user: { notes: 'mine', userTags: ['keep'] } }))
  const fresh = createItem(normalize(design, CTX))
  assert.deepEqual(mergeItems(stored, fresh, { writer: 'connector' }).user, { notes: 'mine', userTags: ['keep'] })
})

// ── liveness gap ──────────────────────────────────────────────────────────────

test('MakerWorld reports liveness "unknown", which is the honest state', () => {
  // The suite whose entire premise is surviving platform loss has no liveness signal at all:
  // an already-catalogued model is never re-fetched, so nothing in it can ever observe a model
  // disappearing. Claiming "live" here would manufacture a guarantee the source never gave.
  assert.equal(item.liveness.state, 'unknown')
  assert.equal(mw.liveness.atScrape, null)
  assert.notEqual(mw.liveness.probe, null, 'but it declares what a host would need to fetch')
})

// ── THE MIGRATION PROOF ───────────────────────────────────────────────────────

test('THE PROOF: one generic filter call answers both domains', () => {
  // A 3D model and a video share no fields, no vocabulary and no source. The flat `metrics`
  // map plus a connector-supplied facet manifest is the entire reason a filter written once
  // works on both — this is what the Item contract is FOR.
  const printTime = mw.facets.find((f) => f.key === 'metrics.minPrintTimeHours')
  const length = youtube.facets.find((f) => f.key === 'metrics.durationSec')
  assert.ok(printTime, 'MakerWorld publishes a print-time range facet')
  assert.ok(length, 'YouTube publishes a duration range facet')

  const video = createItem({ source: 'youtube', sourceId: 'vidAAAAAAAA', kind: 'video',
    title: 'A short video', metrics: { durationSec: 1200 } })

  // "print time under 4 hours" and "under 30 minutes" — same function, same argument shape.
  assert.equal(matchesFilter(item, printTime, { max: 4 }), true, 'the 3 h draft profile qualifies')
  assert.equal(matchesFilter(video, length, { max: 30 }), true, '20 minutes qualifies')
  assert.equal(matchesFilter(item, printTime, { max: 2 }), false)
  assert.equal(matchesFilter(video, length, { max: 15 }), false)

  // And the filters do not bleed across domains: neither item carries the other's metric, so
  // each correctly declines rather than matching on a missing value.
  assert.equal(matchesFilter(video, printTime, { max: 4 }), false)
  assert.equal(matchesFilter(item, length, { max: 30 }), false)
})

test('both connectors coexist in one store under one id namespace', () => {
  const video = createItem({ source: 'youtube', sourceId: 'vidAAAAAAAA', kind: 'video', title: 'v' })
  const store = new Map([[item.id, item], [video.id, video]])
  assert.equal(store.size, 2)
  assert.equal(store.get('makerworld:9000001').kind, 'model')
  assert.equal(store.get('youtube:vidAAAAAAAA').kind, 'video')
})
