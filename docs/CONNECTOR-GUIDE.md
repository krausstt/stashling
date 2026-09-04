# Writing a connector

> One file. No browser, no permissions, no network, no build step. `node --test` and a saved page.

A connector is a **description of a source plus pure functions over strings**. It says what it
needs; the host provides it. That is why you can write and finish one on a plane.

By the end of this page you will have a working connector, a synthetic fixture, and a test that
asserts field coverage as a percentage. Budget an hour for a simple source.

- Interface source of truth: [`packages/core/src/connector.js`](../packages/core/src/connector.js)
- Record shape: [ITEM-CONTRACT.md](./ITEM-CONTRACT.md)
- Where connectors sit: [ARCHITECTURE.md](./ARCHITECTURE.md)

---

## 1. Before you write anything: measure the page

Save the logged-in list page with Ctrl-S. Then, in a throwaway script, answer four questions.
**Do not skip this.** Every rule in §4 exists because someone skipped it.

```js
const html = await readFile(saved, 'utf8')

// 1. What is the per-item container, and is it balanced?
count(html, /<sm-shelf-row/g)          // 240
count(html, /<\/sm-shelf-row>/g)       // 240   ← balanced: this is your scope
count(html, /sm-shelf-row/g)           // 5,118 ← class/CSS noise. NEVER chunk on this.

// 2. How many ids exist page-wide vs inside the scope?
uniq(html, /\/book\/([a-z0-9-]+)/g).length              // 271
uniq(chunks.join(''), /\/book\/([a-z0-9-]+)/g).length   // 240 ← 31 leaked from sidebars

// 3. For each field, what fraction of chunks have it?  (§5's coverage table starts here.)
// 4. Are hrefs absolute or relative?  (Check. Do not assume — see §4.2.)
```

Write the numbers down. They become the assertions in your test and the honest coverage claim in
your PR.

---

## 2. The complete skeleton

Save as `packages/connectors/src/shelfmark.js`. `shelfmark.example` is fictional — `.example` is
reserved by RFC 2606, so a tutorial that uses it can never accidentally point a contributor at a
real site's markup.

