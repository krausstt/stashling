# Architecture — the five layers

> One rule holds the whole thing up: **a connector describes what it needs; the host provides it.**
> Everything else in this document is a consequence of that.

Read [ITEM-CONTRACT.md](./ITEM-CONTRACT.md) first. This document is about who runs the code and
what may import what; the contract is about the record they all pass around.

---

## 1. The stack

```
╔═══════════════════════════════════════════════════════════════════════════════╗
║ 05  SURFACES                                                    per platform  ║
║     extension popup · collection page · CLI                                   ║
║     Owns: permissions, scheduling, retry, progress UI, file I/O               ║
╟───────────────────────────────────────────────────────────────────────────────╢
║ 04  PLUGINS                                                    domain-blind   ║
║     search · rank · relate · cluster · liveness · metric-history              ║
║     triage · annotate · export                                                ║
║     Reads the Item contract and nothing else → works on every source at once  ║
╟───────────────────────────────────────────────────────────────────────────────╢
║ 03  STORE                                                          per host   ║
║     items · attrs · raws · meta                                               ║
║     IndexedDB in the browser · files in the CLI · a Map in a test             ║
╟───────────────────────────────────────────────────────────────────────────────╢
║ 02  CORE                                                              PURE    ║
║     Item · canonicalizeUrl · mergeItems · precedence · interchange · facets   ║
║     Zero imports. Runs identically in Node, a page, and an MV3 worker.        ║
╟──────────────────────────────────┬────────────────────────────────────────────╢
║ 01  CONNECTORS            PURE   │  ↑ connectors import core; core imports    ║
║     match · parseList ·          │    nothing. That is the only edge between  ║
║     parseDetail · normalize ·    │    the two pure layers, and it points up.  ║
║     deriveThumbUrl · liveness ·  │                                            ║
║     facets                       │                                            ║
║     Declare acquisition          │                                            ║
║     strategies; implement none.  │                                            ║
╚══════════════════════════════════┴════════════════════════════════════════════╝

           acquisition strategies are INJECTED downward ──────┐
           (05 implements them, 01 only names them)           ▼
```

### The import rule, stated as a rule

This is the layering, and it is checkable mechanically. If you are about to break a row of this
table, you are in the wrong layer.

| Layer | May import | Must never import |
|---|---|---|
| **01 Connectors** | `@stashling/core`, `_shared/html.js` | `node:*`, `chrome.*` / `browser.*`, DOM globals, `fetch`, the store, plugins |
| **02 Core** | *nothing* | *everything* |
| **03 Store** | core | connectors, plugins, surfaces |
| **04 Plugins** | core | connectors, the store, platform APIs |
| **05 Surfaces** | all of the above, plus platform APIs | — |

Core states its own half of this in the file header of
[`packages/core/src/index.js`](../packages/core/src/index.js): *"If you are about to add an import
to this package, you are probably about to put it in the wrong layer."*

Note the direction on the 01→02 edge. The numbering runs bottom-up by *responsibility* — connectors
are the leaves, the thing a contributor writes — but the only dependency between the two pure
layers points from connectors **to** core. Core never knows a connector exists.

---

## 2. The trick: acquisition strategies are injected

A connector never fetches anything. It declares what it needs and receives text.

```js
acquisition: {
  strategy: ACQUISITION_STRATEGIES.DOM_ACTIVE_TAB,
  scope: 'ytd-playlist-video-renderer',
  autoScroll: { maxMs: 120_000, stableRounds: 3 },
}
```

That declaration says: *"I need the rendered DOM of the active tab, split into
`ytd-playlist-video-renderer` chunks, after auto-scrolling until the row count stops growing."*
It does not call `chrome.scripting`. It does not know `chrome` exists.

**One connector, three hosts, no branching:**

| Host | How it satisfies `dom-active-tab` | What the connector sees |
|---|---|---|
| Extension | `chrome.scripting.executeScript` into the logged-in tab, scroll loop, `documentElement.outerHTML` | a string |
| CLI | `fs.readFile` of a page the user saved with Ctrl-S | a string |
| Test harness | a fixture file on disk | a string |

The same `parseList(text, ctx)` runs in all three, and its output is compared field-by-field
against the same golden JSON. That is why a connector can be developed and tested with no browser,
no permissions and no network — and why a bug found in the extension is reproducible in
`node --test` a minute later.

Three properties follow, and each of them is the reason the injection exists rather than a bonus:

- **Permissions stay out of the parser.** The host asks for `https://www.youtube.com/*` at the
  moment the user activates the connector, and the connector holds no capability of its own. See
  [ADR 0005](./decisions/0005-permissions-are-optional-by-default.md).
