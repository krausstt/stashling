# Contract versions and compatibility

Independently-developed surfaces that share **no code** are coupled by contracts alone. This
file is where those contracts are versioned, and the pattern is lifted directly from
`makerworld-suite/contracts` — the one place in the corpus this project was distilled from where
contract-first coupling between apps demonstrably held as the schema grew.

## Current versions

| Contract | Version | Definition | Consumers |
|---|---|---|---|
| **Item** | v1 | [`ITEM-CONTRACT.md`](./ITEM-CONTRACT.md), [`item.schema.json`](../packages/core/src/schema/item.schema.json) | everything |
| **Interchange JSONL** | v1 (`schema: 1`) | [`ITEM-CONTRACT.md` §8](./ITEM-CONTRACT.md) | CLI, extension |
| **attrs / precedence** | v1 | [`0003`](./decisions/0003-source-precedence.md) | core; no production writer yet |
| **Connector interface** | v1 | [`CONNECTOR-GUIDE.md`](./CONNECTOR-GUIDE.md), `packages/core/src/connector.js` | connectors, extension, CLI |
| **Facet manifest** | v1 | [`ITEM-CONTRACT.md` §3](./ITEM-CONTRACT.md) | connectors, collection UI |

## Compatibility matrix

| Component | Version | Item | Interchange | Connector iface | Last verified |
|---|---|---|---|---|---|
| `@stashling/core` | 0.1.0 | v1 (defines) | v1 (defines) | v1 (defines) | 2026-09-03 |
| `@stashling/connectors` | 0.1.0 | v1 | — | v1 | 2026-09-03 |
| `@stashling/cli` | 0.1.0 | v1 | v1 | v1 | 2026-09-03 |
| extension | 0.1.0 | v1 | v1 | v1 | 2026-09-03 |

"Last verified" means the full suite was green against that combination on that date. It is a
statement about tests, not an intention — a compatibility claim nobody re-checks is worse than
none, because it is believed.

> A caution taken from the source corpus: today-app's `CONTRACT.md` declared four consumed
> bundle formats with a dated "last verified compatible" line, and the code implemented two.
> Per-app contract dates are only as reliable as the discipline behind them. Here, the row above
> is meant to be updated by the same commit that changes behaviour, and the schema/runtime
> agreement is additionally enforced by `packages/core/test/schema.test.js`.

## The rule

- **Additive optional field** → backward compatible, **no version bump**. Old readers ignore it;
  new readers must tolerate its absence.
- **Rename, removal, retype, or an invariant change** → **major bump**, and every consumer is
  updated in the same change.

An invariant change is the one people underestimate. "`metrics` values are finite numbers" and
"a connector never writes the `user` zone" are not documentation — they are the contract, and
loosening either is a major bump even though no field name moved.

## Change checklist

1. Update the definition (`ITEM-CONTRACT.md`, `item.schema.json`, or `connector.js`).
2. Update `packages/core/test/schema.test.js` — the schema and the runtime must agree, and that
   agreement is asserted rather than assumed.
3. Update every consumer in the same change: connectors, CLI, extension.
4. `node --test`, `node scripts/sync-extension.mjs --check`, `node scripts/check-extension.mjs`,
   `node scripts/fixtures.mjs`.
5. Update the tables above, including the date, and add a log entry below.

## Consumer obligations

Rules a reader must honour, stated so they can be pointed at:

- **Unknown record types in the interchange format are ignored, by contract.** That is what lets
  the format grow without breaking readers that predate an addition.
- **Unknown keys in the `user` zone are preserved verbatim.** Any writer merges onto what exists;
  rebuilding the object from a known-key list silently deletes the human's work on round-trip.
- **`metrics` keys are open.** A reader must not assume a fixed set, and must treat an absent
  metric as absent rather than as zero.
- **An embedding vector must carry its model identity.** MakerWorld's embedding cache is keyed on
  item id alone with no record of which model or dimension produced the vector, so swapping the
  embedder silently reuses vectors from a different geometry — and because the builder skips ids
  already cached, it never recomputes them. Two vectors from different models are not comparable
  and nothing in that design can tell. Stashling has no vectors yet; when it does, this is the
  rule.
- **`order` is a hint, not a sequence.** Measured on a real page: ordinals are present on 100% of
  rows and are neither contiguous nor unique. Never key on it.

## Log

### 2026-09-03 — v1, initial

- Item v1: four zones (identity / facets+ext / user / raw), `metrics` as a flat string→number
  map, `liveness` and `membership` as **two orthogonal axes**, `liveness.attempts` and
  `retryAfter` so a terminal state is re-armable.
- Interchange v1: `meta` / `item` / `attr` / `signal` lines; unknown types ignored; `generation`
  plus `lineage`, so the staleness guard applies to a snapshot of the same collection and not to
  a merge of a different one.
- Connector interface v1: `match`, `lists`, `acquisition`, `parseList`, `parseDetail`,
  `normalize`, `deriveThumbUrl`, `liveness`, `facets`, `hosts`.
- attrs/precedence v1: `["user", "connector", "import", "cloud", "local-model", "rules"]`,
  unknown source ranks last, ties by `observedAt` then `confidence`.
