# Worklog — the connector-hub programme

Long work, split into chunks that each end with something committed and something written down.
If a session stops mid-programme, **start here**: the phase table says what is done, what is
next, and what the next step depends on.

This is a working document, not a spec. The specs are [`ITEM-CONTRACT.md`](./ITEM-CONTRACT.md),
[`VERSIONS.md`](./VERSIONS.md) and the [decision records](./decisions/).

---

## Where this is going

Four collectors exist as separate tools. Each one solves the same problem for one source and
none of them can talk to any other:

| Repo | Source | State |
|---|---|---|
| [makerworld-suite](https://github.com/krausstt/makerworld-suite) | MakerWorld models | scraper + web app + Android app; **connector already ported** |
| [grosse-kleinanzeigen](https://github.com/krausstt/grosse-kleinanzeigen) | Kleinanzeigen classifieds | MV3 extension, price history, tombstones |
| [openbrowsertabs](https://github.com/krausstt/openbrowsertabs) | shared links | Android; mostly the **plugin layer**, not a connector |
| [actually-watch-later](https://github.com/krausstt/actually-watch-later) | YouTube Watch Later | standalone MV3 extension — **overlaps Stashling's own YouTube connector** |

The goal is not to absorb four codebases into one. It is that each source becomes a **pure
connector** against one Item contract, so every capability written once — liveness, metric
history, relate, triage, export — works on all of them at once. That is the whole argument of
[the blog post](./BLOG.md): the gaps in each tool are the case for unifying, because each is
missing something another already solved.

---

## Phases

| # | Phase | State | Ends with |
|---|---|---|---|
| 0 | Extension made to actually work | **done** (`6ea0b68`) | 168 tests, first extension tests, UI harness |
| 1 | Recon: map 4 repos onto the contract, review `6ea0b68`, gather hub evidence | **in progress** | this file filled in + ADR-0007 + migration plan |
| 2 | Decide the topology: edge vs hub, and what a container is for | pending phase 1 | ADR-0007 accepted |
| 3 | YouTube: resolve the duplicate implementation | pending phase 1 | one connector, one fixture corpus, the other repo archived or reduced |
| 4 | Contract gaps the connectors expose | pending phase 1 | contract v1.1: create-vs-enrich, cohort annotations, sidecars |
| 5 | Kleinanzeigen connector | pending phase 4 | connector + `passive-capture` + `detail-fetch` hosts |
| 6 | First plugins: liveness, metric-history | pending phase 5 | the premise becomes operational |
| 7 | openbrowsertabs: share-target + relate/cluster/triage plugins | pending phase 6 | the plugin layer exists |
| 8 | The hub (if ADR-0007 says so) | pending phase 2 | optional self-hosted container |
| 9 | The plugin hub / connector registry | pending phase 8 | a way to distribute connectors |

Phases 3–7 each follow the same shape, which is the SDLC discipline this project already uses
and should keep using:

1. **Measure first.** Run the existing tool's parser over a real saved page, locally, and write
   down the coverage percentages. Never start from the old code's assumptions.
2. **Synthetic fixture.** Reproduce the measured shapes with invented values. Real saved pages
   are personal history and never enter the repo ([FIXTURES.md](./FIXTURES.md)).
3. **Connector, pure.** String in, plain objects out. No network, no DOM, no dependencies.
4. **Tests assert percentages**, not spot values, and every extraction bug found in real data
   becomes a fixture row.
5. **Contract change?** Follow the checklist in [VERSIONS.md](./VERSIONS.md) — including
   updating every consumer in the same commit.
6. **Then, and only then**, the host capability and the surface.

---

## Standing constraints

Re-derived too often; they bound every option below.

- A connector is **pure** and declares an acquisition strategy it never implements.
- The extension imports connectors **statically**. Dynamic `import()` does not work in an MV3
  background service worker and remote connector code is a store rejection
  ([ADR-0002](./decisions/0002-connectors-are-bundled-not-remote.md)). **A Node host has neither
  limit** — that asymmetry is the single most important input to the hub decision.
- **Zero dependencies, no build step** ([ADR-0006](./decisions/0006-no-build-step-no-dependencies.md)).
- Acquisition mostly **cannot move to a server**: bot protection fingerprints browser and TLS and
  throttles datacenter IPs, and the session is the user's
  ([ACQUISITION-STRATEGIES.md](./ACQUISITION-STRATEGIES.md)).
- The `user` zone is human-owned. A connector never writes it.

---

## Findings — phase 1 (partial: 4 of 6 recon tracks complete)

### The container question is settled: [ADR-0007](./decisions/0007-edge-collectors-optional-hub.md)

Short version. The **core must not be a container** — it is a pure dependency-free library, so
there is nothing to isolate; a container cannot reach a logged-in session behind bot protection
that fingerprints browser and TLS; and MV3 forbids the extension from delegating logic to it
anyway, so a container would be a *second implementation* of the thing this project has already
been burned by three times.

The instinct is still right about something. **An optional self-hosted hub** is the correct home
for durable storage, the expensive plugin layer, scheduled liveness, and multi-device
convergence — and one asymmetry makes it genuinely valuable rather than merely convenient:
**a Node process can `import()` a connector at runtime and the extension never can.** The
connector registry this project wants to become is only fully expressible on the hub side.

Boundary: **the edge is the only acquirer, and the edge alone is a complete product.** Delete the
container and nothing you collected becomes unreachable.

### YouTube: `actually-watch-later` is not a second implementation, it is the same one

Both parsers were run over both fixtures and diffed across all 14 shared row fields on all 20
rows: **zero differences.** Same selector table, same three duration candidates, same
optional-origin channel regex, same measured percentages in the `why` strings, same
`[Private video]` table with the same "no guessed localisations" note. One parser, two
checkouts, five days apart.

Drift has nonetheless already started, in the shared helpers — AWL's `decodeEntities`
double-decodes `&amp;quot;` and handles no numeric or hex entities, and its `stripTags`
reintroduces the floating-full-stop bug this repo documents as a scar. That is the
openbrowsertabs three-ports failure at t = 5 days.

**Direction: fold in and archive.** Stashling is the survivor because it has everything AWL has
plus the Item contract, precedence, round-trip interchange, the store with raw splitting, the
facets UI, the CLI, MakerWorld as a second connector proving the abstraction, and per-list
`order`/`lists` that AWL structurally cannot express (its `position` is a bare number, so
collecting Watch Later and then Liked videos would overwrite it). A shared parity fixture is the
wrong answer for the same reason: it institutionalises two copies and only detects drift after
it has happened.

What AWL has that Stashling does not, and should take:

| From AWL | Why it matters | State |
|---|---|---|
| depth-counting chunker | Stashling's split-based one gave the **last chunk the rest of the document** | **done**, `b0639a3` |
| digit-anchored number parse | `'.'` parsed to a finite **0** and landed in `metrics.views` | **done**, `b0639a3` |
| disappearance sweep gated on scrape completeness | nothing in Stashling ever writes `membership: 'unlisted'` | phase 3 |
| rows-only capture, `<svg>`/`<style>` stripped in-page | Stashling ships the whole 12.7 MB document across the boundary | phase 3, blocked on the §7 ruling |
| coverage reported in the popup after every scrape | Stashling's better coverage engine is CLI-only, so the alarm never reaches the person scraping | phase 3 |
| fixture row where only `badge-shape[aria-label]` carries the duration | **16 of 17 fallback candidates never decide in either repo** — the ordered table is an untested promise | phase 3 |

### Kleinanzeigen exercises three things nothing else does

It is the hardest connector and the most valuable, because each of these is a genuine gap in the
contract rather than a porting chore:

1. **Two markup generations dispatched per tile, not per page** — so a partial A/B rollout parses
   completely instead of half-failing.
2. **Two orthogonal "gone" axes**, which is exactly `liveness` + `membership` — and it is the
   only implementation of `unlisted` anywhere in the corpus. Stashling *defines* the state,
   *counts* it and *renders* it, and has no writer for it.
3. **A create-vs-enrich admission rule** — `if (!known && !opts.markSaved) continue`: only the
   watchlist may CREATE a record; search and detail pages may only ENRICH. Without it every ad
   you idly click joins the collection. **The connector interface cannot express this at all.**

Also worth knowing before starting: it needs **three acquisition strategies at once**
(`passive-capture`, a list-fetch shape that does not exist in the enum, and `detail-fetch`),
while `connector.acquisition` declares exactly one. MakerWorld already smuggles a second in as
`acquisition.detail`, which `validateConnector` never looks at — unvalidated precedent, not a
design.

And two live bugs in its runner, both the terminal/retryable collapse the contract warns about:
a 429 or 500 permanently tombstones an ad with an `endedAt`, and a thrown fetch never writes
`lastChecked`, so a broken URL camps at the head of the least-recently-checked queue forever.

### Defects found and fixed this phase

| Defect | Impact | Commit |
|---|---|---|
| `chunkByElement` gave the last chunk everything to EOF | on the real page the last row's raw swallowed a 1.8 MB blob, exceeded `MAX_RAW_BYTES`, and was silently dropped | `b0639a3` |
| `parseCompactNumber` returned a finite `0` for `'.'`, `'...'` | wrote `metrics.views: 0`, which ITEM-CONTRACT §3 forbids | `b0639a3` |
| MakerWorld declared `resolveId`; all four hosts read `instanceId` | every collection filed under the family id `collection`, not `collection:<id>` — silent, because the fallback is legitimate | `183 tests` |
| oversize raw destroyed a good body already stored | a page growing past 256 KB deleted its own last lossless capture | `7fd65e7` |
| `putItems` wiped the raw hash history an import touched | two copies of one merge rule, disagreeing | `7fd65e7` |
| `safeHref` promoted `//evil.example/x` to https | a hostile `.jsonl` could point a click at any host | `7fd65e7` |

After the chunker fix, re-measured against the real 582-row page: **every coverage number
unchanged** (100% id/title/duration/views/order, 99.48%/96.74% byline, 0 validation problems),
max raw size **16,144 bytes** instead of 1.8 MB, zero raws over the cap.

### Known-unfixed, from the adversarial review of `6ea0b68`

Recorded so they are not rediscovered. None is a regression; all predate that commit.

- **`exportAll` never bumps the generation**, so exporting and re-importing your own untouched
  backup is refused as stale. The confirm-and-force path in the UI papers over it.
- **Two concurrent exports mint two lineages**; the file carrying the losing one bypasses the
  generation guard permanently.
- **Import during collect silently reverts the collect** — `importFile` reads the whole
  collection, merges in memory, and writes the pre-merge snapshot back. Window is the whole
  store; `upsertItems` has the same shape with a 20-item window.
- **Nothing serialises the message hub**, so `clearAll` can interleave with a collect.
- **`closeDb()` does not cancel an in-flight open**, so a pending `onsuccess` resurrects a handle
  the caller believes closed.
- **The CLI and the extension emit different Items for the same page** — `membership.checkedAt`
  and `raw.capturedAt` are still 0 from the CLI.
- **The IndexedDB fake is weaker than the real API** in specific, listed ways: no error path is
  reachable at all (no quota, no blocked upgrade, no forced close), keys are `JSON.stringify`d
  so a `Date` and its ISO string collide, cursors yield insertion order rather than key order,
  and `objectStore.index()` does not exist. It is honest enough to have caught four real bugs;
  it is not honest enough to prove an absence.

## Open decisions

These block phase 4 and interact, so they should be decided together in one contract bump.

1. **Admission policy** — how does a connector say "this page may enrich but not create"?
   Proposal: `lists[i].admits: 'create' | 'enrich'`, defaulting to `create` so nothing changes
   for YouTube or MakerWorld, with `parseDetail` output defaulting to `enrich`. It must be
   enforced in the store above `mergeItems`, because `mergeItems` returns `incoming` when
   `existing` is null and so cannot refuse a creation.
2. **Multi-strategy acquisition** — one connector, several strategies, validated. Today the
   shape is a single `strategy` plus an unvalidated `acquisition.detail` escape hatch.
3. **`liveness.stateSince`** — Kleinanzeigen's `endedAt`. Is "when did this become gone" a
   first-class field?
4. **Is `reserved` a liveness state** or does it stay `ext.saleState` plus a term facet?
5. **Cohort-scoped annotations** — `refPrices` is user-owned data attached to a *group*, not an
   item. The `user` zone is per-item. Where does a cohort annotation live, and what happens to
   it when regrouping moves an item?
6. **Does `raw` promise verbatim bytes or verbatim-for-parsing?** This blocks the payload
   reduction, and it changes what `hash` means.

## Still unknown — recon batch 2 did not run

Three tracks were scoped and lost to the session limit. They should run before phase 7 or 8:

- **openbrowsertabs** — the plugin layer in detail (relate, clustering, triage, reactions, the
  save-moment ordering) and a drift check of its `UrlNormalizer` against this repo's port.
- **makerworld-suite gap analysis** — what the original scraper captures that the ported
  connector does not, the thumbnail sidecar format, and which of catalogue-app's algorithms
  become plugins.
- **Self-hosted-hub evidence** — how Karakeep, ArchiveBox, linkding and Wallabag each handle
  login-protected content, which would confirm or challenge ADR-0007's boundary. Karakeep's
  decision to embed SingleFile in the extension rather than crawl server-side looks like the
  same conclusion reached independently, and that is worth verifying rather than assuming.
