# Contributing

## Getting started takes one command

```bash
git clone https://github.com/krausstt/stashling && cd stashling
node --test
```

That is the whole setup. There is no `npm install`, because there are **no dependencies** —
runtime or development. If you found a wrong selector, the shortest path from noticing to a
failing test is about ninety seconds. See [`docs/decisions/0006`](docs/decisions/0006-no-build-step-no-dependencies.md)
for why, and when we would revisit it.

Node 20.6.0 or newer.

## The full check

```bash
node --test                              # 151 tests
node scripts/sync-extension.mjs --check  # vendored extension code matches packages/
node scripts/check-extension.mjs         # manifest, imports, permissions
node scripts/fixtures.mjs                # fixture checksums
```

CI runs exactly these, on Node 20 and 22, with no install step.

## The layer rule

Each layer may only depend on the ones below it.

```
  Surfaces     extension UI · CLI
  Plugins      domain-blind
  Store        per host
  Core         PURE
  Connectors   PURE
```

Concretely:

- **`packages/core` imports nothing.** Not a package, not a `node:` builtin. If you need one,
  you are in the wrong layer.
- **`packages/connectors` imports core and nothing else.** No `fetch`, no DOM, no
  `chrome.*`/`browser.*`, no filesystem.
- **Hosts** (extension, CLI) implement acquisition strategies. A connector *declares* what it
  needs; it never performs it. If a connector would need to know which host it is running in,
  the layering is wrong — say so in the issue rather than working around it.

## Rules that came from real damage

Each of these exists because something shipped without it.

- **Scope, then extract.** Split the document into per-item chunks before extracting anything. A
  real YouTube page has 639 unique video ids and 582 real rows.
- **Prefer resilient anchors.** `data-*` attributes, element names, per-item JSON-LD and
  `svg[data-title]` all survived redesigns in the field. Tailwind and CSS-module class names did
  not. Kleinanzeigen runs two markup generations in parallel and detects layout **per tile**, not
  per page, so a partial rollout still parses.
- **One selector table, ordered candidates.** Exact anchor first, structural anchor next, shape
  heuristic last. Name it as the deliberate single point of repair, and record the measured
  coverage of each candidate so the next person can tell a deliberate fallback from a hopeful one.
- **Dedup on a stable source id.** Never on title. Never on position — measured, row ordinals are
  neither contiguous nor unique.
- **A connector never writes the `user` zone.** Not even an empty one.
- **Omit absent metrics; never substitute 0.** Absent and zero must stay distinguishable.
- **Empty beats fabricated.** Below a confidence threshold, return nothing. A wrong "related to"
  costs more trust than a missing one.
- **Never quietly under-collect.** If a capture may be partial, report it.

## Fixtures

**Committed fixtures are synthetic.** Never commit a real saved page — it is your viewing,
shopping or reading history, and it must not enter a public repository at any size. Full rules in
[`docs/FIXTURES.md`](docs/FIXTURES.md).

Every extraction bug found in real data becomes a fixture row, with a comment saying what it
encodes.

## Adding a connector

Start with [`docs/CONNECTOR-GUIDE.md`](docs/CONNECTOR-GUIDE.md), or scaffold one:

```bash
node scripts/new-connector.mjs <id> --kind <kind>
```

Then add the static import to `packages/connectors/src/index.js` by hand. The scaffold prints the
line rather than editing the file: a generated static import list is exactly the kind of thing
that silently breaks, and [`0002`](docs/decisions/0002-connectors-are-bundled-not-remote.md)
explains why that list cannot be dynamic.

**Before opening the PR**, decide deliberately whether the connector should exist: per-platform
terms differ, and the in-browser constraint documented in
[`docs/ACQUISITION-STRATEGIES.md`](docs/ACQUISITION-STRATEGIES.md) is a technical finding about
bot protection, not legal advice.

## Pull requests

- One concern per PR.
- Tests assert **coverage percentages**, not spot values.
- If you touched a contract, follow the checklist in [`docs/VERSIONS.md`](docs/VERSIONS.md).
- If you touched `packages/`, run `npm run sync` so `extension/vendor/` matches, or CI will fail.
- Say what you measured. "byline.url went from 96.7% to 96.7%" is a better PR body than "fixed
  the parser".

## Code style

Match the file you are editing. Practically: ES modules, 2-space indent, no semicolons at
statement ends, and the MPL-2.0 header on every source file.

The one thing that is genuinely different here from most codebases: **comments explain why, and
cite the evidence or the incident that forced the decision.** A comment that restates the code is
noise; a comment recording that a selector was measured at 96.74% and why the missing 3.26% are
not deleted videos is the most valuable line in the file. That is the house style and it is
deliberate — this is a repository about things that break silently.

## Reporting a broken connector

Use the "connector broken" issue template. Include the connector id, the coverage table from
`stashling verify`, which fields moved and by how much, and a **synthetic** minimal fixture
reproducing the new markup.

## Licence

By contributing you agree your contributions are licensed under MPL-2.0. File-level copyleft: a
fix to a connector file stays public, and a proprietary product can still depend on the packages.
Reasoning in [`docs/decisions/0001`](docs/decisions/0001-name-and-licence.md).
