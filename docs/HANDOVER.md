# Handover — updated 2026-10-30

For the next coding agent. Read this, then [`WORKLOG.md`](./WORKLOG.md), then start.

This file is a **snapshot**, and snapshots rot. Every claim below that can go stale comes with
the command that re-checks it. Run §2 before you trust §1.

---

## 1. State at the time of writing

### `main` is in sync with GitHub; the edge-linux work waits in PR #2

| | |
|---|---|
| `main` | `e1f1cec`, equal to `origin/main`, CI green on Node 20.x and 22.x |
| Open PR | **[#2](https://github.com/krausstt/stashling/pull/2)** `edge-linux-provisioning` — CI green on both Node versions, **including the first-ever `shellcheck` run**; mergeable. **Waiting for the owner to merge** (an automated merge was refused as "merge without review", correctly) |
| Tests | **197** on `main`; **207** with PR #2 (driver tests 14 → 24) |
| ADR-0007 | **accepted** by the owner, 2026-10-30 — phase 2 is done |

**Until PR #2 is merged, `main` does not contain the provisioning scripts, `GUIDE.md`, or the
three driver fixes below.** Anyone installing a box from `main` before then gets a driver that
fails most sweeps. Merge first, or clone the branch.

### `hosts/edge-linux/` — what it is and how far it is proven

It turns an always-on Ubuntu 24.04 mini PC into an edge collector: one Chrome on a virtual VNC
display, logged in **by hand** once, driven over CDP by a systemd timer, with a nightly export.
Written for the owner's **Lenovo M720q**. Start at [`hosts/edge-linux/GUIDE.md`](../hosts/edge-linux/GUIDE.md).

Reviewing it line by line (2026-10-30) found three defects in the driver, all fixed in PR #2,
each a failure that would have looked like success or like a quiet day:

1. **A sleeping service worker read as "extension not loaded."** An MV3 worker dies after ~30 s
   idle, so between half-hourly sweeps it has no DevTools target — the only place the driver
   looked. Now the id is derived from the install path and verified against `chrome.runtime.id`.
2. **A killed sweep left its lock forever**, and every later tick exited 0 "already running".
   Stale locks are now reclaimed.
3. **A load-event race** could time out pages that loaded fine.

| Check | Result |
|---|---|
| `shellcheck --severity=warning` | **clean** (CI, PR #2) |
| `bash -n` | passes — under real Linux bash (WSL), not only CI |
| Exec bit / LF in the git index | `100755` / LF on all three scripts |
| Generated systemd lines | rendered and checked; literal `$` uses systemd's `$$` |
| Download URLs it depends on | Node 22.23.4 tarball + checksums, Chrome amd64 `.deb`: all live, checked 2026-10-30 |
| **Run end to end on real hardware** | **never.** The owner's first install on the M720q is that test |

Unverified by anything here, and worth knowing: the extension-id derivation follows Chromium's
documented unpacked-id scheme and is unit-tested against a SHA-256 vector, but its agreement
with a real Chrome is checked only at runtime — by `collect.mjs --check-extension`, which
`doctor.sh` calls. If they ever disagree, `extensionId` in the config overrides it. Several
Chrome-version claims in the script comments (e.g. the release cadence "since Chrome 153") are
the original author's and were not re-verified.

### The second repository: `krausstt/actually-watch-later`

Private, local at `C:\Users\TobiasKrauss\ClaudeCode\actually-watch-later`. Its README now carries
a banner saying it is being folded into Stashling (`0ba0d09`, pushed).

**Do not develop it.** It was diffed against this repo's YouTube connector across all 14 shared
row fields on all 20 fixture rows: **zero differences** — it is the same parser, not a second
one. The agreed direction is to fold its remaining advantages into Stashling and then archive it
(WORKLOG, "YouTube"). Its old plan — "helping you decide what to watch" — is superseded.

Already folded in: the depth-counting chunker and the digit-anchored number parse (`b0639a3`).
Still to fold — see §3, item 3.

Its `eval_assets/` folder holds the real 12.7 MB Watch Later capture, gitignored. It is the only
real page for re-measuring YouTube coverage. Do not delete that folder when archiving the repo.

---

## 2. Verify the state yourself

From the repository root. Everything here installs nothing.

```bash
git fetch origin && git status -sb          # ahead by N? anything staged?
git log --oneline origin/main..main         # the unpushed commits
gh pr list                                  # is PR #2 still open?
npm run check                               # everything below in one go — what CI runs
node --test                                 # expect 197 on main, 207 once PR #2 is merged
node scripts/sync-extension.mjs --check     # vendored copies match packages/
node scripts/check-extension.mjs            # manifest, imports, permissions, facet coverage
node scripts/fixtures.mjs                   # fixture checksums
git ls-files --eol -- 'hosts/*.sh'          # must say i/lf
```

If any number differs from §1, §1 is stale — trust the command, then fix this file.

---

## 3. What to do next, in order

### 1 · PR #2 gets merged — by the owner

Green and mergeable. Do not merge it yourself; ask. Until it lands, see the warning in §1.

### 2 · The first real install on the M720q — with the owner

Nothing in `hosts/edge-linux/` has run on hardware. Walk [`GUIDE.md`](../hosts/edge-linux/GUIDE.md)
with the owner and treat every `doctor.sh` FAIL or WARN as a finding: fix the script or the guide,
not just the box. The things most likely to surface first: the Chrome sandbox under Ubuntu
24.04's AppArmor user-namespace restriction (doctor reports it; **never** answer it with
`--no-sandbox`), and whether `--check-extension` agrees with the id `chrome://extensions` shows.

### 3 · Phase 3: finish folding `actually-watch-later` in, then archive it

Four items remain (WORKLOG has the reasoning for each):

- **Disappearance sweep, gated on scrape completeness.** Nothing in Stashling ever writes
  `membership: 'unlisted'`. AWL has the writer and the rule that matters: an *incomplete*
  scrape marks nothing as gone. Port the rule and its tests, not the code shape — AWL's
  collection model is a flat map that cannot express per-list membership.
- **Coverage in the popup after every scrape.** Stashling's coverage engine is better but
  CLI-only, so the alarm never reaches the person scraping.
- **Fixture rows that make the fallbacks decide.** 16 of 17 fallback selector candidates never
  decide in either repo — the ordered selector table is an untested promise. AWL's row where
  only `badge-shape[aria-label]` carries the duration is the template.
- **Rows-only capture** (strip `<svg>`/`<style>` in-page, ship rows not the 12.7 MB document).
  **Blocked** on open decision 6 below.

Then archive AWL on GitHub — after confirming with the user, and after moving `eval_assets/`
somewhere it survives.

### 4 · Phase 4: the six open contract decisions, as one bump

Listed in WORKLOG, "Open decisions". They interact, so decide them together and ship one
contract version, following the checklist in [`VERSIONS.md`](./VERSIONS.md). They need the
user — they are product decisions, not implementation details.

### 5 · Small, safe, worth doing alongside

Stale claims (all give an old test count): `README.md` line ~30 (`74 tests`), `BLOG.md` line
~259 (`151 tests`), `CONTRIBUTING.md` line ~20 (`151 tests`), `WORKLOG.md` phase-0 row
(`168 tests`). `VERSIONS.md` "last verified" dates are 2026-09-07 — move them only after actually
re-running the suite.

CI maintenance, from the annotations on PR #2's run:
- `actions/checkout@v4` and `actions/setup-node@v4` target Node 20, which GitHub has deprecated
  on runners; move to the current major of each.
- `ubuntu-latest` began migrating to Ubuntu 26 on 2026-10-19. The edge box runs **24.04**, so
  consider pinning `runs-on: ubuntu-24.04` — then the shell scripts are linted on the same
  release they run on.

---

## 4. Decisions that are made — do not reopen without the user

| Decision | Where |
|---|---|
| The name is **Stashling**, not Trove. The local folder is called `Trove`; leave it | ADR-0001 |
| Licence **MPL-2.0** | ADR-0001 |
| Connectors are bundled and statically imported, never fetched | ADR-0002 |
| Derived values are source-tagged rows resolved by precedence | ADR-0003 |
| The rendered DOM is primary; embedded JSON is opt-in | ADR-0004 |
| Host permissions are optional, requested inside a click | ADR-0005 |
| Zero dependencies, no build step | ADR-0006 |
| The core is never a container; an optional hub may be; the edge is the only acquirer | ADR-0007 — accepted 2026-10-30 |

---

## 5. Traps — each of these has already cost time

**Data**

- **Real saved pages never enter any repository, private or not.** They are viewing and
  shopping history, and git history outlives the decision to keep a repo private. `fixtures/`
  is synthetic; coverage against real pages is a local command.
- **A false tombstone is worse than a missed one.** No guessed localisations of
  `[Deleted video]`; no "missing" marks from an incomplete scrape. Inventing a disappearance is
  the exact failure this project exists to prevent.
- **The `user` zone is human-owned.** Never rebuild it from a list of known keys — MakerWorld
  did, and silently deleted user data on every re-scrape until it was caught.

**This machine (Windows 11, PowerShell 5.1)**

- **Git has no global identity here.** It auto-derives the user's *work* email into commits.
  This repo is configured `--local` to `krausstt <37511227+krausstt@users.noreply.github.com>`;
  any new clone or repo needs the same before its first commit.
- **PowerShell 5.1 mangles double quotes inside arguments to native programs.** A multi-line
  `git commit -m` containing `"` gets split into pathspecs. Write the message to a file and use
  `git commit -F <file>`.
- **`Set-Content -Encoding utf8` writes a byte-order mark** on PowerShell 5.1. Used for a
  commit-message file, the BOM becomes an invisible first character of the commit subject. Use
  `[IO.File]::WriteAllText(path, text, (New-Object System.Text.UTF8Encoding($false)))`, or
  write the file with the editor tool.
- **`Get-Content … | Out-String` re-joins lines with `\r\n`**, so it reports CRLF in files that
  are pure LF. Ask git instead: `git ls-files --eol`.
- **`node --test test/` (trailing slash, no glob) tries to `require` a module named `test`.**
  Use `node --test test/*.test.js`. The root `node --test` hides this, which is how it shipped
  once already.
- The Bash tool has intermittently failed with `EPERM` on spawn; PowerShell works.

**The extension**

- **Dynamic `import()` does not work in an MV3 service worker.** It fails at runtime only, in
  the hardest place to observe. `check-extension.mjs` guards it.
- **`permissions.request()` only resolves inside a user gesture** — never from the worker, and
  never from CDP automation.
- **`runtime.sendMessage` never reaches the sender's own frame**, so a worker cannot message
  itself. The edge driver opens an extension page and sends from there for this reason.
- **A background tab under-collects silently.** Virtualised lists render through
  IntersectionObserver, which does not fire in inactive tabs; the scroll stops growing and the
  capture reports success at a fraction of the list. That is what `minRows` is for.

---

## 6. Where everything is

| What | Where |
|---|---|
| This repo | `C:\Users\TobiasKrauss\ClaudeCode\Trove` → `github.com/krausstt/stashling` (public) |
| Resume point and phase table | [`docs/WORKLOG.md`](./WORKLOG.md) |
| The contract | [`docs/ITEM-CONTRACT.md`](./ITEM-CONTRACT.md), [`docs/VERSIONS.md`](./VERSIONS.md) |
| Writing a connector | [`docs/CONNECTOR-GUIDE.md`](./CONNECTOR-GUIDE.md) |
| Fixture rules | [`docs/FIXTURES.md`](./FIXTURES.md) |
| AWL | `C:\Users\TobiasKrauss\ClaudeCode\actually-watch-later` → `krausstt/actually-watch-later` (private, to be archived) |
| Real YouTube capture | `actually-watch-later\eval_assets\` (gitignored, local only) |
| Source tools being unified | `krausstt/makerworld-suite`, `krausstt/grosse-kleinanzeigen`, `krausstt/openbrowsertabs` |

*Written by a coding agent on 2026-10-27, updated 2026-10-30; every number in §1 was measured on
the day it was written, with the commands in §2. Sources: `git log`, `git status`, `git ls-files`,
`node --test`, the three `scripts/` checks, GitHub Actions run 41078970344 (PR #2) and the latest
`main` run, `gh pr view 2`, HEAD requests to nodejs.org and dl.google.com, `docs/WORKLOG.md`,
`docs/decisions/0007-*.md`, and a line-by-line read of everything in `hosts/edge-linux/`.*
