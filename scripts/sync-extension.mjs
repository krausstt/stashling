/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Vendor `packages/*​/src` into `extension/vendor/`.
 *
 * WHY A COPY AND NOT A BUILD STEP. The extension ships with no bundler, and it cannot cheaply
 * acquire one:
 *
 *  1. Dynamic `import()` is not supported in an MV3 background service worker
 *     (w3c/webextensions#212), so the extension cannot load a package on demand.
 *  2. Fetching code at runtime is a Chrome Web Store rejection under the remote-hosted-code
 *     policy — see the header of packages/connectors/src/index.js.
 *  3. A static import cannot escape the extension root. `../../packages/core/src/index.js`
 *     resolves fine from a checkout and resolves to nothing at all once the directory is
 *     zipped and loaded as an extension, which is the worst possible time to find out.
 *
 * So the pure layers are COPIED in, byte for byte, with exactly one transformation: a
 * cross-package bare specifier (`@stashling/core`) becomes a relative path that resolves
 * inside vendor/. No minification, no transpile, no import inlining. The entire value of the
 * no-build scheme is that the file you debug in devtools is the file `node --test` tested.
 *
 * THE FAILURE MODE THIS SCRIPT IS BUILT AROUND is vendored code drifting from the source the
 * tests actually run. You fix a parser bug, the suite goes green, you ship, and the extension
 * keeps running last week's parser — with nothing anywhere reporting a problem. That is the
 * single most likely way a no-build vendoring scheme kills you, so `--check` names every
 * drifted file and CI runs it on every push.
 *
 * Usage:
 *   node scripts/sync-extension.mjs            write extension/vendor/
 *   node scripts/sync-extension.mjs --check    verify only, non-zero exit on any drift
 */

import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, posix, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const VENDOR_DIR = join(ROOT, 'extension', 'vendor')
const MANIFEST_NAME = 'VENDORED.json'

/**
 * Which packages get vendored and where they land.
 *
 * `vendorSub` is the directory name under vendor/, and it is load-bearing for everyone else:
 * the extension imports `./vendor/core/index.js` and `./vendor/connectors/index.js`. Renaming
 * one of these renames a public path that extension/ code hard-codes.
 */
const PACKAGES = [
  { name: '@stashling/core', dir: 'packages/core', vendorSub: 'core' },
  { name: '@stashling/connectors', dir: 'packages/connectors', vendorSub: 'connectors' },
]

const toPosix = (p) => p.split(sep).join('/')

// ── the specifier map ─────────────────────────────────────────────────────────

/**
 * Build `@stashling/core/item` → `core/item.js` from each package's own `exports` map.
 *
 * Derived rather than hard-coded on purpose: the day someone adds `"./triage": "./src/triage.js"`
 * to a package.json, a hard-coded table here would keep resolving the old set and the new
 * specifier would silently survive into vendor/ as an unresolvable bare import. Reading the
 * manifest means the two can never disagree.
 */
function buildSpecifierMap() {
  const map = new Map()
  for (const pkg of PACKAGES) {
    const manifestPath = join(ROOT, pkg.dir, 'package.json')
    const pj = JSON.parse(readFileSync(manifestPath, 'utf8'))
    for (const [sub, target] of Object.entries(pj.exports ?? {})) {
      // Conditional export objects ({ import, require }) are not used in this repo and would
      // need a resolution algorithm; skipping them keeps the map honest instead of guessing.
      if (typeof target !== 'string') continue
      const inPkg = target.replace(/^\.\//, '')
      if (!inPkg.startsWith('src/')) continue
      const specifier = sub === '.' ? pkg.name : `${pkg.name}/${sub.replace(/^\.\//, '')}`
      map.set(specifier, `${pkg.vendorSub}/${inPkg.slice('src/'.length)}`)
    }
  }
  return map
}

// Import forms, in the order they must be tried. `from '…'` covers `import x from`,
// `import {} from` and `export * from`; the other two cover the side-effect import and the
// dynamic one. Dynamic import is banned in MV3 workers (see the header) but a rewrite that
// quietly skipped it would produce a file that looks synced and is not.
const SPECIFIER_PATTERNS = [
  /(\bfrom\s+)(['"])([^'"\n]+)\2/g,
  /(\bimport\s*\(\s*)(['"])([^'"\n]+)\2/g,
  /(\bimport\s+)(['"])([^'"\n]+)\2/g,
]

/**
 * A RELATIVE cross-package import, resolved to its vendor location.
 *
 * This repo has no `node_modules` and never runs `npm install`, so the packages import each
 * other by relative path — `packages/connectors/src/youtube.js` says
 * `../../core/src/connector.js`. That is the honest form in the source tree and it is why the
 * whole thing runs with zero installs.
 *
 * It is also invisible to a rewriter that only looks for bare `@stashling/…` specifiers. The
 * copy lands at `vendor/connectors/youtube.js`, where `../../core/src/connector.js` points
 * outside the extension entirely — so the worker throws on startup with a module-not-found and
 * nothing upstream reported a thing. Left unhandled this is the bug that makes the whole
 * no-build vendoring scheme quietly not work.
 *
 * @returns {string|null} the vendor-relative target (`core/connector.js`), or null when the
 *                        import stays inside its own package and the plain copy already works.
 */
function resolveRelativeCrossPackage(spec, srcRel) {
  if (!spec.startsWith('./') && !spec.startsWith('../')) return null
  const resolved = posix.normalize(posix.join(posix.dirname(srcRel), spec))
  for (const pkg of PACKAGES) {
    const prefix = `${toPosix(pkg.dir)}/src/`
    if (resolved.startsWith(prefix)) return `${pkg.vendorSub}/${resolved.slice(prefix.length)}`
  }
  return null
}

/**
 * Rewrite cross-package specifiers so they resolve from `vendorRel`'s own directory.
 *
 * @param {string} srcRel repo-relative path of the SOURCE file, needed to resolve relative
 *                        specifiers against their real location rather than their copy's.
 */
function rewriteSpecifiers(code, vendorRel, srcRel, map, problems) {
  const fromDir = posix.dirname(vendorRel)
  const toVendorRelative = (target) => {
    let rel = posix.relative(fromDir, target)
    if (!rel.startsWith('.')) rel = `./${rel}`
    return rel
  }

  let rewrites = 0
  let out = code
  for (const pattern of SPECIFIER_PATTERNS) {
    out = out.replace(pattern, (whole, head, quote, spec) => {
      if (spec.startsWith('@stashling/')) {
        const target = map.get(spec)
        if (!target) {
          problems.push(`${vendorRel}: cannot resolve "${spec}" — add it to the package's "exports" map`)
          return whole
        }
        rewrites += 1
        return `${head}${quote}${toVendorRelative(target)}${quote}`
      }

      const crossPackage = resolveRelativeCrossPackage(spec, srcRel)
      if (!crossPackage) return whole
      const rel = toVendorRelative(crossPackage)
      if (rel === spec) return whole // already correct by luck of the layout
      rewrites += 1
      return `${head}${quote}${rel}${quote}`
    })
  }
  return { code: out, rewrites }
}

/**
 * After rewriting, every specifier must be relative.
 *
 * A browser and a service worker have no node_modules and no import map. A leftover bare
 * specifier — `@stashling/core` we failed to map, but equally `node:crypto` sneaking into what
 * is supposed to be a pure layer — throws at worker startup with a message that points at the
 * import site and explains nothing about why. Catching it here costs one regex pass.
 */
function findBareSpecifiers(code, vendorRel) {
  const bad = []
  for (const pattern of SPECIFIER_PATTERNS) {
    for (const m of code.matchAll(pattern)) {
      const spec = m[3]
      if (spec.startsWith('./') || spec.startsWith('../') || spec.startsWith('/')) continue
      // An unresolved `@stashling/…` already produced a precise "add it to exports" line; a
      // second, vaguer line about the same specifier only buries it.
      if (spec.startsWith('@stashling/')) continue
      bad.push(`${vendorRel}: non-relative import "${spec}" will not resolve inside the extension`)
    }
  }
  return bad
}

// ── file walking ──────────────────────────────────────────────────────────────

function walk(dir, base = dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const abs = join(dir, entry.name)
    if (entry.isDirectory()) walk(abs, base, out)
    else if (entry.isFile()) out.push(toPosix(relative(base, abs)))
  }
  return out
}

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')

/**
 * Compute what vendor/ SHOULD contain, without touching the disk.
 *
 * Both modes go through this one function so `--check` can never verify against a different
 * notion of "correct" than the writer produces. A checker with its own copy of the transform
 * is a checker that passes while the output is wrong.
 */
function planVendor() {
  const map = buildSpecifierMap()
  const problems = []
  const files = new Map() // vendorRel → { bytes: Buffer, from: string, rewrites: number }

  for (const pkg of PACKAGES) {
    const srcDir = join(ROOT, pkg.dir, 'src')
    if (!existsSync(srcDir)) {
      problems.push(`${pkg.dir}/src does not exist — nothing to vendor for ${pkg.name}`)
      continue
    }
    for (const rel of walk(srcDir)) {
      const vendorRel = `${pkg.vendorSub}/${rel}`
      const abs = join(srcDir, rel.split('/').join(sep))
      if (!rel.endsWith('.js')) {
        // .json and anything else travels verbatim as bytes. Only JS has import specifiers,
        // and re-encoding a file we do not need to read is a way to invent line-ending drift.
        files.set(vendorRel, { bytes: readFileSync(abs), from: toPosix(relative(ROOT, abs)), rewrites: 0 })
        continue
      }
      const source = readFileSync(abs, 'utf8')
      const srcRel = toPosix(relative(ROOT, abs))
      const { code, rewrites } = rewriteSpecifiers(source, vendorRel, srcRel, map, problems)
      problems.push(...findBareSpecifiers(code, vendorRel))
      files.set(vendorRel, { bytes: Buffer.from(code, 'utf8'), from: toPosix(relative(ROOT, abs)), rewrites })
    }
  }
  return { files, problems }
}

function gitCommit() {
  try {
    const out = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] })
    return out.toString().trim() || null
  } catch {
    // No git, no commits yet, or a tarball checkout. The provenance line is a nicety; the
    // sha256 per file is the part that actually proves anything.
    return null
  }
}

/**
 * The deterministic half of VENDORED.json.
 *
 * `commit` and `generatedAt` are deliberately NOT part of this: CI checks out a different
 * commit than the developer who ran the sync, and a timestamp changes every run, so including
 * either in the drift comparison would make `--check` fail permanently for reasons that have
 * nothing to do with the code. They stay in the file as provenance and out of the comparison.
 */
function manifestFileRows(files) {
  return [...files.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([vendorRel, f]) => ({
      vendor: vendorRel,
      from: f.from,
      bytes: f.bytes.length,
      sha256: sha256(f.bytes),
      rewritten: f.rewrites > 0,
    }))
}

function buildManifest(files) {
  return {
    schema: 1,
    generator: 'scripts/sync-extension.mjs',
    note: 'Generated. Do not edit by hand — run `npm run sync`. `commit` and `generatedAt` are provenance only and are excluded from `--check`.',
    commit: gitCommit(),
    generatedAt: new Date().toISOString(),
    files: manifestFileRows(files),
  }
}

// ── node --check ──────────────────────────────────────────────────────────────

/**
 * Syntax-check every vendored .js with the real parser.
 *
 * The rewrite is a regex over source text, which is exactly the kind of thing that produces a
 * file that looks right and does not parse. This is the cheap proof that it did not.
 */
function syntaxCheck(vendorRels) {
  const failures = []
  for (const rel of vendorRels) {
    if (!rel.endsWith('.js')) continue
    const abs = join(VENDOR_DIR, rel.split('/').join(sep))
    if (!existsSync(abs)) continue
    const r = spawnSync(process.execPath, ['--check', abs], { encoding: 'utf8' })
    if (r.status !== 0) failures.push(`${rel}: ${(r.stderr || '').trim().split('\n').slice(0, 3).join(' / ')}`)
  }
  return failures
}

// ── modes ─────────────────────────────────────────────────────────────────────

function writeVendor(files) {
  mkdirSync(VENDOR_DIR, { recursive: true })

  let written = 0
  let unchanged = 0
  for (const [rel, f] of files) {
    const abs = join(VENDOR_DIR, rel.split('/').join(sep))
    mkdirSync(dirname(abs), { recursive: true })
    if (existsSync(abs) && readFileSync(abs).equals(f.bytes)) { unchanged += 1; continue }
    writeFileSync(abs, f.bytes)
    written += 1
  }

  // Prune anything vendor/ holds that the plan does not produce — a connector deleted from
  // packages/ must not keep running in the extension. The path guard below is not paranoia
  // theatre: this is the only unlink in the repo, and it must be incapable of reaching a file
  // the user wrote by hand outside vendor/.
  const removed = []
  if (existsSync(VENDOR_DIR)) {
    for (const rel of walk(VENDOR_DIR)) {
      if (rel === MANIFEST_NAME || files.has(rel)) continue
      const abs = join(VENDOR_DIR, rel.split('/').join(sep))
      if (!abs.startsWith(VENDOR_DIR + sep)) throw new Error(`refusing to delete outside vendor/: ${abs}`)
      rmSync(abs)
      removed.push(rel)
    }
  }

  writeFileSync(join(VENDOR_DIR, MANIFEST_NAME), `${JSON.stringify(buildManifest(files), null, 2)}\n`)
  return { written, unchanged, removed }
}

function checkVendor(files) {
  const drift = []

  if (!existsSync(VENDOR_DIR)) {
    return [`extension/vendor/ does not exist — run \`npm run sync\` (${files.size} files missing)`]
  }

  const onDisk = new Set(walk(VENDOR_DIR))
  for (const [rel, f] of files) {
    const abs = join(VENDOR_DIR, rel.split('/').join(sep))
    if (!onDisk.has(rel)) { drift.push(`  - vendor/${rel}  MISSING (expected from ${f.from})`); continue }
    const actual = readFileSync(abs)
    if (!actual.equals(f.bytes)) {
      drift.push(`  M vendor/${rel}  DIFFERS from ${f.from}  (expected sha256 ${sha256(f.bytes).slice(0, 12)}…, found ${sha256(actual).slice(0, 12)}…, ${f.bytes.length} vs ${actual.length} bytes)`)
    }
  }
  for (const rel of onDisk) {
    if (rel === MANIFEST_NAME || files.has(rel)) continue
    drift.push(`  + vendor/${rel}  STALE — no such file under packages/*/src`)
  }

  const manifestPath = join(VENDOR_DIR, MANIFEST_NAME)
  if (!existsSync(manifestPath)) {
    drift.push(`  - vendor/${MANIFEST_NAME}  MISSING`)
  } else {
    let recorded = null
    try { recorded = JSON.parse(readFileSync(manifestPath, 'utf8')) } catch (err) {
      drift.push(`  M vendor/${MANIFEST_NAME}  UNPARSEABLE (${err.message})`)
    }
    if (recorded) {
      const expected = JSON.stringify(manifestFileRows(files))
      if (JSON.stringify(recorded.files ?? null) !== expected) {
        drift.push(`  M vendor/${MANIFEST_NAME}  file list/hashes are stale`)
      }
    }
  }
  return drift
}

// ── main ──────────────────────────────────────────────────────────────────────

function main(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write('usage: node scripts/sync-extension.mjs [--check]\n')
    return 0
  }
  const checkOnly = argv.includes('--check')

  const { files, problems } = planVendor()
  if (problems.length) {
    process.stderr.write(`sync-extension: ${problems.length} problem(s) in the source packages:\n`)
    for (const p of problems) process.stderr.write(`  ! ${p}\n`)
    return 2
  }

  if (checkOnly) {
    const drift = checkVendor(files)
    if (drift.length) {
      process.stderr.write(`sync-extension --check: DRIFT in ${drift.length} file(s).\n`)
      process.stderr.write(`${drift.join('\n')}\n`)
      process.stderr.write('\nextension/vendor/ is not what packages/*/src produces, so the extension is running\n')
      process.stderr.write('code that `node --test` never tested. Fix with: npm run sync\n')
      return 1
    }
    const failures = syntaxCheck([...files.keys()])
    if (failures.length) {
      process.stderr.write(`sync-extension --check: ${failures.length} vendored file(s) fail node --check:\n`)
      for (const f of failures) process.stderr.write(`  ! ${f}\n`)
      return 1
    }
    const rewritten = [...files.values()].filter((f) => f.rewrites > 0).length
    process.stdout.write(`sync-extension --check: OK — ${files.size} files in sync (${rewritten} with rewritten imports).\n`)
    return 0
  }

  const { written, unchanged, removed } = writeVendor(files)
  const failures = syntaxCheck([...files.keys()])
  if (failures.length) {
    process.stderr.write(`sync-extension: ${failures.length} vendored file(s) fail node --check:\n`)
    for (const f of failures) process.stderr.write(`  ! ${f}\n`)
    return 1
  }

  const rewritten = [...files.entries()].filter(([, f]) => f.rewrites > 0)
  process.stdout.write(`sync-extension: ${files.size} files → extension/vendor/ (${written} written, ${unchanged} unchanged, ${removed.length} pruned)\n`)
  for (const [rel, f] of rewritten) process.stdout.write(`  ~ vendor/${rel}  ${f.rewrites} import(s) rewritten to relative paths\n`)
  for (const rel of removed) process.stdout.write(`  - vendor/${rel}  pruned (gone from packages/)\n`)
  process.stdout.write(`  ✓ node --check passed on every vendored .js\n`)
  process.stdout.write(`  ✓ wrote extension/vendor/${MANIFEST_NAME}\n`)
  return 0
}

process.exitCode = main(process.argv.slice(2))
