/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { readBundle } from './jsonl.js'
import { coverage, incomplete, validateAll, groupProblems, metricKeys } from './coverage.js'
import { table, pct, plural, jsonLine } from './format.js'
import { UsageError, EXIT } from './errors.js'

export default {
  name: 'verify',
  summary: 'validate a store and report per-field coverage percentages',
  usage: 'stashling verify <file.jsonl> [--source <id>] [--json] [--min <percent>]',
  options: { source: { type: 'string' }, json: { type: 'boolean' }, min: { type: 'string' } },
  help: `The headline output is the coverage table, not the pass/fail.

Every field in every item, as a percentage. A field at 100% yesterday and 96% today means the
source redesigned overnight and a selector is silently returning nothing for 4% of rows — which
a spot check on the first row will not tell you, and which no error will report, because
returning nothing is not an error.

--min <percent> fails the run when an OBSERVED field drops below that threshold.

"Observed" means present on at least one item. A field at exactly 0% is not a regression, it is
a field this source does not produce — YouTube rows carry no summary and no tags — and failing
a build over that would make the flag useless on its first day. Those fields are still printed.

--min is a coarse standalone gate, and it cannot see a field that fell from 100% all the way to
0%, because such a field now reads as "not produced". For real regression detection compare
against a stored baseline with \`stashling fixture --golden\`, which diffs field by field and
reports the delta in percentage points.`,

  async run({ values, positionals, io }) {
    const file = positionals[0]
    if (!file) throw new UsageError('an interchange file is required', { hint: 'usage: stashling verify <file.jsonl>' })

    const bundle = await readBundle(file)
    const items = values.source ? bundle.items.filter((i) => i.source === values.source) : bundle.items

    if (!items.length && bundle.errorCount) {
      throw new UsageError(`${file} does not look like an interchange file`, {
        hint: `${bundle.errorCount} of ${bundle.lines} lines failed to parse`,
      })
    }

    const cov = coverage(items, { fields: undefined })
    const { problems, duplicateIds, checked } = validateAll(items)
    const short = incomplete(cov)
    const min = values.min === undefined ? null : Number(values.min)
    if (values.min !== undefined && (!Number.isFinite(min) || min < 0 || min > 100)) {
      throw new UsageError('--min must be a percentage between 0 and 100')
    }
    // `r.percent > 0` is the load-bearing half: a field no item carries is a field this source
    // does not produce, not a regression. Without it, `--min` fails on the first honest run of
    // every connector that does not populate every optional facet — which is all of them.
    const belowMin = min === null
      ? []
      : cov.rows.filter((r) => r.percent !== null && r.percent > 0 && r.percent < min)

    if (values.json) {
      io.out(`${jsonLine({
        file, checked, sources: [...new Set(items.map((i) => i.source))],
        generation: Number(bundle.meta?.generation) || 0,
        coverage: cov.rows, problems: groupProblems(problems), duplicateIds,
        malformedLines: bundle.errorCount, belowMin: belowMin.map((r) => r.field),
      })}\n`)
      return problems.length || belowMin.length ? EXIT.FAILURE : EXIT.OK
    }

    io.out(`${file}\n`)
    io.out(`${plural(checked, 'item')}`)
    const sources = [...new Set(items.map((i) => i.source))]
    if (sources.length) io.out(` from ${sources.join(', ')}`)
    io.out(`, generation ${Number(bundle.meta?.generation) || 0}, `)
    io.out(`schema ${bundle.meta?.schema ?? '(unstated)'}\n\n`)

    io.out(table(
      ['field', 'present', 'coverage'],
      cov.rows.map((r) => [r.field, `${r.present}/${cov.total}`, pct(r.present, cov.total)]),
      ['left', 'right', 'right'],
    ))

    const metrics = metricKeys(items)
    if (metrics.length) io.out(`\nmetric keys present: ${metrics.join(', ')}\n`)

    if (short.length) {
      io.out(`\n${plural(short.length, 'field')} below 100%:\n`)
      for (const r of short) io.out(`  ${pct(r.present, cov.total)}  ${r.field}  (${r.missing} missing)\n`)
      io.out('\nCompare this against the last run. A field that was 100% and is now 96% is the\n')
      io.out('earliest signal that a source redesigned — nothing else reports it, because a\n')
      io.out('selector returning nothing is not an error.\n')
    }

    if (problems.length) {
      io.out(`\n${plural(problems.length, 'validation problem')}:\n`)
      for (const g of groupProblems(problems)) {
        io.out(`  ${String(g.count).padStart(5)}x ${g.problem}\n`)
        io.out(`         e.g. ${g.examples.join(', ')}\n`)
      }
    } else {
      io.out('\nno validation problems.\n')
    }

    if (duplicateIds.length) {
      io.out(`\n${duplicateIds.length} duplicate id(s) — dedup broke upstream, and the next merge\n`)
      io.out('silently halves the collection. Dedup is on sourceId, never on title or order.\n')
    }

    if (bundle.errorCount) {
      io.err(`\n${bundle.errorCount} malformed ${plural(bundle.errorCount, 'line')} skipped\n`)
    }

    if (belowMin.length) {
      io.err(`\n${belowMin.length} field(s) below --min ${min}%: `
        + `${belowMin.map((r) => r.field).join(', ')}\n`)
    }

    return problems.length || belowMin.length ? EXIT.FAILURE : EXIT.OK
  },
}
