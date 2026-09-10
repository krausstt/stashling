/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The YouTube connector, tested against a synthetic fixture that reproduces the structural
 * shapes measured on one real 582-row Watch Later page.
 *
 * Coverage is asserted as PERCENTAGES rather than as spot checks, because the percentage is the
 * alarm. A drop from 100% to 96% on `title` is how you find out a platform redesigned overnight;
 * a spot check on row 1 tells you nothing until row 1 happens to be the broken one.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import yt, { SELECTORS, match, listIdFor, listParam, parseList, normalize, atScrape, deriveThumbUrl }
  from '../src/youtube.js'
import { createItem, validateItem, validateConnector, canonicalizeUrl } from '../../core/src/index.js'

const FIXTURE = fileURLToPath(new URL('../../../fixtures/youtube/watch-later.fixture.html', import.meta.url))
const html = readFileSync(FIXTURE, 'utf8')
const CTX = { url: 'https://www.youtube.com/playlist?list=WL', capturedAt: 1756900000000 }

const raws = parseList(html)
const items = raws.map((r) => normalize(r, CTX)).filter(Boolean).map((p) => createItem(p))
const byId = new Map(items.map((i) => [i.sourceId, i]))

const pct = (n) => (n / raws.length) * 100
const coverage = (fn) => pct(raws.filter(fn).length)

// ── the connector itself ──────────────────────────────────────────────────────

test('the connector is structurally valid', () => {
  assert.deepEqual(validateConnector(yt), [])
  assert.equal(yt.id, 'youtube')
  assert.equal(yt.kind, 'video')
  assert.equal(yt.acquisition.strategy, 'dom-active-tab')
  assert.equal(yt.acquisition.scope, 'ytd-playlist-video-renderer')
  assert.ok(yt.acquisition.autoScroll.maxMs > 0, 'a virtualized list needs a scroll deadline')
})

test('match claims playlist pages and refuses the watch page', () => {
  assert.equal(match('https://www.youtube.com/playlist?list=WL'), true)
  assert.equal(match('https://www.youtube.com/playlist?list=LL'), true)
  assert.equal(match('https://m.youtube.com/playlist?list=PL123'), true)
  // The watch page renders its queue with ytd-playlist-panel-video-renderer — a different
  // element. Claiming it would hand the host a scope that yields zero rows, which reads as
  // "the connector broke" rather than "wrong page".
  assert.equal(match('https://www.youtube.com/watch?v=vidAAAAAAAA&list=WL'), false)
  assert.equal(match('https://www.youtube.com/playlist'), false)
  assert.equal(match('https://vimeo.com/playlist?list=WL'), false)
})

test('list ids map WL and LL to names and everything else per playlist', () => {
  assert.equal(listIdFor('https://www.youtube.com/playlist?list=WL'), 'watch-later')
  assert.equal(listIdFor('https://www.youtube.com/playlist?list=LL'), 'likes')
  assert.equal(listIdFor('https://www.youtube.com/playlist?list=PLabc'), 'playlist:PLabc')
  assert.equal(listParam('https://example.com/playlist?list=WL'), null)
})

// ── scope-then-extract ────────────────────────────────────────────────────────

test('SCOPE-THEN-EXTRACT: page-wide ids leak, row-scoped ids do not', () => {
  // The real page holds 639 unique watch?v= ids but only 582 real rows. The fixture reproduces
  // that shape with decoy anchors and a leftover ytInitialData blob outside every row element.
  const pageWide = new Set([...html.matchAll(/watch\?v=([A-Za-z0-9_-]{11})/g)].map((m) => m[1]))
  const scoped = new Set(raws.map((r) => r.videoId))

  assert.ok(pageWide.size > scoped.size, 'the fixture must contain decoys, or this proves nothing')
  assert.equal(scoped.size, raws.length, 'every row yields exactly one distinct id')
  for (const id of scoped) assert.ok(!id.startsWith('decoy'), `decoy ${id} leaked into the result`)
  assert.ok(pageWide.has('decoy000001'), 'a page-wide scan does pick the decoys up')
})

