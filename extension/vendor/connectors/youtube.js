/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * YouTube playlist connector — Watch Later, Liked videos, and any other `list=` playlist.
 *
 * Every number and every selector in this file was measured against one real saved Watch
 * Later page (12,725,371 bytes, 582 rows). The measurements are recorded in
 * `fixtures/youtube/README.md`; the shapes they describe are reproduced synthetically in
 * `fixtures/youtube/watch-later.fixture.html`. Where a code path has NOT been seen in real
 * data — there is exactly one, the `[Private video]` / `[Deleted video]` placeholder — the
 * comment says so rather than implying evidence that does not exist.
 *
 * Three findings shaped the whole file, and each of them is a selector that looks correct and
 * silently returns nothing:
 *
 *  1. HREFS ARE ABSOLUTE. Every link in a saved page is
 *     `href="https://www.youtube.com/@handle"`, never `href="/@handle"`. A pattern anchored on
 *     a leading slash — the obvious thing to write — matched 0 of 582 rows.
 *  2. IDS SIT ON CUSTOM ELEMENTS. `#index` and `#video-info` are both `<yt-formatted-string>`.
 *     `span#index` and `div#video-info` each matched 0 times PAGE-WIDE while reading as
 *     entirely reasonable selectors. Everything here matches ids tag-agnostically.
 *  3. `#attributed-channel-name` is present in all 582 rows, carries `hidden=""`, and is empty
 *     in all 582. It is the most plausible-looking channel anchor on the page and it yields 0%.
 *
 * And one architectural finding: `ytInitialData` on that page contains ZERO
 * `playlistVideoRenderer` nodes and 39 `videoId` values with zero overlap with the 582
 * rendered rows — they are homepage-feed payloads left behind by SPA navigation. The rendered
 * DOM is the only source of truth for playlist rows. This connector never touches embedded JSON.
 */

import { defineConnector } from '../core/connector.js'
import { urlsplit, parseQsl } from '../core/url.js'
import {
  chunkByElement, attrOfId, textOfId, attrOf, hrefs, stripTags, parseClock,
  parseCompactNumber, firstOf,
} from './_shared/html.js'

const VERSION = '1.1.0'

/** The element the host must scope to. 582 open tags, 582 close tags, perfectly balanced. */
const ROW_ELEMENT = 'ytd-playlist-video-renderer'

/**
 * Placeholder titles YouTube substitutes IN PLACE when a row's video goes away.
 *
 * Because the substitution happens in the list markup itself, `liveness.atScrape` needs no
 * network probe — which is the whole reason `probe` below is null.
 *
 * HONESTY NOTE: the real 582-row capture contains ZERO of these. All five spellings that were
 * searched for ("[Private video]", "[Deleted video]", "Private video", "Deleted video",
 * "Privates Video") occur 0 times page-wide. This table is therefore covered only by synthetic
 * fixture rows. Localized spellings are deliberately ABSENT: we have no capture of a localized
 * placeholder, and inventing one risks marking a live row as gone — a false tombstone is worse
 * than a missed one, because it is the failure a survivability tool exists to prevent.
 */
const UNAVAILABLE_TITLES = Object.freeze({
  '[private video]': 'private',
  '[deleted video]': 'deleted',
})

// ── local string helpers ──────────────────────────────────────────────────────
// These are here rather than in `_shared/html.js` because they are shaped by YouTube's markup
// specifically; a second connector needing them is the signal to promote them, not this one.

/** Inner HTML (NOT stripped) of the element carrying `id`, tag-agnostically. */
function innerOfId(html, id) {
  const m = new RegExp(`<([a-zA-Z0-9-]+)[^>]*\\bid="${id}"[^>]*>([\\s\\S]*?)</\\1>`, 'i')
    .exec(String(html ?? ''))
  return m ? m[2] : null
}

/**
 * The first whole `<name …>…</name>` element, tags included.
 *
 * Scoping BEFORE reading an id is not optional here. A row contains two elements with
 * `id="text"`: the duration `<span id="text">` inside the thumbnail overlay, and the channel
 * `<yt-formatted-string id="text" title="…">` inside `<ytd-channel-name>`. The duration one
 * comes first in document order, so an unscoped `attrOfId(chunk, 'text', 'title')` reads the
 * duration span, finds no `title` attribute, and returns null — a 0% channel name from a
 * selector that is otherwise correct.
 */
