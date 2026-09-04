/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Host permissions, requested at the moment a connector is used and never at install.
 *
 * WHY OPTIONAL RATHER THAN STATIC:
 *
 *  - A static `host_permissions` list covering every bundled connector asks the user, at
 *    install, for access to every site the project has ever supported. That reads as excessive
 *    permissions during Chrome Web Store review, and excessive permissions are themselves read
 *    as evidence of unrelated functionality — which loops straight back into a single-purpose
 *    finding.
 *  - More importantly it is true: an unused connector would hold live access to a site you
 *    never asked it to touch. Requesting per activation turns the connector count from a review
 *    liability into a privacy property you can state plainly.
 *
 * THE FAILURE MODE THIS FILE EXISTS TO PREVENT:
 *
 * A newly declared optional host permission is NOT granted by reloading or updating the
 * extension. It is granted only by a `permissions.request()` call made from inside a user
 * gesture. MakerWorld's scraper hit exactly this: a host permission added in 0.6.0 was silently
 * ungranted after reload, thumbnails failed for a whole release, and the only mitigation was a
 * hard-coded hint string printed after the fact. So: `has()` is checked before every run, the
 * popup shows the state, and the request is wired to a click.
 */

if (!globalThis.browser) globalThis.browser = chrome

/** Match patterns a connector needs. Falls back to an origin pattern from the tab's URL. */
export function hostsFor(connector, url) {
  const declared = connector?.hosts ?? []
  if (declared.length) return [...declared]
  if (!url) return []
  try {
    return [`${new URL(url).origin}/*`]
  } catch {
    return []
  }
}

/** Does the user already grant these? */
export async function has(origins) {
  if (!origins?.length) return true
  try {
    return await browser.permissions.contains({ origins })
  } catch {
    return false
  }
}

/**
 * Ask for them.
 *
 * MUST be called synchronously enough inside a click handler that the gesture is still live —
 * Chrome rejects a request made after an intervening `await` on a slow operation. Callers do
 * their `has()` check first and then call this directly from the handler.
 */
export async function request(origins) {
  if (!origins?.length) return true
  try {
    return await browser.permissions.request({ origins })
  } catch (err) {
    return { error: err?.message ?? String(err) }
  }
}

/** Give a permission back. Offered in the UI because a collector that cannot be revoked is a bug. */
export async function drop(origins) {
  if (!origins?.length) return true
  try {
    return await browser.permissions.remove({ origins })
  } catch {
    return false
  }
}

/**
 * Everything currently granted, for the "what this extension can reach right now" panel.
 * That panel is not decoration: since 2026-08-01 the Chrome Web Store's Limited Use policy
 * requires the data a collector touches to be prominently disclosed in the product UI itself,
 * not only on the listing page.
 */
export async function granted() {
  try {
    const all = await browser.permissions.getAll()
    return all?.origins ?? []
  } catch {
    return []
  }
}