- **Retry and budget policy live in one place.** A per-connector fetch loop means N throttles to
  audit; the Kleinanzeigen tool had exactly that, with `sleep(900)`, `sleep(1200)` and
  `sleep(1400)` hand-written at three different call sites. A declared budget
  (`{minDelayMs, maxItemsPerRun, maxPagesPerQuery, cursor: 'leastRecentlyChecked'}`) is enforced by
  the runtime and is the same object for every connector.
- **The connector package is portable by construction.** Zero `browser.*` surface means Firefox's
  event page and Safari's non-persistent background page need no shim at layer 01 at all.

`ctx` is how the host passes back what only it knows — the page URL, the list id, the current
timestamp, per-run options. It is a plain object; a connector must treat every field as optional.

---

## 3. Layer by layer

### 01 Connectors — pure, one file per source

Everything a new source needs and nothing a runtime needs. The interface is defined and validated
in [`packages/core/src/connector.js`](../packages/core/src/connector.js); the tutorial is
[CONNECTOR-GUIDE.md](./CONNECTOR-GUIDE.md).

Connectors parse **HTML as strings**, not as a DOM. That is not an aesthetic choice: it is what
lets one module run in an MV3 service worker (no `DOMParser`), in Node (no DOM at all) and in a
content script without branching, and it keeps a DOM library out of the dependency tree. The
string-level helpers live in
[`packages/connectors/src/_shared/html.js`](../packages/connectors/src/_shared/html.js). Both
shipped scrapers this design is distilled from already worked this way. See
[ADR 0006](./decisions/0006-no-build-step-no-dependencies.md).

The registry
([`packages/connectors/src/index.js`](../packages/connectors/src/index.js)) uses **static imports
only** — dynamic `import()` is unsupported in an MV3 background service worker, and runtime-fetched
code is a store rejection. See
[ADR 0002](./decisions/0002-connectors-are-bundled-not-remote.md).

### 02 Core — pure, no imports

The Item contract, `canonicalizeUrl`, zone-scoped `mergeItems`, source precedence, the interchange
format, generic faceting, and `defineConnector`. Every file is unit-testable with `node --test` and
nothing installed.

Three independently-built collector tools each arrived at a dependency-free core without
coordinating. That is 3 for 3, and it is the strongest single signal in the corpus this design was
distilled from.

### 03 Store — per host, four stores

`items` · `attrs` · `raws` · `meta`. The shapes are fixed by the contract; the engine is not.

| Host | Engine | Why |
|---|---|---|
| Extension | IndexedDB (`stashling` v1) | A saved Watch Later page is 12,725,371 bytes; `storage.local` caps at 10 MB without `unlimitedStorage` |
| CLI | files on disk | git-diffable, greppable, and the export format doubles as the storage format |
| Test | a `Map` | no I/O in a unit test |

Two store rules are load-bearing and neither is obvious:

- **`raw` lives in its own store.** Reading the collection — which the popup, the collection page
  and every export do — must not drag hundreds of verbatim HTML chunks through structured clone.
  `raw` stays the source of truth for export without being in the hot path.
- **The store never invents a merge rule.** It calls core's `mergeItems`. A second implementation of
  zone ownership is a second place for the `user`-zone deletion bug to come back, and that bug
  already shipped once.

The extension's implementation is [`extension/store.js`](../extension/store.js), and its header
comments carry the incident behind each constant (`FLUSH_EVERY = 20`, `MAX_RAW_BYTES`,
`STALE_MS`, the cached-handle `onclose`).

### 04 Plugins — domain-blind

A plugin reads the Item contract and nothing else. It never imports a connector, never branches on
`item.source`, and never reads `item.ext` — that zone is opaque by contract.

This is what the flat `metrics` map buys. `"print time ≤ 4 h"` and `"under 30 minutes"` are the
same code path in [`packages/core/src/facets.js`](../packages/core/src/facets.js), because both
are a `range` facet over a `string → finite number` map with a `scale` and a `cap`. A filter UI
that has never heard of 3D printing renders a working print-time slider from the connector's facet
manifest.

**Honest status. Most of these are not built yet in v0.1.**

