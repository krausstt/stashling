---
name: A connector stopped working
about: A site redesigned and extraction is silently returning less than it used to
title: '[connector] '
labels: connector-rot
---

## ⚠️ Please do not attach your saved page

A real saved page is your viewing, shopping or reading history. It cannot be accepted into this
repository at any size, and maintainers should not ask for one. Send a **synthetic** minimal
reproduction instead — see [docs/FIXTURES.md](../../docs/FIXTURES.md).

## Which connector

- **Connector id:**
- **List / page type:** (e.g. watch-later, likes, collection)
- **Connector version:** (`stashling connectors`)

## What the coverage says

The useful signal is the percentage, not "it broke". Run:

```bash
node packages/cli/bin/stashling.js parse <your saved page> --connector <id> --url <page url>
```

Paste the coverage table:

```
field                present  coverage
-------------------  -------  --------
```

**Which fields moved, and by how much?**

| Field | Was | Now |
|---|---|---|
|  |  |  |

A field that went from 100% to 0% is a selector that now matches nothing. A field that went from
100% to 96% is usually a new edge case in a few rows — and those are different bugs.

## What changed in the markup

If you can see it: which anchor stopped working, and what replaced it.

Anchors that have survived redesigns in the field: `data-*` attributes, element names, per-item
JSON-LD, `svg[data-title]`. Anchors that have not: Tailwind and CSS-module class names.

```html
<!-- the new markup for one row, values replaced with invented ones -->
```

## A synthetic fixture (the most useful thing you can include)

Hand-authored markup reproducing the new shape, with invented ids, titles and names. If you can
open a PR adding it to `fixtures/<connector>/` as a `*.fixture.html` row with a comment saying
what it encodes, that is the whole fix except for the selector.

## Environment

- OS / browser:
- Node version (`node --version`):
- Did `node --test` pass before your change?
