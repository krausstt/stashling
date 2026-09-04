# The Item contract — v1

> One record shape that holds a 3D model, a used-goods listing, a saved link and a video
> without becoming the union of four schemas.

Status: **v1, stable.** Additive optional fields do not bump the version. Renames, removals,
retypes and invariant changes do. See [VERSIONS.md](./VERSIONS.md).

---

## 1. The four zones

Every field belongs to exactly one zone. The zone decides **who may write it** and
**what happens on re-acquisition**. This is the whole design; the field list is downstream of it.

| Zone | Owner | On re-acquire | Rule |
|---|---|---|---|
| **identity** | core | recomputed | Derived deterministically. Never hand-edited. |
| **facets** | connector, read by every plugin | replaced | Generic. A plugin may read these without knowing the source. |
| **ext** | the connector | replaced | Opaque to core. Core never inspects it. This is what stops the shared schema from growing. |
| **user** | the human | **never touched** | Open map. Merged forward verbatim, including keys nothing understands. |
| **raw** | the connector | replaced, previous kept | Lossless. Never reconstruct a record from parsed columns. |

Two laws follow, and both were learned the hard way in the tools this is distilled from:

- **A writer may only replace keys in the zones it owns.** A connector re-scrape replaces
  `facets`, `ext` and `raw`. It does not read, write, or clear `user`.
- **The `user` zone is `additionalProperties: true` by design.** Never rebuild it from a
  known-key whitelist. MakerWorld's `makeUserMeta()` did exactly that and silently deleted
  `userTags`, `related`, `parts` and `links` on every re-scrape until 0.6.2 fixed it by
  spreading unknown keys through untouched. today-app's `CONTRACT.md` now cites the incident
  by name. §5 makes the class of bug structurally impossible rather than merely documented.

---

## 2. The record

```jsonc
{
  // ── identity (core owns; deterministic) ───────────────────────────────
  "id":        "youtube:gPW_mitgosw",   // `${source}:${sourceId}` — global, stable, greppable
  "source":    "youtube",
  "sourceId":  "gPW_mitgosw",
  "kind":      "video",                 // open vocabulary: video|model|listing|link|…

  "url":          "https://www.youtube.com/watch?v=gPW_mitgosw&list=WL&index=1",
  "canonicalUrl": "https://youtube.com/watch?v=gPW_mitgosw",  // §4 — cross-source dedup key

  // ── facets (connector writes, every plugin reads) ─────────────────────
  "title":   "Everything I know about 3D Printing",
  "summary": "",                        // plain text, HTML stripped
  "byline":  { "name": "Alexandre Chappel", "handle": "@achappel", "url": null, "id": null },
  "thumb":   { "url": "https://i.ytimg.com/vi/gPW_mitgosw/mqdefault.jpg", "derived": true },

  "lists":   ["watch-later"],           // membership is a SCRAPED FACT, not user data
  "order":   { "watch-later": 1 },      // the source's own sequence, per list

  "tags":       [],                     // from the source
  "categories": [],

  "metrics": { "views": 612000, "durationSec": 1938 },   // flat string → number. See §3.

  "times":     { "publishedAt": null, "firstSeenAt": 0, "lastSeenAt": 0, "capturedAt": 0 },
  "sightings": 1,

  // ── state (§6) ────────────────────────────────────────────────────────
  "liveness":   { "state": "live",   "checkedAt": 0, "evidence": null,
                  "attempts": 0, "retryAfter": null },
  "membership": { "state": "listed", "checkedAt": 0 },

  // ── opaque zones ──────────────────────────────────────────────────────
  "ext":  {},          // connector-owned. Core NEVER inspects.
  "user": {},          // human-owned, OPEN MAP. Never rebuilt from a whitelist.
  "raw":  null         // { "body": "<verbatim payload>", "hash": "…", "contentType": "text/html" }
}
```

### Required fields

`id`, `source`, `sourceId`, `kind`, `url`, `title`, `lists`, `metrics`, `times`,
`sightings`, `liveness`, `membership`, `ext`, `user`.

Everything else is optional and may be `null`. **`byline.name` and `byline.url` are
explicitly optional** — measured against a real 582-item YouTube Watch Later page, 3 rows
(0.5%) have no channel name and 19 rows (3.3%) have no channel URL, because auto-generated
and multi-owner bylines render a link-less anchor. Those are not deleted videos; modelling
them as failures produces false tombstones.

---

## 3. `metrics` — the key move

A flat `string → number` map, and the **only** thing faceting, sorting and gauge plugins read.

That is what lets `"print time ≤ 4 h"` and `"under 30 minutes"` be the same code path.
The connector supplies a **facet manifest** (label, unit, scale, cap, log) so a generic
range-filter UI can render a domain it knows nothing about:

```js
facets: [
  { key: "metrics.durationSec", label: "Length", type: "range", unit: "min",
    scale: 60, cap: 60, capOpen: true },
  { key: "metrics.views",       label: "Views",  type: "range", log: true },
  { key: "byline.name",         label: "Channel", type: "term" },
]
```

Rules:

- Values are finite numbers. Never a string, never `null` — **omit the key instead.**
  A metric that is absent is different from a metric that is zero, and every plugin must
  be able to tell them apart. Scores average over the channels that exist rather than
  penalising the ones that do not.
- Keys are `camelCase` and carry their unit when ambiguous: `durationSec`, `printTimeHours`,
  `priceCents`. Do not store a formatted string.
- Counters (`views`, `likes`, `downloads`) belong here. So does anything a user might want
  to sort by, threshold on, or watch change over time — `metrics` is what the
  metric-history plugin appends from.

---

## 4. `canonicalUrl`

Held **separately** from `url`, because `url` is provenance ("this is where I found it")
and `canonicalUrl` is identity ("this is what it is"). One video reached via Watch Later
and via a share sheet must resolve to one node.

The algorithm is a JavaScript port of openbrowsertabs' `UrlNormalizer`, itself ported 1:1
from a Python reference and guarded there by 14 cross-validation tests. It is specified
step-by-step in [`packages/core/src/url.js`](../packages/core/src/url.js) and locked by a
parity fixture table. Summary:

1. `unwrapAmp` — Google `/url?q=`, Google `/amp/s/`, `*.cdn.ampproject.org` (`ampshare=` in
   **fragment first, then query**), `/v/s/` paths.
2. Lowercase host, strip a leading `www.` only.
3. Drop tracking params. Two prefix families (`utm_`, `gad_`); everything else is an exact
   `^…$` match. This is deliberate — a bare `si` *prefix* would also strip `size`.
4. Per-host keep-rules (YouTube: keep only `v`).
5. Drop AMP leftovers (`amp`, `amp_gsa`, `amp_js_v`, `usqp`).
6. Strip trailing `.amp`, collapse trailing slashes, strip a trailing `/amp`.
7. Rebuild as `https://host/path[?query]`. Scheme is forced, fragment is dropped.

**Encoding parity matters more than it looks.** The reference implementations use Python
`quote_plus` / Java `URLEncoder`, which encode space as `+`. `encodeURIComponent` encodes it
as `%20`. openbrowsertabs already ships three ports of this function and the untested JS one
has drifted in at least seven ways, this being one — which silently splits the dedup key
across runtimes. Stashling implements `quotePlus` explicitly (§`url.js`) and asserts it
against a checked-in parity table.

Per-connector escape hatches: `keepFragment` (SPA routes, PDF page anchors) and
`forceHttps: false`. Both default off.

---

## 5. Source precedence — the anti-clobber mechanism

Enrichment does not overwrite fields. Every derived attribute is a row carrying **who
asserted it**, and readers resolve by precedence.

```sql
attrs( itemId, key, valueText, valueNum, valueTime, source, confidence, observedAt )
       UNIQUE( itemId, key, source )
```

```js
SOURCE_PRECEDENCE = ["user", "connector", "import", "cloud", "local-model", "rules"]
// read(item, key) → highest-precedence row present. The user always wins.
// Unknown source → ranks last. An unrecognised writer can never beat a known one.
// Ties → observedAt DESC, then confidence DESC. (Never row-iteration order.)
```

Three consequences, each replacing a rule someone currently has to remember:

- **Enrichment cannot destroy curation.** A cloud batch writes `source:"cloud"` rows; a user
  edit writes `source:"user"`. Both persist; the user's wins on read. No merge logic, no
  whitelist, no incident.
- **Re-running anything is idempotent.** The `UNIQUE` constraint makes a re-run an upsert of
  that source's own opinion.
- **Disagreement is inspectable.** You can show "rules say *article*, the model says *paper*,
  you said *reference*" — the honest UI, and impossible once you have overwritten.

The typed value columns exist so "published before 2024" and "under 30 minutes" stay
comparisons rather than string parsing.

> **Honest status.** This schema exists in openbrowsertabs as DDL plus a precedence list, and
> is **dead code there** — `putAttr`, `attrs()`, `putEdge` and `learnTerm` have zero callers
> and the `edges` table is never written. It is a strong hypothesis, not tested code being
> ported. Stashling implements and tests it; that is one of the things this repo is for.

---

## 6. Liveness and membership are two different axes

The doc this repo grew from treated "gone" as one axis. Kleinanzeigen proves it is two, and
needs both:

- **`liveness.state`** — what the *source* says about the item.
  `live` | `gone` | `restricted` | `unknown`.
