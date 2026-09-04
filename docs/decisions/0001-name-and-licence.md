# 0001 — The name is Stashling, and the licence is MPL-2.0

**Status:** accepted, 2026-09-03

## Context

The design this project grew out of used the working name **Trove**, explicitly marked
"swappable". Before writing a public artefact, that name was checked:

- npm `trove` is **taken** (a live package, "a simple tool for stashing and grabbing files").
- The `@trove` npm scope is **taken**, and has been since 2018 — so the usual fallback is closed.
- Three *live 2026* npm projects sit in the same personal-data niche: `@3sln/trove` (self-hostable
  drive with a sandboxed plugin architecture), `@fldr/trove` (end-to-end-encrypted personal
  repositories), `@ontrove/cli` (a personal knowledge base).
- The Chrome Web Store already carries **two** extensions called Trove, one of which is a
  highlights clipper — the same category as this.
- GitHub returns ~3,600 repositories with "trove" in the name, and `trove classifiers` is
  permanent Python-packaging vocabulary, which poisons search.

Separately, a licence had to be chosen. The asset worth protecting is not the extension shell —
it is the **connector corpus**: parse rules for many sites, kept fresh against redesigns. That is
the expensive, perishable, hard-to-replicate part.

## Decision

**Stashling.** npm name free, GitHub org free, one unrelated repository with no traction, no
product usage found. It reads as "a small thing you stash", which is what an Item is.

**MPL-2.0 across the repository.**

## Consequences

MPL-2.0 is *file-level* copyleft, and that boundary happens to land exactly on the unit of
value: **a connector is a file.** A company that fixes the Amazon parser to keep its own product
working must publish that fix; it does not have to open its product. That is precisely the trade
an incubator wants.

It also does not block adoption. Any proprietary application can depend on and bundle
`@stashling/core` and `@stashling/connectors` — which is what actually recruits contributors,
because people contribute to libraries they are already using in anger.

The alternatives, and why not:

- **MIT** — gives the corpus away for nothing and has no patent grant. A closed SaaS can absorb
  every connector and never return a fix.
- **Apache-2.0** — a good patent grant and the easiest corporate path, but zero reciprocity. It
  is the right answer if attracting corporate contributors dominates everything else; it was not
  chosen because it protects nothing about the corpus.
- **AGPL-3.0** — for *client-side* code the §13 network clause essentially never fires: this runs
  on the user's machine and is not offered to users over a network. So you pay the full
  corporate-avoidance cost for a clause that does not bite. On the npm packages specifically it
  is close to fatal for the incubator premise, because almost nothing downstream could depend on
  them. It would become the right answer for a hosted sync service, and that component alone
  should take it.

MPL-2.0's secondary-licence clause keeps the door open: the shipped extension, or a future
server, can be relicensed to GPL/AGPL without a contributor relicensing campaign.

Neither the Chrome Web Store nor AMO restricts licence — GPL-3.0 and AGPL-3.0 extensions ship on
both today, so this was never a distribution constraint.

*Not legal advice; this is a strategy note. The reading of AGPL §13 above is the mainstream
consensus rather than a quoted authority.*
