# Stashling

**Keep what you find, like and collect — portable off the platform, survivable if your account
is blocked, pipeable into your own stack.**

Your Watch Later list, your liked models, your watchlist of used-goods listings: these are things
you assembled, one decision at a time, inside somebody else's product. You cannot grep them, you
cannot join them against each other, and you cannot take them with you. When Omnivore's cloud shut
down in November 2024 it deleted user data with it; what survived was the repo and the exports
people had already taken. Stashling exists so that the export is the normal case rather than the
emergency one.

It is a browser extension, a Node CLI and a pure library that share one record shape. A
**connector** describes a source in a single file — how to recognise its URLs, how to split its
markup into items, how to turn one item into a record — and never touches the network, the DOM or
storage. The extension provides the browser; the CLI provides a saved HTML file; the test harness
provides a fixture. One connector, three hosts, no branching.

---

## Status: v0.1.0, early

This is a distillation of three collector tools I built separately, rewritten around one contract.
The reasoning behind every design decision is written down in [`docs/`](./docs); the honest state
of the code is this:

**Works today**

- `@stashling/core` — the Item contract, URL canonicalization, zone-scoped merge, source
  precedence, generic faceting, the JSONL interchange format. Zero dependencies, 74 tests green
  under `node --test`; 151 across the whole suite (measured 2026-09-07).
- Two connectors: `youtube` (Watch Later) and `makerworld` (likes, downloads, collections).
- An extension shell: MV3 service worker, IndexedDB store, a popup that runs a scrape.
- A CLI that parses a saved page into records, and reads and writes the interchange format.

**Does not work yet, and I would rather say so**

- The browse surface is minimal. There is a list and a filter; there is no real UI.
- Most of the plugin ideas in the docs — metric history, taste ranking, clustering, embeddings —
  are not built. The contract has room for them; the code does not have them.
- Liveness probing is specified and implemented per-connector, but has been exercised against
  fixtures rather than against a long-running collection. No item in my own corpus has yet been
  observed dying.
- No published packages and no store listing. Load it unpacked or run it from source. (CI does
  run now — `node --test`, the sync/manifest/fixture checks and a CLI round-trip smoke test, on
  Node 20.x and 22.x, installing nothing.)

---

## Quick start — nothing to install

Node ≥ 20.6. No `npm install`, no build step, no lockfile to trust.

```bash
git clone https://github.com/krausstt/stashling.git
cd stashling
node --test                      # the whole suite, built-in runner, no dependencies
```

Parse a page you already have. Save any YouTube Watch Later page with Ctrl+S ("complete"), then:

```bash
node packages/cli/bin/stashling.js parse "Watch later - YouTube.html" --connector youtube
node packages/cli/bin/stashling.js parse "Watch later - YouTube.html" --connector youtube \
  --out watch-later.jsonl
node packages/cli/bin/stashling.js verify watch-later.jsonl     # round-trip + contract check
```

Run it in the browser:

1. `chrome://extensions` → enable **Developer mode** → **Load unpacked** → pick `extension/`.
2. Open the list you want to keep (`youtube.com/playlist?list=WL`, `makerworld.com/.../likes`).
3. Click the Stashling icon → **Collect**. It asks for permission on that host at that moment,
   not at install; an unused connector never holds access to a site you did not ask it to touch.
4. **Export** writes the same JSONL the CLI reads.

---

## What it does today

| Connector | Source | Lists | Strategy | Liveness signal |
|---|---|---|---|---|
| `youtube` | youtube.com | Watch Later | `dom-active-tab`, scoped to `ytd-playlist-video-renderer`, auto-scroll | in-place placeholder title (`[Private video]`, `[Deleted video]`) |
| `makerworld` | makerworld.com | likes, downloads, collections | `dom-active-tab` + `detail-fetch` (throttled, resumable) | detail fetch outcome |

Six acquisition strategies exist in the contract; a connector names the ones it needs and the host
implements them once: `dom-active-tab`, `passive-capture`, `detail-fetch`, `share-target`,
`file-import`, `api`. See [`packages/core/src/connector.js`](./packages/core/src/connector.js).

A collected Item is one JSON object. The zone a field lives in decides **who may write it** and
**what happens when the source is scraped again** — that is the entire design, and the field list
is downstream of it:

