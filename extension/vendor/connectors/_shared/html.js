/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * String-level HTML helpers shared by connectors.
 *
 * WHY STRINGS AND NOT A DOM: a connector receives serialized HTML and returns plain objects.
 * That is what lets the same connector run in an MV3 service worker, in a Node CLI against a
 * saved page, and in a test harness against a fixture — with no branching and no DOM library
 * in the dependency tree. Both shipped scrapers this is distilled from already work this way.
 *
 * The rendered DOM is the primary source of truth. Embedded JSON (`__NEXT_DATA__`,
 * `ytInitialData`) is an optimization a connector MAY opt into, never the default:
 * MakerWorld's embedded-JSON path is the lucky case, and YouTube's is actively misleading —
 * a real saved Watch Later page's `ytInitialData` contains ZERO playlist rows and 39
 * videoIds from an entirely different route, because the page is an SPA the user navigated
 * within.
 */

/**
 * Split a document into per-item chunks on an element name, WITHOUT a DOM.
 *
 * Scope-then-extract is mandatory. Measured on a real 582-item YouTube Watch Later page:
 * the document holds 639 unique `watch?v=` ids but only 582 real rows — the surplus leaks in
 * from sidebars, recommendations and description anchors. Extracting page-wide gives you a
 * 10% contamination rate with no way to tell which rows are real.
 *
 * Matching is on `<element` (open tag) so attributes are irrelevant, and the raw element
 * NAME is used rather than a class: on that same page the bare substring
 * `ytd-playlist-video-renderer` appears 12,804 times as a CSS scope token but only 582 times
 * as an open tag.
 *
 * @param {string} html
 * @param {string} elementName e.g. "ytd-playlist-video-renderer"
 * @returns {string[]} one chunk per element, each starting at its open tag
 */
export function chunkByElement(html, elementName) {
  const parts = String(html ?? '').split(`<${elementName}`)
  return parts.slice(1).map((p) => `<${elementName}${p}`)
}

/** Split on a literal marker (a class token, a comment). Prefer `chunkByElement`. */
export function chunkByMarker(html, marker) {
  const parts = String(html ?? '').split(marker)
  return parts.slice(1)
}

const ENTITIES = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'",
  '&apos;': "'", '&nbsp;': ' ', '&#x27;': "'", '&#x2F;': '/',
}

/** Decode the handful of entities that actually appear in attribute values and text. */
export function decodeEntities(s) {
  return String(s ?? '')
    .replace(/&(?:amp|lt|gt|quot|apos|nbsp|#39|#x27|#x2F);/g, (m) => ENTITIES[m] ?? m)
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#[xX]([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
}

/**
 * Read an attribute from the element carrying a given id, TAG-AGNOSTICALLY.
 *
 * The tag-agnostic part is not stylistic. On a real YouTube page `#index` is a
 * `<yt-formatted-string>` and `#video-info` is a `<yt-formatted-string>` — so `span#index`
 * and `div#video-info` each match ZERO times page-wide while looking entirely reasonable.
 * Custom-element frameworks move ids between tag names freely; the id survives, the tag does not.
 */
export function attrOfId(html, id, attribute) {
  const re = new RegExp(`<[a-zA-Z0-9-]+[^>]*\\bid="${escapeRe(id)}"[^>]*>`, 'i')
  const tag = re.exec(String(html ?? ''))
  if (!tag) return null
  return attrOf(tag[0], attribute)
}

/** Read an attribute out of a single open tag string. */
export function attrOf(tag, attribute) {
  const m = new RegExp(`\\b${escapeRe(attribute)}="([^"]*)"`, 'i').exec(String(tag ?? ''))
  return m ? decodeEntities(m[1]) : null
}

/** Inner text of the element carrying `id`, tags stripped. Handles one level of nesting. */
export function textOfId(html, id) {
  const re = new RegExp(
    `<([a-zA-Z0-9-]+)[^>]*\\bid="${escapeRe(id)}"[^>]*>([\\s\\S]*?)</\\1>`, 'i',
  )
  const m = re.exec(String(html ?? ''))
  return m ? stripTags(m[2]) : null
}

/** Inner text of the first `<element …>…</element>`, tags stripped. */
export function textOfElement(html, elementName) {
  const re = new RegExp(`<${escapeRe(elementName)}[^>]*>([\\s\\S]*?)</${escapeRe(elementName)}>`, 'i')
  const m = re.exec(String(html ?? ''))
  return m ? stripTags(m[1]) : null
}

/**
 * Tags that imply a line break, and therefore a word boundary. Everything else is inline.
 *
 * The distinction matters and a naive strip gets it wrong in both directions. Replacing EVERY
 * tag with a space turns `<p>A caddy for <b>hex bits</b>.</p>` into "A caddy for hex bits ." —
 * a floating full stop in every summary that contains inline markup, which is most of them.
 * Replacing every tag with nothing turns `<li>a</li><li>b</li>` into "ab" and silently welds
 * list items together.
 *
 * So: block tags become a space, inline tags vanish. That is what `textContent` does for the
 * inline case and what a reader expects for the block case.
 */
const BLOCK_TAGS = new Set([
  'address', 'article', 'aside', 'blockquote', 'br', 'dd', 'div', 'dl', 'dt', 'fieldset',
  'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr',
  'li', 'main', 'nav', 'ol', 'p', 'pre', 'section', 'table', 'tbody', 'td', 'tfoot', 'th',
  'thead', 'tr', 'ul',
])

/** Remove tags, decode entities, collapse whitespace. */
export function stripTags(html) {
  const text = String(html ?? '').replace(/<[^>]*>/g, (tag) => {
    const m = /^<\/?\s*([a-zA-Z0-9-]+)/.exec(tag)
    return m && BLOCK_TAGS.has(m[1].toLowerCase()) ? ' ' : ''
  })
  return decodeEntities(text).replace(/\s+/g, ' ').trim()
}

/**
 * All `href` values in a chunk, decoded.
 *
 * Saved pages carry ABSOLUTE hrefs. A selector written against a leading `/` — the obvious
 * thing to write, and what an earlier draft of this design specified — matches 0 of 582 rows
 * on a real YouTube page, because every link is `https://www.youtube.com/@handle`. Match on
 * a substring or an optional-origin pattern, never on a leading slash.
 */
export function hrefs(html) {
  const out = []
  const re = /\bhref="([^"]*)"/gi
  let m
  while ((m = re.exec(String(html ?? '')))) out.push(decodeEntities(m[1]))
  return out
}

