# MakerWorld fixtures

All three committed fixtures are **synthetic**. The real saved pages — a Likes page of 6,695,802
bytes, a Collection of 1,573,799, a Downloads of 1,822,471 and a model detail page of ~1.5 MB —
stay local, because they are somebody's library.

## What was measured

| Page | Bytes | Cards | List token |
|---|---|---|---|
| Likes | 6,695,802 | **733** (all unique) | `likes` |
| Collection | 1,573,799 | **79** | `collection:10129261` |
| Downloads | 1,822,471 | **115** | `downloads` |
| Detail | ~1.5 MB | 1 design | resolved via `props.pageProps.design` |

A detail page's design payload is ~53 KB inside ~1.5 MB of HTML, which is why `raw` stores the
design object rather than the page: keeping the wrapper buys nothing and costs 30× the bytes.

## What the fixtures encode

### `listing.fixture.html`

Eight `js-design-card` chunks yielding six cards:

- ordinary `likes` cards, and a `downloads` card — the list token comes from `data-trackid`, not
  from the page URL
- a **numeric** from-token, which must normalise to `collection:10129261`
- a duplicate of an earlier model further down the grid: first occurrence wins, so the pinned
  position survives and the card is not emitted twice
- a skeleton with no `data-trackid`, which is skipped rather than half-parsed
- **the title time bomb**: an avatar `<img>` rendered *before* the cover and carrying real alt
  text. The shipped parser took the first `<img alt>` in the chunk with no anchoring, so this
  card would be titled with a creator's name — silently, since a wrong title raises nothing. The
  selector ladder titles it from the model anchor instead.
- a card whose only title source is the cover alt

Obfuscated `mw-css-*` class names are reproduced deliberately so a test can prove nothing depends
on them.

### `detail.fixture.html` — the known path

Resolves through `props.pageProps.design`. Encodes:

- **`prediction` is SECONDS.** 49,536 → 13.76 h. Read as minutes it yields a plausible 826-hour
  print that nothing downstream can detect. The unit lives in the key name (`printTimeHours`).
- one **rated** profile (`ratingCount` 2) and one **unrated** (`ratingCount` 0), so `rating` must
  be `null` rather than 0 — "nobody rated it" is not "everybody hated it"
- differing `needAms`, so `printableWithoutAms` is true via the draft profile
- A1 mini compatibility declared **both** ways: `compatibility.devProductName` and
  `otherCompatibility[]`
- `categories` mixing an object and a plain string, as some templates do
- **`productProperyList`** — MakerWorld's own misspelling of "Property", and load-bearing.
  Correcting it reads as an obvious tidy-up and silently returns zero colours for every model.
- a for-you card summary carrying `id`, `title` and `likeCount` but **no `instances` array**,
  which the discriminator must refuse

### `detail-moved.fixture.html` — the re-template case

`props.pageProps.design` is absent; the design has moved into a query cache. The discriminated
deep walk must still find it, and `parseDetail().via` must report `deep-walk` — the earliest
possible warning that the site re-templated, at the cost of one comparison.

It carries two decoys the walk must refuse: one with no `instances`, and one where `instances` is
an **object** rather than an array. `Array.isArray(instances)` is the discriminator, and it is
load-bearing rather than defensive — without it, a summary card becomes a record with every
counter populated and no print profiles at all. Plausible, and wrong.

## The liveness gap

MakerWorld listing pages carry **no liveness signal whatsoever**, so the connector reports
`unknown` rather than `live`. The original suite is worse than unimplemented here: once a model
is catalogued it is never re-fetched, so nothing in it can ever observe a model disappearing —
in the tool whose entire premise is surviving platform loss.

That gap is the single best argument in this repository for unifying these tools.

## Checking against your own pages

```bash
# save your own pages into fixtures/makerworld/_local/ (gitignored), then:
node packages/cli/bin/stashling.js parse "fixtures/makerworld/_local/likes.html" \
  --connector makerworld --url "https://makerworld.com/en/@you/likes" --now 1756900000000
```