```jsonc
{
  "id": "youtube:gPW_mitgosw",          // identity — core owns, recomputed, greppable
  "source": "youtube", "sourceId": "gPW_mitgosw", "kind": "video",
  "url":          "https://www.youtube.com/watch?v=gPW_mitgosw&list=WL&index=1",
  "canonicalUrl": "https://youtube.com/watch?v=gPW_mitgosw",   // what it IS, vs where I found it

  "title": "Everything I know about 3D Printing",              // facets — connector writes,
  "byline": { "name": "Alexandre Chappel", "handle": "@achappel" },  //   every plugin reads
  "thumb": { "url": "https://i.ytimg.com/vi/gPW_mitgosw/mqdefault.jpg", "derived": true },
  "lists": ["watch-later"], "order": { "watch-later": 1 },     // membership is a scraped FACT
  "metrics": { "views": 612000, "durationSec": 1938 },         // flat string → finite number
  "times": { "firstSeenAt": 0, "lastSeenAt": 0 }, "sightings": 1,

  "liveness":   { "state": "live",   "checkedAt": 0, "evidence": null },   // what the SOURCE says
  "membership": { "state": "listed", "checkedAt": 0 },                     // what YOUR list says

  "ext":  {},        // connector-owned, opaque to core — this is what stops the schema growing
  "user": {},        // human-owned, OPEN MAP, never rebuilt from a whitelist, never touched
  "raw":  null       // lossless payload; never reconstruct a record from parsed columns
}
```

Full reasoning, invariants and the merge rules: [`docs/ITEM-CONTRACT.md`](./docs/ITEM-CONTRACT.md).

---

## Write a connector in one file

A connector is a description plus pure functions over strings. It says *what it needs* and never
implements it — which is also why you can test one against a saved page with no browser at all.

