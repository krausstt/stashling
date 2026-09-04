/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { readBundle, openSink, writeBundle } from './jsonl.js'
import { plural } from './format.js'
import { UsageError, EXIT } from './errors.js'

export default {
  name: 'export',
  summary: 'write a store back out as interchange JSONL',
  usage: 'stashling export <store.jsonl> [--out <file.jsonl>] [--generation N] [--source <id>]',
  options: { out: { type: 'string' }, generation: { type: 'string' }, source: { type: 'string' } },
  help: `Writes to stdout unless --out is given, so it pipes.

--generation stamps the meta line. A consumer refuses a payload whose generation is not newer
than its own, which is what stops a stale copy from silently rolling state back. By default the
store's generation is carried forward unchanged; bump it when you have added something.

--source exports only the items from one connector. The zone rule still applies on the way back
in, so a partial export is safe to re-import: it adds and merges, it never deletes.`,

  async run({ values, positionals, io }) {
    const file = positionals[0]
    if (!file) throw new UsageError('a store file is required', { hint: 'usage: stashling export <store.jsonl>' })

    const store = await readBundle(file)

    let items = store.items
    let attrs = store.attrs
    if (values.source) {
      items = items.filter((it) => it.source === values.source)
      const keep = new Set(items.map((it) => it.id))
      attrs = attrs.filter((a) => keep.has(a.itemId))
      if (!items.length) {
        throw new UsageError(`no items with source "${values.source}"`, {
          hint: `sources present: ${[...new Set(store.items.map((i) => i.source))].join(', ') || '(none)'}`,
        })
      }
    }

    const generation = values.generation !== undefined
      ? Number(values.generation)
      : Number(store.meta?.generation) || 0
    if (!Number.isFinite(generation)) throw new UsageError('--generation must be a number')

    const sink = openSink(values.out ?? null, io)
    const written = await writeBundle(sink, {
      items,
      attrs,
      signals: store.signals,
      // The lineage travels with the export: this file is a snapshot OF that store, and saying
      // so is what lets an importer tell a rollback from a merge.
      meta: { generation, exportedAt: Number(store.meta?.exportedAt) || 0, lineage: store.meta?.lineage },
    })
    await sink.end()

    const where = values.out ? ` to ${values.out}` : ''
    io.err(`exported ${plural(items.length, 'item')}, `
      + `${plural(attrs.length, 'attr')} (${written} records)${where}, generation ${generation}\n`)
    return EXIT.OK
  },
}