test('chunk count is driven by the open tag, not the CSS scope token', () => {
  // On the real page the bare substring appears 12,804 times as a class token but only 582 times
  // as an open tag. Counting the substring overstates the row count by ~22x.
  const openTags = (html.match(/<ytd-playlist-video-renderer/g) ?? []).length
  const substring = (html.match(/ytd-playlist-video-renderer/g) ?? []).length
  assert.equal(raws.length, openTags)
  assert.ok(substring > openTags, 'the fixture reproduces the class-token noise')
})

test('a chunk ENDS at its own closing tag — the last row does not run to EOF', async () => {
  // The split-based chunker gave the last chunk everything to end-of-document. Measured on this
  // fixture: 3,784 chars against ~2,800 for its siblings, carrying the decoy ids, the
  // ytInitialData blob and </html>. On the real 582-row page that is a 1.8 MB blob attached to
  // the last row, which then exceeds the store's MAX_RAW_BYTES and loses its lossless copy.
  const { chunkByElement } = await import('../src/_shared/html.js')
  const chunks = chunkByElement(html, 'ytd-playlist-video-renderer')
  const last = chunks.at(-1)

  assert.ok(last.trimEnd().endsWith('</ytd-playlist-video-renderer>'), 'chunk ends at its close tag')
  assert.equal(/decoy0000/.test(last), false, 'no decoy leaked into the last row')
  assert.equal(last.includes('ytInitialData'), false)
  assert.equal(last.includes('</html>'), false)

  const sizes = chunks.map((c) => c.length)
  const median = [...sizes].sort((a, b) => a - b)[Math.floor(sizes.length / 2)]
  assert.ok(last.length < median * 2, `last chunk ${last.length} is an outlier vs median ${median}`)
})

test('chunkByElement handles trailing junk, nesting and self-closing tags', async () => {
  const { chunkByElement } = await import('../src/_shared/html.js')
  assert.deepEqual(chunkByElement('<r>a</r>TRAILING JUNK', 'r'), ['<r>a</r>'])
  assert.deepEqual(chunkByElement('<r><r>in</r>out</r><r>b</r>', 'r'),
    ['<r><r>in</r>out</r>', '<r>b</r>'], 'a nested row is one chunk, not two and a fragment')
  assert.deepEqual(chunkByElement('<r a=1 />x<r>b</r>', 'r'), ['<r a=1 />', '<r>b</r>'])
  assert.deepEqual(chunkByElement('<r>unclosed', 'r'), ['<r>unclosed'], 'a truncated page keeps its rows')
  assert.deepEqual(chunkByElement('', 'r'), [])
  assert.deepEqual(chunkByElement('<rowdy>x</rowdy>', 'r'), [], 'the element NAME must match wholly')
})

test('open and close tags are balanced across the fixture', () => {
  // CONNECTOR-GUIDE tells every author to check this by hand; nothing asserted it.
  const open = (html.match(/<ytd-playlist-video-renderer\b/g) ?? []).length
  const close = (html.match(/<\/ytd-playlist-video-renderer>/g) ?? []).length
  assert.equal(open, close)
  assert.equal(raws.length, open)
})

test('parseCompactNumber returns null for junk, never a finite 0', async () => {
  // A bare '.' matched `([\d.,]+)`, stripped to '', and Number('') is 0 — so `metrics.views`
  // was written as 0 for unparseable text. ITEM-CONTRACT §3: absent is omitted, never zero.
  const { parseCompactNumber } = await import('../src/_shared/html.js')
  for (const junk of ['.', '...', ', ,', '', '   ', 'views', null, undefined]) {
    assert.equal(parseCompactNumber(junk), null, `${JSON.stringify(junk)} must be null`)
  }
  assert.equal(parseCompactNumber('1.5'), 2, 'a decimal is a decimal, not stripped grouping')
  assert.equal(parseCompactNumber('1.2M views'), 1200000)
  assert.equal(parseCompactNumber('1,2M'), 1200000)
  assert.equal(parseCompactNumber('1,234 views'), 1234)
  assert.equal(parseCompactNumber('1.234 Aufrufe'), 1234)
  assert.equal(parseCompactNumber('612K views'), 612000)
  assert.equal(parseCompactNumber('5 views'), 5)
})

