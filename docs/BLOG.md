# Three scrapers, built separately, agreed on six things

I have written the same program three times without noticing.

The first was a scraper for MakerWorld — a Chrome extension that turns my Likes page into a JSON
catalogue, plus a web app to browse it and an Android app to swipe through it on the sofa. The
second was a companion for Kleinanzeigen, Germany's Craigslist, which keeps a permanent local
record of my watchlist including the price history of listings the site has already deleted. The
third is a mobile link collector: share a URL into it, and it categorises, relates and clusters
what you have saved.

Different domains. Different languages — JavaScript, Kotlin, Python. Different years. No shared
code, no shared design document, and at no point did I sit down and plan an architecture across
them.

They independently converged on the same six mechanisms.

That convergence is the interesting part, and it is a much stronger argument than anything I
could construct on purpose. Three implementations solving the same problem the same way, without
coordinating, means the mechanism is **forced by the problem** rather than chosen by taste. So
this is what I did: I read all three codebases properly, wrote down what they agreed on, then
stress-tested the result against a fourth domain that broke one of its assumptions.

The result is [Stashling](https://github.com/krausstt/stashling), which is MPL-2.0 and about
which I will make no claims beyond what its tests actually cover.

---

## The premise

The thing all three tools are really about: **what you find, like and collect should be yours.**
Portable off the platform. Survivable if your account is blocked or the service shuts down.
Pipeable into your own stack.

That is not an abstract worry. Omnivore — a well-funded, well-liked read-later app — shut its
cloud service down in November 2024 after an acquihire, and deleted user data. What survived was
the export people had taken and the self-hostable code. Nothing else.

## The six things they agreed on

| Mechanism | MakerWorld | Kleinanzeigen | link collector |
|---|---|---|---|
| A pure, dependency-free core | `parser.js`, runs in Node and the browser, 50 assertions | `src/lib/*`, shared by content script and extension pages | `:core`, pure JVM Kotlin, 86 tests |
| **Dedup on a stable source id, never on title** | `modelId` | ad id from `data-adid`, URL regex fallback | `canonical_url UNIQUE` |
| Provenance timestamps and sighting counts | `scrapedAt` | `firstSeen`/`lastSeen`/`lastChecked` | `first_seen_at`, `n_sightings` |
| User annotation held apart from fetched data | `userMeta`, an open map | *absent* | separate columns enrichment cannot touch |
| Lossless raw preservation | whole records kept; `model_raw` | *absent* | body held off the shared projection |
| Tombstones and liveness verification | *absent* | `status`, `endedAt`, redirect check | `enrichment_state`; archived rows revive |

Three of six are unanimous. The strongest signal in the whole corpus is the first one: every
single tool ended up with a pure core that has no I/O, no DOM and no platform APIs, and every
one of them arrived there for the same reason — you cannot test a scraper you cannot run without
a browser, and a scraper you cannot test rots silently.

Re-encounter as *signal rather than error* is the one I like most. All three count sightings.
None of them treats "I have seen this before" as a duplicate to discard; they treat it as
information about what keeps coming back.

## The gaps are the actual argument

Here is the part I did not expect, and it is more useful than the agreement.

**MakerWorld has no liveness checking at all.** This is the tool whose entire stated purpose is
"if Bambu goes down or blocks my account I lose everything". And the reason is worse than "not
implemented yet": once a model is in the catalogue it is *never re-fetched*. The scan merges its
list membership and moves on. So nothing in that codebase can ever observe a model disappearing,
by construction. Its counts and print profiles freeze at first capture, permanently.

**Kleinanzeigen has no per-item notes and no import path.** The only user-editable data in the
entire extension is a per-group reference price. There is no way to annotate an item, tag one, or
correct anything the machine decided.

**Nothing could read its own exports.** All three export. None re-ingests. The one importer that
does exist is *destructive* — it clears the store before ingesting, so importing a filtered
export permanently deletes every record and annotation not in that file, with no confirmation and
no undo.

Each tool is missing something another already solved. That is the case for unifying them, and it
is not an aesthetic one: it is that each domain gets to inherit the others' hard-won mechanisms
for free.

---

## Four stories that changed the design

### The whitelist that ate the user's data

MakerWorld's `makeUserMeta()` returned a fixed object of five known keys. Then the catalogue app
started writing four more — `userTags`, `related`, `parts`, `links` — and every re-scrape
silently deleted them. Not with an error. The scraper rebuilt the object from its whitelist,
wrote it back, and the user's annotations were gone.

It was caught and fixed in version 0.6.2, which now collects every unknown key into `extras` and
spreads them through untouched. The Android app's contract file cites the incident by name:

> never rebuild it from a fixed whitelist, or you'll silently delete the user's data on
> round-trip.

Discipline caught it once. I did not want to rely on discipline catching it every time, so in
Stashling the user zone is one of four **zones**, and the zone decides who may write a field:

- **identity** — core owns it, recomputed deterministically
- **facets** and **ext** — the connector owns them, replaced on every re-acquire
- **user** — the human owns it, an open map, and a connector never writes it at all
- **raw** — lossless; you never reconstruct a record from parsed columns

There is no whitelist to get wrong, because a connector's `normalize()` does not return a `user`
key. It has nothing to clobber with.

### The stress test that broke my own design

I had a design document. Before writing code I ran it against a fourth domain I had never
scraped: my own YouTube Watch Later page, saved to disk. 12,725,371 bytes, 582 rows.

Most of it held up, and three predictions were confirmed nicely. **Derived fields are real**: no
thumbnail URL exists anywhere in that page — they are lazy-loaded — but
`i.ytimg.com/vi/{id}/mqdefault.jpg` returns 200 at about 14 KB, so a connector can construct one
from the id. **Scope-then-extract is mandatory**: the page contains 639 unique `watch?v=` ids and
only 582 real rows, the surplus leaking in from sidebars and recommendations. **Liveness comes
free**: YouTube replaces a removed entry in place with the literal title `[Private video]`, so
detecting it needs no network request at all.

Then the part that broke.

I expected `ytInitialData` — YouTube's embedded JSON blob — to hold the playlist, mirroring
MakerWorld's `__NEXT_DATA__`, which works so well that the JSON-API fallback it was designed to
need was never written. So I measured it.

Zero `playlistVideoRenderer` nodes. Zero `playlistVideoListRenderer`. The blob is 1.8 MB, parses
perfectly, and contains 39 `videoId` values with **zero overlap** with the 582 rows actually on
the page. It is homepage-feed and notification payload from an entirely different route, left
behind because YouTube is a single-page app and I had navigated within it.

A connector that trusted it would have confidently returned 39 wrong items and reported success.

So the design inverted: **the rendered DOM is the source of truth, and embedded JSON is an
optimisation a connector may opt into.** MakerWorld's HTML-JSON path is the lucky case, not the
general one.

The stress test also forced a genuine addition. YouTube's list is virtualized — those 582 rows
were 582 because that is how far I had scrolled, not because the playlist is 582 long. So
`autoScroll` had to become a real capability, with a settle-detector and a deadline. Both of the
other domains quietly needed it too; it only became visible when a third made it unavoidable.

And it turned up three selectors that look completely correct and return nothing:

- **Every href in a saved page is absolute.** `href="https://www.youtube.com/@handle"`, never
  `href="/@handle"`. My design document specified matching on a leading `/@`. That matches 0 of
  582 rows.
- **The ids sit on custom elements.** `#index` and `#video-info` are both `<yt-formatted-string>`,
  so `span#index` and `div#video-info` each match zero times *page-wide* while reading as
  entirely reasonable CSS.
- **`#attributed-channel-name`** is present in all 582 rows, is the most plausible-looking
  channel anchor on the page, carries `hidden=""`, and is empty in every single one.

None of those produce an error. They produce *nothing*, which is much worse.

### The three ports that drifted

The link collector has three implementations of its own URL canonicaliser: Kotlin (which ships),
Python (the reference), and JavaScript (for a web demo). Its own source describes the third as
having "parity by convention only".

It has drifted in at least seven ways. My favourite: Python's `quote_plus` and Java's
`URLEncoder` encode a space as `+`, and `encodeURIComponent` encodes it as `%20`. So the same
input canonicalises differently depending on which port you ask — which silently splits the dedup
key, the one value the entire design rests on.

The fix is not fewer ports. It is making drift *detectable*: one corpus of expected outputs, run
against every implementation. Stashling has a single canonicaliser, and it implements `quotePlus`
explicitly rather than reaching for the convenient built-in, with a test asserting it differs
from `encodeURIComponent`.

### The best idea in the corpus was dead code

While reading the link collector I found the thing I now consider the strongest idea across all
three tools, and it has never run.

Instead of enrichment *overwriting* a field, every derived attribute is a row carrying **who
asserted it**, and readers resolve by precedence:

```sql
attrs( itemId, key, valueText, valueNum, valueTime, source, confidence, observedAt )
       UNIQUE( itemId, key, source )
```

```js
SOURCE_PRECEDENCE = ["user", "connector", "import", "cloud", "local-model", "rules"]
```

Three properties fall out for free. Enrichment cannot destroy curation, because a cloud batch
writes `source:"cloud"` rows and a user edit writes `source:"user"`, and both persist. Re-running
anything is idempotent, because the `UNIQUE` constraint makes a re-run an upsert of that source's
own opinion. And **disagreement becomes inspectable** — you can show "the rules say *article*,
the model says *paper*, you said *reference*", which is the honest interface and is impossible
once you have overwritten.

The schema exists. The precedence list exists. The resolver exists. And `putAttr`, `attrs()`,
`putEdge` and `learnTerm` have **zero callers**; the `edges` table is never written; the backfill
that would populate the entity table runs only inside a migration, so on a fresh install it
executes against an empty table and no row is ever created again.

I want to be precise about this, because it is the difference between a report and a
advertisement: Stashling implements and tests source precedence for the first time. It is a
strong hypothesis with unit tests, not battle-tested code being ported.

---

## What that adds up to

Five layers, each depending only on those below it:

```
  Surfaces     extension popup · collection page · CLI
  Plugins      domain-blind: search, rank, relate, liveness, history, triage, export
  Store        items · attrs · raws · meta
  Core         PURE  the Item contract, canonicalize, merge, precedence, interchange
  Connectors   PURE  match · parseList · parseDetail · normalize · liveness · facets
```

The trick that keeps connectors pure is that **acquisition strategies are injected by the host,
never imported by a connector**. A connector declares *"I need the rendered DOM of the active
tab, scoped to `ytd-playlist-video-renderer`, with auto-scroll"* — as data. It never calls
`chrome.scripting`. The extension provides that capability; a Node CLI provides it by reading a
saved file; the test harness provides it from a fixture. One connector, three hosts, no
branching, and it can be tested against a saved page with no browser at all.

The payoff is a flat `metrics` map — `string → number` — which is the only thing the faceting
layer reads. Which means this test passes:

```js
// A 3D model and a video share no fields, no vocabulary and no source.
assert.equal(matchesFilter(model, printTime, { max: 4 }), true)   // "print time under 4 hours"
assert.equal(matchesFilter(video, length,    { max: 30 }), true)  // "under 30 minutes"
```

Same function, same argument shape, two domains that have nothing in common. That single test is
the migration proof, and it is the reason the contract is shaped the way it is.

### One thing MV3 settles for you

I wanted a connector registry that loads the right module for the current site, so a broken
selector could be repaired without a store review. You cannot have it, for two independent
reasons. Dynamic `import()` is still unsupported in an MV3 background service worker
(w3c/webextensions#212, still open). And remotely hosted code is banned outright — the policy
specifically prohibits *"building an interpreter to run complex commands fetched from a remote
source, even if those commands are fetched as data."*

So connectors are bundled and statically imported, and updates ship as extension updates. One
door stays open: Chrome explicitly permits fetching a remote *configuration* file when all logic
is in the package, and a JSON list of selectors consumed by fixed `querySelector` code is data.
That is not built yet, but the line is drawn in the decision record so it is already decided when
the first connector breaks in the wild.

---

## What is actually built

Honest inventory. `node --test` runs **151 tests** with **zero dependencies installed**, because
there are none — no runtime dependencies, no dev dependencies, no build step.

**Working:** the Item contract and its schema; URL canonicalisation with an explicit
`quotePlus`; zone-scoped merge; source precedence; the interchange format **in both directions**;
generic faceting; a YouTube connector measured at 100% coverage on id, title, duration, position
and view count against the real 582-row page, and 99.48% / 96.74% on the two byline fields that
are genuinely optional; a MakerWorld connector ported from the existing 50-assertion parser; an
MV3 extension shell with `dom-active-tab` + `autoScroll` and `file-import`; and a CLI that
parses, verifies, imports and exports.

**Not built:** most of the plugin layer. Search, ranking, relate, clustering, metric history and
triage all exist as working code in the three source tools and none of them has been ported yet.
The liveness *engine* is not built either — the contract models it, YouTube detects tombstones
from the scrape, and MakerWorld honestly reports `unknown` because its listing pages contain no
liveness signal whatsoever.

**Untested against reality:** the `[Private video]` path. The real 582-row capture contains
exactly zero private or deleted rows — all five spellings occur zero times — so that code path is
covered only by a synthetic fixture. The connector's comment says so rather than implying
evidence that does not exist.

One rule I would encourage anyone building this kind of thing to steal: **committed fixtures are
synthetic.** A real saved page is your viewing, shopping or reading history, and it has no
business in a public repository at any size. The committed YouTube fixture is 34 KB of
hand-authored markup that reproduces the measured *shapes* — including the href-less bylines, the
hidden empty channel element, and the fact that the page's own row ordinals skip 400 and 415 and
repeat 500 twice, because a virtualized list re-renders and its numbering drifts. The 12.7 MB
original never leaves my machine.

If you want to write a connector, it is one file of pure functions over strings, and you can test
it against a fixture with no browser: [the connector
guide](https://github.com/krausstt/stashling/blob/main/docs/CONNECTOR-GUIDE.md).

---

*Generated by AI (Claude Opus 5). Sources read directly for this work: the `makerworld-suite`,
`kleinanzeigen-companion` and `openbrowsertabs` repositories, the last on branch
`claude/browser-tabs-data-science-fqre87`, which is 28 commits ahead of `main` and is the
current system; and a saved "Watch later — YouTube" page of 12,725,371 bytes, measured with
throwaway scripts written for the analysis and reproduced by the connector's own test suite. MV3
remote-code policy, `optional_host_permissions` behaviour and the 2026 Chrome Web Store policy
updates verified against
[Chrome for Developers](https://developer.chrome.com/docs/extensions/develop/migrate/remote-hosted-code)
and the [Chrome Web Store MV3
requirements](https://developer.chrome.com/docs/webstore/program-policies/mv3-requirements) on
2026-09-03.*

*Not independently verified: assertion counts quoted from the source tools' own logs where the
referenced harnesses are absent from those trees, and third-party platform claims recorded inside
openbrowsertabs' German design documents, which are reported as those documents state them. The
YouTube coverage figures are my own measurements against that saved page and are reproducible
from it.*