```js
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * shelfmark.example — reading lists.
 *
 * Measured on a saved "My Shelf" page (240 rows, 2026-09-01): the page holds 271 unique
 * /book/<slug> ids but only 240 real rows; the surplus is the "readers also shelved" rail.
 * Scope first, extract second.
 */

import { defineConnector, ACQUISITION_STRATEGIES } from '@stashling/core'
import {
  chunkByElement, attrOf, textOfElement, stripTags, hrefs, first, firstOf,
  parseCompactNumber,
} from './_shared/html.js'

const VERSION = '1.0.0'
const ROW = 'sm-shelf-row'

/**
 * ONE selector table. Ordered candidates: exact anchor first, shape heuristic last.
 *
 * This table is the deliberate single point of repair. When the site redesigns, a contributor
 * adds one candidate here and nothing else in the file changes. Kleinanzeigen's equivalent table
 * is named as such in its README, and it is why that scraper survived a redesign that shipped to
 * only some users: candidates are tried PER ITEM, so a page mixing two markup generations parses
 * completely instead of half-failing.
 */
const SEL = {
  sourceId: [
    (c) => attrOf(c, 'data-item-id'),                    // exact: survived the 2026-04 redesign
    (c) => first(c, /\/book\/([a-z0-9][a-z0-9-]{2,})/i), // structural: the id is in the URL
  ],
  title: [
    (c) => attrOf(c, 'data-title'),
    (c) => textOfElement(c, 'h3'),
  ],
  author: [
    (c) => attrOf(c, 'data-author'),
    (c) => textOfElement(c, 'sm-byline'),
  ],
  pages: [
    (c) => Number(attrOf(c, 'data-pages')) || null,
    (c) => {
      const m = /(\d[\d.,]*)\s*(?:pages|Seiten)\b/i.exec(c)
      return m ? parseCompactNumber(m[1]) : null
    },
  ],
  coverId: [
    (c) => attrOf(c, 'data-cover'),
    (c) => first(c, /covers\/([a-f0-9]{8,})/i),
  ],
}

/** Try each candidate against one chunk; first non-empty wins. */
const pick = (chunk, candidates) => firstOf(candidates, (read) => read(chunk))

/** The one marker the site uses for a withdrawn title. Verified on 3 real rows, 2026-09-01. */
const GONE_MARKER = 'no longer available'

export default defineConnector({
  // ── identity ────────────────────────────────────────────────────────────────
  id: 'shelfmark',        // becomes the Item id namespace: "shelfmark:<sourceId>"
  kind: 'book',           // open vocabulary
  version: VERSION,       // travels with `raw`, so an old blob can be re-shredded by a new parser
  priority: 0,

  hosts: ['https://shelfmark.example/*'],   // → optional_host_permissions, requested on activation

  match: (url) => /^https?:\/\/(www\.)?shelfmark\.example\//i.test(url),

  lists: [
    { id: 'shelf',  label: 'My Shelf',  match: (url) => /\/shelf(\/|$|\?)/i.test(url) },
    { id: 'to-read', label: 'To read',  match: (url) => /\/shelf\/to-read/i.test(url) },
  ],

  // ── what the host must provide ──────────────────────────────────────────────
  acquisition: {
    strategy: ACQUISITION_STRATEGIES.DOM_ACTIVE_TAB,
    scope: ROW,                                   // required for dom-active-tab. Non-negotiable.
    autoScroll: { maxMs: 120_000, stableRounds: 3 },
  },

  // ── parsing: strings in, plain objects out ──────────────────────────────────

  /**
   * @param {string} text  the serialized page
   * @param {object} ctx   host facts: { url, listId, now, … }. Treat every field as optional.
   * @returns {object[]}   RawItems, one per row. Shape is yours; `normalize` is its only reader.
   */
  parseList(text, ctx = {}) {
    const out = []
    const seen = new Set()

    chunkByElement(text, ROW).forEach((chunk, i) => {
      const sourceId = pick(chunk, SEL.sourceId)

      // Empty beats fabricated: a row we cannot identify is DROPPED, not guessed at.
      if (!sourceId) return

      // Dedup on the stable source id, never on the title. Two editions share a title.
      if (seen.has(sourceId)) return
      seen.add(sourceId)

      const url = hrefs(chunk).find((h) => h.includes('/book/')) ?? null

      out.push({
        sourceId,
        url,
        title: pick(chunk, SEL.title),
        author: pick(chunk, SEL.author),
        authorUrl: hrefs(chunk).find((h) => h.includes('/author/')) ?? null,
        pages: pick(chunk, SEL.pages),
        coverId: pick(chunk, SEL.coverId),
        index: i + 1,                                   // the source's own order
        gone: stripTags(chunk).toLowerCase().includes(GONE_MARKER),
        html: chunk,                                    // the lossless blob. See ITEM-CONTRACT §7.
      })
    })

    return out
  },

  /** Optional. `null` when the source has no useful detail page. */
  parseDetail: null,

  /**
   * RawItem → a PARTIAL Item. The host calls core's `createItem` on the result, which fills in
   * `id`, `canonicalUrl` and every default.
   */
  normalize(raw, ctx = {}) {
    const listId = ctx.listId ?? 'shelf'
    const now = Number(ctx.now) || 0

    const item = {
      source: 'shelfmark',
      sourceId: raw.sourceId,
      kind: 'book',
      url: raw.url ?? `https://shelfmark.example/book/${raw.sourceId}`,

      title: raw.title ?? '',
      byline: { name: raw.author ?? null, handle: null, url: raw.authorUrl ?? null, id: null },

      lists: [listId],
      order: raw.index != null ? { [listId]: raw.index } : {},

      metrics: {},                                  // see below — omission is meaningful

      times: { firstSeenAt: now, lastSeenAt: now, capturedAt: now, publishedAt: null },

      // Connector-owned and opaque to core. Everything this source has that the contract does not
      // model goes here, and nothing here is ever read by a plugin.
      ext: { coverId: raw.coverId ?? null },

      // NOTE: no `user` key. A connector NEVER writes the human's zone — not even `{}`.
      // MakerWorld's `makeUserMeta()` rebuilt it from a whitelist and silently deleted four
      // user-owned arrays on every re-scrape until 0.6.2.

      raw: raw.html
        ? { body: raw.html, contentType: 'text/html', capturedAt: now, connectorVersion: VERSION }
        : null,
    }

    // OMIT an absent metric; never substitute 0. `metrics` is the only thing generic faceting
    // reads, and every plugin must be able to tell "we did not observe this" from "this is zero".
    if (Number.isFinite(raw.pages)) item.metrics.pages = raw.pages

    return item
  },

  /** Optional. Derive a cheap thumbnail rather than storing a full-resolution one. */
  deriveThumbUrl(item) {
    const id = item?.ext?.coverId
    // MakerWorld 0.6.1 stored full-res 1.8 MB covers for 860 items, blew the IndexedDB quota and
    // produced ZERO usable thumbnails. Ask the CDN for a resized image; never store the original.
    return id ? `https://cdn.shelfmark.example/covers/${id}?w=400&fmt=webp` : null
  },

  liveness: {
    /** What the LIST page already told us. Free — no extra request. */
    atScrape(raw) {
      return raw.gone
        ? { state: 'gone', evidence: `list marker: "${GONE_MARKER}"` }
        : { state: 'live', evidence: null }
    },

    /**
     * What a fetched detail page says. Returns a liveness patch, or null for "no opinion".
     * `finalUrl` is the URL AFTER redirects, and it matters more than the status code:
     * deleted listings frequently return HTTP 200 with a redirect, not a 404.
     */
    probe({ finalUrl, body, statusCode }) {
      if (finalUrl && !finalUrl.includes('/book/')) {
        return { state: 'gone', evidence: `redirected to ${finalUrl}` }
      }
      if (statusCode === 404) return { state: 'gone', evidence: 'http 404' }
      if (statusCode === 403) return { state: 'restricted', evidence: 'http 403' }
      if (body && stripTags(body).toLowerCase().includes(GONE_MARKER)) {
        return { state: 'gone', evidence: `body marker: "${GONE_MARKER}"` }
      }
      return null
    },
  },

  /**
   * The facet manifest. This is what lets a UI that has never heard of books render a working
   * page-count filter. `scale`/`cap`/`capOpen`/`log` are display concerns; the values stay raw.
   */
  facets: [
    { key: 'metrics.pages', label: 'Length', type: 'range', unit: 'pages', cap: 800, capOpen: true },
    { key: 'byline.name',   label: 'Author', type: 'term' },
    { key: 'lists',         label: 'Shelf',  type: 'term' },
  ],
})
```

Register it by adding two lines to
[`packages/connectors/src/index.js`](../packages/connectors/src/index.js) — a static import and an
entry in the frozen `connectors` array. Static, because dynamic `import()` does not work in an MV3
service worker and remote code is a store rejection
([ADR 0002](./decisions/0002-connectors-are-bundled-not-remote.md)).

---

## 3. The interface reference

Everything `validateConnector` checks, and everything it does not.

### Required

| Member | Signature | Notes |
|---|---|---|
| `id` | `string` | `^[a-z0-9][a-z0-9-]*$`. Must not contain `:` — it becomes the Item id namespace. |
| `kind` | `string` | Open vocabulary: `video`, `model`, `listing`, `link`, `book`, … |
| `version` | `string` | Semver. Stamped into `raw.connectorVersion`, so an old blob is re-shreddable. |
| `match` | `(url) => boolean` | Cheap and total. A throw is caught by the registry and treated as `false`. |
| `lists` | `Array<{id, label, match(url)}>` | May be empty. Each entry needs all three members. |
| `acquisition` | `{strategy, scope?, autoScroll?}` | `strategy` must be an `ACQUISITION_STRATEGIES` value. |
| `parseList` | `(text, ctx) => RawItem[]` | Pure. Strings in, plain objects out. |
| `normalize` | `(raw, ctx) => Partial<Item>` | Pure. The host calls `createItem` on the result. |
| `facets` | `Facet[]` | May be empty. See below for the validation gap. |

### Optional

| Member | Signature | Default | Notes |
|---|---|---|---|
| `priority` | `number` | `0` | `connectorsFor(url)` sorts descending. Use it when two connectors claim one URL. |
| `hosts` | `string[]` | `[]` | Match patterns. `allHosts()` collects them for `optional_host_permissions`. |
| `parseDetail` | `(text, ctx) => RawItem \| null` | `null` | Only needed if the list page is not enough. |
| `deriveThumbUrl` | `(item) => string \| null` | `null` | Prefer a CDN transform over storing an original. |
| `liveness.atScrape` | `(raw) => Partial<Liveness> \| null` | `null` | Free signal from the list page. |
| `liveness.probe` | `({finalUrl, body, statusCode}) => Partial<Liveness> \| null` | `null` | Costs a request. Runs under the host's budget. |

### `acquisition` rules enforced at import

- `strategy` must be one of `dom-active-tab`, `passive-capture`, `detail-fetch`, `share-target`,
  `file-import`, `api`.
- **`scope` is required for `dom-active-tab`.** Not stylistic — see §4.1.
- `autoScroll.maxMs` must be a positive number. A scroll without a deadline is a hang.

### The one gap to know about

`validateConnector` checks that `facets` **is an array**. It does not check the descriptors inside
it. Call core's `validateFacetManifest(connector.facets)` yourself in your connector's test and
assert it returns `[]`; that catches a missing `label`, a bad `type`, a non-positive `scale` and a
duplicate key, none of which fail at import.

`defineConnector` validates eagerly and throws, so a broken connector fails at import rather than
halfway through a 582-item scrape.

---

## 4. Rules that come from real damage

Every rule below is a scar. The numbers are measured, not estimated.

### 4.1 Scope, then extract. Never the other way round.

A real 582-item YouTube Watch Later page contains **639** unique `watch?v=` ids page-wide, but only
**582** real rows. The 57 surplus ids decompose exactly: 39 from an unrelated `ytInitialData` blob
and 18 from `rel="nofollow"` description anchors. Extract page-wide and you get a 10% contamination
rate with no way to tell which rows are real.

Chunk on the **open tag of the element**, not on a class token or a bare substring. On that same
page:

| Pattern | Matches |
|---|---|
| `<ytd-playlist-video-renderer` (open tag) | 582 |
| `</ytd-playlist-video-renderer>` (close tag) | 582 — balanced, so the chunking is sound |
| `ytd-playlist-video-renderer` (bare substring) | **12,804** — CSS scope tokens |

`chunkByElement(html, name)` does exactly this. Nothing else is an acceptable scope for
`dom-active-tab`, which is why `validateConnector` refuses a connector without one.

### 4.2 Prefer anchors that survive a redesign

Ranked by what actually survived in the field:

1. **`data-*` attributes** — the site put them there on purpose, usually for its own tests.
2. **Element names** — custom elements (`<ytd-playlist-video-renderer>`, `<sm-shelf-row>`) are
   framework-stable; classes are not.
3. **Per-item JSON-LD** — `script[type="application/ld+json"]` *inside* the tile. Kleinanzeigen's
   parser calls this "immune to class churn" and uses it as the primary title source on its newer
   layout.
4. **`svg[data-title="…"]`** — icons carry semantic names when nothing else does. Kleinanzeigen
   finds the location block by `svg[data-title="locationOutline"]` and reads its parent, because
   the new layout has no stable location class at all.
5. **Shape heuristics, last.** Kleinanzeigen's class-less price fallback: scan every `p`/`span`,
   skip text over 24 characters, accept anything matching a currency shape, keep the shortest
   match. Ugly, effective, and correctly ranked last.

What died: Tailwind and CSS-module class names. Also two anchors that look perfectly reasonable and
match **zero** times on the real page:

- **Do not pair a tag name with an id.** `#index` is a `<yt-formatted-string>`, not a `<span>`;
  `#video-info` is one too. `span#index` and `div#video-info` each match 0 times page-wide.
  `attrOfId` and `textOfId` are tag-agnostic for exactly this reason.
