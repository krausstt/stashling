# 0004 — The rendered DOM is the source of truth; embedded JSON is opt-in

**Status:** accepted, 2026-09-03

## Context

MakerWorld's scraper reads `__NEXT_DATA__` — a complete JSON payload embedded in the page — and
it works beautifully: 857 of 860 models captured through that path, and the JSON-API fallback it
was designed to need was never written.

That success made embedded JSON look like the general strategy. The obvious generalisation was:
*prefer the embedded blob, fall back to the DOM.*

## Decision

**Inverted.** The rendered DOM is the primary source of truth. Embedded JSON is an optimisation a
connector MAY opt into, and no part of the platform assumes it exists.

## The measurement that forced it

Running the design against one real saved YouTube Watch Later page (12,725,371 bytes, 582 rows):

| Expectation | Measured |
|---|---|
| `ytInitialData` holds the playlist | It holds **zero** `playlistVideoRenderer` nodes |
| …and `playlistVideoListRenderer` | **zero** |
| It at least has the video ids | **39 unique** `videoId` values, with **zero overlap** with the 582 rendered rows |

The blob parses fine and is 1.8 MB. It is simply from a **different route** — homepage-feed
renderers and notification payloads — because YouTube is a single-page app and the page had been
navigated *within*. A connector that trusted it would have confidently returned 39 wrong items
and reported success.

MakerWorld's HTML-JSON path is the lucky case, not the general one.

## Consequences

- Connectors parse **strings of rendered markup**. That is also why they need no DOM library and
  can be tested in Node against a saved page with no browser at all.
- Scope-then-extract becomes mandatory rather than stylistic. The same page holds **639** unique
  `watch?v=` ids but only **582** real rows; the surplus leaks in from sidebars, recommendations
  and description anchors. Splitting into per-row chunks *before* extracting anything is what
  produces clean data — a page-wide scan has a ~10% contamination rate with no way to tell which
  rows are real.
- A connector that wants an embedded blob must find it, validate it with a **discriminator**, and
  fall back. MakerWorld's `findDesignObject` is the reference implementation: known path first,
  then a deep walk that only accepts an object with `Array.isArray(instances)`. That requirement
  is load-bearing, not defensive — the same payload carries for-you card summaries with `id`,
  `title` and `likeCount` that would otherwise be accepted as a full record.
- Virtualized lists become a first-class problem, because the DOM only contains what has been
  scrolled into existence. See `docs/ACQUISITION-STRATEGIES.md` on `autoScroll`, and note that it
  is a mitigation rather than a guarantee: the host reports rows seen and whether the count had
  settled, and never claims completeness it cannot prove.
