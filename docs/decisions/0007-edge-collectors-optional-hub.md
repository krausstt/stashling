# 0007 — Collectors live at the edge; the container is an optional hub, never the core

**Status:** accepted, 2026-10-30, by the project owner (proposed 2026-09-10) — supersedes
nothing, but it settles a question ADR-0002 and `ACQUISITION-STRATEGIES.md` only answered by
implication.

## Context

The proposal on the table: *"the core of Stashling should maybe be a Docker container."*

It is worth taking seriously, because the instinct behind it is correct even though the
sentence as written is not. Three separate things are being conflated, and separating them is
most of the decision:

1. **the core** — `@stashling/core`: the Item contract, canonicalisation, zone merge, source
   precedence, the interchange format;
2. **acquisition** — actually getting the rows out of a site you are logged into;
3. **everything after acquisition** — storage, the plugin layer, search, history, a real browse
   surface, multi-device convergence.

Only the third has anything to gain from a container.

## The challenge: why the core must not be one

**The core is a pure library with no I/O and no dependencies.** It is ~1,500 lines of functions
over plain objects. Containerising it is a category error in the same way that shipping a Docker
image for a JSON schema would be: there is no process to isolate, no dependency to pin, no port
to expose. `import { createItem } from '@stashling/core'` is already the smallest possible
integration surface, and it works in Node, in a browser page, and in an MV3 service worker
without change.

**A container cannot do the one thing that matters.** Acquisition has to happen inside the
user's own logged-in browser session. This is not a preference and it is not laziness — it is
the measured constraint the whole architecture is bent around. Kleinanzeigen's own notes record
that its bot protection fingerprints browser and TLS characteristics and throttles datacenter
IPs, and that its terms forbid automated access; openbrowsertabs' notes record an attempt to
reach Watch Later programmatically refused with `disallowed_useragent`. A container on your NAS
has a datacenter-shaped TLS fingerprint, no session cookies, and no user gesture. It cannot be
the collector, and a design where the collector is the core makes the core the one component
that cannot run.

**Manifest V3 forbids the extension from delegating logic to it anyway.** Even if a container
held the "real" core, the extension could not call out to it for anything that decides
behaviour: remotely hosted code is banned, and the policy specifically names *"building an
interpreter to run complex commands fetched from a remote source, even if those commands are
fetched as data"* (ADR-0002). The extension must carry its own copy of the logic regardless. A
container in that picture is a second implementation to keep in sync — the exact failure this
project already documents three times over (openbrowsertabs' three drifting ports; and, found
this week, `actually-watch-later` being a byte-identical second copy of the YouTube parser).

**And it costs the property that makes the project credible.** Zero dependencies, no build step,
`git clone && node --test` (ADR-0006). A Dockerfile is a bigger operational surface than the
entire codebase, and for a tool whose pitch is "you keep your data, forever, with no
infrastructure", *requiring* infrastructure is a contradiction in the first sentence.

## What is right about the instinct

All of that is an argument against one specific sentence, not against containers. Four things
genuinely want a long-lived process, and Stashling has no home for any of them today:

- **Storage at a size IndexedDB is wrong for.** One saved Watch Later page is 12.7 MB. Keeping
  raws for years across several sources is a database's job, and full-text search over 100k
  items is not something to hand-roll over an object store.
- **The expensive plugin layer.** Embeddings, clustering, TF-IDF over a large corpus, metric
  history compaction. MakerWorld's suite already needed a 384-dimension MiniLM pass and shipped
  it as a browser-side WASM download with a documented list of ways that goes wrong.
- **Work that must happen while you are not there.** Liveness probing on a schedule, budgeted
  and resumable. An MV3 service worker is terminated after 30 seconds of inactivity; it is
  structurally the wrong place for a job that takes an hour.
- **Convergence.** Today the extension, the CLI and (eventually) a phone each hold a separate
  collection. "A pipe, not a database" was openbrowsertabs' answer and it was never built.

**And one asymmetry decides the shape.** A Node process *can* `import()` a connector at runtime.
The extension cannot — that is ADR-0002 and it is not going to change. So the connector registry
this project wants to become — the plugin hub — is only fully expressible on the hub side. In
the extension a connector is compiled in; in the hub it can be installed. That is not a
workaround, it is a genuine capability difference, and it is the strongest argument for the
container existing at all.