// ── coverage ──────────────────────────────────────────────────────────────────

test('COVERAGE: id, title and index are 100%', () => {
  assert.equal(coverage((r) => /^[A-Za-z0-9_-]{11}$/.test(r.videoId ?? '')), 100)
  assert.equal(coverage((r) => Boolean(r.title)), 100)
  assert.equal(coverage((r) => Number.isFinite(r.index)), 100)
})

test('COVERAGE: duration and views are 100% on rows that have them', () => {
  // The two placeholder rows carry no metadata line and no thumbnail overlay at all — that is
  // what a removed video looks like, so they are excluded from the denominator rather than
  // counted as extraction failures.
  const playable = raws.filter((r) => !r.unavailable)
  const cov = (fn) => (playable.filter(fn).length / playable.length) * 100
  assert.equal(cov((r) => Number.isFinite(r.durationSec)), 100)
  assert.equal(cov((r) => Number.isFinite(r.views)), 100)
  assert.equal(raws.length - playable.length, 2, 'the fixture carries exactly 2 placeholder rows')
})

test('COVERAGE: byline degrades exactly as measured — and it is NOT a tombstone', () => {
  const playable = raws.filter((r) => !r.unavailable)
  const noName = playable.filter((r) => !r.channelName)
  const noUrl = playable.filter((r) => !r.channelUrl)

  assert.equal(noName.length, 1, 'the is-empty="" row')
  assert.equal(noUrl.length, 2, 'the is-empty="" row plus the href-less anchor row')
  // Measured on the real page: the 3 nameless rows are a strict subset of the 19 url-less ones.
  assert.ok(noName.every((r) => !r.channelUrl), 'nameless is a subset of urlless')

  // The load-bearing assertion. Treating a null byline as "gone" would have invented 19 false
  // deletions on the very first real scrape of 582 rows.
  for (const r of noUrl) assert.equal(atScrape(r).state, 'live')
  assert.equal(byId.get('vidGGGGGGGG').byline.name, null)
  assert.equal(byId.get('vidGGGGGGGG').byline.url, null)
  assert.equal(byId.get('vidFFFFFFFF').byline.name, 'Northwind Labs and Apex Robotics')
  assert.equal(byId.get('vidFFFFFFFF').byline.url, null)
})

// ── the three 0% traps ────────────────────────────────────────────────────────

test('TRAP 1: hrefs are absolute — a leading-slash pattern finds nothing', () => {
  const leadingSlash = /^(\/@|\/channel\/)/
  const withChannel = raws.filter((r) => r.channelUrl)
  assert.ok(withChannel.length > 0)
  assert.equal(
    withChannel.filter((r) => leadingSlash.test(r.channelUrl)).length, 0,
    'the pattern an earlier draft specified matches 0 rows',
  )
  assert.ok(withChannel.every((r) => r.channelUrl.startsWith('https://www.youtube.com/')))
})

test('TRAP 2: #index and #video-info are custom elements, not span/div', () => {
  assert.equal((html.match(/<span[^>]*\bid="index"/g) ?? []).length, 0)
  assert.equal((html.match(/<div[^>]*\bid="video-info"/g) ?? []).length, 0)
  assert.ok((html.match(/<yt-formatted-string[^>]*\bid="index"/g) ?? []).length > 0)
  // The tag-agnostic reader gets them anyway.
  assert.equal(coverage((r) => Number.isFinite(r.index)), 100)
})

test('TRAP 3: #attributed-channel-name is present in every row and always empty', () => {
  const rows = html.split('<ytd-playlist-video-renderer').slice(1)
  const withTrap = rows.filter((c) => c.includes('id="attributed-channel-name"'))
  assert.ok(withTrap.length >= 10, 'the fixture reproduces the trap')
  for (const c of withTrap) {
    assert.match(c, /id="attributed-channel-name" hidden=""><\/span>/,
      'it is hidden and empty — the most plausible channel anchor on the page yields 0%')
  }
})

