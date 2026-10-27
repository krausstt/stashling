# Handover — 2026-10-27

For the next coding agent. Read this, then [`WORKLOG.md`](./WORKLOG.md), then start.

This file is a **snapshot**, and snapshots rot. Every claim below that can go stale comes with
the command that re-checks it. Run §2 before you trust §1.

---

## 1. State at the time of writing

### The repository is ahead of GitHub, and has uncommitted work in it

| | |
|---|---|
| Local `main` | `77496e9` |
| `origin/main` on GitHub | `ed47598` — last pushed **2026-09-07** |
| Unpushed commits | **5**: `6ea0b68` `7fd65e7` `b0639a3` `d666754` `77496e9` — all reviewed, all green |
| Staged, **not committed** | `hosts/edge-linux/{bootstrap,doctor,upgrade-chrome}.sh`, `stashling.example.json`, and a CI change that lints them |
| Tests | **197 pass, 0 fail** (`node --test`) — 14 of those are `hosts/edge-linux/test/` |
| Checks | vendor sync OK · extension check OK · fixtures 4 verified, 0 mismatched |

**Do not `git add -A && git commit` on arrival.** The staged scripts are someone's unfinished
work, not a mess to tidy. See §3, item 1.

### What the staged work is

`hosts/edge-linux/` turns an always-on Ubuntu 24.04 mini PC into an edge collector: one Chrome
instance on a shared VNC display, logged in **by hand** once, driven over CDP by a systemd timer.
The driver half (`driver/cdp.mjs`, `driver/collect.mjs`, 14 tests) is committed in `77496e9`. The
provisioning half — the three shell scripts — is staged only.

What is verified about the scripts, and what is not:

| Check | Result |
|---|---|
| `bash -n` on all three | passes |
| Executable bit in the git index | set (`100755`) on all three |
| Line endings in the index | LF on all three (`git ls-files --eol`) |
| `stashling.example.json` | valid JSON |
| `shellcheck` | **never run** — not installed on the dev machine; the staged CI step would be its first run |
| Run on real Ubuntu hardware | **no evidence it ever has been.** Treat as unverified |

They run as root on a machine holding live, logged-in session cookies. That is why they deserve
more scrutiny than their line count suggests, and why the staged CI change adds `shellcheck`.

### The second repository: `krausstt/actually-watch-later`

Private, one commit (`761c284`), local at `C:\Users\TobiasKrauss\ClaudeCode\actually-watch-later`.

**Do not develop it.** It was diffed against this repo's YouTube connector across all 14 shared
row fields on all 20 fixture rows: **zero differences** — it is the same parser, not a second
one. The agreed direction is to fold its remaining advantages into Stashling and then archive it
(WORKLOG, "YouTube"). Its README still says the next increment is "helping you decide what to
watch"; that plan is superseded.

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
npm run check                               # everything below in one go — what CI runs
node --test                                 # expect 197 pass
node scripts/sync-extension.mjs --check     # vendored copies match packages/
node scripts/check-extension.mjs            # manifest, imports, permissions, facet coverage
node scripts/fixtures.mjs                   # fixture checksums
git ls-files --eol -- 'hosts/*.sh'          # must say i/lf
```

If any number differs from §1, §1 is stale — trust the command, then fix this file.

---

## 3. What to do next, in order

### 1 · Resolve the staged edge-linux scripts — ask the user first

They are not yours, and they were left mid-flight. Ask whether they are finished. If yes:
commit them **with** the staged CI change (they belong together — the CI step is how they get
linted, since there is no `shellcheck` on Windows), push to a **branch**, and let CI run
`shellcheck` before anything reaches `main`. If it flags warnings, fix them; do not lower
`--severity`.

### 2 · Push the 5 local commits — ask the user first

They are reviewed and green, but pushing is outward-facing and was not done. Push them before
or with item 1, so `main` on GitHub stops being two months behind.

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

Stale claims (all say an old test count; the real number is 197):
`README.md` line ~30 (`74 tests`), `BLOG.md` line ~259 (`151 tests`), `CONTRIBUTING.md` line ~20
(`151 tests`), `WORKLOG.md` phase-0 row (`168 tests`). `VERSIONS.md` "last verified" dates are
2026-09-07 — move them only after actually re-running the suite.

`hosts/edge-linux/` has **no documentation outside its own file headers.** It needs a README
covering: what the box is for, the one-time manual login over an SSH-tunnelled VNC, that the
extension's host permission must also be granted by hand (CDP cannot fake a user gesture), and
how to set `minRows`. The headers of `bootstrap.sh`, `collect.mjs` and `stashling.example.json`
already contain all of that — collect it, do not invent it.

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
| The core is never a container; an optional hub may be; the edge is the only acquirer | ADR-0007 |

**ADR-0007 is marked `proposed` in its file**, while other notes describe it as decided. The
file is the authority. Getting the user to accept it formally closes phase 2.

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

*Written by a coding agent from the repository state on 2026-10-27; every number in §1 was
measured that day with the commands in §2. Sources: `git log`, `git status`, `git ls-files`,
`node --test`, the three `scripts/` checks, `docs/WORKLOG.md`, `docs/decisions/0007-*.md`, and
the file headers in `hosts/edge-linux/`.*
