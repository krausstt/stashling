# Stashling — agent instructions

Keep what you find, like and collect — portable, survivable, pipeable into your own stack.
Pure per-source **connectors** against one **Item contract**, an MV3 extension that collects,
a CLI, and an edge-collector host. MPL-2.0.

**Start every session with [`docs/HANDOVER.md`](docs/HANDOVER.md), then
[`docs/WORKLOG.md`](docs/WORKLOG.md).** The handover says what is in flight; the worklog says
which phase is next and why.

## Before you change anything

```bash
git status -sb       # staged work may be someone else's unfinished change — do not sweep it up
npm run check        # vendor sync + extension check + fixtures + the whole suite; installs nothing
npm run ui           # the extension UI harness (no browser needed)
```

`npm run check` is what CI runs. If it is not green before you start, find out why before you
change anything.

## Rules that are not negotiable

- **Zero dependencies, no build step.** CI installs nothing on purpose; an accidental
  dependency must fail the build.
- **Connectors are pure**: string in, plain objects out. No network, no DOM, no imports beyond
  core. They declare an acquisition strategy and never implement it.
- **The extension imports statically.** No dynamic `import()` — it does not work in an MV3
  service worker. No remote code, ever.
- **The `user` zone belongs to the human.** A connector never writes it; nothing rebuilds it
  from a list of known keys.
- **Real saved pages are personal data and never get committed** — not even to a private
  repo. Fixtures are synthetic. See `docs/FIXTURES.md`.
- **A false tombstone is worse than a missed one.** Never mark something gone on incomplete
  evidence.
- **Contract changes follow `docs/VERSIONS.md`**, and update every consumer in the same commit.
- After editing `packages/core` or `packages/connectors`, run `npm run sync` — the extension
  carries vendored copies, and `npm run sync:check` fails CI if they drift.

## Ask the user before

Pushing, archiving or renaming a repository, accepting an ADR, changing the licence or the
name, or deciding any of the open contract questions in the worklog.

## This machine

Windows, PowerShell 5.1. Commit with `git commit -F <file>` — PowerShell mangles double quotes
in native arguments — and write that file without a BOM (`Set-Content -Encoding utf8` adds one,
and it becomes the first character of the commit subject). Check line endings with `git ls-files --eol`, not `Out-String`. Git identity
is set `--local` to the GitHub noreply address; there is no global one, so a fresh repo would
commit under the user's work email.

Commit messages end with:

```
Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```