test('the duration table has three independent anchors and they agree', () => {
  // All three were at 100% on the real page. If YouTube drops one, the next must already work.
  const row = html.split('<ytd-playlist-video-renderer')[1]
  const got = SELECTORS.duration.map((c) => c.get('<ytd-playlist-video-renderer' + row))
  assert.equal(got.filter(Boolean).length, 3, 'all three candidates resolve on a normal row')
  for (const g of got) assert.equal(g.sec, 1938, '32:18 and "32 minutes, 18 seconds" agree')
})

test('the channel lookup is scoped first, or it reads the duration span', () => {
  // Every row contains TWO elements with id="text": the duration span inside the thumbnail
  // overlay (first in document order) and the channel name. An unscoped read finds the duration.
  const row = '<ytd-playlist-video-renderer' + html.split('<ytd-playlist-video-renderer')[1]
  assert.ok((row.match(/\bid="text"/g) ?? []).length >= 2, 'the fixture reproduces the collision')
  assert.equal(byId.get('vidAAAAAAAA').byline.name, 'Fern Workshop')
})

// ── ordering ──────────────────────────────────────────────────────────────────

test('ORDER IS A HINT, NOT A SEQUENCE: gaps and duplicates are normal', () => {
  // Measured on the real page: ordinals 400 and 415 are absent, and 499 and 500 each appear
  // twice, one of them out of document order. That is YouTube's own numbering — the row reading
  // 401 also carries href="…&index=401". A virtualized list re-renders and its ordinals drift.
  const idx = raws.map((r) => r.index)
  assert.ok(idx.includes(11) && !idx.includes(10), 'the fixture skips an ordinal')
  assert.equal(idx.filter((v) => v === 12).length, 2, 'the fixture repeats an ordinal')
  // Identity never touches order. Two rows share ordinal 12 and remain distinct items.
  assert.equal(byId.get('vidKKKKKKKK').order['watch-later'], 12)
  assert.equal(byId.get('vidLLLLLLLL').order['watch-later'], 12)
  assert.notEqual(byId.get('vidKKKKKKKK').id, byId.get('vidLLLLLLLL').id)
})

test('parseList returns failures rather than filtering them out', () => {
  // Dropping unparseable rows would make coverage 100% by construction and silently
  // under-collect. A row with no id survives to parseList's output and is only dropped at
  // normalize, where it provably has no identity.
  const orphan = parseList('<ytd-playlist-video-renderer><div id="meta"></div></ytd-playlist-video-renderer>')
  assert.equal(orphan.length, 1)
  assert.equal(orphan[0].videoId, null)
  assert.equal(normalize(orphan[0], CTX), null, 'no sourceId means no identity, so no Item')
})

// ── liveness ──────────────────────────────────────────────────────────────────

test('placeholder titles are tombstones with evidence, no probe needed', () => {
  const priv = byId.get('vidHHHHHHHH')
  const del = byId.get('vidIIIIIIII')
  assert.equal(priv.liveness.state, 'gone')
  assert.equal(del.liveness.state, 'gone')
  assert.match(priv.liveness.evidence, /\[Private video\]/)
  assert.match(del.liveness.evidence, /\[Deleted video\]/)
  // The distinction survives in ext for a host that wants to re-check privates specifically.
  assert.equal(priv.ext.unavailableReason, 'private')
  assert.equal(del.ext.unavailableReason, 'deleted')
  assert.equal(yt.liveness.probe, null, 'the list itself tells us; no network round trip')
})

test('every other row is live', () => {
  const live = items.filter((i) => i.liveness.state === 'live')
  assert.equal(live.length, items.length - 2)
})

// ── normalize / contract conformance ──────────────────────────────────────────

test('every produced Item passes validateItem with zero problems', () => {
  const problems = items.flatMap((i) => validateItem(i).map((p) => `${i.id}: ${p}`))
  assert.deepEqual(problems, [])
  assert.equal(items.length, raws.length)
})

