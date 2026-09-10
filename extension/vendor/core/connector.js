/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The connector interface: everything a new source needs, and nothing a runtime needs.
 *
 * A connector is a DESCRIPTION of a source plus pure functions over strings. It declares
 * which acquisition strategies it requires; it never implements one. It says
 *
 *     "I need the rendered DOM of the active tab, scoped to ytd-playlist-video-renderer,
 *      with auto-scroll"
 *
 * and does not call `chrome.scripting`. The extension provides that capability; the CLI
 * provides it by reading a saved HTML file; the test harness provides it from a fixture.
 * One connector, three hosts, no branching — which is also why a connector can be tested
 * against a saved page with no browser at all.
 *
 * Absent by design: storage, scheduling, retry policy, permission handling. Host concerns.
 */

/** The host implements these once. Connectors only name the ones they need. */
export const ACQUISITION_STRATEGIES = Object.freeze({
  /** Read the rendered DOM of the logged-in tab, optionally auto-scrolling until stable. */
  DOM_ACTIVE_TAB: 'dom-active-tab',
  /** A content script observes pages as the user browses and upserts what it sees. */
  PASSIVE_CAPTURE: 'passive-capture',
  /** Throttled per-item fetch inside the user's session, budgeted and resumable. */
  DETAIL_FETCH: 'detail-fetch',
  /** OS share sheet, pasted text, shared file. Items arrive with human intent attached. */
  SHARE_TARGET: 'share-target',
  /** A saved page or a previous export. Also the test harness's strategy. */
  FILE_IMPORT: 'file-import',
  /** An official API where one exists. Server-side is acceptable here; the others are not. */
  API: 'api',
})

const STRATEGY_VALUES = new Set(Object.values(ACQUISITION_STRATEGIES))

/**
 * The three-way acquisition outcome. Only `RETRYABLE` re-enters the queue.
 *
 * Collapsing TERMINAL and RETRYABLE into one failure mode is the classic bug that makes a
 * queue either drop paywalled pages forever or retry them until heat death. openbrowsertabs
 * has the first half of that bug: its `unfetchable` is terminal with no retry path anywhere,
 * so one timeout removes an item from enrichment permanently.
 */
export const OUTCOME = Object.freeze({
  SUCCESS: 'success',
  TERMINAL: 'terminal',
  RETRYABLE: 'retryable',
})

/**
 * Validate a connector module. Returns human-readable problems; empty means valid.
 * The CI fixture harness runs this over every bundled connector.
 */
export function validateConnector(c) {
  const p = []
  if (!c || typeof c !== 'object') return ['connector is not an object']

  if (!c.id || typeof c.id !== 'string') p.push('id is required (a stable, lowercase slug)')
  else if (!/^[a-z0-9][a-z0-9-]*$/.test(c.id)) p.push(`id "${c.id}" must be lowercase alphanumeric with dashes`)
  else if (c.id.includes(':')) p.push('id must not contain ":" — it becomes the Item id namespace')

  if (!c.kind || typeof c.kind !== 'string') p.push('kind is required (video|model|listing|link|…)')
  if (typeof c.version !== 'string' || !c.version) p.push('version is required (semver, travels with `raw`)')
  if (typeof c.match !== 'function') p.push('match(url) → boolean is required')

  if (!Array.isArray(c.lists)) p.push('lists must be an array (may be empty)')
  else {
    c.lists.forEach((l, i) => {
      if (!l?.id) p.push(`lists[${i}]: id is required`)
      if (!l?.label) p.push(`lists[${i}]: label is required`)
      if (typeof l?.match !== 'function') p.push(`lists[${i}]: match(url) → boolean is required`)
      if (l?.instanceId !== undefined && typeof l.instanceId !== 'function') {
        p.push(`lists[${i}]: instanceId must be a function or absent`)
      }
      // `id` names the FAMILY; `instanceId(url)` names the particular list an Item joins. Every
      // host reads `instanceId` and falls back to `id`, so a connector that spells it anything
      // else files every instance under the family name and nothing fails — the fallback is
      // legitimate. MakerWorld shipped `resolveId` and every collection landed under
      // `collection` instead of `collection:<id>`.
      for (const wrong of ['resolveId', 'idFor', 'listId', 'instance']) {
        if (l && typeof l[wrong] === 'function') {
          p.push(`lists[${i}]: "${wrong}" is not read by any host — the member is called instanceId`)
        }
      }
    })
  }

  const acq = c.acquisition
  if (!acq || typeof acq !== 'object') p.push('acquisition is required')
  else {
    if (!STRATEGY_VALUES.has(acq.strategy)) {
      p.push(`acquisition.strategy "${acq.strategy}" is not one of ${[...STRATEGY_VALUES].join('|')}`)
    }
    if (acq.strategy === ACQUISITION_STRATEGIES.DOM_ACTIVE_TAB && !acq.scope) {
      // Scope-then-extract is mandatory, not stylistic. A YouTube Watch Later page holds 639
      // unique watch?v= ids but only 582 real rows; the surplus leaks in from sidebars and
      // recommendations. Splitting into per-item chunks BEFORE extracting is what produces
      // clean data — measured, not assumed.
      p.push('acquisition.scope is required for dom-active-tab (split per item before extracting)')
    }
    if (acq.autoScroll && !(Number(acq.autoScroll.maxMs) > 0)) {
      p.push('acquisition.autoScroll.maxMs must be a positive number (a scroll needs a deadline)')
    }
  }

  if (typeof c.parseList !== 'function') p.push('parseList(text, ctx) → RawItem[] is required')
  if (c.parseDetail !== null && c.parseDetail !== undefined && typeof c.parseDetail !== 'function') {
    p.push('parseDetail must be a function or null')
  }
  if (typeof c.normalize !== 'function') p.push('normalize(raw, ctx) → partial Item is required')

  if (c.deriveThumbUrl !== undefined && c.deriveThumbUrl !== null && typeof c.deriveThumbUrl !== 'function') {
    p.push('deriveThumbUrl must be a function or null')
  }

  if (c.liveness !== undefined && c.liveness !== null) {
    if (typeof c.liveness !== 'object') p.push('liveness must be an object or null')
    else {
      if (c.liveness.atScrape !== null && c.liveness.atScrape !== undefined
          && typeof c.liveness.atScrape !== 'function') {
        p.push('liveness.atScrape must be a function or null')
      }
      if (c.liveness.probe !== null && c.liveness.probe !== undefined
          && typeof c.liveness.probe !== 'function') {
        p.push('liveness.probe must be a function or null')
      }
    }
  }

  if (!Array.isArray(c.facets)) p.push('facets must be an array (may be empty)')

  if (c.hosts !== undefined && !Array.isArray(c.hosts)) {
    p.push('hosts must be an array of match patterns for optional_host_permissions')
  }

  return p
}

/**
 * Wrap a connector definition, validating eagerly so a broken connector fails at import
 * rather than mid-scrape, and filling in the optional members.
 */
export function defineConnector(def) {
  const problems = validateConnector(def)
  if (problems.length) {
    throw new Error(`invalid connector "${def?.id ?? '?'}":\n  - ${problems.join('\n  - ')}`)
  }
  return Object.freeze({
    parseDetail: null,
    deriveThumbUrl: null,
    liveness: { atScrape: null, probe: null },
    hosts: [],
    ...def,
  })
}