- **Do not assume relative hrefs.** Every link in a saved page is absolute
  (`https://www.youtube.com/@handle`). A selector written against a leading `/` — the obvious thing
  to write — matched **0 of 582** rows. Match on a substring, or make the origin optional.
- **A present anchor is not a populated one.** `#attributed-channel-name` exists in all 582 chunks
  and is `hidden=""` and empty in all 582. Coverage-test every anchor before you trust it.

**Detect layout per item, not per page.** Kleinanzeigen runs two markup generations in parallel and
dispatches with `isNewLayout(tile) ? parseItemNew(tile) : parseItemOld(tile)` inside the loop. A
partial rollout — half the tiles new, half old, which is what an A/B test looks like — still parses
completely. A per-page dispatch would have silently dropped half the list.

### 4.3 One selector table, ordered, named as the single point of repair

Exact anchor first, structural anchor next, shape heuristic last. `firstOf` is the resolver. Keep
it at the top of the file and keep it complete: when the site changes, a contributor should be able
to fix the connector by adding one candidate without reading the rest of the file.

Two things belong in the framework, not in the table: whitespace collapse (`stripTags` already does
it) and entity decoding (`attrOf` and `decodeEntities` already do it). And every entry is a **list**
of candidates, even when there is only one today — Kleinanzeigen's table has three bare-string
entries among fourteen, and that inconsistency is a trap for the next person.

