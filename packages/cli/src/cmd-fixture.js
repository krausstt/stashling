/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { requireConnector } from './registry.js'
import { runConnector } from './acquire.js'
import { coverage, coverageDelta } from './coverage.js'
import { table, pct, plural, truncate } from './format.js'
import { assertReadable } from './jsonl.js'
import { UsageError, FailureError, EXIT } from './errors.js'

/** Deep structural diff, returning dotted paths. Ordered, bounded, and readable in a CI log. */
function diff(expected, actual, path = '', out = [], limit = 60) {
  if (out.length >= limit) return out
  const bothObjects = expected && actual && typeof expected === 'object' && typeof actual === 'object'
  if (!bothObjects) {
    if (JSON.stringify(expected) !== JSON.stringify(actual)) {
      out.push({ path: path || '(root)', expected, actual })
    }
    return out
  }
  if (Array.isArray(expected) !== Array.isArray(actual)) {
    out.push({ path: path || '(root)', expected: Array.isArray(expected) ? 'array' : 'object', actual: Array.isArray(actual) ? 'array' : 'object' })
    return out
  }
  const keys = [...new Set([...Object.keys(expected), ...Object.keys(actual)])]
  for (const k of keys) {
    diff(expected[k], actual[k], path ? `${path}.${k}` : k, out, limit)
    if (out.length >= limit) break
  }
  return out
}

export default {
  name: 'fixture',
  summary: 'run a connector over a fixture and diff it against golden output',
  usage: 'stashling fixture <connector> <page.html> --golden <golden.json> [--update] [--url <url>] [--list <id>]',
  options: {
    golden: { type: 'string' },
    update: { type: 'boolean' },
    url: { type: 'string' },
    list: { type: 'string' },
    now: { type: 'string' },
  },
  help: `This is what CI calls. It exits non-zero on any mismatch.

The golden file is asserted FIELD BY FIELD and the result is reported as coverage percentages
against the golden baseline, not as a single pass/fail. That is the difference between "the
fixture broke" and "title dropped from 100% to 96% and everything else is fine".

--now pins the acquisition clock so the diff is byte-stable. A clock in the middle of a
comparison makes CI flap.

--update rewrites the golden file. Read the diff before you use it: a golden file updated
without looking is how a regression becomes the new expected behaviour.`,

  async run({ values, positionals, io }) {
    const [connectorId, file] = positionals
    if (!connectorId || !file) {
      throw new UsageError('a connector id and a fixture page are required', {
        hint: 'usage: stashling fixture <connector> <page.html> --golden <golden.json>',
      })
    }
    if (!values.golden) throw new UsageError('--golden <file.json> is required')

    const connector = await requireConnector(connectorId)
    await assertReadable(file, 'fixture page')
    const html = await readFile(file, 'utf8')

    const now = values.now ? Number(values.now) : 0
    if (values.now && !Number.isFinite(now)) throw new UsageError('--now must be a number (epoch ms)')

    const { items, rawCount, problems } = runConnector(connector, html, {
      url: values.url, list: values.list, listId: values.list, now, strategy: 'file-import', file,
    })

    if (values.update || !existsSync(values.golden)) {
      await writeFile(values.golden, `${JSON.stringify(items, null, 2)}\n`, 'utf8')
      const verb = values.update ? 'updated' : 'created'
      io.out(`${verb} ${values.golden} with ${plural(items.length, 'item')}\n`)
      if (!values.update) io.out('(the golden file did not exist — review it before committing)\n')
      return EXIT.OK
    }

    const golden = JSON.parse(await readFile(values.golden, 'utf8'))
    if (!Array.isArray(golden)) throw new UsageError(`${values.golden} is not an array of Items`)

    io.out(`${connector.id} @ ${connector.version} — ${file}\n`)
    io.out(`golden: ${plural(golden.length, 'item')}, produced: ${items.length}\n\n`)

    const delta = coverageDelta(golden, items)
    io.out(table(
      ['field', 'golden', 'now', 'delta'],
      delta.rows.map((r) => [
        r.field,
        r.baselinePercent === null ? '   -  ' : `${r.baselinePercent.toFixed(1)}%`,
        r.percent === null ? '   -  ' : `${r.percent.toFixed(1)}%`,
        r.delta === null ? '' : `${r.delta > 0 ? '+' : ''}${r.delta.toFixed(1)}`,
      ]),
      ['left', 'right', 'right', 'right'],
    ))

    const regressions = delta.rows.filter((r) => r.delta !== null && r.delta < 0)
    const failures = []

    if (items.length !== golden.length) {
      failures.push(`item count ${items.length} != golden ${golden.length}`)
    }

    const byId = new Map(items.map((i) => [i.id, i]))
    const goldById = new Map(golden.map((i) => [i.id, i]))
    for (const id of goldById.keys()) if (!byId.has(id)) failures.push(`missing item: ${id}`)
    for (const id of byId.keys()) if (!goldById.has(id)) failures.push(`unexpected item: ${id}`)

    const fieldDiffs = []
    for (const [id, expected] of goldById) {
      const actual = byId.get(id)
      if (!actual) continue
      for (const d of diff(expected, actual)) fieldDiffs.push({ id, ...d })
    }

    if (fieldDiffs.length) {
      io.out(`\n${plural(fieldDiffs.length, 'field difference')}:\n`)
      for (const d of fieldDiffs.slice(0, 30)) {
        io.out(`  ${d.id}  ${d.path}\n`)
        io.out(`    golden: ${truncate(JSON.stringify(d.expected), 80)}\n`)
        io.out(`    now:    ${truncate(JSON.stringify(d.actual), 80)}\n`)
      }
      if (fieldDiffs.length > 30) io.out(`  … and ${fieldDiffs.length - 30} more\n`)
    }

    if (regressions.length) {
      io.out(`\nCOVERAGE REGRESSION in ${plural(regressions.length, 'field')}: `
        + `${regressions.map((r) => `${r.field} ${r.delta.toFixed(1)}pts`).join(', ')}\n`)
    }

    for (const p of problems.slice(0, 10)) io.err(`row ${p.index}: ${p.message}\n`)

    const cov = coverage(items)
    io.out(`\n${rawCount} rows parsed, ${items.length} items produced, `
      + `${cov.rows.filter((r) => r.percent === 100).length} of ${cov.rows.length} fields at 100%.\n`)

    if (failures.length || fieldDiffs.length || regressions.length) {
      throw new FailureError('fixture does not match golden output', {
        details: failures.length ? failures.slice(0, 20).map((f) => `  ${f}`).join('\n') : undefined,
      })
    }

    io.out('fixture matches golden output.\n')
    return EXIT.OK
  },
}
