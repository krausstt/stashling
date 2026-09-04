# @stashling/core

The pure layer of [Stashling](https://github.com/krausstt/stashling): the Item contract, URL
canonicalization, zone-scoped merge, source precedence, and the interchange format.

**No network. No DOM. No platform APIs. No dependencies.** Everything here runs identically in
Node, in a browser page, and in an MV3 service worker, and is unit-testable with `node --test`
and nothing installed.

```bash
npm install @stashling/core
```

## Why it is pure

Three independently-built collector tools — a MakerWorld scraper suite, a Kleinanzeigen
companion, a mobile link collector — each arrived at a dependency-free core without
coordinating. That is 3 for 3, and the strongest single signal in the corpus this design was
distilled from. Acquisition, storage and scheduling are host concerns; if you need an import
here, the layering is probably wrong.

## The Item contract

Four zones, and the zone decides who may write a field and what happens when the source is
scraped again:

| Zone | Owner | On re-acquire |
|---|---|---|
| identity | core | recomputed deterministically |
| facets | connector, read by every plugin | replaced |
| ext | the connector, opaque to core | replaced |
| **user** | **the human** | **never touched** — open map, unknown keys preserved |
| raw | the connector | replaced, previous retained |

```js
import { createItem, mergeItems, validateItem } from '@stashling/core'

const item = createItem({
  source: 'youtube', sourceId: 'gPW_mitgosw', kind: 'video',
  title: 'Everything I know about 3D Printing',
  url: 'https://www.youtube.com/watch?v=gPW_mitgosw&list=WL&index=1',
  metrics: { views: 612000, durationSec: 1938 },
  lists: ['watch-later'], order: { 'watch-later': 1 },
})

item.id           // "youtube:gPW_mitgosw"
item.canonicalUrl // "https://youtube.com/watch?v=gPW_mitgosw"
validateItem(item) // []

// A connector re-scrape can never touch what the human wrote.
mergeItems(stored, fresh, { writer: 'connector' }).user // unchanged, unknown keys and all
```

Full reasoning: [`docs/ITEM-CONTRACT.md`](../../docs/ITEM-CONTRACT.md).

## What's in it

- **`createItem` / `validateItem`** — construction and structural validation. `validateItem`
  returns a list of problems rather than throwing, because a scrape of 582 items should report
  the 3 bad rows, not abort on the first.
- **`canonicalizeUrl`** — AMP unwrapping, tracking-param stripping, per-host keep-rules. Ported
  from a Kotlin implementation that was itself ported from a Python reference and cross-validated
  against it. Implements `quotePlus` explicitly, because `encodeURIComponent` emits `%20` where
  the reference emits `+`, and a canonical URL that differs by one character is a silently split
  dedup key.
- **`mergeItems`** — zone-scoped. Lists union, metrics merge, `firstSeenAt` takes the earlier
  value, empty incoming strings do not clear stored ones, a stale liveness probe never overwrites
  a fresher one.
- **`resolveAttrs` / `SOURCE_PRECEDENCE`** — enrichment writes rows carrying *who asserted a
  value*; readers resolve by rank. Enrichment cannot destroy curation, re-runs are idempotent, and
  disagreement stays inspectable.
- **`toJsonl` / `fromJsonl` / `mergeBundle`** — both directions. A portability format that only
  writes is not a portability format.
- **`facets`** — generic range/term filtering over the flat `metrics` map, so "print time ≤ 4 h"
  and "under 30 minutes" are the same code path.
- **`defineConnector` / `validateConnector`** — the connector interface.

## Licence

MPL-2.0. File-level copyleft: use it in a proprietary product freely, publish your fixes to
these files.
