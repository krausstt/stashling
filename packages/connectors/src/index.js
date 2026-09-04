/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The connector registry.
 *
 * STATIC IMPORTS ONLY — and this is a hard architectural constraint, not a preference:
 *
 *  1. Dynamic `import()` is not supported in an MV3 background service worker.
 *     (w3c/webextensions#212, still open, last touched 2025-12-05; crbug 1198822.)
 *  2. Fetching connector code at runtime is a Chrome Web Store rejection under the
 *     remote-hosted-code policy, which explicitly bans "building an interpreter to run
 *     complex commands fetched from a remote source, EVEN IF those commands are fetched as
 *     data".
 *
 * So connectors ship in the package and update with it. Because a connector is a pure module
 * with no runtime of its own, bundling them all costs nothing at rest — this is how
 * filter-list and command extensions have always worked.
 *
 * What CAN be updated out-of-band is a selector MANIFEST: declarative data (selectors, field
 * names, match patterns, version stamps) consumed by fixed, shipped traversal logic. Chrome's
 * policy explicitly permits "fetching a remote configuration file ... where all logic for
 * the functionality is contained within the extension package". The line is that the remote
 * file must never carry control flow, action verbs, step sequences, or anything dispatched
 * through a generic opcode switch. See docs/decisions/0002.
 */

import youtube from './youtube.js'
import makerworld from './makerworld.js'

export const connectors = Object.freeze([youtube, makerworld])

const byId = new Map(connectors.map((c) => [c.id, c]))

/** Look up a connector by its id. */
export function getConnector(id) {
  return byId.get(id) ?? null
}

/**
 * Every connector claiming this URL, highest priority first.
 * Returns an array rather than one match so a host can disambiguate or ask the user.
 */
export function connectorsFor(url) {
  if (!url) return []
  return connectors
    .filter((c) => {
      try { return c.match(url) } catch { return false }
    })
    .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))
}

/** The first connector claiming this URL, or null. */
export function connectorFor(url) {
  return connectorsFor(url)[0] ?? null
}

/** Which named list of a connector this URL is, if any. */
export function listFor(connector, url) {
  if (!connector || !url) return null
  return connector.lists.find((l) => {
    try { return l.match(url) } catch { return false }
  }) ?? null
}

/**
 * Every host match pattern across all connectors, for `optional_host_permissions`.
 *
 * Permissions are requested at the moment a user activates a connector, never at install.
 * A static `host_permissions` list covering every connector reads as excessive permissions
 * during review — and, more importantly, means an unused connector holds live access to a
 * site you never asked it to touch.
 */
export function allHosts() {
  return [...new Set(connectors.flatMap((c) => c.hosts ?? []))].sort()
}

export { youtube, makerworld }
export default connectors