function sliceElement(html, name) {
  const m = new RegExp(`<${name}\\b[^>]*>[\\s\\S]*?</${name}>`, 'i').exec(String(html ?? ''))
  return m ? m[0] : null
}

/** Text of each `<span>` inside a fragment, in document order, empties dropped. */
function spanTexts(html) {
  const out = []
  const re = /<span\b[^>]*>([\s\S]*?)<\/span>/gi
  let m
  while ((m = re.exec(String(html ?? '')))) {
    const t = stripTags(m[1])
    if (t) out.push(t)
  }
  return out
}

/** A bullet / dash separator span carries no information. */
const isSeparator = (s) => /^[•·∙|/,\-–—\s]+$/.test(s)

/**
 * "32 minutes, 18 seconds" → 1938. The `badge-shape[aria-label]` spelling of a duration.
 *
 * ENGLISH ONLY, and knowingly so: this is the third and last candidate in the duration table,
 * reached only when both clock-text anchors are gone. On a non-English page it returns null
 * and `metrics.durationSec` is omitted — which is the correct outcome, because omitted and
 * zero must stay distinguishable.
 */
function parseSpokenDuration(text) {
  const t = String(text ?? '')
  const h = /(\d+)\s*hour/i.exec(t)
  const m = /(\d+)\s*minute/i.exec(t)
  const s = /(\d+)\s*second/i.exec(t)
  if (!h && !m && !s) return null
  return (h ? Number(h[1]) * 3600 : 0) + (m ? Number(m[1]) * 60 : 0) + (s ? Number(s[1]) : 0)
}

/** The 11-character video id out of any string carrying a watch URL. */
function videoIdIn(text) {
  const m = /watch\?v=([A-Za-z0-9_-]{11})/.exec(String(text ?? ''))
  return m ? m[1] : null
}

// ── THE SELECTOR TABLE ────────────────────────────────────────────────────────

/**
 * THE SELECTOR TABLE — the deliberate single point of repair.
 *
 * Every field is a candidate LIST, tried in order: the exact anchor first, a structural anchor
 * next, a shape heuristic last. `firstOf` takes the first non-empty result. When YouTube
 * redesigns, this table is the file you edit and the only one.
 *
 * The shape is copied from Kleinanzeigen's selector table, which earned it: that site runs two
 * markup generations in parallel, so a per-page dispatch fails on a partial rollout while an
 * ordered candidate list simply falls through to the generation that is present. YouTube ships
 * the same way — `ytBadgeShapeText` and the older `span#text` duration anchor coexist in this
 * very capture, both at 100%.
 *
 * `why` is not decoration. It is the coverage number the candidate was measured at, so the next
 * person can tell a deliberate fallback from a hopeful one.
 */
