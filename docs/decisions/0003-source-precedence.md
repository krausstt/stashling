# 0003 — Derived values are rows with a source, resolved by precedence

**Status:** accepted, 2026-09-03 — **and being validated for the first time here**

## Context

Every tool this design came from eventually grows a second writer: a classifier, a batch job, a
rules pass, a user edit. The naive shape is that each writer *overwrites* a field. Two failures
follow, and both happened for real:

- **Enrichment destroys curation.** MakerWorld's `makeUserMeta()` rebuilt the user object from a
  five-key whitelist, so every re-scrape silently deleted `userTags`, `related`, `parts` and
  `links`. It was caught and fixed in 0.6.2, and today-app's contract now cites the incident by
  name: *"never rebuild it from a fixed whitelist, or you'll silently delete the user's data on
  round-trip."* Discipline caught it once.
- **Disagreement becomes unshowable.** Once a rules pass has overwritten a field, you cannot tell
  the user "the rules say *article*, the model says *paper*, you said *reference*", because two
  of those three no longer exist.

## Decision

Derived attributes are **rows carrying who asserted them**, and readers resolve by precedence.

```sql
attrs( itemId, key, valueText, valueNum, valueTime, source, confidence, observedAt )
       UNIQUE( itemId, key, source )
```

```js
SOURCE_PRECEDENCE = ["user", "connector", "import", "cloud", "local-model", "rules"]
```

An **unknown source ranks last** rather than first or throwing, so a plugin from the future
degrades safely and can never outrank a known writer. Ties break by `observedAt` descending then
`confidence` descending — never by row iteration order, which would make two runs over the same
data disagree.

## Consequences

Three properties fall out for free, each replacing a rule someone otherwise has to remember:

- **Enrichment cannot destroy curation.** A cloud batch writes `source:"cloud"` rows; a user edit
  writes `source:"user"`. Both persist; the user's wins on read. No merge logic, no whitelist.
- **Re-running anything is idempotent.** The `UNIQUE` constraint makes a re-run an upsert of that
  source's own opinion, touching nobody else's.
- **Disagreement is inspectable**, which is the honest UI and is impossible once you overwrite.

The typed value columns exist so "published before 2024" and "under 30 minutes" stay comparisons
rather than string parsing.

## Honest status

This schema, and this precedence list, already exist in openbrowsertabs — and are **dead code**
there. Verified by repository-wide grep: `putAttr`, `attrs()`, `putEdge`, `learnTerm`,
`edgesOf`, `countVocabHit` and `upsertEntity` have **zero callers**, the `edges` table is never
written, and the backfill that would populate `entities` runs only inside a migration, so on a
fresh install it executes against an empty table and no entity row is ever created again.

So this is a **strong hypothesis being implemented for the first time**, not tested code being
ported. It is one of the main reasons this repository exists. It has unit tests here; it does not
yet have production mileage anywhere.
