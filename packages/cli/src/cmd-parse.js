/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { loadRegistry, requireConnector } from './registry.js'
import { runConnector, sniffUrl } from './acquire.js'
import { coverage, incomplete, validateAll, groupProblems } from './coverage.js'
import { table, jsonLine, pct, truncate, plural } from './format.js'
import { UsageError, EXIT } from './errors.js'
import { assertReadable, openSink } from './jsonl.js'
import { writeBundle } from './jsonl.js'

export default {
  name: 'parse',
  summary: 'run a connector over a saved page and print or export the Items',
  usage: 'stashling parse <file.html> [--connector <id>] [--url <url>] [--list <id>] [--json|--jsonl <out>] [--limit N]',
  options: {
    connector: { type: 'string' },
    url: { type: 'string' },
    list: { type: 'string' },
    json: { type: 'boolean' },
    jsonl: { type: 'string' },
    limit: { type: 'string' },
    now: { type: 'string' },
  },
  help: `This is the file-import acquisition strategy: the same pure connector the extension
runs against a live tab, pointed at a page you saved to disk.

The connector is chosen by matching the page's own URL, sniffed from og:url, <link rel=canonical>
or <base href>. Pass --url for a page that carries none of them, or --connector to force one.

Coverage is reported as PERCENTAGES because the percentage is the alarm: a drop from 100% to 96%
on title is how you find out a platform redesigned overnight.`,

  async run({ values, positionals, io }) {
    const file = positionals[0]
    if (!file) throw new UsageError('a saved page is required', { hint: 'usage: stashling parse <file.html>' })
    await assertReadable(file, 'saved page')

    const html = await readFile(file, 'utf8')
    const sniffed = sniffUrl(html)
    const url = values.url ?? sniffed

    let connector
    if (values.connector) {
      connector = await requireConnector(values.connector)
    } else {
      if (!url) {
        throw new UsageError('cannot tell which connector this page belongs to', {
          hint: 'the page carries no og:url, canonical link or base href — pass --url or --connector',
        })
      }
      const reg = await loadRegistry()
      connector = reg.connectorFor(url)
      if (!connector) {
        throw new UsageError(`no bundled connector claims ${url}`, {
          hint: `bundled: ${(await loadRegistry()).connectors.map((c) => c.id).join(', ')}`,
        })
      }
    }

    const reg = await loadRegistry()
    const listId = values.list
      ?? (url ? reg.listFor(connector, url)?.instanceId?.(url) ?? reg.listFor(connector, url)?.id : null)
      ?? null

    const now = values.now ? Number(values.now) : 0
    if (values.now && !Number.isFinite(now)) throw new UsageError('--now must be a number (epoch ms)')

    const { items: all, rawCount, problems } = runConnector(connector, html, {
      url, list: listId, listId, now, strategy: 'file-import', file,
    })

    const limit = values.limit ? Number(values.limit) : 0
    if (values.limit && (!Number.isFinite(limit) || limit < 1)) throw new UsageError('--limit must be a positive number')
    const items = limit ? all.slice(0, limit) : all

    if (values.jsonl) {
      const sink = openSink(values.jsonl, io)
      // The lineage is derived from the connector and the page rather than generated randomly,
      // so re-parsing an unchanged page yields a file an importer recognises as the SAME
      // snapshot instead of a new collection to merge all over again.
      const written = await writeBundle(sink, {
        items,
        meta: { exportedAt: now, generation: 1, lineage: `${connector.id}:${basename(file)}` },
      })
      await sink.end()
      io.err(`wrote ${plural(written, 'record')} to ${values.jsonl}\n`)
      return problems.length ? EXIT.FAILURE : EXIT.OK
    }

    if (values.json) {
      io.out(`${jsonLine(items)}\n`)
      return problems.length ? EXIT.FAILURE : EXIT.OK
    }

    io.out(`${connector.id} @ ${connector.version} — ${file}\n`)
    io.out(`page URL: ${url ?? '(unknown)'}${values.url ? ' (--url)' : sniffed ? ' (sniffed)' : ''}\n`)
    io.out(`list: ${listId ?? '(none)'}\n\n`)

    io.out(table(
      ['#', 'id', 'title', 'metrics', 'liveness'],
      items.map((it) => [
        String(it.order[listId] ?? ''),
        it.id,
        truncate(it.title || '(no title)', 44),
        Object.entries(it.metrics).map(([k, v]) => `${k}=${v}`).join(' ') || '-',
        it.liveness.state,
      ]),
      ['right'],
    ))

    const cov = coverage(all)
    io.out(`\ncoverage over ${plural(cov.total, 'item')}\n`)
    io.out(table(
      ['field', 'present', 'coverage'],
      cov.rows.map((r) => [r.field, `${r.present}/${cov.total}`, pct(r.present, cov.total)]),
      ['left', 'right', 'right'],
    ))

    const short = incomplete(cov)
    if (short.length) {
      io.out(`\n${plural(short.length, 'field')} below 100%: `
        + `${short.map((r) => `${r.field} ${pct(r.present, cov.total).trim()}`).join(', ')}\n`)
      io.out('That is not necessarily a bug — some fields are legitimately optional. It IS the number to watch.\n')
    }

    if (rawCount !== all.length) {
      io.out(`\n${rawCount - all.length} of ${rawCount} parsed rows produced no Item `
        + '(no identity — a row without a source id cannot be stored).\n')
    }

    const { problems: structural } = validateAll(all)
    if (structural.length) {
      io.out('\nvalidation problems:\n')
      for (const g of groupProblems(structural)) {
        io.out(`  ${String(g.count).padStart(4)}x ${g.problem}  e.g. ${g.examples.join(', ')}\n`)
      }
    }

    for (const p of problems.slice(0, 10)) io.err(`row ${p.index}: ${p.message}\n`)
    if (problems.length > 10) io.err(`… and ${problems.length - 10} more row problems\n`)

    return structural.length || problems.length ? EXIT.FAILURE : EXIT.OK
  },
}
