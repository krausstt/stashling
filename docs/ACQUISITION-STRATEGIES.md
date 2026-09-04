# Acquisition strategies

A connector **declares** which strategy it needs. The host **implements** it. A connector never
calls `chrome.scripting`, never opens a socket, and never reads a file.

That split is what lets one connector run in three places with no branching:

| Host | Provides | How a page arrives |
|---|---|---|
| The extension | `dom-active-tab`, `file-import` | the rendered DOM of your logged-in tab |
| The Node CLI | `file-import` | a page you saved to disk |
| The test harness | `file-import` | a fixture |

A connector says *"I need the rendered DOM of the active tab, scoped to
`ytd-playlist-video-renderer`, with auto-scroll"* — as data, in its `acquisition` block. If a
connector ever needs to know which host it is running in, the layering is wrong.

---

## The six strategies

| Strategy | What it does | Proven by |
|---|---|---|
| `dom-active-tab` | Read the rendered DOM of the logged-in tab, optionally auto-scrolling until the row count stabilises. Scope to per-item chunks before extracting. | MakerWorld listings · Kleinanzeigen · YouTube |
| `passive-capture` | A content script observes pages as the user browses and upserts what it sees. No crawling at all. | Kleinanzeigen |
| `detail-fetch` | Throttled per-item fetch inside the user's own session: jitter, backoff, a per-run budget, round-robin resumption ordered by least-recently-checked. | MakerWorld detail · Kleinanzeigen verification |
| `share-target` | OS share sheet, pasted text, a shared file. Items arrive one at a time **with human intent attached**, which is the one thing scraping can never reconstruct later. | openbrowsertabs |
| `file-import` | A saved page, or a previous export. Also the test harness's strategy — which is why fixtures work at all. | all three |
| `api` | An official API where one exists. Server-side is acceptable here; for the others it is not. | eBay (planned in Kleinanzeigen's backend concept) |

**Implemented in v1:** `dom-active-tab` and `file-import`. The rest are declared in the contract
(`ACQUISITION_STRATEGIES` in `packages/core/src/connector.js`) and validated, so a connector can
name one before a host implements it — but `validateConnector` will accept it and the extension
will not run it.

---

## `dom-active-tab`, and `autoScroll`

Two things make this more than "read `outerHTML`".

### Scope, then extract

Splitting the document into per-item chunks **before** extracting anything is mandatory.
Measured on a real Watch Later page: 639 unique `watch?v=` ids page-wide, 582 real rows. The
surplus leaks in from sidebars, recommendations and description anchors, and nothing
distinguishes them after the fact.

`validateConnector` refuses a `dom-active-tab` connector that declares no `scope`.

### `autoScroll`

A virtualized list only materialises rows near the viewport. The 582 rows in that capture were
582 because that is how far the page had been scrolled — **not** because the playlist is 582
long. Neither shipped scraper handles this: one instructs the user to scroll manually, and the
other's notes say infinite scroll is simply not handled.

```js
autoScroll: { until: 'stable', maxMs: 120000, settleMs: 1500, stableRounds: 3 }
```

The host scrolls, counts the scoped element, and stops when the count has not grown for
`stableRounds` polls — or when `maxMs` runs out, which is a deadline rather than a failure.

**It reports rather than promises.** The result carries `rowsSeen`, `settled` and
`stoppedBecause`, and the UI shows them. autoScroll is a mitigation, not a guarantee, and
silently under-collecting is the worst failure available to a tool whose promise is that you keep
everything.

One measured caveat: that page carries **no claimed total** anywhere in its DOM — the only
"N videos" strings in 12.7 MB are i18n plural templates, never a rendered count. So a host cannot
compare seen-against-claimed from the markup. It can only report that growth stalled and let the
user judge. Where a source *does* state a total, compare and surface the discrepancy.

---

## The three-way outcome

Acquisition returns one of three things, and **only the third re-enters the queue**:

| Outcome | Meaning | Queue behaviour |
|---|---|---|
| `success` | a usable payload | done |
| `terminal` | reached the source, no usable payload — 404, paywall, wrong content-type | record evidence and the status code; do not retry until re-sighted |
| `retryable` | offline, timeout, 5xx, 429 | retry with backoff |

Collapsing `terminal` and `retryable` into one failure mode is the classic bug that makes a queue
either drop paywalled pages forever or retry them until heat death.

And a terminal state must be **re-armable**. openbrowsertabs' `unfetchable` is terminal with no
retry path anywhere in the codebase — nothing ever sets a row back to pending — so a single
transient failure removes an item from enrichment permanently and permanently inflates the inbox
count. Here, `liveness` carries `attempts` and `retryAfter`, and re-sighting an item re-arms it.

---

## Why acquisition mostly cannot move to a server

Kleinanzeigen's backend notes record the sharpest version of this: that platform's terms forbid
automated access, and its bot protection fingerprints browser and TLS characteristics while
throttling datacenter IPs. So **requests must stay inside the user's real browser**, with a
server permitted only to orchestrate and persist. Their own conclusion draws the line correctly:
eBay, which offers an API, may run server-side; Kleinanzeigen may not.

The same shape appears on YouTube: openbrowsertabs' notes record an attempt to reach Watch Later
programmatically that was refused with `disallowed_useragent`, and note that Google Takeout no
longer exports playlists. *(That finding is theirs and is dated — re-verify before relying on
it.)* Either way it points the same direction: in-browser DOM, or nothing.

> **This is a technical finding about bot protection, not legal advice.** Per-platform terms
> differ and they change. Whether a given connector should exist at all is a decision to make
> deliberately, per source, **before** shipping it — not a question the architecture answers for
> you. Kleinanzeigen's own notes state its terms forbid automated access; YouTube's terms are
> their own question.

Two related constraints worth stating plainly, because they shape what is even worth building:

- **Throttling is not politeness theatre.** A fixed interval is the single most legible bot
  signature there is, and this runs inside the user's own logged-in session. Every strategy that
  makes repeated requests declares a jittered range (`throttleMs: [400, 1200]`).
- **Budgets and round-robin.** A verification pass should check the least-recently-checked items
  first, cap the number of requests per run, and resume where it left off. Kleinanzeigen does
  exactly this — and its one gap is instructive: a failed fetch never writes `lastChecked`, so a
  permanently-broken URL stays at the head of the queue and consumes budget on every future run,
  forever. Record the attempt, not just the success.
