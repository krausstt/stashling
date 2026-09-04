/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The CLI, driven in-process.
 *
 * `run()` returns an exit code and never calls `process.exit`, so none of this spawns a
 * subprocess. A test suite that spawns a process per assertion is a test suite people stop
 * running.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { run } from '../src/run.js'
import { EXIT } from '../src/errors.js'
import { fromJsonl } from '../../core/src/interchange.js'

const REPO = path.resolve(fileURLToPath(new URL('../../..', import.meta.url)))
const YT_FIXTURE = path.join(REPO, 'fixtures/youtube/watch-later.fixture.html')
const MW_FIXTURE = path.join(REPO, 'fixtures/makerworld/listing.fixture.html')
const YT_URL = 'https://www.youtube.com/playlist?list=WL'
const NOW = '1756900000000'

function makeIo() {
  const out = []
  const err = []
  return {
    io: { out: (s) => out.push(s), err: (s) => err.push(s), isTTY: false, env: {} },
    get stdout() { return out.join('') },
    get stderr() { return err.join('') },
  }
}

async function cli(...argv) {
  const capture = makeIo()
  const code = await run(argv, capture.io)
  return { code, stdout: capture.stdout, stderr: capture.stderr }
}

function tmp() {
  const dir = mkdtempSync(path.join(tmpdir(), 'stashling-cli-'))
  test.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

// ── plumbing ──────────────────────────────────────────────────────────────────

test('--help is a successful request for help, not a usage error', async () => {
  // A CLI that exits non-zero on --help breaks every `set -e` script wrapped around it.
  const { code, stdout } = await cli('--help')
  assert.equal(code, EXIT.OK)
  assert.match(stdout, /usage: stashling <command>/)
})

test('no arguments prints usage on stderr and exits 2', async () => {
  const { code, stderr } = await cli()
  assert.equal(code, EXIT.USAGE)
  assert.match(stderr, /usage: stashling <command>/)
})

test('an unknown command exits 2 and lists the real ones', async () => {
  const { code, stderr } = await cli('frobnicate')
  assert.equal(code, EXIT.USAGE)
  assert.match(stderr, /unknown command "frobnicate"/)
  assert.match(stderr, /known commands: .*verify/)
})

test('an unknown flag exits 2 and shows that command usage', async () => {
  const { code, stderr } = await cli('verify', 'x.jsonl', '--nope')
  assert.equal(code, EXIT.USAGE)
  assert.match(stderr, /usage: stashling verify/)
})

test('a missing file is a usage error, not a crash', async () => {
  const { code, stderr } = await cli('verify', path.join(tmpdir(), 'definitely-not-here.jsonl'))
  assert.equal(code, EXIT.USAGE)
  assert.match(stderr, /cannot read interchange file/)
})

test('connectors lists what is bundled, and as JSON', async () => {
  const { code, stdout } = await cli('connectors', '--json')
  assert.equal(code, EXIT.OK)
  const described = JSON.parse(stdout)
  assert.deepEqual(described.map((c) => c.id).sort(), ['makerworld', 'youtube'])
  assert.equal(described.find((c) => c.id === 'youtube').strategy, 'dom-active-tab')
})

// ── parse ─────────────────────────────────────────────────────────────────────

test('parse runs a connector over a saved page and reports coverage as percentages', async () => {
  const { code, stdout } = await cli('parse', YT_FIXTURE, '--url', YT_URL, '--now', NOW)
  assert.equal(code, EXIT.OK)
  assert.match(stdout, /youtube @ /)
  assert.match(stdout, /coverage over 12 items/)
  assert.match(stdout, /title\s+12\/12\s+100\.0%/)
  // The alarm, not a spot check: byline is legitimately below 100% and must be visible as such.
  assert.match(stdout, /byline\.name\s+9\/12/)
})

test('parse picks the connector from the page URL when told, and refuses when it cannot', async () => {
  const forced = await cli('parse', MW_FIXTURE, '--connector', 'makerworld', '--now', NOW)
  assert.equal(forced.code, EXIT.OK)
  assert.match(forced.stdout, /makerworld @ /)

  // The synthetic fixture carries no og:url or canonical link, so there is nothing to sniff.
  const guessing = await cli('parse', MW_FIXTURE, '--now', NOW)
  assert.equal(guessing.code, EXIT.USAGE)
  assert.match(guessing.stderr, /cannot tell which connector/)
})

test('parse --jsonl writes an interchange file that parses back', async () => {
  const dir = tmp()
  const out = path.join(dir, 'yt.jsonl')
  const { code } = await cli('parse', YT_FIXTURE, '--url', YT_URL, '--now', NOW, '--jsonl', out)
  assert.equal(code, EXIT.OK)

  const bundle = fromJsonl(readFileSync(out, 'utf8'))
  assert.equal(bundle.items.length, 12)
  assert.equal(bundle.errors.length, 0)
  assert.equal(bundle.meta.schema, 1)
  // The lineage is derived from connector + file, so re-parsing the same page is recognisably
  // the same snapshot rather than a brand new collection.
  assert.equal(bundle.meta.lineage, 'youtube:watch-later.fixture.html')
})

// ── the round trip ────────────────────────────────────────────────────────────

test('ROUND TRIP: export of an import is byte-identical in its items', async () => {
  const dir = tmp()
  const scrape = path.join(dir, 'yt.jsonl')
  const store = path.join(dir, 'store.jsonl')
  const back = path.join(dir, 'back.jsonl')

  await cli('parse', YT_FIXTURE, '--url', YT_URL, '--now', NOW, '--jsonl', scrape)
  assert.equal((await cli('import', scrape, '--into', store)).code, EXIT.OK)
  assert.equal((await cli('export', store, '--out', back)).code, EXIT.OK)

  const first = fromJsonl(readFileSync(scrape, 'utf8')).items
  const round = fromJsonl(readFileSync(back, 'utf8')).items
  assert.equal(round.length, first.length)

  const byId = new Map(round.map((i) => [i.id, i]))
  for (const item of first) assert.deepEqual(byId.get(item.id), item, `${item.id} did not survive the round trip`)
})

test('IMPORT IS NOT DESTRUCTIVE: a partial file never deletes what is not in it', async () => {
  const dir = tmp()
  const yt = path.join(dir, 'yt.jsonl')
  const mw = path.join(dir, 'mw.jsonl')
  const store = path.join(dir, 'store.jsonl')
  const partial = path.join(dir, 'partial.jsonl')

  await cli('parse', YT_FIXTURE, '--url', YT_URL, '--now', NOW, '--jsonl', yt)
  await cli('parse', MW_FIXTURE, '--connector', 'makerworld', '--now', NOW, '--jsonl', mw)
  await cli('import', yt, '--into', store)
  await cli('import', mw, '--into', store)

  const both = fromJsonl(readFileSync(store, 'utf8')).items
  assert.equal(both.length, 18, 'two domains coexist in one store')
  assert.deepEqual([...new Set(both.map((i) => i.source))].sort(), ['makerworld', 'youtube'])

  // Export only YouTube, then feed that partial file back in.
  await cli('export', store, '--source', 'youtube', '--out', partial)
  assert.equal(fromJsonl(readFileSync(partial, 'utf8')).items.length, 12)

  const reimport = await cli('import', partial, '--into', store, '--force')
  assert.equal(reimport.code, EXIT.OK)
  const after = fromJsonl(readFileSync(store, 'utf8')).items
  assert.equal(after.length, 18, 'the 6 MakerWorld items absent from the file survived')
})

test('a stale snapshot of the same store is refused; --force overrides', async () => {
  const dir = tmp()
  const store = path.join(dir, 'store.jsonl')
  const snapshot = path.join(dir, 'snapshot.jsonl')
  const yt = path.join(dir, 'yt.jsonl')

  await cli('parse', YT_FIXTURE, '--url', YT_URL, '--now', NOW, '--jsonl', yt)
  await cli('import', yt, '--into', store)
  await cli('export', store, '--out', snapshot)

  // The snapshot carries the store's own lineage at the store's own generation, so re-importing
  // it is exactly the rollback the counter exists to stop.
  const refused = await cli('import', snapshot, '--into', store)
  assert.equal(refused.code, EXIT.FAILURE)
  assert.match(refused.stderr, /stale snapshot of this same store/)

  assert.equal((await cli('import', snapshot, '--into', store, '--force')).code, EXIT.OK)
})

test('a file from a DIFFERENT collection merges rather than being refused', async () => {
  const dir = tmp()
  const store = path.join(dir, 'store.jsonl')
  const yt = path.join(dir, 'yt.jsonl')
  const mw = path.join(dir, 'mw.jsonl')

  await cli('parse', YT_FIXTURE, '--url', YT_URL, '--now', NOW, '--jsonl', yt)
  await cli('parse', MW_FIXTURE, '--connector', 'makerworld', '--now', NOW, '--jsonl', mw)
  await cli('import', yt, '--into', store)

  // mw.jsonl is generation 1 while the store is already past it. A generation-only guard would
  // refuse this, which would be the guard firing on the wrong thing.
  const merged = await cli('import', mw, '--into', store)
  assert.equal(merged.code, EXIT.OK)
  assert.match(merged.stdout, /6 added/)
})

test('import without --into is a dry run and writes nothing', async () => {
  const dir = tmp()
  const yt = path.join(dir, 'yt.jsonl')
  const store = path.join(dir, 'store.jsonl')
  await cli('parse', YT_FIXTURE, '--url', YT_URL, '--now', NOW, '--jsonl', yt)

  const { code, stdout } = await cli('import', yt)
  assert.equal(code, EXIT.OK)
  assert.match(stdout, /dry run/)
  assert.equal(existsSync(store), false)
})

// ── verify ────────────────────────────────────────────────────────────────────

test('verify reports coverage and exits 0 on a clean store', async () => {
  const dir = tmp()
  const yt = path.join(dir, 'yt.jsonl')
  await cli('parse', YT_FIXTURE, '--url', YT_URL, '--now', NOW, '--jsonl', yt)

  const { code, stdout } = await cli('verify', yt)
  assert.equal(code, EXIT.OK)
  assert.match(stdout, /12 items from youtube/)
  assert.match(stdout, /no validation problems/)
  assert.match(stdout, /metric keys present: metrics\.durationSec, metrics\.views/)
})

test('verify --json is machine-readable and carries the coverage rows', async () => {
  const dir = tmp()
  const yt = path.join(dir, 'yt.jsonl')
  await cli('parse', YT_FIXTURE, '--url', YT_URL, '--now', NOW, '--jsonl', yt)

  const { code, stdout } = await cli('verify', yt, '--json')
  assert.equal(code, EXIT.OK)
  const report = JSON.parse(stdout)
  assert.equal(report.checked, 12)
  assert.deepEqual(report.sources, ['youtube'])
  assert.equal(report.coverage.find((r) => r.field === 'title').percent, 100)
})

test('verify catches a duplicate id, which is dedup having broken upstream', async () => {
  const dir = tmp()
  const yt = path.join(dir, 'yt.jsonl')
  const doubled = path.join(dir, 'doubled.jsonl')
  await cli('parse', YT_FIXTURE, '--url', YT_URL, '--now', NOW, '--jsonl', yt)

  const lines = readFileSync(yt, 'utf8').split('\n').filter(Boolean)
  writeFileSync(doubled, [...lines, lines[1]].join('\n'))

  const { code, stdout } = await cli('verify', doubled)
  assert.equal(code, EXIT.FAILURE)
  assert.match(stdout, /duplicate id/)
})

test('verify --min fails on an OBSERVED field below the threshold, and ignores unproduced ones', async () => {
  const dir = tmp()
  const yt = path.join(dir, 'yt.jsonl')
  await cli('parse', YT_FIXTURE, '--url', YT_URL, '--now', NOW, '--jsonl', yt)

  // YouTube rows carry no summary, no tags and no categories, so those sit at 0%. They are not
  // regressions and must not fail the gate, or --min is useless on its first honest run.
  assert.equal((await cli('verify', yt, '--min', '50')).code, EXIT.OK)

  // byline.name is at 75% here — genuinely observed, genuinely partial. That IS the signal.
  const strict = await cli('verify', yt, '--min', '99')
  assert.equal(strict.code, EXIT.FAILURE)
  assert.match(strict.stderr, /below --min 99%/)
  assert.match(strict.stderr, /byline\.name/)
  assert.equal(/\bsummary\b/.test(strict.stderr), false, 'an unproduced field is not reported as failing')
})

test('pointing verify at an HTML file says so instead of drowning in parse errors', async () => {
  const { code, stderr } = await cli('verify', YT_FIXTURE)
  assert.equal(code, EXIT.USAGE)
  assert.match(stderr, /does not look like an interchange file/)
})

// ── fixture ───────────────────────────────────────────────────────────────────

test('fixture creates a golden file, then matches it', async () => {
  const dir = tmp()
  const golden = path.join(dir, 'golden.json')

  const created = await cli('fixture', 'youtube', YT_FIXTURE, '--golden', golden, '--url', YT_URL, '--now', NOW)
  assert.equal(created.code, EXIT.OK)
  assert.match(created.stdout, /created/)

  const matched = await cli('fixture', 'youtube', YT_FIXTURE, '--golden', golden, '--url', YT_URL, '--now', NOW)
  assert.equal(matched.code, EXIT.OK)
  assert.match(matched.stdout, /fixture matches golden output/)
})

test('fixture FAILS on a regression, and names the field that moved', async () => {
  const dir = tmp()
  const golden = path.join(dir, 'golden.json')
  await cli('fixture', 'youtube', YT_FIXTURE, '--golden', golden, '--url', YT_URL, '--now', NOW)

  // Simulate a source redesign: one title stops being extracted.
  const items = JSON.parse(readFileSync(golden, 'utf8'))
  items[0].title = 'What the title used to be'
  writeFileSync(golden, JSON.stringify(items, null, 2))

  const { code, stdout } = await cli('fixture', 'youtube', YT_FIXTURE, '--golden', golden, '--url', YT_URL, '--now', NOW)
  assert.equal(code, EXIT.FAILURE)
  assert.match(stdout, /field difference/)
  assert.match(stdout, /title/)
})

test('fixture on an unknown connector lists the ones that exist', async () => {
  const { code, stderr } = await cli('fixture', 'myspace', YT_FIXTURE, '--golden', 'x.json')
  assert.equal(code, EXIT.USAGE)
  assert.match(stderr, /no connector with id "myspace"/)
  assert.match(stderr, /bundled connectors: /)
})
