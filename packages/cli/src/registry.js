/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The connector registry, loaded LAZILY and on purpose.
 *
 * `import`, `export` and `verify` are operations on the interchange format. They must keep
 * working when a connector module is broken — a syntax error in one bundled connector must
 * not take down the tool whose entire job is getting your data back out. A top-level
 * `import … from '../../connectors/src/index.js'` in `run.js` would make every command,
 * including `--help`, fail on a defect in code it never calls.
 *
 * Relative paths, not package specifiers: this repo has no `node_modules` and never runs
 * `npm install`, so the workspace links that would make `@stashling/connectors` resolve do
 * not exist. The relative path is the honest one.
 */

import { UsageError } from './errors.js'

let cached = null

/**
 * @returns {Promise<object>} the module namespace of `@stashling/connectors`
 * @throws {UsageError} with the underlying reason, when the registry cannot be loaded
 */
export async function loadRegistry() {
  if (!cached) {
    cached = import('../../connectors/src/index.js').catch((err) => {
      cached = null // a failed load must not be cached; the next call may run after a fix
      throw new UsageError('the connector registry failed to load', {
        hint: `${err?.message ?? err}\n  (packages/connectors is part of this repo — this is a defect there, not a usage problem)`,
      })
    })
  }
  return cached
}

/** Look up one connector by id, or fail with the list of ids that do exist. */
export async function requireConnector(id) {
  const reg = await loadRegistry()
  const connector = reg.getConnector(id)
  if (!connector) {
    const known = reg.connectors.map((c) => c.id).join(', ') || '(none bundled)'
    throw new UsageError(`no connector with id "${id}"`, { hint: `bundled connectors: ${known}` })
  }
  return connector
}

/** A plain, JSON-friendly description of a connector — what `stashling connectors` prints. */
export function describeConnector(c) {
  return {
    id: c.id,
    kind: c.kind,
    version: c.version,
    priority: c.priority ?? 0,
    strategy: c.acquisition?.strategy ?? null,
    scope: c.acquisition?.scope ?? null,
    autoScrollMs: c.acquisition?.autoScroll?.maxMs ?? null,
    lists: (c.lists ?? []).map((l) => ({ id: l.id, label: l.label })),
    hosts: [...(c.hosts ?? [])],
    facets: (c.facets ?? []).map((f) => ({ key: f.key, label: f.label, type: f.type })),
    hasDetail: typeof c.parseDetail === 'function',
    hasLivenessProbe: typeof c.liveness?.probe === 'function',
  }
}
