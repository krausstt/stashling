/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Static checks on the extension that CI can run without a browser.
 *
 * These are cheap and they catch the class of bug that is otherwise found by a human loading the
 * unpacked extension and staring at an empty popup: a manifest pointing at a file that does not
 * exist, an import that does not resolve, a `permissions` entry the code never uses, or an API
 * the code calls that the manifest never asked for. None of those raise an error at build time,
 * because there is no build.
 *
 *   node scripts/check-extension.mjs
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const EXT = path.join(ROOT, 'extension')

const problems = []
const notes = []
const fail = (m) => problems.push(m)

// ── manifest ──────────────────────────────────────────────────────────────────

const manifestPath = path.join(EXT, 'manifest.json')
if (!existsSync(manifestPath)) {
  console.error('extension/manifest.json is missing')
  process.exit(1)
}

let manifest
try {
  manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
} catch (err) {
  console.error(`extension/manifest.json is not valid JSON — ${err.message}`)
  process.exit(1)
}

if (manifest.manifest_version !== 3) fail(`manifest_version is ${manifest.manifest_version}, expected 3`)

/**
 * Firefox has no background service worker at all (bug 1573659) and Safari's MV3 service-worker
 * debugging is broken, so a manifest that declares only `service_worker` ships a Chromium-only
 * extension by accident. Declaring BOTH is the documented portable form.
 */
if (!manifest.background?.service_worker) fail('background.service_worker is missing (Chrome needs it)')
if (!Array.isArray(manifest.background?.scripts) || !manifest.background.scripts.length) {
  fail('background.scripts is missing — Firefox does not support service workers and needs the event-page form')
}

/**
 * Static host permissions covering every connector is a Chrome Web Store finding (excessive
 * permissions, which is then read as evidence of unrelated functionality) and is also just
 * untrue to the design: an unused connector should hold no access.
 */
if (manifest.host_permissions?.length) {
  fail(`host_permissions declares ${manifest.host_permissions.length} static host(s) — `
    + 'these belong in optional_host_permissions, requested at activation')
}
if (!manifest.optional_host_permissions?.length) {
  fail('optional_host_permissions is empty — no connector could ever be granted access')
}

// Firefox refuses NEW submissions without a data-collection declaration (required since 2025-11-03).
if (!manifest.browser_specific_settings?.gecko?.data_collection_permissions) {
  fail('browser_specific_settings.gecko.data_collection_permissions is missing — '
    + 'AMO requires it for new extensions since 2025-11-03')
}

if (manifest.minimum_chrome_version) {
  notes.push('minimum_chrome_version is set: users below it stop receiving updates entirely, '
    + 'including security fixes. The globalThis.browser shim covers the same ground without that cost.')
}

// ── referenced files exist ────────────────────────────────────────────────────

const refs = new Set()
const addRef = (p) => { if (typeof p === 'string' && p && !/^https?:/i.test(p)) refs.add(p) }
addRef(manifest.action?.default_popup)
addRef(manifest.options_ui?.page)
addRef(manifest.background?.service_worker)
for (const s of manifest.background?.scripts ?? []) addRef(s)
for (const i of Object.values(manifest.icons ?? {})) addRef(i)
for (const cs of manifest.content_scripts ?? []) {
  for (const s of [...(cs.js ?? []), ...(cs.css ?? [])]) addRef(s)
}

for (const ref of refs) {
  if (!existsSync(path.join(EXT, ref))) fail(`manifest references a file that does not exist: ${ref}`)
}

// ── the import graph resolves ─────────────────────────────────────────────────

const reachable = new Set()

/**
 * Blank out comments and string/template literals so a check reads CODE.
 *
 * Crude by design — it is a lexical blanking pass, not a parser, and it only has to be right
 * enough that prose about an API is not mistaken for a call to it. It replaces rather than
 * deletes so byte offsets stay usable.
 */