/** First capture group of `re`, or null. */
export function first(html, re) {
  const m = re.exec(String(html ?? ''))
  return m ? m[1] : null
}

/** Every distinct capture-group-1 match. `re` must be global. */
export function allMatches(html, re) {
  const out = new Set()
  const rx = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g')
  let m
  while ((m = rx.exec(String(html ?? '')))) out.add(m[1])
  return [...out]
}

/**
 * "32:18" → 1938, "1:02:03" → 3723. Returns null when unparseable rather than 0,
 * so an absent duration stays distinguishable from a zero one.
 */
export function parseClock(text) {
  const t = String(text ?? '').trim()
  if (!/^\d{1,3}(:\d{2}){1,2}$/.test(t)) return null
  const parts = t.split(':').map(Number)
  return parts.reduce((acc, p) => acc * 60 + p, 0)
}

/**
 * "612K views" → 612000, "1.2M views" → 1200000, "1.234 Aufrufe" → 1234.
 * Handles both `.` and `,` as the grouping or decimal separator.
 */
export function parseCompactNumber(text) {
  const t = String(text ?? '').trim()
  const m = /([\d.,]+)\s*([KMBkmb])?/.exec(t)
  if (!m) return null
  const suffix = (m[2] || '').toUpperCase()
  let numText = m[1]
  if (suffix) {
    numText = numText.replace(/,/g, '.')
  } else {
    // No suffix: separators are thousands grouping ("1.234" / "1,234" are both 1234).
    numText = numText.replace(/[.,]/g, '')
  }
  const n = Number(numText)
  if (!Number.isFinite(n)) return null
  const mult = suffix === 'K' ? 1e3 : suffix === 'M' ? 1e6 : suffix === 'B' ? 1e9 : 1
  return Math.round(n * mult)
}

/**
 * Try each candidate in order, first non-empty result wins.
 *
 * This is the shape of every durable selector table in the corpus: the exact anchor first,
 * a structural anchor next, a shape-based heuristic last. Kleinanzeigen's README names its
 * equivalent table as the deliberate single point of repair, because it runs two markup
 * generations in parallel and a per-page dispatch would fail on a partial rollout.
 */
export function firstOf(candidates, fn) {
  for (const candidate of candidates) {
    const value = fn(candidate)
    if (value !== null && value !== undefined && value !== '') return value
  }
  return null
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