test('canonicalUrl keeps only v; url keeps the provenance query intact', () => {
  const item = byId.get('vidAAAAAAAA')
  assert.equal(item.canonicalUrl, 'https://youtube.com/watch?v=vidAAAAAAAA')
  assert.match(item.url, /list=WL/, 'url is where it was found, and keeps list/index/pp')
  assert.equal(canonicalizeUrl(item.url), item.canonicalUrl)
})

test('metrics are omitted when absent, never zero', () => {
  const placeholder = byId.get('vidHHHHHHHH')
  assert.equal('durationSec' in placeholder.metrics, false)
  assert.equal('views' in placeholder.metrics, false)
  const normal = byId.get('vidAAAAAAAA')
  assert.deepEqual(normal.metrics, { durationSec: 1938, views: 612000 })
})

test('all three view-count shapes and both duration shapes parse', () => {
  assert.equal(byId.get('vidAAAAAAAA').metrics.views, 612000)   // "612K views"
  assert.equal(byId.get('vidBBBBBBBB').metrics.views, 1200000)  // "1.2M views"
  assert.equal(byId.get('vidCCCCCCCC').metrics.views, 5)        // "5 views"
  assert.equal(byId.get('vidBBBBBBBB').metrics.durationSec, 3723) // "1:02:03"
  assert.equal(byId.get('vidCCCCCCCC').metrics.durationSec, 45)   // "0:45"
})

test('a /channel/UC… byline yields an id and no handle', () => {
  const item = byId.get('vidEEEEEEEE')
  assert.equal(item.byline.id, 'UCfixture0000000000001')
  assert.equal(item.byline.handle, null)
  assert.match(item.byline.url, /\/channel\/UC/)
})

test('thumbnails are derived, and honestly labelled', () => {
  // Nothing on the page asserts a thumbnail URL — they are lazy-loaded.
  assert.equal(html.includes('i.ytimg.com'), false, 'the page contains no thumbnail URLs at all')
  assert.equal(deriveThumbUrl('vidAAAAAAAA'), 'https://i.ytimg.com/vi/vidAAAAAAAA/mqdefault.jpg')
  assert.equal(deriveThumbUrl('too-short'), null)
  assert.equal(byId.get('vidAAAAAAAA').thumb.derived, true)
  assert.equal(coverage(() => true), 100)
  assert.ok(items.every((i) => i.thumb?.url))
})

test('the connector never writes the user zone', () => {
  const partial = normalize(raws[0], CTX)
  assert.equal('user' in partial, false, 'omitted, not set to {} — nothing of ours to clobber with')
  assert.deepEqual(createItem(partial).user, {})
})

test('raw is preserved losslessly and carries the connector version', () => {
  const item = byId.get('vidAAAAAAAA')
  assert.ok(item.raw.body.includes('vidAAAAAAAA'))
  assert.equal(item.raw.connectorVersion, yt.version)
  assert.equal(item.raw.contentType, 'text/html')
  // Opting out is explicit.
  assert.equal(normalize(raws[0], { ...CTX, keepRaw: false }).raw, null)
})

test('list membership and ordering come from the ctx URL', () => {
  assert.deepEqual(byId.get('vidAAAAAAAA').lists, ['watch-later'])
  const asLikes = createItem(normalize(raws[0], { url: 'https://www.youtube.com/playlist?list=LL' }))
  assert.deepEqual(asLikes.lists, ['likes'])
  assert.deepEqual(asLikes.order, { likes: 1 })
})

test('the facet manifest matches what the connector actually emits', () => {
  const keys = yt.facets.map((f) => f.key)
  assert.ok(keys.includes('metrics.durationSec'))
  assert.ok(keys.includes('metrics.views'))
  const length = yt.facets.find((f) => f.key === 'metrics.durationSec')
  assert.equal(length.scale, 60)
  assert.equal(length.capOpen, true, '"60+ min" — or one conference talk stretches the axis')
  assert.equal(yt.facets.find((f) => f.key === 'metrics.views').log, true)
})
