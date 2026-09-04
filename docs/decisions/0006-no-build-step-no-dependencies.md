# 0006 — No build step, no dependencies, `node --test`

**Status:** accepted, 2026-09-03

## Context

All three tools this design was distilled from are build-free: no bundler, no transpiler, and in
two cases no `package.json` dependencies at all. That was not an accident of scale, it was
repeatedly chosen — and it is the reason a five-year-old copy of any of them still runs.

The modern default would be a bundler (WXT, CRXJS and vite-plugin-web-extension are all actively
maintained in 2026) plus Vitest. Both were considered seriously.

## Decision

**No bundler. No runtime dependencies. No dev dependencies. `node --test` as the runner.**
`npm test` works on a fresh clone with nothing installed.

The extension consumes the packages through a vendoring step
(`scripts/sync-extension.mjs`) rather than a bundler: a byte-for-byte copy with exactly one
transformation — cross-package import specifiers rewritten to resolve inside `vendor/`.

## Why this is affordable here

The usual argument for a bundler in MV3 is that a connector registry needs dynamic `import()`,
which is unsupported in a service worker, so the import map has to be generated at build time.
That is real — but generating a static import list is a 200-line script, not a toolchain.

The usual argument for Vitest is a DOM environment. **Connectors here parse HTML as strings**
(see `0004`), so there is no DOM to provide. That single architectural choice removes the main
reason to install anything.

`node:test` is Stability 2 (stable) and its snapshot support stabilised in v23.4.0.

## Consequences

**What is given up, honestly:**

- Code coverage (`--experimental-test-coverage`) and watch mode are still Stability 1 in
  `node:test`. Coverage runs, but it is experimental.
- No TypeScript. The contract is enforced by `validateItem`, a JSON Schema, and tests asserting
  the schema and the runtime agree — not by a compiler.
- A connector that genuinely needs a DOM cannot be written the way the bundled ones are. That is
  a deliberate constraint, and the moment a real source cannot be parsed as a string is the
  moment to revisit this decision rather than smuggle in a parser.

**What is bought:**

- `git clone && node --test` is the entire contributor onboarding. No install step is the
  shortest possible path from "I found a bug in a selector" to "I have a failing test".
- The file you debug in devtools is the file the tests ran against — no source maps, no
  "works in dev, broken in the build".
- Nothing to audit for supply-chain risk in a tool that reads your logged-in pages. For this
  product specifically, that is not a minor property.
- CI has no `npm install` and no cache step, so a dependency added by accident makes the build
  *fail* rather than merely slow down.

**When to revisit:** a connector needing a real DOM; a surface needing a UI framework; or the
`node:test` coverage story remaining experimental when coverage gating becomes necessary. None of
those is true today.