### 4.4 Dedup on a stable source id, never on the title

Two editions, two languages, a re-upload and the original — all share a title. The MakerWorld
scraper dedups on `modelId` at three separate layers. `id` is `${source}:${sourceId}`, so a stable
`sourceId` is also what makes one store hold every source at once without collisions.

If the source has no id, derive one from the URL path and say so in a comment. Never hash the title.

### 4.5 Never write the `user` zone from a connector

Not the key, not `{}`, not "just to initialize it". The human owns that zone and it is an open map
with `additionalProperties: true` by design.

MakerWorld's `makeUserMeta()` rebuilt it from five known keys and silently deleted `userTags`,
`related`, `parts` and `links` on every re-scrape until 0.6.2. `mergeItems(existing, incoming,
{writer: 'connector'})` carries `existing.user` through untouched, which makes the bug structurally
impossible — but only if your `normalize` does not put a `user` key in the incoming item.

### 4.6 Omit an absent metric. Never substitute 0.

`metrics` is a flat `string → finite number` map and the only thing generic faceting reads. An
absent metric and a zero metric are different facts, and every plugin must be able to tell them
apart: scores average over the channels that exist rather than penalising the ones that do not, and
a `range` filter on a facet no item carries must render as "does not apply here", not as an empty
0–0 slider.

