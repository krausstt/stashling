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

## Findings

_Filled in by phase 1._

## Open decisions

_Filled in by phase 1._