export const SELECTORS = Object.freeze({
  videoId: [
    { name: 'a#video-title[href]', why: '582/582 = 100% on the real capture',
      get: (c) => videoIdIn(attrOfId(c, 'video-title', 'href')) },
    { name: 'any watch?v= href in the row', why: 'the thumbnail anchor carries the same id',
      get: (c) => firstOf(hrefs(c), (h) => videoIdIn(h)) },
    { name: 'any watch?v= anywhere in the row', why: 'last resort; still ROW-scoped, so the '
      + '57 non-playlist ids that leak into a page-wide scan cannot reach it',
      get: (c) => videoIdIn(c) },
  ],

  watchUrl: [
    { name: 'a#video-title[href]', why: 'provenance URL, list= and index= intact',
      get: (c) => attrOfId(c, 'video-title', 'href') },
    { name: 'first watch?v= href in the row', why: 'thumbnail anchor, same target',
      get: (c) => firstOf(hrefs(c), (h) => (videoIdIn(h) ? h : null)) },
  ],

  title: [
    { name: 'a#video-title[title]', why: '582/582 = 100%',
      get: (c) => attrOfId(c, 'video-title', 'title') },
    { name: 'a#video-title inner text', why: '582/582 = 100%, 0 mismatches against the attribute',
      get: (c) => textOfId(c, 'video-title') },
    { name: 'h3[aria-label] minus the spoken duration', why: 'the aria-label is title + duration '
      + '("… 32 minutes"), so the tail has to come off; lossy, hence last',
      get: (c) => {
        const m = /<h3\b[^>]*\baria-label="([^"]*)"/i.exec(c)
        if (!m) return null
        return stripTags(m[1])
          .replace(/\s+\d+\s+(?:hours?|minutes?|seconds?)(?:,?\s+\d+\s+(?:hours?|minutes?|seconds?))*$/i, '')
          .trim()
      } },
  ],

  // Returns { text, sec } — candidate 3 speaks a different dialect ("32 minutes, 18 seconds")
  // and has no clock text at all, so the table has to carry both halves together.
  duration: [
    { name: 'span#text inside ytd-thumbnail-overlay-time-status-renderer', why: '582/582 = 100%',
      get: (c) => {
        const overlay = sliceElement(c, 'ytd-thumbnail-overlay-time-status-renderer')
        const text = overlay ? textOfId(overlay, 'text') : null
        const sec = parseClock(text)
        return text ? { text, sec } : null
      } },
    { name: 'div.ytBadgeShapeText', why: '582/582 = 100%; the newer badge markup',
      get: (c) => {
        const m = /<div\b[^>]*class="[^"]*\bytBadgeShapeText\b[^"]*"[^>]*>([\s\S]*?)<\/div>/i.exec(c)
        const text = m ? stripTags(m[1]) : null
        return text ? { text, sec: parseClock(text) } : null
      } },
    { name: 'badge-shape[aria-label]', why: '582/582 = 100%; spoken form, English only',
      get: (c) => {
        const m = /<badge-shape\b[^>]*\baria-label="([^"]*)"/i.exec(c)
        const sec = m ? parseSpokenDuration(m[1]) : null
        return sec == null ? null : { text: null, sec }
      } },
  ],

  index: [
    // MEASURED, and NOT what an earlier pass of this analysis claimed: the values are present in
    // 582/582 rows and span 1..582, but they are NOT contiguous. On the real capture, 400 and 415
    // are absent while 499 and 500 each appear twice, once out of document order. This is the
    // page's own numbering, not a parse error — the row that reads 401 also carries
    // `href="…&index=401"`. A virtualized list re-renders as you scroll and its ordinals drift.
    //
    // So `order` is a source HINT, never a dense sequence and never a key. Anything that assumes
    // contiguity (progress bars, "item N of M", gap detection used as a completeness check) is
    // wrong here. Identity is `sourceId`; this is exactly why dedup never touches order.
    { name: '#index (tag-agnostic)', why: '582/582 = 100% present, range 1..582, NOT contiguous. '
      + 'It is a <yt-formatted-string>: span#index matches 0 times page-wide',
      get: (c) => textOfId(c, 'index') },
    { name: '#index-container text', why: 'structural parent, survives the inner element being renamed',
      get: (c) => {
        const inner = innerOfId(c, 'index-container')
        const t = inner ? stripTags(inner) : null
        return t && /^\d+$/.test(t) ? t : null
      } },
  ],

  // The metadata line: ["612K views", "•", "2 months ago"]. Its first span carried "views" in
  // 582/582 rows. Shapes seen: "#K views" 396, "#M views" 181, "# views" 5. No "No views" rows.
  videoInfo: [
    { name: '#video-info spans (tag-agnostic)', why: '582/582 = 100%. It is a '
      + '<yt-formatted-string>: div#video-info matches 0 times page-wide',
      get: (c) => {
        const inner = innerOfId(c, 'video-info')
        if (!inner) return null
        const spans = spanTexts(inner).filter((s) => !isSeparator(s))
        return spans.length ? spans : null
      } },
    { name: 'any span in the row whose text carries the unit word',
      why: 'shape heuristic. Deliberately NOT "#metadata inner text": #metadata is a <div> full '
        + 'of nested <div>s, and a non-greedy close-tag match on it returns a truncated '
        + 'fragment — a fallback that returns plausible garbage is worse than one that returns '
        + 'nothing',
      get: (c) => {
        const m = /<span\b[^>]*>([^<]*\bviews?\b[^<]*)<\/span>/i.exec(c)
        return m ? [stripTags(m[1])] : null
      } },
  ],

  // Scoped to <ytd-channel-name> by the caller — see sliceElement's comment for why that
  // scoping is load-bearing and not tidiness.
  channelName: [
    { name: 'yt-formatted-string#text[title]', why: '579/582 = 99.48%; empty string on the 3 '
      + 'rows that carry is-empty="", which firstOf skips',
      get: (n) => attrOfId(n, 'text', 'title') },
    { name: 'the anchor inner text', why: '579/582, agrees exactly with the title attribute',
      get: (n) => {
        const m = /<a\b[^>]*>([\s\S]*?)<\/a>/i.exec(n)
        return m ? stripTags(m[1]) : null
      } },
    { name: 'tp-yt-paper-tooltip #tooltip text', why: '579/582, third independent agreement',
      get: (n) => {
        const tip = sliceElement(n, 'tp-yt-paper-tooltip')
        return tip ? textOfId(tip, 'tooltip') : null
      } },
  ],

  channelUrl: [
    { name: 'href matching an OPTIONAL origin + /@ | /channel/ | /c/ | /user/',
      why: '563/582 = 96.74% (562 /@handle, 1 /channel/UC…). The leading-slash version of this '
        + 'same pattern matches 0/582 — every href in a saved page is absolute',
      get: (n) => firstOf(hrefs(n), (h) => (CHANNEL_PATH.test(h) ? h : null)) },
    { name: 'any non-watch href inside ytd-channel-name', why: 'structural: the only other link '
      + 'in that subtree would still be the channel',
      get: (n) => firstOf(hrefs(n), (h) => (videoIdIn(h) ? null : h)) },
  ],
})

