# YouTube fixtures

`watch-later.fixture.html` is **synthetic**: hand-authored markup with invented video ids, titles
and channel names. It reproduces the structural shapes measured on one real saved Watch Later
page — 12,725,371 bytes, 582 rows — which stays on the machine it was saved on, because it is a
viewing history.

## What was measured

All figures are from that single real capture, `n = 582`.

### Chunking

| | |
|---|---|
| `<ytd-playlist-video-renderer` open tags | **582** |
| `</ytd-playlist-video-renderer>` close tags | **582** (balanced) |
| the bare substring, anywhere | **12,804** — CSS scope tokens. Never count this. |
| unique `watch?v=` ids **page-wide** | **639** |
| …of which are real rows | **582** |

The 57-id surplus decomposes exactly: 39 from a leftover `ytInitialData` blob and 18 from
`rel="nofollow"` description anchors. A page-wide id scan has a ~9% contamination rate and no way
to tell which ids are real, which is why scope-then-extract is mandatory.

### Field coverage

| Field | Anchor | Coverage |
|---|---|---|
| `sourceId` | `watch?v=` within the row | **100%** (582 unique, 0 duplicates) |
| `title` | `a#video-title[title]` | **100%** (inner text agrees exactly, 0 mismatches) |
| `metrics.durationSec` | `span#text` in the thumbnail overlay | **100%** |
| `order` | `#index` | **100%** present |
| `metrics.views` | `#video-info`, first span | **100%** |
| `byline.name` | `<ytd-channel-name>` | **99.48%** (3 missing) |
| `byline.url` | href in `<ytd-channel-name>` | **96.74%** (19 missing) |
| `thumb.url` | **derived** from the id | **100%** — verified 200, ~14 KB |

Duration has **four** independent anchors, each at 100%: `span#text`, `div.ytBadgeShapeText`,
`badge-shape[aria-label]` ("32 minutes, 18 seconds"), and `h3[aria-label]`.

### The gaps are not tombstones

The 19 missing URLs are rows whose byline anchor carries **no `href` attribute** —
auto-generated and multi-owner bylines. The 3 missing names are a strict subset, carrying
`is-empty=""` and `title=""`.

Every one of them is a perfectly live video. Treating a null byline as a liveness signal would
have invented 19 false deletions on the first real scrape, which is exactly the failure a
survivability tool exists to prevent. The fixture reproduces both shapes and the test asserts
neither is marked `gone`.

### Three anchors that look right and yield 0%

| Anchor | Coverage | Why |
|---|---|---|
| `href^="/@"` or `href^="/channel/"` | **0 / 582** | every href in a saved page is absolute |
| `span#index`, `div#video-info` | **0 page-wide** | both are `<yt-formatted-string>` |
| `#attributed-channel-name` | **0 / 582** | present in every row, `hidden=""`, always empty |

### `ytInitialData` is unusable for playlist rows

| | |
|---|---|
| `ytInitialData` assignments | 1 |
| blob size | 1,836,791 chars, parses fine |
| `playlistVideoRenderer` nodes | **0** |
| `playlistVideoListRenderer` | **0** |
| unique `videoId` values | **39** |
| overlap with the 582 rendered rows | **0** |

It is homepage-feed and notification payload from a different route, left behind by SPA
navigation. See [docs/decisions/0004](../../docs/decisions/0004-rendered-dom-is-primary.md).

### Ordinals are not a sequence

`#index` is present on 100% of rows and spans 1..582 — but it is **not contiguous and not
unique**. Ordinals 400 and 415 are absent; 499 and 500 each appear twice, one of them out of
document order. This is YouTube's own numbering, not a parse error: the row reading 401 also
carries `href="…&index=401"`. A virtualized list re-renders as you scroll and its ordinals drift.

`order` is therefore a hint. Identity is `sourceId`. The fixture reproduces both a skipped and a
repeated ordinal.

### One path with no real-data coverage

The capture contains **zero** private or deleted rows — `[Private video]`, `[Deleted video]`,
`Private video`, `Deleted video` and `Privates Video` all occur 0 times page-wide. The
placeholder-detection path is therefore covered **only** by synthetic fixture rows, and the
connector's comment says so rather than implying evidence that does not exist.

Localised placeholder spellings are deliberately absent from the table: no capture of one exists,
and inventing one risks marking a live row as gone. A false tombstone is worse than a missed one.

## Checking against your own page

```bash
# save your Watch Later page into fixtures/youtube/_local/ (gitignored), then:
node packages/cli/bin/stashling.js parse "fixtures/youtube/_local/watch-later.html" \
  --url "https://www.youtube.com/playlist?list=WL" --now 1756900000000
```

Report the numbers. Commit nothing.
