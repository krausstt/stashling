# The fixture corpus

Selectors rot. A source redesigns overnight, a selector starts returning nothing, and **nothing
raises an error** — because returning nothing is not an error. The fixture corpus plus coverage
percentages is the only thing that reports it.

This is the one piece of process the architecture actually requires.

---

## The rules

### 1. Committed fixtures are SYNTHETIC

**A real saved page is somebody's personal viewing, shopping or reading history. It must never
enter a public repository, at any size.**

A committed fixture is hand-authored markup that reproduces the *structural shapes* measured on a
real page, with invented ids, titles and names. `fixtures/youtube/watch-later.fixture.html` is
34 KB and contains twelve rows; the real page it was derived from is 12.7 MB, contains 582, and
lives only on the machine it was saved on.

`.gitignore` enforces the split: `fixtures/**/*.html` is ignored, `*.fixture.html` is
un-ignored. `scripts/fixtures.mjs` warns if a committed fixture is not named that way — a
fixture invisible to git verifies on the author's machine and is reported missing everywhere
else, forever, with no visible cause. It also warns above 512 KB, because that is the size range
where "a real page slipped past .gitignore" becomes the likeliest explanation.

### 2. Real pages are local-only, and their absence is fine

Real pages live under `fixtures/<source>/_local/`, which is gitignored. They are declared in the
`MANIFEST.json` with `"role": "local-only"` so the corpus documents what a full check needs, and
`scripts/fixtures.mjs` reports them as **skipped**, never as a failure. CI has none of them and
must stay green.

Their purpose is a private coverage check:

```bash
node packages/cli/bin/stashling.js parse "fixtures/youtube/_local/watch-later.html" \
  --url "https://www.youtube.com/playlist?list=WL" --now 1756900000000
```

Report the numbers; commit nothing.

### 3. Every fixture is checksummed

```bash
node scripts/fixtures.mjs            # verify
node scripts/fixtures.mjs --update   # record sha256 + byte size for new entries
```

`MANIFEST.json` records, per file: `path`, `role`, `bytes`, `sha256`, `describes` (what
structural shape it reproduces, and why that shape is in the corpus) and `regenerate` (how to
obtain or rebuild it). A checksum **mismatch** fails; an absent local-only file does not.

### 4. Coverage is asserted as PERCENTAGES, not spot checks

A spot check on row 1 tells you nothing until row 1 happens to be the broken one. The percentage
is the alarm:

```js
assert.equal(coverage((r) => Boolean(r.title)), 100)
```

A drop from 100% to 96% on `title` is how you learn a platform redesigned overnight.

`stashling verify` prints the whole table, and `stashling fixture --golden` diffs it against a
stored baseline and reports the delta in **percentage points**.

### 5. Some fields are legitimately below 100%, and the fixture says so

On the real Watch Later page, `byline.name` is 99.48% and `byline.url` is 96.74%. Those 3 and 19
rows are auto-generated and multi-owner bylines whose anchor carries no `href` — **not** deleted
videos. Modelling them as failures would have invented 19 false tombstones on the first real
scrape.

So the fixture reproduces both shapes explicitly, and the test asserts the exact degradation
*and* that neither is treated as a liveness signal. A fixture that only contains the happy path
tests nothing you were worried about.

### 6. Every extraction bug found in real data becomes a fixture

This is the rule that makes the corpus grow in the right direction. Real examples from the tools
this design came from, each of which only appeared against real pages:

- A context window mis-assigned the `32GB` in `"32GB, 2TB SSD"` to storage, because `ssd` fell
  inside its window.
- `includes('neu')` matched **"Neupreis"** and marked used items as new. Fixed with `\bneu\b` in
  an ordered first-match-wins list.
- Every YouTube URL was tagged `health`, because a topic rule contained a bare `watch` and every
  YouTube URL contains `/watch?v=`.
- A page-wide id scan picked up 639 ids where 582 rows existed.
- An avatar `<img>` rendered before the cover image poisoned every title with a creator name.

Each of those is now a row in a synthetic fixture with a comment saying what it is for.

---

## Layout

```
fixtures/
  youtube/
    MANIFEST.json
    README.md                     the measurements this corpus encodes
    watch-later.fixture.html      SYNTHETIC, committed
    _local/watch-later.html       real, gitignored, never committed
  makerworld/
    MANIFEST.json
    listing.fixture.html          SYNTHETIC
    detail.fixture.html           SYNTHETIC — known-path payload
    detail-moved.fixture.html     SYNTHETIC — the deep-walk / re-template case
    _local/*.html                 real, gitignored
```

## Adding a fixture

1. Write the markup by hand, reproducing the shape and nothing else. Invent every value.
2. Comment each row with the shape it encodes and, where known, the measured frequency.
3. Add it to `MANIFEST.json` with `bytes` and `sha256` as `null`.
4. `node scripts/fixtures.mjs --update` to record the checksums.
5. Assert against it in the connector's test with a **percentage**, not a spot value.

## Reporting a broken connector

If a site redesigns and a connector stops working, the useful bug report is:

- the connector id and the coverage table from `stashling verify`,
- which fields moved and by how much,
- **a synthetic minimal fixture** reproducing the new markup.

Please do not attach your real saved page. It is your history, and the maintainers cannot accept
it into the repository anyway.