/**
 * Optional origin, then a channel path. The optional-origin half is the entire point: written
 * as `/^(\/@|\/channel\/)/` — which is what the first draft of the design specified — this
 * pattern matches 0 of 582 rows on a real saved page.
 */
const CHANNEL_PATH = /^(?:https?:\/\/[^/]*youtube\.com)?\/(?:@[^/?#]+|channel\/[^/?#]+|c\/[^/?#]+|user\/[^/?#]+)/i

// ── URL predicates ────────────────────────────────────────────────────────────

function isYouTubeHost(host) {
  const h = String(host ?? '').toLowerCase().replace(/^www\./, '')
  return h === 'youtube.com' || h.endsWith('.youtube.com')
}

/** The `list=` query parameter, or null. */
export function listParam(url) {
  const s = urlsplit(url)
  if (!isYouTubeHost(s.netloc)) return null
  for (const [k, v] of parseQsl(s.query)) if (k === 'list' && v) return v
  return null
}

/**
 * Does this connector claim the URL?
 *
 * `/watch?v=…&list=WL` is DELIBERATELY excluded even though it carries a `list=` param: the
 * watch page renders its queue with `ytd-playlist-panel-video-renderer`, a different element
 * with different internals. Claiming that page would hand the host a scope that produces zero
 * rows, which reads as "the connector broke" rather than "wrong page".
 */
export function match(url) {
  const s = urlsplit(url)
  if (!isYouTubeHost(s.netloc)) return false
  if (s.path.replace(/\/+$/, '') !== '/playlist') return false
  return listParam(url) !== null
}

/** The list membership string for a URL: `watch-later`, `likes`, or `playlist:PL…`. */
export function listIdFor(url) {
  const list = listParam(url)
  if (!list) return null
  if (list === 'WL') return 'watch-later'
  if (list === 'LL') return 'likes'
  return `playlist:${list}`
}

// ── parse ─────────────────────────────────────────────────────────────────────

/**
 * Scope, then extract. One RawItem per row element, in document order.
 *
 * NOTHING IS FILTERED OUT. A row whose id or title failed to parse is still returned, with
 * nulls — because the coverage percentage over the returned rows is the alarm that tells you
 * YouTube redesigned overnight. Dropping the failures would make coverage 100% by construction
 * and silently under-collect instead.
 *
 * @param {string} html a whole page, or any fragment containing row elements
 * @param {object} [ctx]
 * @returns {object[]} RawItem[]
 */
export function parseList(html, _ctx = {}) {
  return chunkByElement(html, ROW_ELEMENT).map((chunk, chunkIndex) => {
    const title = firstOf(SELECTORS.title, (c) => c.get(chunk))
    const duration = firstOf(SELECTORS.duration, (c) => c.get(chunk)) ?? { text: null, sec: null }
    const indexText = firstOf(SELECTORS.index, (c) => c.get(chunk))
    const info = firstOf(SELECTORS.videoInfo, (c) => c.get(chunk)) ?? []

    // The views span is identified by its UNIT WORD, not by its position. The measured layout
    // puts it first in 582/582 rows, but a row that grows a badge span in front of it would
    // then silently start reporting "2 months ago" as a view count — parseCompactNumber is
    // perfectly happy to read that as 2.
    const viewsText = info.find((s) => /views?\b/i.test(s)) ?? null
    const publishedText = info.length > 1 && info[info.length - 1] !== viewsText
      ? info[info.length - 1]
      : null

    const channelChunk = sliceElement(chunk, 'ytd-channel-name')
    const channelName = channelChunk
      ? firstOf(SELECTORS.channelName, (c) => c.get(channelChunk))
      : null
    const channelUrl = channelChunk
      ? firstOf(SELECTORS.channelUrl, (c) => c.get(channelChunk))
      : null

    const idx = indexText != null && /^\d+$/.test(String(indexText).trim())
      ? Number(String(indexText).trim())
      : null

    return {
      chunkIndex,
      videoId: firstOf(SELECTORS.videoId, (c) => c.get(chunk)),
      watchUrl: firstOf(SELECTORS.watchUrl, (c) => c.get(chunk)),
      title: title ?? null,
      durationText: duration.text ?? null,
      durationSec: Number.isFinite(duration.sec) ? duration.sec : null,
      index: idx,
      viewsText: viewsText ?? null,
      views: viewsText ? parseCompactNumber(viewsText) : null,
      publishedText,
      channelName: channelName ?? null,
      channelUrl: channelUrl ?? null,
      channelHandle: handleOf(channelUrl),
      channelId: channelIdOf(channelUrl),
      unavailable: unavailableReason(title),
      html: chunk,
    }
  })
}

function handleOf(url) {
  const m = /\/(@[^/?#]+)/.exec(String(url ?? ''))
  return m ? m[1] : null
}

function channelIdOf(url) {
  const m = /\/channel\/([A-Za-z0-9_-]+)/.exec(String(url ?? ''))
  return m ? m[1] : null
}

function unavailableReason(title) {
  const key = String(title ?? '').trim().toLowerCase()
  return UNAVAILABLE_TITLES[key] ?? null
}

/**
 * There is no detail page worth fetching. A list row already carries id, title, duration,
 * views, position and byline — every field the Item contract asks a video connector for. A
 * per-item fetch would spend 582 requests to learn nothing and would put the user's session in
 * front of YouTube's rate limiter for no gain.
 */
export const parseDetail = null

// ── liveness ──────────────────────────────────────────────────────────────────

/**
 * Liveness from the scrape alone — no probe, because YouTube substitutes the placeholder title
 * IN PLACE inside the row markup. `evidence` records the literal placeholder, per §6 of the
 * Item contract: a state without evidence cannot be argued with later.
 *
 * `private` is reported as `gone` rather than `restricted` on purpose: from the collection's
 * point of view the payload is unrecoverable either way, and the distinction that matters is
 * preserved in `ext.unavailableReason`, so a host that wants to re-check privates can.
 */
export function atScrape(raw) {
  const reason = raw?.unavailable ?? unavailableReason(raw?.title)
  if (reason) {
    return { state: 'gone', evidence: `placeholder title: ${String(raw?.title ?? '').trim()}` }
  }
  // A missing byline is NOT a liveness signal. 19 of 582 rows (3.3%) have a link-less byline
  // anchor and 3 (0.5%) have no name at all — auto-generated and multi-owner bylines, every one
  // of them a perfectly live video. Treating a null byline as a tombstone would have invented
  // 19 false deletions on the very first real scrape.
  return { state: 'live', evidence: null }
}

// ── thumbnails ────────────────────────────────────────────────────────────────

/**
 * Derive the thumbnail URL, because the page does not contain one.
 *
 * Thumbnails are lazy-loaded: a saved page's `<img src>` points at a local `_files/` copy, and
 * a live scrape sees a placeholder. The id-derived URL is stable and cheap — measured live,
 * `mqdefault.jpg` returns 200 at ~14 KB and `hqdefault.jpg` at ~21 KB. This is why
 * `deriveThumbUrl` exists in the connector interface at all.
 *
 * `derived: true` on the resulting `thumb` is the honest label: nothing on the page asserted it.
 */
export function deriveThumbUrl(itemOrId, opts = {}) {
  const id = typeof itemOrId === 'string'
    ? itemOrId
    : itemOrId?.sourceId ?? itemOrId?.videoId ?? null
  if (!id || !/^[A-Za-z0-9_-]{11}$/.test(id)) return null
  const quality = opts.quality ?? 'mqdefault'
  return `https://i.ytimg.com/vi/${id}/${quality}.jpg`
}

// ── normalize ─────────────────────────────────────────────────────────────────

/**
 * RawItem → partial Item. Returns null for a row with no video id, because an Item without a
 * `sourceId` has no identity and would collide with every other such row under `makeId`.
 *
 * @param {object} raw from `parseList`
 * @param {object} [ctx] `{ url, listId, capturedAt, keepRaw }`
 */
export function normalize(raw, ctx = {}) {
  if (!raw?.videoId) return null

  const capturedAt = Number.isFinite(ctx.capturedAt) ? ctx.capturedAt : 0
  const listId = ctx.listId ?? listIdFor(ctx.url) ?? null
  const live = atScrape(raw)

  // A metric is written ONLY when it was actually parsed. Never 0 as a stand-in for absent:
  // §3 of the contract, and the reason scores can average over the channels that exist instead
  // of penalising the rows that are merely quiet about them.
  const metrics = {}
  if (Number.isFinite(raw.durationSec)) metrics.durationSec = raw.durationSec
  if (Number.isFinite(raw.views)) metrics.views = raw.views

  return {
    source: 'youtube',
    sourceId: raw.videoId,
    kind: 'video',
    // `url` is provenance — the link as found, list= and index= and pp= intact. `canonicalUrl`
    // is identity and core derives it, stripping everything but `v`.
    url: raw.watchUrl ?? `https://www.youtube.com/watch?v=${raw.videoId}`,

    title: raw.title ?? '',
    summary: '',
    byline: {
      // Independently optional. 19 rows have a name and no URL; 3 have neither. They are a
      // strict subset — a URL without a name has never been observed — but nothing here
      // depends on that, because the day it happens should not be the day parsing breaks.
      name: raw.channelName ?? null,
      handle: raw.channelHandle ?? null,
      url: raw.channelUrl ?? null,
      id: raw.channelId ?? null,
    },
    thumb: (() => {
      const url = deriveThumbUrl(raw.videoId)
      return url ? { url, derived: true } : null
    })(),

    // Membership in a list is a SCRAPED FACT, not user data — it belongs in facets and gets
    // replaced on re-acquire like every other facet.
    lists: listId ? [listId] : [],
    order: listId && Number.isFinite(raw.index) ? { [listId]: raw.index } : {},

    tags: [],
    categories: [],
    metrics,

    times: {
      // `publishedText` is a relative phrase ("2 months ago") whose absolute value depends on
      // when the page was captured, so it is NOT promoted to a timestamp. It is kept verbatim
      // in `ext` where a host that knows `capturedAt` can resolve it if it wants to.
      publishedAt: null,
      firstSeenAt: capturedAt,
      lastSeenAt: capturedAt,
      capturedAt,
    },
    sightings: 1,

    liveness: {
      state: live.state,
      checkedAt: capturedAt,
      evidence: live.evidence,
      attempts: 0,
      retryAfter: null,
    },
    membership: { state: 'listed', checkedAt: capturedAt },

    ext: {
      index: raw.index ?? null,
      durationText: raw.durationText ?? null,
      viewsText: raw.viewsText ?? null,
      publishedText: raw.publishedText ?? null,
      unavailableReason: raw.unavailable ?? null,
    },

    // The connector NEVER writes `user`. Omitted, not set to {} — createItem supplies the
    // empty map, and a merge then has nothing of ours to clobber a human's keys with.

    // Lossless by default; `hash` is left null because a pure connector has no crypto and the
    // host that stores the blob is the one that can hash it. `connectorVersion` travels with
    // the body so an older raw can be re-shredded by a newer parser.
    raw: ctx.keepRaw === false || !raw.html ? null : {
      body: raw.html,
      contentType: 'text/html',
      hash: null,
      capturedAt,
      connectorVersion: VERSION,
    },
  }
}

// ── the connector ─────────────────────────────────────────────────────────────

export default defineConnector({
  id: 'youtube',
  kind: 'video',
  version: VERSION,
  priority: 10,

  match,
  hosts: ['https://*.youtube.com/*'],

  lists: [
    // `id` names the FAMILY (what validateConnector checks); `instanceId(url)` returns the
    // membership string an Item actually carries, which for a generic playlist is per-playlist.
    { id: 'watch-later', label: 'Watch Later', match: (u) => listParam(u) === 'WL',
      instanceId: () => 'watch-later' },
    { id: 'likes', label: 'Liked videos', match: (u) => listParam(u) === 'LL',
      instanceId: () => 'likes' },
    { id: 'playlist', label: 'Playlist',
      match: (u) => { const l = listParam(u); return Boolean(l) && l !== 'WL' && l !== 'LL' },
      instanceId: (u) => listIdFor(u) },
  ],

  acquisition: {
    strategy: 'dom-active-tab',
    scope: ROW_ELEMENT,

    // The list is VIRTUALIZED. The 582 rows in the real capture are 582 because that is how far
    // the page had been scrolled, not because the playlist is 582 long. `until: 'stable'` means
    // scroll until the row count stops growing for `settleMs`, then stop; `maxMs` is the
    // deadline that keeps a pathological page from scrolling forever.
    autoScroll: { until: 'stable', maxMs: 120000, settleMs: 1500, stableRounds: 3 },

    // Randomized delay between scroll steps. Not politeness theatre: a fixed interval is the
    // single most legible bot signature, and this runs inside the user's own logged-in session.
    throttleMs: [400, 1200],

    // The host must record rows-seen and surface it. NOTE, measured: this page carries NO
    // claimed total in its DOM — the only "N videos" strings in 12.7 MB are i18n plural
    // templates ("{count,plural, =1{1 video}other{# videos}}"), never a rendered count. So a
    // host cannot compare seen-vs-claimed from the markup; it can only report that growth
    // stalled, and let the user judge. Saying so here beats a `parseClaimedCount` that returns
    // null forever.
    reportRowsSeen: true,
  },

  parseList,
  parseDetail,
  normalize,
  deriveThumbUrl,

  liveness: { atScrape, probe: null },

  facets: [
    // `cap: 60` with `capOpen: true` reads "60+ min" at the top of the slider. Without capOpen
    // a single 4-hour conference talk stretches the axis until every real video is a sliver.
    { key: 'metrics.durationSec', label: 'Length', type: 'range', unit: 'min', scale: 60, cap: 60, capOpen: true },
    // View counts are power-law: 396 rows in the "#K views" band, 181 in "#M", 5 bare.
    // A linear axis renders that as one bar and 581 slivers.
    { key: 'metrics.views', label: 'Views', type: 'range', log: true },
    { key: 'byline.name', label: 'Channel', type: 'term' },
  ],
})
