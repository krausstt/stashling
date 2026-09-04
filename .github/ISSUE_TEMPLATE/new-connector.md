---
name: Propose a new connector
about: A source whose lists you want to keep
title: '[connector] '
labels: new-connector
---

## The source

- **Site:**
- **Proposed connector id:** (lowercase, dashes — it becomes the Item id namespace)
- **Kind:** (video | model | listing | link | …)

## Which lists does it have?

The user's *own* collections — not the site's public catalogue. Watchlist, likes, saved, wishlist,
collection, downloads.

| List | URL pattern | Roughly how many items |
|---|---|---|
|  |  |  |

## Is there a stable per-item id in the markup?

**This is the gating question.** Dedup is on a stable source id, never on title and never on
position. If the only thing distinguishing two rows is their title, the connector cannot work
correctly and the answer is probably no.

- Where does it appear? (`data-*` attribute, an href path segment, embedded JSON)
- Is it stable across page loads and across sessions?

## Which acquisition strategy?

See [docs/ACQUISITION-STRATEGIES.md](../../docs/ACQUISITION-STRATEGIES.md).

- [ ] `dom-active-tab` — read the rendered page in a logged-in tab
- [ ] `passive-capture` — observe pages as the user browses
- [ ] `detail-fetch` — a throttled per-item fetch is needed for the useful fields
- [ ] `file-import` — a saved page only
- [ ] `api` — the site has an official API

**Is the list virtualized** (does it load more as you scroll)? If yes, it needs `autoScroll`, and
the connector must be honest about capture completeness.

## Liveness

How does the site say an item is gone? Some sources make this free — YouTube replaces a removed
row's title in place. Some make it expensive — deleted Kleinanzeigen listings return HTTP 200 and
redirect, so a status-code check reports every deleted item as alive.

If there is no signal at all, say so. `unknown` is an honest state and it is better than a
fabricated `live`.

## Terms of service

**Please answer this before writing code.**

- Do the site's terms permit a user reading their own logged-in pages in their own browser?
- Is there bot protection that makes this only viable in-browser?

The in-browser constraint documented in this repository is a technical finding, not legal advice,
and this decision is made deliberately per connector rather than assumed by the architecture.

## Anything unusual

Two markup generations in parallel? Localised strings? Numbers formatted per locale? Values only
present on a detail page? Say so now — these are what actually cost time.
