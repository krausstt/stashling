/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Verify the fixture corpus, and summarise connector coverage where golden files exist.
 *
 * WHY ABSENCE IS NOT A FAILURE. The fixtures a connector is really measured against are the
 * user's own saved pages — a MakerWorld likes page is 6.7 MB, a YouTube Watch Later page is
 * 12,725,371 bytes, and both are somebody's personal history. They are gitignored BY POLICY
 * (see .gitignore), so on a fresh clone and on every CI run they are simply not there. A
 * corpus checker that failed on a missing file would fail on every machine but the author's,
 * and the standard response to a check that always fails is to stop running it.
 *
 * So: absence is reported and tolerated. A CHECKSUM MISMATCH is the only content failure,
 * because that means the file on disk is not the file the recorded numbers were measured from
 * and every coverage figure quoted against it is a lie.
 *
 * MANIFEST.json (fixtures/<source>/MANIFEST.json), schema 1:
 *
 *   {
 *     "schema": 1,
 *     "source": "youtube",                    // connector id
 *     "note":   "free text",
 *     "files": [{
 *       "path":       "watch-later.fixture.html", // relative to fixtures/<source>/
 *       "role":       "committed",            // "committed" (synthetic, in git)
 *                                             // | "local-only" (real page, gitignored)
 *       "bytes":      4096,                   // null until recorded
 *       "sha256":     "…",                    // null until recorded
 *       "describes":  "what structural shape this reproduces",
 *       "regenerate": "how to obtain or rebuild it"
 *     }]
 *   }
 *
 * Usage:
 *   node scripts/fixtures.mjs             verify
 *   node scripts/fixtures.mjs --update    fill in bytes/sha256 for entries recorded as null
 */

import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const FIXTURES_DIR = join(ROOT, 'fixtures')

/**
 * Any committed fixture bigger than this gets a warning.
 *
 * Not an arbitrary round number: the two real pages this repo was built against are 6.7 MB and
 * 12.7 MB, and a hand-authored synthetic reproduction of a page's STRUCTURE runs to a few
 * kilobytes. Something in between is the shape of an accident — a real page that slipped past
 * .gitignore, carrying the contributor's actual watch history into a public repo forever.
 */
const COMMITTED_SIZE_WARN = 512 * 1024

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')
const pct = (n, d) => (d === 0 ? '  n/a' : `${((n / d) * 100).toFixed(1).padStart(5)}%`)

/** Dotted-path read. Deliberately local: this script must still run when core is mid-refactor. */
function readPath(obj, path) {
  let node = obj
  for (const seg of path.split('.')) {
    if (node == null || typeof node !== 'object') return undefined
    node = node[seg]
  }
  return node
}

const isPresent = (v) => {
  if (v === undefined || v === null || v === '') return false
  if (Array.isArray(v)) return v.length > 0
  return true
}

// ── manifest verification ─────────────────────────────────────────────────────

/** The Item paths a connector is graded on. `metrics.*` keys are discovered per corpus. */
const COVERAGE_PATHS = [
  'sourceId', 'url', 'title', 'byline.name', 'byline.url',
  'thumb.url', 'times.publishedAt', 'lists',
]

function verifySource(sourceDir, source, report) {
  const manifestPath = join(sourceDir, 'MANIFEST.json')
  if (!existsSync(manifestPath)) {
    report.warnings.push(`${source}: no MANIFEST.json — the directory's contents are unverifiable`)
    return
  }

  let manifest
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch (err) {
    // A manifest that will not parse is a hard failure and not an "absence": nothing in the
    // directory can be checked, so passing would mean reporting green on zero verification.
    report.errors.push(`${source}: MANIFEST.json is not valid JSON — ${err.message}`)
    return
  }
  if (!Array.isArray(manifest.files)) {
    report.errors.push(`${source}: MANIFEST.json has no "files" array`)
    return
  }

  process.stdout.write(`\n${source}  (${manifest.files.length} file(s) declared)\n`)

  for (const entry of manifest.files) {
    const rel = String(entry?.path ?? '')
    if (!rel) { report.errors.push(`${source}: a files[] entry has no "path"`); continue }
    const abs = join(sourceDir, rel.split('/').join(sep))
    const role = entry.role === 'local-only' ? 'local-only' : 'committed'

    if (!existsSync(abs)) {
      if (role === 'local-only') {
        report.skipped += 1
        process.stdout.write(`  ·  ${rel}  skipped, local only (gitignored personal page)\n`)
      } else {
        report.missing += 1
        report.warnings.push(`${source}/${rel}: declared "committed" but absent from the checkout`)
        process.stdout.write(`  ?  ${rel}  MISSING (declared committed)\n`)
      }
      continue
    }

    const bytes = readFileSync(abs)
    const hash = sha256(bytes)
    const problems = []
    if (entry.sha256 && entry.sha256 !== hash) problems.push(`sha256 ${String(entry.sha256).slice(0, 12)}… != ${hash.slice(0, 12)}…`)
    if (Number.isFinite(entry.bytes) && entry.bytes !== bytes.length) problems.push(`bytes ${entry.bytes} != ${bytes.length}`)

    if (problems.length) {
      report.mismatched += 1
      report.errors.push(`${source}/${rel}: ${problems.join('; ')} — the recorded measurements were taken from a different file`)
      process.stdout.write(`  X  ${rel}  MISMATCH: ${problems.join('; ')}\n`)
      continue
    }

    if (!entry.sha256) {
      report.unrecorded.push({ source, rel, hash, bytes: bytes.length, entry })
      process.stdout.write(`  +  ${rel}  present, ${bytes.length} bytes, NOT YET RECORDED (run --update)\n`)
    } else {
      report.verified += 1
      process.stdout.write(`  ok ${rel}  ${bytes.length} bytes, sha256 ${hash.slice(0, 12)}…\n`)
    }

    if (role === 'committed') {
      if (bytes.length > COMMITTED_SIZE_WARN) {
        report.warnings.push(`${source}/${rel}: ${bytes.length} bytes is large for a synthetic fixture — is this a real saved page?`)
      }
      // .gitignore ignores fixtures/**/*.html and un-ignores only *.fixture.html. A committed
      // fixture named anything else is invisible to git, so it verifies on the author's
      // machine and is reported MISSING everywhere else, forever, with no visible cause.
      if (rel.endsWith('.html') && !rel.endsWith('.fixture.html')) {
        report.warnings.push(`${source}/${rel}: committed HTML must be named *.fixture.html or .gitignore swallows it`)
      }
    }
  }

  coverageFor(sourceDir, source, report)
  return manifest
}