```js
import { defineConnector, ACQUISITION_STRATEGIES } from '@stashling/core'
import { chunkByElement, attrOfId, textOfId, first, parseClock } from '@stashling/connectors/shared/html'

export default defineConnector({
  id: 'example',
  kind: 'video',
  version: '1.0.0',
  hosts: ['https://example.com/*'],                       // optional_host_permissions, asked at use
  match: (url) => /^https:\/\/example\.com\//.test(url),
  lists: [{ id: 'saved', label: 'Saved', match: (url) => url.includes('/saved') }],

  acquisition: {
    strategy: ACQUISITION_STRATEGIES.DOM_ACTIVE_TAB,
    scope: 'x-saved-row',            // REQUIRED: split per item BEFORE extracting anything
    autoScroll: { maxMs: 60_000 },   // virtualized list; a scroll needs a deadline
  },

  parseList(html) {
    return chunkByElement(html, 'x-saved-row').map((chunk) => ({
      sourceId: first(chunk, /\/watch\/([a-z0-9]+)/),
      title:    attrOfId(chunk, 'row-title', 'title'),
      duration: textOfId(chunk, 'row-duration'),
    }))
  },

  normalize(raw) {
    const durationSec = parseClock(raw.duration)
    return {
      source: 'example', sourceId: raw.sourceId, kind: 'video',
      url: `https://example.com/watch/${raw.sourceId}`,
      title: raw.title ?? '',
      // omit an absent metric rather than writing 0 — absent and zero must stay distinguishable
      metrics: durationSec == null ? {} : { durationSec },
    }
  },

  deriveThumbUrl: (item) => `https://img.example.com/${item.sourceId}/m.jpg`,
  facets: [{ key: 'metrics.durationSec', label: 'Length', type: 'range', unit: 'min', scale: 60 }],
})
```

`defineConnector` validates eagerly, so a broken connector fails at import rather than mid-scrape.
Drop the file in `packages/connectors/src/`, add one static import to the registry, add a fixture,
and the harness reports your field coverage. Step by step:
[`docs/CONNECTOR-GUIDE.md`](./docs/CONNECTOR-GUIDE.md) and [`docs/FIXTURES.md`](./docs/FIXTURES.md).

---

## Design principles

Each of these is here because something specific happened. The evidence is the point.

- **The core is pure — no network, no DOM, no platform APIs, no dependencies.** Three collector
  tools built independently each arrived at a dependency-free core without coordinating; that is
  the strongest single signal in the corpus this design was distilled from.
- **Dedup on a stable source id, never on a title.** Titles get edited, translated and truncated;
  all three tools key on a machine id, and two of them state the invariant in their own docs.
- **The `user` zone is an open map and is never rebuilt from a whitelist.** One tool's
  `makeUserMeta()` returned a fixed five-key object and silently deleted the annotations a sibling
  app had started writing, on every re-scrape, until version 0.6.2 spread unknown keys through
  untouched.
- **Scope, then extract.** A real 582-item Watch Later page contains 639 unique `watch?v=` ids
  page-wide (measured 2026-09-03); splitting into per-item chunks first is what makes the
  difference between 582 rows and 10% contamination.
- **The rendered DOM is the source of truth; embedded JSON is an optimization a connector may opt
  into.** On that same page `ytInitialData` holds zero playlist rows and 39 video ids from a
  different route entirely, because the page is an SPA the user navigated within.
- **Liveness and membership are two axes, not one.** An item can be live on the site and no longer
  on your list; collapsing those loses the difference between "the platform deleted it" and "I
  removed it", which is exactly the distinction a survivability tool exists to keep.
- **"Gone" is a URL-shape assertion, not a status code.** Deleted Kleinanzeigen listings return
  HTTP 200 with a redirect to a category page, so a status-code-only probe reports every deleted
  listing as alive.
- **A terminal state must be re-armable.** One tool's `unfetchable` is terminal with no retry path
  anywhere, so a single transient timeout removes an item from enrichment forever and permanently
  inflates the inbox count.
- **Round-trip is a step-one test, not a later feature.** A portability architecture whose data
  only flows one way is not portable; a fixture asserts `fromJsonl(toJsonl(items))` is deep-equal
  to the input, `user` zone included.
- **Enrichment writes rows that say who asserted them, and the user always wins on read.** No merge
  logic, no whitelist, no incident — and disagreement stays inspectable instead of being
  overwritten.
- **Connectors ship in the package.** Dynamic `import()` does not work in an MV3 background service
  worker, and fetching connector code at runtime is a Chrome Web Store rejection under the
  remote-hosted-code policy. Bundled costs nothing at rest, because a connector is a pure module
  with no runtime of its own.
- **One implementation, or a checked-in parity table.** The same URL canonicalizer exists three
  times in one of the source projects; the untested third port has drifted in at least seven ways,
  one of which silently splits the dedup key across runtimes.

---

## Licence

**MPL-2.0.** File-level copyleft: you can embed a connector or the core in a proprietary product
without relicensing your product, and fixes to *these files* come back to everyone who depends on
them. That is deliberately weaker than AGPL — the people whose data most needs an exit are usually
inside commercial products, and a licence they cannot adopt is a licence that does not help them.

---

## Prior art and credit

Very little here is new. Most of it is a recombination of things other projects proved first, and
they are worth reading in their own right.

- **[Zotero translators](https://github.com/zotero/translators)** — the closest architecture that
  exists. One JavaScript file per site with a JSON header carrying a stable GUID
  (`translatorID`), a `target` regex that decides whether the file applies, a `priority`, and
  `lastUpdated` as the version; the body exports `detectWeb` and `doWeb`. Clients sync the
  translator directory from a central repository and fetch a translator's source lazily, only
  when a page matches its target. Stashling's connector shape is Zotero's shape with the
  extraction moved to strings so it can run in a service worker. AGPL-3.0.
- **[Adblock filter lists](https://github.com/uBlockOrigin/uAssets)** (EasyList, uBlock Origin) —
  the proven way to update rules for millions of browsers without shipping an extension update:
  the publisher declares its own refresh interval in a header (`! Expires: 6 days`), and updates
  arrive as diffs with a per-patch checksum. If Stashling ever ships out-of-band selector
  manifests, it should copy these header conventions rather than invent new ones. EasyList is
  dual GPLv3 / CC BY-SA 3.0.
- **[yt-dlp](https://github.com/yt-dlp/yt-dlp)** — the posture worth copying exactly: hundreds of
  trusted extractors bundled in the repo and shipped by frequent releases, with remote components
  available but opt-in and off by default. Two tiers, and the safe one is the default.
- **[ArchiveBox](https://github.com/ArchiveBox/ArchiveBox)** — defines its adapter contract as a
  process boundary (JSON-Schema'd config, JSONL on stdout, each plugin runnable standalone), which
  makes adapters language-agnostic and independently testable. It also rewrote that plugin core
  twice, which is why Stashling versions the contract from v1.
- **[SingleFile](https://github.com/gildas-lormeau/SingleFile)** — no site adapters at all: one
  universal serializer that always produces a self-contained, survivable artifact. A zero-adapter
  fallback is the right floor for a tool like this, and Stashling's lossless `raw` zone is the same
  instinct at record scale.
- **[Bruno](https://github.com/usebruno/bruno)** — no cloud, no account, and every request is a
  plain diffable text file on your own disk. The storage format *is* the product. That is the whole
  argument for line-delimited JSON here rather than a database you can only reach through our UI.
- **[Omnivore](https://github.com/omnivore-app/omnivore)** — the cloud service shut down in
  November 2024 after the team was acquihired, and user data was deleted with it. The repository
  was not archived and is still being committed to; what survived was the open code and the exports
  people had already taken. That is the entire argument for this project, and I would rather credit
  it than paraphrase it.

Also read, and worth your time: **[Wallabag](https://github.com/wallabag/wallabag)** and
[ftr-site-config](https://github.com/fivefilters/ftr-site-config) (host-keyed declarative rules —
and the chronic "site config not updated yet" bug that comes from distributing them at build time),
**[Karakeep](https://github.com/karakeep-app/karakeep)** (whose Reddit-plugin XSS advisory is the
reason adapter output must be sanitized at one sink rather than per adapter),
**[Obsidian Web Clipper](https://github.com/obsidianmd/obsidian-clipper)** (URL-regex *and*
schema.org triggers — broad coverage without per-site code), and
**[linkding](https://github.com/sissbruecker/linkding)** / **[Shiori](https://github.com/go-shiori/shiori)**
(no plugin system at all: one generic scraper plus a documented API is a cheaper ecosystem surface
than a plugin runtime, and worth being honest about).

---

## Where to go next

| Document | What is in it |
|---|---|
| [`docs/ITEM-CONTRACT.md`](./docs/ITEM-CONTRACT.md) | The record shape, the four zones, precedence, liveness, interchange |
| [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) | Layers, hosts, acquisition strategies, what lives where |
| [`docs/CONNECTOR-GUIDE.md`](./docs/CONNECTOR-GUIDE.md) | Writing and testing a connector, start to finish |
| [`docs/FIXTURES.md`](./docs/FIXTURES.md) | Synthetic fixtures, the coverage harness, why no real page is committed |
| [`docs/VERSIONS.md`](./docs/VERSIONS.md) | What bumps the contract version and what does not |
| [`docs/decisions/`](./docs/decisions/) | The decision records, including the remote-code line |
| [`docs/BLOG.md`](./docs/BLOG.md) | Why the architecture looks like this: three tools that converged |
| [`CONTRIBUTING.md`](./CONTRIBUTING.md) | How to contribute; a new connector is the best first PR |
| [`hosts/edge-linux/GUIDE.md`](./hosts/edge-linux/GUIDE.md) | Running an always-on collector box (Ubuntu Server 24.04) |
| [`docs/HANDOVER.md`](./docs/HANDOVER.md) · [`docs/WORKLOG.md`](./docs/WORKLOG.md) | **Picking up development?** Current state, what is in flight, what is next |

**Privacy note for contributors:** committed fixtures are hand-authored synthetic markup with
invented ids, titles and names. Real saved pages are used to *measure* coverage and are never
committed. See [`docs/FIXTURES.md`](./docs/FIXTURES.md).

---

<sub>Documentation and code in this repository were drafted with AI assistance (Claude Opus 5),
working from three source repositories (a MakerWorld scraper suite, a Kleinanzeigen companion, a
mobile link collector), direct measurements of a real 12.7 MB saved YouTube Watch Later page, and
Chrome Web Store / Chrome for Developers extension policy documentation verified 2026-09-03. Every
number quoted above is measured; claims that are not are marked as such in
[`docs/BLOG.md`](./docs/BLOG.md).</sub>
