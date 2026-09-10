/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The two functions that stand between a collection and the page that renders it.
 *
 * They live in their own module for one reason: they are the security boundary, and a security
 * boundary with no tests is a claim rather than a control. `collection.js` cannot be imported by
 * a test — it touches `document` at module scope — so as long as these lived inside it they had
 * no coverage at all, and the first version of `safeHref` shipped with two holes because of it.
 *
 * WHY ANY OF THIS IS NEEDED: items reach the collection page from two places, a connector and an
 * imported interchange file. The second is not trusted input. `mergeBundle` takes records as
 * they come, so a hand-edited or hostile `.jsonl` can put any string in any field, and
 * `liveness.state` is interpolated into a `class="…"` attribute.
 *
 * Manifest V3's default CSP (`script-src 'self'`) blocks the script half of an injection — no
 * `javascript:` URL, no inline handler. It does NOT restrict `img-src`, so an injected
 * `<img src="https://evil/…">` still fires a request. In an extension whose single promise is
 * that nothing leaves your machine, that is the promise broken by opening a file someone shared.
 */

const ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }

/**
 * Escape for both text and quoted-attribute positions.
 *
 * Quotes are included even though a text position does not need them, because one function used
 * everywhere is checkable and two functions used selectively is a rule nobody can verify. The
 * earlier split — an `escapeHtml` without quotes and an `escapeAttr` that escaped only `"` —
 * is exactly the kind of thing that reads as fine and lets one interpolation through.
 */
export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ENTITIES[c])
}

export const escapeAttr = escapeHtml

/**
 * Only an ABSOLUTE http(s) URL is allowed into an `href`. Everything else returns null and the
 * caller renders inert text.
 *
 * NO BASE URL, deliberately — and this is the whole subtlety. Resolving against a placeholder
 * base, which the first version did, is worse than not checking at all in two measured ways:
 *
 *   '//evil.example/beacon'  →  https://evil.example/beacon   protocol-relative, silently
 *                                                             promoted to the attacker's host
 *   ''                       →  https://invalid.invalid/      and `createItem` defaults `url`
 *                                                             to '', so EVERY url-less item
 *                                                             became a live-looking link
 *
 * Without a base, `new URL()` throws on both, which is the answer we want.
 */
export function safeHref(url) {
  const raw = String(url ?? '').trim()
  if (!raw) return null
  try {
    const parsed = new URL(raw)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : null
  } catch {
    return null
  }
}

/**
 * A liveness value from a hostile file is not one of the four states, and it must never be
 * allowed to choose a CSS class. Unknown values collapse to `unknown`; the literal string is
 * still shown to the user as escaped text by the caller.
 */
export const LIVENESS_CLASSES = Object.freeze(['live', 'gone', 'restricted', 'unknown'])

export function safeLivenessClass(state) {
  return LIVENESS_CLASSES.includes(state) ? state : 'unknown'
}
