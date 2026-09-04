## What this changes

<!-- One concern per PR. -->

## What you measured

Numbers beat adjectives. If this touches extraction, paste the before/after coverage:

| Field | Before | After |
|---|---|---|
|  |  |  |

## Checklist

- [ ] `node --test` passes
- [ ] `node scripts/sync-extension.mjs --check` passes (run `npm run sync` if you changed `packages/`)
- [ ] `node scripts/check-extension.mjs` passes
- [ ] `node scripts/fixtures.mjs` passes

### Layers

- [ ] `packages/core` still imports **nothing** — not a package, not a `node:` builtin
- [ ] `packages/connectors` imports only core — no `fetch`, no DOM, no `chrome.*`, no filesystem
- [ ] No connector needs to know which host it is running in

### Data

- [ ] **This does not write the `user` zone from a connector** — should always be checked
- [ ] Absent metrics are omitted, not written as `0`
- [ ] No dedup on title or on position
- [ ] Nothing silently under-collects; partial captures are reported

### Fixtures

- [ ] Any new fixture is **synthetic** — no real saved page, at any size
- [ ] Checksums recorded (`node scripts/fixtures.mjs --update`)
- [ ] Any extraction bug found in real data became a fixture row, with a comment saying what it encodes
- [ ] Tests assert coverage **percentages**, not spot values

### Contract

- [ ] If a contract changed, the checklist in [docs/VERSIONS.md](../docs/VERSIONS.md) was followed
- [ ] `packages/core/test/schema.test.js` still passes — schema and runtime must agree

### Dependencies

- [ ] No new dependency, runtime or dev. (If you believe one is genuinely needed, say why here
      and expect it to be discussed — see [docs/decisions/0006](../docs/decisions/0006-no-build-step-no-dependencies.md).)
