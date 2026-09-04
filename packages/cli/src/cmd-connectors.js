/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { loadRegistry, describeConnector } from './registry.js'
import { table, jsonLine, plural } from './format.js'
import { EXIT } from './errors.js'

export default {
  name: 'connectors',
  summary: 'list the bundled connectors, their lists, strategies, hosts and facets',
  usage: 'stashling connectors [--json]',
  options: { json: { type: 'boolean' } },
  help: `Connectors are BUNDLED and statically imported — they cannot be added at runtime.
Dynamic import() is unsupported in an MV3 background service worker, and remotely fetched
connector code is a Chrome Web Store rejection under the remote-hosted-code policy. So a
connector ships with the package and updates with it. See docs/decisions/0002.`,

  async run({ values, io }) {
    const reg = await loadRegistry()
    const described = reg.connectors.map(describeConnector)

    if (values.json) {
      io.out(`${jsonLine(described)}\n`)
      return EXIT.OK
    }

    if (!described.length) {
      io.out('no connectors bundled\n')
      return EXIT.OK
    }

    io.out(table(
      ['id', 'kind', 'ver', 'strategy', 'scope', 'lists', 'facets'],
      described.map((c) => [
        c.id,
        c.kind,
        c.version,
        c.strategy ?? '-',
        c.scope ?? '-',
        c.lists.map((l) => l.id).join(', ') || '-',
        String(c.facets.length),
      ]),
    ))

    for (const c of described) {
      io.out(`\n${c.id}\n`)
      io.out(`  hosts        ${c.hosts.join(' ') || '(none declared)'}\n`)
      io.out(`  lists        ${c.lists.map((l) => `${l.id} (${l.label})`).join(', ') || '(none)'}\n`)
      io.out(`  facets       ${c.facets.map((f) => `${f.key} ${f.type}`).join(', ') || '(none)'}\n`)
      io.out(`  detail page  ${c.hasDetail ? 'yes' : 'no'}\n`)
      io.out(`  liveness     ${c.hasLivenessProbe ? 'probe' : 'scrape-time only or none'}\n`)
      if (c.autoScrollMs) io.out(`  autoScroll   up to ${c.autoScrollMs} ms (virtualized list)\n`)
    }

    io.out(`\n${plural(described.length, 'connector')} bundled.\n`)
    io.out('Hosts are requested at activation time via optional_host_permissions, never at install.\n')
    return EXIT.OK
  },
}
