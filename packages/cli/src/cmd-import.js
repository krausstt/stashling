/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { readBundle, openSink, writeBundle } from './jsonl.js'
import { shouldAccept, mergeBundle } from '../../core/src/interchange.js'
import { plural, table } from './format.js'
import { UsageError, EXIT } from './errors.js'

export default {
  name: 'import',
  summary: 'merge an interchange file into a store, without deleting anything',
  usage: 'stashling import <file.jsonl> [--into <store.jsonl>] [--force]',
  options: { into: { type: 'string' }, force: { type: 'boolean' }, json: { type: 'boolean' } },
  help: `IMPORT IS NOT DESTRUCTIVE. Items present in the store but absent from the incoming file
survive. This is the whole point: the one importer in the tools this design came from cleared its
store first, so importing a filtered export permanently deleted every record and annotation not
in that file, with no prompt and no undo.

Merge policy is the zone rule, not a new invention:
  facets / ext / raw   incoming replaces
  user                 incoming keys merge ON TOP of local ones, deleting nothing
  times.firstSeenAt    the EARLIER of the two wins
  sightings            the LARGER wins
  attrs                stamped source:"import", so they can never outrank the user

A payload whose generation is not newer than the store's is REFUSED, so a stale file cannot
silently roll your collection back. --force overrides that.`,

  async run({ values, positionals, io }) {
    const file = positionals[0]
    if (!file) throw new UsageError('an interchange file is required', { hint: 'usage: stashling import <file.jsonl>' })

    const incoming = await readBundle(file)
    if (!incoming.items.length && !incoming.attrs.length && incoming.errorCount) {
      throw new UsageError(`${file} does not look like an interchange file`, {
        hint: `${incoming.errorCount} of ${incoming.lines} lines failed to parse`,
      })
    }

    const store = values.into && existsSync(values.into)
      ? await readBundle(values.into)
      : { meta: null, items: [], attrs: [], signals: [] }

    const localGeneration = Number(store.meta?.generation) || 0
    const incomingGeneration = Number(incoming.meta?.generation) || 0

    // A store that has never been written adopts a lineage of its own, so that later snapshots
    // OF IT are recognisable as such. Files from elsewhere carry their own and merge freely.
    const lineage = store.meta?.lineage ?? `store:${randomUUID()}`

    if (!values.force && !shouldAccept({ generation: localGeneration, lineage: store.meta?.lineage }, incoming.meta)) {
      io.err('stashling: refusing a stale snapshot of this same store — incoming generation '
        + `${incomingGeneration} is not newer than the store's ${localGeneration}\n`)
      if (!incoming.meta?.lineage) {
        io.err('  (the incoming file declares no lineage, so it is read as possibly being a\n'
          + '   snapshot of this store rather than a separate collection)\n')
      }
      io.err('  pass --force to import it anyway\n')
      return EXIT.FAILURE
    }

    const merged = mergeBundle(store, incoming)

    io.out(table(
      ['', 'items', 'attrs'],
      [
        ['store before', String(store.items.length), String(store.attrs.length)],
        ['incoming', String(incoming.items.length), String(incoming.attrs.length)],
        ['store after', String(merged.items.length), String(merged.attrs.length)],
      ],
      ['left', 'right', 'right'],
    ))
    io.out(`\n${merged.added} added, ${merged.merged} merged, `
      + `${store.items.length - merged.merged} untouched.\n`)

    if (incoming.errorCount) {
      io.err(`${incoming.errorCount} malformed ${plural(incoming.errorCount, 'line')} skipped `
        + `(first at line ${incoming.errors[0]?.line})\n`)
    }
    if (incoming.unknown.length) {
      io.out(`${incoming.unknown.length} record(s) of unknown type ignored by contract — `
        + 'that is how the format grows without breaking old readers.\n')
    }

    if (!values.into) {
      io.out('\n(dry run — pass --into <store.jsonl> to write the result)\n')
      return EXIT.OK
    }

    const sink = openSink(values.into, io)
    const written = await writeBundle(sink, {
      items: merged.items,
      attrs: merged.attrs,
      signals: [...(store.signals ?? []), ...(incoming.signals ?? [])],
      meta: { generation: Math.max(localGeneration, incomingGeneration) + 1, lineage },
    })
    await sink.end()
    io.out(`wrote ${plural(written, 'record')} to ${values.into} `
      + `(generation ${Math.max(localGeneration, incomingGeneration) + 1})\n`)
    return EXIT.OK
  },
}