function stripCommentsAndStrings(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => ' '.repeat(m.length))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(m.length - p1.length))
    .replace(/`(?:\\.|[^`\\])*`/g, (m) => ' '.repeat(m.length))
    .replace(/'(?:\\.|[^'\\\n])*'/g, (m) => ' '.repeat(m.length))
    .replace(/"(?:\\.|[^"\\\n])*"/g, (m) => ' '.repeat(m.length))
}

function walk(file) {
  const real = path.resolve(file)
  if (reachable.has(real)) return
  if (!existsSync(real)) return
  reachable.add(real)

  const src = readFileSync(real, 'utf8')
  for (const m of src.matchAll(/(?:from|import)\s*\(?\s*['"](\.[^'"]+)['"]/g)) {
    const target = path.resolve(path.dirname(real), m[1])
    if (!existsSync(target)) {
      fail(`${path.relative(ROOT, real)} imports "${m[1]}", which does not exist`)
      continue
    }
    if (target.endsWith('.js')) walk(target)
  }
  // Dynamic import() is unsupported in an MV3 background service worker (w3c/webextensions#212).
  // Static-only is a hard constraint, not a style rule, so it is checked rather than trusted —
  // but comments in this repo discuss the ban by name, so the check runs on code only.
  if (real.endsWith('sw.js') && /\bimport\s*\(/.test(stripCommentsAndStrings(src))) {
    fail(`${path.relative(ROOT, real)} uses dynamic import(), which does not work in an MV3 service worker`)
  }
}

const entries = ['sw.js', 'popup.js', 'ui/collection.js']
  .map((f) => path.join(EXT, f))
  .filter((f) => existsSync(f))
for (const entry of entries) walk(entry)

for (const html of ['popup.html', 'ui/collection.html']) {
  const file = path.join(EXT, html)
  if (!existsSync(file)) continue
  const src = readFileSync(file, 'utf8')
  for (const m of src.matchAll(/(?:src|href)="([^"]+)"/g)) {
    if (/^https?:|^data:|^#/.test(m[1])) {
      fail(`${html} references a remote resource: ${m[1]} — MV3 forbids remotely hosted code, `
        + 'and remote CSS/fonts leak the fact that the page was opened')
      continue
    }
    if (!existsSync(path.resolve(path.dirname(file), m[1]))) {
      fail(`${html} references "${m[1]}", which does not exist`)
    }
  }
}

// ── permissions actually used ─────────────────────────────────────────────────

const allSource = [...reachable].map((f) => readFileSync(f, 'utf8')).join('\n')
const API_FOR = {
  scripting: /\b(?:browser|chrome)\.scripting\./,
  storage: /\b(?:browser|chrome)\.storage\./,
  alarms: /\b(?:browser|chrome)\.alarms\b/,
  downloads: /\b(?:browser|chrome)\.downloads\./,
  tabs: /\b(?:browser|chrome)\.tabs\./,
}
for (const [perm, re] of Object.entries(API_FOR)) {
  const declared = (manifest.permissions ?? []).includes(perm)
  const used = re.test(allSource)
  if (used && !declared && perm !== 'tabs') {
    // `tabs` is the exception: tabs.query works under activeTab for the current tab.
    fail(`the code calls ${perm} but the manifest does not request the "${perm}" permission`)
  }
  if (declared && !used) {
    notes.push(`"${perm}" is requested but never used — every unused permission is a review finding`)
  }
}

if (/\bpermissions\.request\(/.test(allSource) && !/popup\.js/.test([...reachable].join(' '))) {
  notes.push('permissions.request() must run inside a user gesture; make sure its only caller is a click handler')
}

// ── vendored code is present ──────────────────────────────────────────────────

const vendor = path.join(EXT, 'vendor')
if (!existsSync(vendor)) {
  fail('extension/vendor is missing — run `npm run sync`')
} else {
  const count = (function countJs(dir) {
    let n = 0
    for (const entry of readdirSync(dir)) {
      const p = path.join(dir, entry)
      n += statSync(p).isDirectory() ? countJs(p) : (entry.endsWith('.js') ? 1 : 0)
    }
    return n
  })(vendor)
  if (!count) fail('extension/vendor contains no JavaScript — run `npm run sync`')
}

// ── the collection UI renders every facet type core supports ──────────────────

/**
 * A connector declaring a facet type the UI does not render gets a filter that silently does
 * nothing: `matchesFilter` honours it, so the filter is real, but no control is ever drawn.
 * That shipped — `makerworld` declared two `bool` facets and the UI branched only on `range`
 * and `term`, so "A1 mini" and "Prints without AMS" were invisible while looking implemented.
 *
 * The two files cannot enforce this on each other at runtime, and no test loads the DOM, so it
 * is checked lexically here instead. Strings are deliberately NOT blanked out: string literals
 * are exactly what is being matched.
 */
const facetsFile = path.join(EXT, 'vendor', 'core', 'facets.js')
const collectionFile = path.join(EXT, 'ui', 'collection.js')
if (!existsSync(facetsFile) || !existsSync(collectionFile)) {
  notes.push('facet-coverage check skipped — vendor/core/facets.js or ui/collection.js is missing')
} else {
  const declared = /FACET_TYPES\s*=\s*new Set\(\[([\s\S]*?)\]\)/.exec(readFileSync(facetsFile, 'utf8'))
  if (!declared) {
    notes.push('facet-coverage check skipped — could not find FACET_TYPES in vendor/core/facets.js')
  } else {
    const types = [...declared[1].matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1])
    const ui = readFileSync(collectionFile, 'utf8')
    const handled = types.filter((t) => new RegExp(
      `facet\\.type\\s*===\\s*['"]${t}['"]|case\\s*['"]${t}['"]`).test(ui))
    for (const t of types) {
      if (!handled.includes(t)) {
        fail(`core supports the "${t}" facet type but ui/collection.js never renders a control `
          + 'for it — a connector declaring it would get a filter that silently does nothing')
      }
    }
    if (types.length) {
      notes.push(`facet coverage: ${handled.length}/${types.length} core facet types render `
        + `(${types.join(', ')})`)
    }
  }
}

// ── report ────────────────────────────────────────────────────────────────────

process.stdout.write(`check-extension: ${reachable.size} module(s) reachable from `
  + `${entries.length} entry point(s), ${refs.size} manifest reference(s)\n`)
for (const n of notes) process.stdout.write(`  note: ${n}\n`)
for (const p of problems) process.stdout.write(`  FAIL: ${p}\n`)

if (problems.length) {
  process.stdout.write(`\ncheck-extension: ${problems.length} problem(s)\n`)
  process.exit(1)
}
process.stdout.write('check-extension: OK\n')