`normalizeMetrics` drops non-finite values rather than coercing them, so a `null` you pass in
vanishes silently. Better to never pass it.

Same rule for the record: `byline.name` and `byline.url` are explicitly optional. On the real
Watch Later page 3 rows (0.5%) have no channel name and 19 (3.3%) have no channel URL, because
auto-generated and multi-owner bylines render a link-less anchor. Those are not deleted videos.
Modelling them as failures produces false tombstones.

### 4.7 Empty beats fabricated

Below your confidence threshold, return nothing. A dropped row is a visible gap that someone can
fix; a fabricated row is a silent corruption that propagates into export, dedup and every plugin
downstream. `parseList` returning 240 clean rows out of 243 is a good result. Returning 243 rows
where 3 carry a guessed id is not.

### 4.8 Every extraction bug found in real data becomes a fixture

A one-line fix with no fixture is a bug waiting to be reintroduced by the next redesign. Three real
ones, all of which shipped:

- **The context window that mis-assigned RAM to storage.** A loose context window around
  `/(\d{1,4})\s*(gb|tb)\b/` assigned the `32GB` in `"32GB, 2TB SSD"` to *storage*, because the token
  `ssd` fell inside `32GB`'s window. Fixed on 2026-07-06 by immediate adjacency only — 14 characters
  after the match, 16 before, plus "TB is always storage". The scar comment is still in the file.
- **`includes('neu')` matching `"Neupreis"`.** Every used listing that mentioned its original price
  ("Neupreis" = new price) was classified as condition *new*. Fixed with `\bneu\b` inside an
  **ordered** first-match-wins list with `defekt` first, so `neuwertig` and `wie neu` are consumed
  before the bare `neu` rule can see them. The scar comment reads: *word boundaries matter*.
- **The `watch` rule that tagged every video as fitness.** A `health` topic rule contained the bare
  token `watch`. Every YouTube URL contains `/watch?v=`, so every video in the collection was tagged
  as fitness content and a LEGO build video showed men's-health articles as "related". Fixed to
  `smartwatch` — and, structurally, by classifying on extracted page text instead of the URL.
  **Unanchored substring rules applied to URLs match URL structure, not content.**

Each of those is now a two-line fixture and a named regression test. That is the whole cost.

---

## 5. Test it

Two files. No runner to install, no config.

**The fixture** — `fixtures/shelfmark/shelf.min.html`. **Hand-authored and synthetic**: it
reproduces the measured structural shapes with invented ids, titles and names. Never commit a real
saved page; it is somebody's reading history. Full rules in [FIXTURES.md](./FIXTURES.md).

```html
<sm-shelf-row data-item-id="bk-4417" data-title="The Cartographer&#39;s Objection"
              data-author="R. Okonkwo" data-pages="384" data-cover="a91f3c02">
  <a href="https://shelfmark.example/book/bk-4417"><h3>The Cartographer&#39;s Objection</h3></a>
  <sm-byline><a href="https://shelfmark.example/author/r-okonkwo">R. Okonkwo</a></sm-byline>
</sm-shelf-row>

<!-- Row 2 reproduces the measured 4% of rows whose byline is a link-less anchor. -->
<sm-shelf-row data-item-id="bk-9028" data-title="Notes Toward a Smaller Map" data-pages="112">
  <a href="https://shelfmark.example/book/bk-9028"><h3>Notes Toward a Smaller Map</h3></a>
  <sm-byline><a>Anthology</a></sm-byline>
</sm-shelf-row>

<!-- The "readers also shelved" rail. It carries /book/ ids and MUST NOT be picked up. -->
<aside><a href="https://shelfmark.example/book/bk-0001">Contamination</a></aside>
```