// ── coverage ──────────────────────────────────────────────────────────────────

/**
 * Summarise field coverage from golden files, if any.
 *
 * A golden file is whatever the connector's test harness writes out: an array of Items, or an
 * object with an `items` array. Both shapes are accepted rather than one being declared
 * correct, because the number that matters here is "what fraction of rows carry a byline url",
 * and refusing to compute it over a container shape you did not expect helps nobody.
 */
function coverageFor(sourceDir, source, report) {
  const goldenDir = join(sourceDir, 'golden')
  if (!existsSync(goldenDir)) return

  const files = readdirSync(goldenDir).filter((f) => f.endsWith('.json')).sort()
  for (const file of files) {
    let doc
    try {
      doc = JSON.parse(readFileSync(join(goldenDir, file), 'utf8'))
    } catch (err) {
      report.errors.push(`${source}/golden/${file}: not valid JSON — ${err.message}`)
      continue
    }
    const items = Array.isArray(doc) ? doc : Array.isArray(doc?.items) ? doc.items : null
    if (!items) {
      report.warnings.push(`${source}/golden/${file}: no array of items found (expected an array or { items: [] })`)
      continue
    }
    if (!items.length) {
      process.stdout.write(`  coverage golden/${file}: 0 items\n`)
      continue
    }

    const metricKeys = new Set()
    for (const it of items) for (const k of Object.keys(it?.metrics ?? {})) metricKeys.add(k)
    const paths = [...COVERAGE_PATHS, ...[...metricKeys].sort().map((k) => `metrics.${k}`)]

    process.stdout.write(`  coverage golden/${file}: ${items.length} items\n`)
    for (const path of paths) {
      const hit = items.reduce((n, it) => n + (isPresent(readPath(it, path)) ? 1 : 0), 0)
      process.stdout.write(`      ${path.padEnd(22)} ${pct(hit, items.length)}  (${hit}/${items.length})\n`)
      report.coverage.push({ source, file, path, hit, total: items.length })
    }
  }
}

// ── main ──────────────────────────────────────────────────────────────────────

function main(argv) {
  const update = argv.includes('--update')

  if (!existsSync(FIXTURES_DIR)) {
    process.stdout.write('fixtures: no fixtures/ directory yet — nothing to verify.\n')
    return 0
  }

  const sources = readdirSync(FIXTURES_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('_') && !d.name.startsWith('.'))
    .map((d) => d.name)
    .sort()

  if (!sources.length) {
    process.stdout.write('fixtures: fixtures/ holds no source directories yet — nothing to verify.\n')
    return 0
  }

  const report = {
    verified: 0, skipped: 0, missing: 0, mismatched: 0,
    errors: [], warnings: [], unrecorded: [], coverage: [],
  }

  const manifests = new Map()
  for (const source of sources) {
    const dir = join(FIXTURES_DIR, source)
    const m = verifySource(dir, source, report)
    if (m) manifests.set(source, { dir, manifest: m })
  }

  if (update && report.unrecorded.length) {
    // Only ever fills a null. Overwriting a recorded hash would turn "this file changed under
    // me" into "this file is fine now", which is the one thing this script exists to prevent.
    for (const { source } of report.unrecorded) {
      const held = manifests.get(source)
      if (!held) continue
      for (const u of report.unrecorded.filter((x) => x.source === source)) {
        u.entry.bytes = u.bytes
        u.entry.sha256 = u.hash
      }
      writeFileSync(join(held.dir, 'MANIFEST.json'), `${JSON.stringify(held.manifest, null, 2)}\n`)
    }
    process.stdout.write(`\nfixtures --update: recorded ${report.unrecorded.length} previously null checksum(s).\n`)
    report.unrecorded.length = 0
  }

  process.stdout.write('\n')
  for (const w of report.warnings) process.stdout.write(`warn: ${w}\n`)
  for (const e of report.errors) process.stderr.write(`FAIL: ${e}\n`)

  process.stdout.write(
    `\nfixtures: ${report.verified} verified, ${report.skipped} skipped (local only), `
    + `${report.missing} missing, ${report.mismatched} MISMATCHED, ${report.unrecorded.length} unrecorded, `
    + `${report.warnings.length} warning(s) across ${sources.length} source(s).\n`,
  )

  // Absence never fails. A mismatch, an unparseable manifest or an unreadable golden file does.
  return report.errors.length ? 1 : 0
}

process.exitCode = main(process.argv.slice(2))
