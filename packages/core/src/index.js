/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * @stashling/core — the pure layer.
 *
 * No network, no DOM, no platform APIs, no dependencies. Everything here runs identically
 * in Node, in a browser page, and in an MV3 service worker, and is unit-testable with
 * `node --test` and nothing installed.
 *
 * If you are about to add an import to this package, you are probably about to put it in
 * the wrong layer. Acquisition, storage and scheduling are host concerns.
 */

export {
  SCHEMA_VERSION, LIVENESS_STATES, MEMBERSHIP_STATES, ZONES, REQUIRED_KEYS,
  makeId, parseId, createItem, validateItem, normalizeMetrics, readPath,
} from './item.js'

export {
  urlsplit, percentDecode, parseQsl, quotePlus, urlencode,
  unwrapAmp, canonicalizeUrl, isHttpUrl, DEFAULT_HOST_RULES,
} from './url.js'

export { mergeItems, mergeUser, mergeLists, rearmLiveness } from './merge.js'

export {
  SOURCE_PRECEDENCE, rank, makeAttr, attrValue, beats,
  resolveAttrs, readAttr, resolvedValues, opinions, upsertAttrs,
} from './precedence.js'

export { toJsonl, fromJsonl, shouldAccept, mergeBundle, GENERATOR } from './interchange.js'

export {
  validateFacet, validateFacetManifest, facetValue, facetRange,
  termCounts, matchesFilter, applyFilters, logGauge,
} from './facets.js'

export {
  ACQUISITION_STRATEGIES, OUTCOME, validateConnector, defineConnector,
} from './connector.js'
