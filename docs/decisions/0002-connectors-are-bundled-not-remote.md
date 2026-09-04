# 0002 — Connectors are bundled and statically imported, never fetched

**Status:** accepted, 2026-09-03

## Context

The obvious shape for a connector platform is a registry: the extension discovers which
connector a page needs and loads it on demand. That would let a broken selector be repaired
without shipping an extension update — and selectors are precisely what rots.

Two independent constraints kill it.

**1. Dynamic `import()` does not work in an MV3 background service worker.**
[w3c/webextensions#212](https://github.com/w3c/webextensions/issues/212) is still open (last
activity 2025-12-05, tracking crbug 1198822). Static ESM works with `"type": "module"`; the
dynamic form does not. A "load the module for the current site" registry is exactly the dynamic
form.

**2. Remotely hosted code is banned outright.** The Chrome Web Store's MV3 requirements prohibit
a `<script>` pointing outside the package, `eval` of a remotely fetched string, and — the clause
that matters here — *"building an interpreter to run complex commands fetched from a remote
source, even if those commands are fetched as data."* Fetching connector logic post-install is a
rejection (violation class "Blue Argon"), and the developer documentation is blunt about
workarounds: *"Generally speaking, no. RHC is not allowed."*

## Decision

**One extension. Every connector bundled. Statically imported from a generated registry.
Connector updates ship as extension updates.**

Because a connector is a pure module with no runtime of its own, bundling them all costs nothing
at rest. This is how filter-list and command extensions have always worked.

`scripts/sync-extension.mjs` vendors `packages/*/src` into `extension/vendor/` and CI fails if
the copy drifts from the source the tests actually ran against.

## Consequences

A broken selector requires a store review round-trip. That is a real cost and it is the main
thing this design pays for MV3 compliance.

**One door stays open, and it is worth knowing about.** Chrome explicitly permits *"fetching a
remote configuration file for A/B testing or determining enabled features, where all logic for
the functionality is contained within the extension package"*, and the RHC documentation states
that remote code *"does not include data or things like JSON or CSS."* A JSON list of selectors
consumed by fixed, shipped `querySelector` logic sits squarely inside that allowance.

The bright line is the interpreter clause. A future remote selector manifest may carry
selectors, field names, match patterns, feature flags and a schema version. It must **never**
carry control flow, action verbs, step sequences, regex-transform pipelines that amount to a
mini-language, or anything dispatched through a generic opcode switch. And a representative
default must ship in the package regardless, so the extension is fully functional offline and a
reviewer can discern its full functionality from the submitted code.

That is not implemented in v1. It is recorded here so the shape is already decided when the
first connector breaks in the wild.

## Prior art worth stealing from, when that day comes

- **Zotero translators** — the closest existing architecture. One file per site with a JSON
  header (`translatorID` GUID, a URL regex `target`, `priority`, `lastUpdated` as the version).
  The client syncs its translator directory from a central repository, and the connector caches
  only header *metadata*, fetching a translator's source lazily when a page matches. Split
  manifest from payload; timestamp is the version; GUID is the identity.
- **Adblock filter lists** — the proven way to update rules for millions of browsers without
  shipping software: publisher-declared expiry (`! Expires: 6 days`), diff paths, and patch
  blocks carrying a checksum. Copy the header conventions rather than inventing new ones.
- **yt-dlp** — two tiers: extractors bundled in-repo and shipped by frequent releases, plus
  opt-in remote components that are **off by default**. That is the right posture for anything
  fetched later.
- **wallabag / ftr-site-config** — the cautionary case. Its declarative host-keyed rules are
  distributed as a *build-time dependency*, so a rule fix needs a release and a package update.
  "Site config not updated yet" is its chronic bug class.
