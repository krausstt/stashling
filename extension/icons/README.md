# Icons

**Not generated.** This directory is intentionally empty of binaries, and `manifest.json`
declares no `icons` key yet — an extension without icons loads and runs fine, and a placeholder
committed as "temporary" outlives every intention to replace it.

## What is needed before a store submission

| File | Size | Used for |
|---|---|---|
| `icon16.png` | 16×16 | favicon next to the page action |
| `icon32.png` | 32×32 | Windows, and the extension management page |
| `icon48.png` | 48×48 | the extensions page |
| `icon128.png` | 128×128 | installation and the Chrome Web Store listing |

Then add to `manifest.json`:

```json
"icons": { "16": "icons/icon16.png", "32": "icons/icon32.png",
           "48": "icons/icon48.png", "128": "icons/icon128.png" }
```

Keep an `icon.svg` source alongside them and generate the PNGs from it, so a redraw is one
command rather than four exports. Both of the extensions this project was distilled from ship a
`generate_icons.py` next to their icons for exactly that reason.

Design note: the icon has to read at 16px, which means one shape and no text. Whatever it is, it
should survive being rendered in monochrome — Firefox and Safari both grey it out in some states.