| Plugin | Status in v0.1 | Provenance |
|---|---|---|
| **facets** — range/term filters, log gauge | **SHIPPED**, tested — `core/src/facets.js` | catalogue-app's dual-range print-effort filter + its log-scale "Top Trumps" gauges |
| **export / import** — JSONL both directions | **SHIPPED**, tested — `core/src/interchange.js` | new. None of the three source tools can re-ingest its own export |
| **annotate** — the `user` zone | **SHIPPED as contract**, no UI — `mergeUser` in `core/src/merge.js` | today-app's merge-onto-raw; MakerWorld's 0.6.2 unknown-key fix |
| **precedence** — attrs, `read(item, key)` | **SHIPPED**, tested — `core/src/precedence.js` | openbrowsertabs' DDL, which is dead code there. First working implementation. See [ADR 0003](./decisions/0003-source-precedence.md) |
| **search** — hybrid keyword + semantic | **PORTABLE FROM** catalogue-app: `squash`/`squashWords`, blended weights, per-channel relevance floors, `keywordCentroid` query expansion | not ported. Needs the embeddings-sidecar decision in ITEM-CONTRACT §9 settled first |
| **rank** — N dimensions → 0–100 with a visible breakdown | **PORTABLE FROM** Kleinanzeigen's 6-dimension `ranking.js` | the weights are domain knowledge and must become a manifest, not code |
| **relate** — TF-IDF cosine | **PORTABLE FROM** openbrowsertabs `TextSimilarity.topRelated` | deterministic, offline, no model |
| **cluster** — rarest-tag grouping | **PORTABLE FROM** openbrowsertabs `Clustering.byTag` | |
| **triage** — inbox batch pick + score | **PORTABLE FROM** openbrowsertabs `InboxBatch`; today-app's swipe deck | today-app's version has no batching, per-author cap or recency decay; port the OBT one |
| **liveness** — round-robin probe under a budget | **PORTABLE FROM** Kleinanzeigen `checkStatuses` (least-recently-checked cursor, 25/run) | the contract is already in core (§6, `OUTCOME`); the runner is not |
| **metric-history** | **PLANNED** | Kleinanzeigen's `priceHistory` is the only precedent; generalize to any `metrics` key |
| **taste / recommender** | **PLANNED** | catalogue-app's `tasteVector`/`scoreRec`; today-app describes a learning loop it does not have |

The point of the table is that the column on the right is already written down. Porting a plugin
here is transcription plus tests, not research — and each one that lands works on **every**
connector at once, which is the whole argument for the layer.

### 05 Surfaces — per platform

The extension popup and collection page, and the CLI. Surfaces own everything the pure layers
refuse: permission prompts, scheduling, retry policy, progress reporting, file dialogs, and the
implementations of the acquisition strategies from
[ACQUISITION-STRATEGIES.md](./ACQUISITION-STRATEGIES.md).

The MV3 constraint that shapes this layer: **a background service worker holds no state across
ticks.** Chrome terminates it after 30 s of inactivity, and Firefox has no MV3 service worker at
all (bug 1573659) — it runs the same code from an event page. So run status is a ~300-byte object
in `storage.local` with a heartbeat, not a module-level variable, and not a lock: a lock taken by a
process the platform may kill without notice is a lock nobody can release.

---

## 4. What unification buys you

Four things you cannot get from four separate tools, no matter how good each one is.

**One graph across sources, via `canonicalUrl`.** A video reached from Watch Later and the same
video reached from a share sheet resolve to one node, because `url` is provenance ("where I found
it") and `canonicalUrl` is identity ("what it is"). Cross-source relate, cluster and dedup all
fall out of that one field being computed the same way everywhere — which is why core implements
`quotePlus` explicitly rather than trusting `encodeURIComponent`, and asserts it against a parity
table.

**Liveness for every list, not just the one tool that thought of it.** Kleinanzeigen needed
tombstones and got them; YouTube Watch Later needed them just as much and had none. `liveness`
and `membership` are two axes on every Item, so "the platform deleted it" and "I removed it" stay
distinguishable in every collection, and the probe runner is written once.

**History for any metric, not just price.** `metrics` is a flat `string → number` map, so the
metric-history plugin appends from it without knowing whether it is watching `priceCents`,
`likes`, `downloads` or `views`.

**One export path.** One JSONL format, one importer, one round-trip test — and
`fromJsonl(toJsonl(items))` deep-equals `items`, `user` zone included. A portability architecture
whose data only flows one way is not portable, and all three source tools were exactly that.

---

## 5. Where the seams are

Deliberate seams, so you know which ones are safe to cut along:

- **Connector ↔ host** — `ACQUISITION_STRATEGIES` plus `ctx`. Adding a host means implementing
  strategies, not touching connectors.
- **Connector ↔ plugin** — the Item contract plus the facet manifest. A connector never calls a
  plugin and a plugin never imports a connector.
- **Store ↔ everything** — four store names and core's merge. Swapping IndexedDB for files changes
  no other layer.
- **This tool ↔ your stack** — the interchange format. It is line-delimited JSON with an ignore-
  unknown-`type` rule, so it stays greppable and it stays forward-compatible.

## 6. See also

- [ITEM-CONTRACT.md](./ITEM-CONTRACT.md) — the record shape, zones, precedence, liveness, interchange
- [CONNECTOR-GUIDE.md](./CONNECTOR-GUIDE.md) — write one in a single file, tested against a fixture
- [ACQUISITION-STRATEGIES.md](./ACQUISITION-STRATEGIES.md) — the six strategies and who implements them
- [FIXTURES.md](./FIXTURES.md) — the corpus rules and why committed fixtures are synthetic
- [VERSIONS.md](./VERSIONS.md) — contract versions and the compatibility matrix
- [decisions/](./decisions/) — the ADRs behind every claim above