- **`membership.state`** — whether the item is still in *your* collection.
  `listed` | `unlisted`.

An item can legitimately be `liveness: live` **and** `membership: unlisted` — still on the
site, no longer on your watchlist. Collapsing these loses the distinction between "the
platform deleted it" and "I removed it", which is precisely the distinction a survivability
tool exists to keep.

`liveness.evidence` records *why*: the redirect target, the marker text, the placeholder
title. This matters because **deleted listings frequently return HTTP 200 with a redirect,
not a 404** — verified against live Kleinanzeigen pages on 2026-07-05. A status-code-only
probe reports every deleted listing as alive.

`attempts` and `retryAfter` exist to fix a real trap: openbrowsertabs' `unfetchable` is
terminal with no retry path anywhere, so one transient failure removes an item from
enrichment forever and permanently inflates the inbox count. **A terminal state must be
re-armable**, and re-sighting an item re-arms it.

Acquisition returns one of three outcomes, and only the third re-enters the queue:

| Outcome | Meaning | Queue |
|---|---|---|
| `success` | usable payload | done |
| `terminal` | reached the source, no usable payload (404, paywall, wrong content-type) | record `evidence` + `statusCode`, do not retry until re-sighted |
| `retryable` | offline, timeout, 5xx, 429 | retry with backoff |

Collapsing `terminal` and `retryable` into one failure mode is the classic bug that makes a
queue either drop paywalled pages forever or retry them until heat death.

---

## 7. `raw` — lossless preservation

```jsonc
"raw": { "body": "<verbatim payload>", "contentType": "text/html", "hash": "sha256-…",
         "capturedAt": 0, "connectorVersion": "1.0.0" }
```

today-app states the rule in the clearest form anyone in this corpus managed:

> *This is the source of truth for export — we NEVER reconstruct the full record from parsed columns.*

Two additions over its implementation:

- **`connectorVersion` and `capturedAt` travel with the blob**, so an older raw can be
  re-shredded by a newer parser. today-app's raw is keyed only by id and REPLACEd on
  re-import, which discards the previous raw and means an item cannot survive a connector
  regression.
- **`hash`** lets a re-import skip unchanged items instead of blindly replacing them.

`raw` is optional — a connector may set `raw: null` — but a connector that omits it forfeits
the round-trip guarantee, and the fixture harness will say so.

---

## 8. Round-trip: the interchange format

**A portability architecture whose data only flows one way is not portable.** None of the
three source tools can re-ingest its own export; Kleinanzeigen has no importer at all, and
today-app's exporter has zero callers. So this is a **step-one test here, not a later
feature**: the same code that writes the interchange format reads it, and a fixture asserts
`fromJsonl(toJsonl(items))` is deep-equal to `items`, `user` zone included.

Line-delimited JSON, one typed record per line, unknown `type` values ignored by contract:

```jsonl
{"type":"meta","schema":1,"generator":"stashling/0.1.0","exportedAt":0,"count":582,"generation":3}
{"type":"item","id":"youtube:gPW_mitgosw", … }
{"type":"attr","itemId":"youtube:gPW_mitgosw","key":"topic","valueText":"3d-printing","source":"rules","confidence":0.8,"observedAt":0}
{"type":"signal","itemId":"…","action":"kept","at":0}
```

- `generation` is a monotonic counter so a stale payload is **discarded rather than
  imported** — openbrowsertabs reasoned this out for sync and never implemented it.
- Import merge policy is the zone rule, not a new invention: incoming `facets`/`ext`/`raw`
  replace; incoming `user` keys merge onto local ones without deleting unknown keys;
  `times.firstSeenAt` takes the **earlier** of the two; `sightings` takes the **larger**.
- `attr` lines carry their own `source`, so an import is just another precedence writer
  (`source: "import"`), and can never outrank the user.

---

## 9. What this contract deliberately does not do

- **No `attrs` for things the connector already knows.** A connector writes facets directly.
  The attrs table is for *derived, contested* values — classification, topics, summaries —
  where two sources can disagree.
- **No embeddings in the contract.** Vectors live in sidecars and **must carry their model
  identity**. MakerWorld's embedding cache is keyed on item id alone with no record of which
  model or dimension produced the vector, so swapping the embedder silently reuses vectors
  from a different geometry — and because the builder skips ids already cached, it never
  recomputes them. Two vectors from different models are not comparable, and nothing in the
  current corpus can tell.
- **No score persistence.** Scores are a projection computed on read, because they depend on
  cohort membership. A stored score changes meaning silently when the cohort changes.
- **No LLM anywhere.** Worth knowing: openbrowsertabs' "enhance and relate with AI" contains
  no LLM at all — it is TF-IDF, ordered rules and tag-frequency clustering. The cheap version
  shipped and works.