## Decision

**Two tiers, and the boundary between them is acquisition.**

```
  EDGE  (always, and always the only acquirer)
    browser extension · mobile share target · CLI over a saved file
    → pure connectors, the Item contract, a local store
    → fully functional with no hub. This is the product.

  HUB   (optional, self-hosted, a container)
    ingest the interchange format · durable storage · the plugin layer
    · scheduled liveness · search · a real browse surface · API connectors
    → NEVER acquires from a session-protected source
    → CAN load connectors dynamically, which the extension cannot
```

Concretely:

- **`@stashling/core` stays a pure npm package.** It is the one thing both tiers share, and it
  is shared as source, not as a service.
- **The hub is a *sink and a workbench*, not a crawler.** It receives interchange JSONL pushed
  from the edge. Its one acquisition privilege is `api` — a source with an official API (eBay
  is the example already in the notes) may legitimately be polled server-side.
- **The edge never requires the hub.** If the hub is off, collection, export and import still
  work. This is the acceptance test for the whole design: delete the container and nothing you
  have collected becomes unreachable.
- **The hub never becomes required to read your own data.** The interchange format stays plain
  JSONL that `stashling verify` can read with no server.

## The SaaS shape this implies

Asked from a "modular SaaS" angle, the honest answer is that the sellable thing here is
**convenience, never access**:

- The **format** and the **connectors** are open, and the exit is free by construction — the
  hub's entire input and output is a file format the CLI can read.
- The **hub image** is what someone would pay to have run for them. Hosting it changes nothing
  about who can read the data, because it is the same container with the same export.
- What must never be sold is *the ability to get your data out*, and the architecture makes
  that hard to walk back: the edge tier is a complete product and the interchange format is
  readable without any of this.

If that sounds like it forecloses a business, note that the failure mode it forecloses is the
one that actually happened to the closest comparable product. Omnivore's cloud shut down in
November 2024 and deleted user data; what survived was the export people had taken and the
self-hostable code. A design where the hosted tier is a convenience over an open format is the
one that survives its own vendor.

## Consequences

**Accepted costs.**

- Two storage implementations (IndexedDB at the edge, a real database in the hub) that must
  agree about the Item contract. Mitigated by both consuming `@stashling/core` and by the
  interchange round-trip test being the shared conformance suite — but it is a real second
  implementation and ADR-0003's warning about second implementations applies to it.
- The self-hosting tax is genuine: most people will never run the container, so **every feature
  must degrade to "edge only" rather than being hub-first.** Any capability that only works with
  a hub is a capability most users do not have.
- A hub that ingests a collection is a new exfiltration target and a new thing to keep patched.
  It must default to localhost-only and say so loudly.

**Explicit non-goals, restated because they are easy to drift into.**

- No accounts. No cloud by default. No telemetry.
- The hub does not scrape session-protected sources. If a future connector wants that, the
  answer is a headless browser **on the user's own machine driving their own profile**, which is
  a different decision needing its own record — not a server with stored credentials.
- The hub is not where the contract lives. `@stashling/core` remains the single definition, and
  the hub is a consumer of it exactly like the extension is.

**Deferred, and blocked on this being accepted:** what the hub is actually built with, its
storage engine, and whether the connector registry ships as npm packages, a Zotero-style synced
repository, or an adblock-style checksummed manifest. Those belong in ADR-0008 once there is a
hub to put them in.

## Status of the evidence

The measured constraints (bot protection, `disallowed_useragent`, MV3 worker lifetime, the store
policy on remote code) are recorded with sources in `ACQUISITION-STRATEGIES.md` and ADR-0002.
The comparisons to Karakeep, ArchiveBox, linkding, Wallabag, Omnivore and Zotero come from a
verified prior-art sweep during the project's design phase and are summarised in `BLOG.md` and
ADR-0002; **a second sweep specifically covering how each of those handles login-protected
content was scoped and not completed**, and should run before ADR-0008. The one thing it would
most usefully settle is what Karakeep's v0.32 decision to embed SingleFile in the extension —
rather than crawl server-side — implies for the boundary drawn here, because on the face of it
it is the same conclusion reached independently.