**The test** — `packages/connectors/test/shelfmark.test.js`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createItem, validateItem, validateFacetManifest, validateConnector } from '@stashling/core'
import shelfmark from '../src/shelfmark.js'

const html = readFileSync(new URL('../../../fixtures/shelfmark/shelf.min.html', import.meta.url), 'utf8')
const rows = shelfmark.parseList(html, { listId: 'shelf' })

/** Coverage, not spot checks: the fraction of rows carrying a field. */
const coverage = (field) => rows.filter((r) => r[field] != null && r[field] !== '').length / rows.length

test('the connector is structurally valid', () => {
  assert.deepEqual(validateConnector(shelfmark), [])
  assert.deepEqual(validateFacetManifest(shelfmark.facets), [])   // not checked by validateConnector
})

test('scope excludes the recommendation rail', () => {
  assert.equal(rows.length, 2)                                    // 3 /book/ ids exist page-wide
  assert.ok(!rows.some((r) => r.sourceId === 'bk-0001'))
})

test('field coverage matches the measured page', () => {
  assert.equal(coverage('sourceId'), 1, 'sourceId must be 100% — it is the dedup key')
  assert.equal(coverage('title'), 1)
  assert.equal(coverage('url'), 1)
  assert.equal(coverage('author'), 1)
  assert.equal(coverage('authorUrl'), 0.5, 'link-less bylines are expected, not a failure')
})

test('normalize produces a valid Item and never touches the user zone', () => {
  const item = createItem(shelfmark.normalize(rows[0], { listId: 'shelf', now: 1 }))
  assert.deepEqual(validateItem(item), [])
  assert.equal(item.id, 'shelfmark:bk-4417')
  assert.deepEqual(item.user, {}, 'a connector must never write `user`')
  assert.equal(item.metrics.pages, 384)
})

test('an absent metric is omitted, not zeroed', () => {
  const raw = { ...rows[0], pages: null }
  const item = createItem(shelfmark.normalize(raw, { listId: 'shelf', now: 1 }))
  assert.ok(!('pages' in item.metrics))
})
```

Run it:

```bash
cd C:\dev\stashling
node --test
```

Bare `node --test` auto-discovers `**/*.test.js`. There is nothing to install.

---

## 6. Checklist before you open a PR

Structure

- [ ] One file in `packages/connectors/src/`, plus a static import and array entry in `index.js`
- [ ] MPL-2.0 header comment at the top of every new file
- [ ] No `node:*`, no `chrome.*` / `browser.*`, no DOM globals, no `fetch`, no `import()` anywhere in the connector
- [ ] `hosts` declared, so the extension can request the permission at activation instead of install

Correctness

- [ ] `validateConnector(c)` returns `[]`, asserted in a test
- [ ] `validateFacetManifest(c.facets)` returns `[]`, asserted in a test
- [ ] `acquisition.scope` set (mandatory for `dom-active-tab`) and `autoScroll.maxMs` positive
- [ ] Chunk count asserted, and asserted to be **balanced** against the closing tag
- [ ] Dedup is on `sourceId`, never on the title
- [ ] `normalize` writes no `user` key
- [ ] Absent metrics are omitted, never `0` or `null`
- [ ] `raw` is populated, or the PR says why it is not (omitting it forfeits round-trip)
- [ ] Rows below the confidence threshold are dropped, not guessed

Tests and evidence

- [ ] A synthetic fixture is committed; **no real saved page is in the diff**
- [ ] Coverage is asserted as a percentage per field, not by spot-checking row 1
- [ ] Every extraction bug you fixed while writing it has a named regression test
- [ ] The PR body quotes the real-page numbers you measured: rows found, page-wide id count, per-field coverage, and which rows the surplus ids came from
- [ ] `node --test` is green from a clean clone with no `npm install`

Documentation

- [ ] The selector table has a comment per candidate saying **why that anchor**, not what it does
- [ ] Every non-obvious rule cites the evidence or the incident that forced it — that is the house style, and it is what makes this repo worth reading
