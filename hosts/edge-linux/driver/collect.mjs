#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * One collection sweep on the always-on box. Run by `stashling-collect.timer`.
 *
 * This file is a HOST, in the sense `packages/core/src/connector.js` means it: the connector
 * declares `dom-active-tab` and never implements it; the extension implements the capture; and
 * this implements the two things the extension cannot — *scheduling* and *navigation*.
 *
 *     stashling-collect.timer  ->  this  ->  CDP  ->  extension page  ->  sw.js `collect`
 *
 * WHY IT DRIVES AN EXTENSION PAGE AND NOT THE SERVICE WORKER. `chrome.runtime.sendMessage`
 * dispatches to every frame of the extension EXCEPT the sender's own, so a `sendMessage` issued
 * inside sw.js never reaches sw.js's own `onMessage`. The call resolves, nothing logs, and the
 * run that never happened is indistinguishable from a quiet day. So the driver opens
 * `ui/collection.html` and sends from there.
 *
 * WHY THE SITE TAB MUST BE THE ACTIVE TAB. The capture auto-scrolls a virtualized list until
 * the row count stops growing. A virtualized list materialises rows through
 * IntersectionObserver and requestAnimationFrame, and Chromium's position is that
 * IntersectionObserver does not fire in inactive tabs — intended behaviour, not a bug. A
 * background tab therefore materialises its first screenful, the count stops growing because
 * nothing is rendering, and `settled: true` comes back having collected a fraction of the list.
 * Nothing errors. Nothing times out.
 *
 * That failure is the reason for `minRows`. A capture that is quietly 7% complete is worse than
 * one that fails, because the first one gets merged into the store and the second one gets
 * fixed. `settled` is the connector's own honest report that it stopped growing; `minRows` is
 * the operator's assertion that it stopped growing *in the right place*. Both are checked, and
 * a sweep that fails either exits non-zero so the unit goes red.
 *
 * The flags often recommended for this — `--disable-renderer-backgrounding` and friends — are
 * accepted by Chrome and govern process priority and timer budgets, not a tab's visibility
 * state. Treating them as a fix for this is how you stop looking for the real cause.
 */

import {
  mkdirSync, writeFileSync, readFileSync, openSync, closeSync, unlinkSync, realpathSync,
} from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { Cdp, discover, evaluate } from './cdp.mjs'

const DEFAULT_CONFIG = '/etc/stashling/stashling.json'
const DEFAULT_EXTENSION_DIR = '/opt/stashling/extension'

/**
 * Longer than the collect unit's TimeoutStartSec (20 min). A lock older than that cannot belong to
 * a live sweep: systemd would already have killed it — and a killed process never runs `finally`.
 */
const DEFAULT_STALE_LOCK_MS = 25 * 60_000

/** Paths a platform sends you to when the session is gone or a challenge is in the way. */
const DEFAULT_BLOCKED = [
  'accounts\\.google\\.com',
  'consent\\.(youtube|google)\\.',
  '/sorry/',            // Google's rate-limit / unusual-traffic interstitial
  '/signin\\b',
  '/login\\b',
  '/challenge\\b',
  '/captcha\\b',
]

const log = (...a) => console.log(...a)
const warn = (...a) => console.error(...a)
const jitter = (lo, hi) => lo + Math.floor(Math.random() * Math.max(1, hi - lo))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ── config ──────────────────────────────────────────────────────────────────────────────────

export function validateConfig(cfg) {
  const p = []
  if (!cfg || typeof cfg !== 'object') return ['config is not an object']
  if (!cfg.profileDir) p.push('profileDir is required (the --user-data-dir Chrome was started with)')
  if (!Array.isArray(cfg.targets) || cfg.targets.length === 0) {
    p.push('targets must be a non-empty array')
  } else {
    cfg.targets.forEach((t, i) => {
      if (!t?.name) p.push(`targets[${i}]: name is required`)
      if (!t?.url) p.push(`targets[${i}]: url is required`)
      else if (!/^https:\/\//i.test(t.url)) p.push(`targets[${i}]: url must be https`)
      // A floor of 0 is not a floor. Requiring it to be set is what stops the silent-truncation
      // failure from being opt-in: you cannot configure a target without stating what "enough"
      // means for it.
      if (!Number.isInteger(t?.minRows) || t.minRows < 1) {
        p.push(`targets[${i}]: minRows must be an integer >= 1 — the row count below which a `
          + 'capture is treated as truncated rather than complete')
      }
    })
  }
  return p
}

export function loadConfig(file) {
  const cfg = JSON.parse(readFileSync(file, 'utf8'))
  const problems = validateConfig(cfg)
  if (problems.length) {
    throw new Error(`invalid ${file}:\n  - ${problems.join('\n  - ')}`)
  }
  return {
    exportDir: null,
    extensionDir: DEFAULT_EXTENSION_DIR,
    extensionId: null,
    staleLockMs: DEFAULT_STALE_LOCK_MS,
    stateDir: '/var/lib/stashling/state',
    betweenTargetsMs: [20_000, 90_000],
    blockedUrlPatterns: DEFAULT_BLOCKED,
    pageLoadTimeoutMs: 60_000,
    collectTimeoutMs: 8 * 60_000,
    ...cfg,
  }
}

// ── a lock, because two sweeps at once is two Chromes fighting over one active tab ──────────

/** Is that pid a running process? `kill(pid, 0)` delivers nothing; it only asks. */
function pidIsAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // EPERM: it exists and belongs to someone else — alive. ESRCH: no such process.
    return err?.code === 'EPERM'
  }
}

/**
 * May this lock be taken over? PURE, so the decision is testable without killing anything.
 *
 * WHY THIS EXISTS. The lock is released in a `finally`, and a process that systemd kills at
 * `TimeoutStartSec` never runs its `finally`. The first version of this driver therefore had a
 * failure mode worse than any it guarded against: one hung sweep left `collect.lock` behind —
 * across reboots, since it lives in /var/lib — and every later tick logged "already running",
 * exited 0, and kept the unit green while nothing was ever collected again.
 *
 * Stale if the recorded pid is gone, OR the lock is older than any live sweep could be. The age
 * test covers pid reuse after a reboot, where the number may now belong to an unrelated process.
 * An unparseable lock is stale: something that cannot say who holds it holds nothing.
 */
export function lockIsStale(text, { now = Date.now(), maxAgeMs = DEFAULT_STALE_LOCK_MS, isAlive = pidIsAlive } = {}) {
  const pid = Number.parseInt((/\bpid=(\d+)/.exec(String(text ?? '')) ?? [])[1], 10)
  const started = Date.parse((/\bstarted=(\S+)/.exec(String(text ?? '')) ?? [])[1])
  if (!Number.isInteger(pid) || pid <= 0 || !Number.isFinite(started)) return { stale: true, why: 'unparseable' }
  if (now - started > maxAgeMs) return { stale: true, why: `older than ${Math.round(maxAgeMs / 60_000)} min` }
  if (!isAlive(pid)) return { stale: true, why: `pid ${pid} is not running` }
  return { stale: false, why: `pid ${pid} is running` }
}

function takeLock(stateDir, { maxAgeMs = DEFAULT_STALE_LOCK_MS } = {}) {
  mkdirSync(stateDir, { recursive: true })
  const file = path.join(stateDir, 'collect.lock')

  for (let attempt = 0; attempt < 2; attempt += 1) {
    let fd
    try {
      fd = openSync(file, 'wx')           // O_CREAT|O_EXCL — atomic
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err
      let held = ''
      try { held = readFileSync(file, 'utf8').trim() } catch { continue /* released while we looked */ }
      const verdict = lockIsStale(held, { maxAgeMs })
      if (!verdict.stale || attempt > 0) return { ok: false, file, held }
      // Said out loud, because reclaiming a lock is exactly the event you want in the journal if
      // the cause turns out to be a sweep that keeps hanging.
      warn(`reclaiming a stale lock (${verdict.why}): ${held}`)
      try { unlinkSync(file) } catch { /* someone else reclaimed it first */ }
      continue
    }
    writeFileSync(fd, `pid=${process.pid} started=${new Date().toISOString()}\n`)
    closeSync(fd)
    return {
      ok: true,
      file,
      release() { try { unlinkSync(file) } catch { /* already gone */ } },
    }
  }
  return { ok: false, file, held: 'contended' }
}

// ── talking to the extension ────────────────────────────────────────────────────────────────

/**
 * Find the extension by its service-worker target and return its id.
 *
 * Deliberately derived rather than configured: an unpacked extension's id comes from the path
 * it was loaded from, so writing it into a config file is a footgun waiting for the day the
 * directory moves. The service worker is `sw.js` at the extension root, which is specific
 * enough to identify this extension and nothing else.
 */
export function extensionIdFrom(targets, { swPath = '/sw.js' } = {}) {
  const sw = targets.find((t) => t.type === 'service_worker' && String(t.url).endsWith(swPath))
  if (!sw) return null
  const m = /^chrome-extension:\/\/([a-p]{32})\//.exec(sw.url)
  return m ? m[1] : null
}

/**
 * Chrome's id for an UNPACKED extension: SHA-256 of its absolute path, first 16 bytes, hex,
 * each hex digit 0-f mapped onto the letters a-p.
 *
 * WHY THE ID IS DERIVED AND NOT READ OFF A RUNNING WORKER. An MV3 service worker is terminated
 * after ~30 s idle (sw.js says so in its own header), and the keepalive alarm only runs during a
 * collect. The timer fires every half hour, so the worker is almost always ASLEEP when a sweep
 * starts — and a sleeping worker has no DevTools target. The first version of this driver read
 * the id only from that target, so "asleep" and "not installed" were the same answer, and most
 * sweeps would have failed with "the service worker is not running". The path does not sleep.
 *
 * The derivation is checked, not trusted: `openExtensionPage` compares it to `chrome.runtime.id`
 * inside the page, and `extensionId` in the config overrides it if the two ever disagree.
 */
export function unpackedExtensionId(absPath) {
  return createHash('sha256').update(String(absPath)).digest('hex').slice(0, 32)
    .replace(/[0-9a-f]/g, (c) => String.fromCharCode(97 + Number.parseInt(c, 16)))
}

/**
 * Which id should this sweep talk to? An explicit `extensionId` wins; otherwise the id derived
 * from the install path. A running worker is only CORROBORATION — another extension can also
 * have a `/sw.js`, so a worker is evidence about state, never about identity.
 */
export function resolveExtensionId(targets, { extensionDir, extensionId } = {}) {
  if (extensionId) return { id: extensionId, via: 'config', awake: Boolean(findWorker(targets, extensionId)) }
  if (!extensionDir) {
    const running = extensionIdFrom(targets)
    return { id: running, via: running ? 'service-worker' : null, awake: Boolean(running) }
  }
  let resolved = extensionDir
  try { resolved = realpathSync(extensionDir) } catch { /* not on this machine; hash the configured path */ }
  const id = unpackedExtensionId(resolved)
  return { id, via: 'path', path: resolved, awake: Boolean(findWorker(targets, id)) }
}

function findWorker(targets, id) {
  return (targets ?? []).find((t) => t.type === 'service_worker'
    && String(t.url).startsWith(`chrome-extension://${id}/`))
}

/** Send one message to sw.js from an extension page and return its reply. */
function sendMessage(cdp, sessionId, type, payload, timeoutMs) {
  const expr = `chrome.runtime.sendMessage(${JSON.stringify({ type, payload })})`
  return evaluate(cdp, sessionId, expr, { timeoutMs })
}

// ── one target ──────────────────────────────────────────────────────────────────────────────

async function sweepTarget(cdp, extId, target, cfg) {
  const started = Date.now()
  const out = { name: target.name, url: target.url, ok: false }

  // 1. A tab of our own at the list URL. Created fresh each sweep rather than reused: a tab left
  //    open for days is exactly the one Chrome's memory saver discards, and a discarded tab
  //    keeps its title and favicon so it looks perfectly healthy right up until the capture
  //    comes back as a login wall.
  // 2. …and its load event, with a deadline of its own. See `openPage` for why the tab is born
  //    blank and navigated afterwards.
  let siteTarget
  let site
  try {
    ({ targetId: siteTarget, sessionId: site } = await openPage(cdp, target.url, cfg.pageLoadTimeoutMs))
  } catch (err) {
    out.reason = 'error'
    out.detail = err?.message ?? String(err)
    out.ms = Date.now() - started
    return out
  }

  try {
    // 3. THE ACTIVE TAB. Both calls: activateTarget selects the tab in its window,
    //    bringToFront raises the window. Without a window manager the second is a no-op, which
    //    is one reason the bootstrap installs openbox.
    await cdp.send('Target.activateTarget', { targetId: siteTarget })
    await cdp.send('Page.bringToFront', {}, { sessionId: site })

    // 4. Where did we actually end up? A session that lapsed overnight redirects to a sign-in
    //    page that returns 200 and parses to zero rows.
    const finalUrl = await evaluate(cdp, site, 'location.href', { awaitPromise: false })
    out.finalUrl = finalUrl
    const blocked = (cfg.blockedUrlPatterns ?? []).find((re) => new RegExp(re, 'i').test(String(finalUrl)))
    if (blocked) {
      out.reason = 'needs-human'
      out.detail = `redirected to ${finalUrl} (matched /${blocked}/)`
      return out
    }

    // 5. Does the extension still hold the host permission? It cannot be re-granted from here —
    //    `permissions.request()` needs a real user gesture and CDP cannot supply one — so this
    //    is a check that ends the sweep, not one that triggers a fix.
    const extPage = await openExtensionPage(cdp, extId, cfg.pageLoadTimeoutMs)
    const page = extPage.sessionId
    try {
      // Creating that tab stole focus. Give it back before anything scrolls.
      await cdp.send('Target.activateTarget', { targetId: siteTarget })

      const described = await sendMessage(cdp, page, 'describeTab', { url: target.url }, 30_000)
      if (!described || described.error) {
        out.reason = 'extension-unreachable'
        out.detail = described?.error ?? 'no reply from the service worker'
        return out
      }
      if (!described.connector) {
        out.reason = 'no-connector'
        out.detail = `no bundled connector matches ${target.url}`
        return out
      }
      out.connector = described.connector.id
      out.list = described.list?.id ?? null
      if (!described.hasPermission) {
        out.reason = 'needs-human'
        out.detail = `host permission not granted for ${(described.origins ?? []).join(', ')} `
          + '— grant it once in the VNC session; a timer cannot'
        return out
      }

      // 6. Which tab is that, in the extension's numbering? `active + currentWindow` needs no
      //    "tabs" permission, and after the re-activation above the active tab is ours.
      const tabId = await evaluate(cdp, page,
        'chrome.tabs.query({active:true,currentWindow:true}).then(t => t[0]?.id ?? null)',
        { timeoutMs: 15_000 })
      if (typeof tabId !== 'number') {
        out.reason = 'no-tab-id'
        return out
      }

      // 7. The run. Generous timeout: the capture auto-scrolls for up to `autoScroll.maxMs`
      //    (120 s for YouTube) and then parses, normalises and stores several hundred rows.
      //    Keep this under the service worker's five-minute-per-request ceiling plus slack —
      //    beyond that Chrome kills the handler mid-run and the caller is told nothing.
      const res = await sendMessage(cdp, page, 'collect', { tabId, url: target.url }, cfg.collectTimeoutMs)
      out.result = res

      if (!res || res.error) {
        out.reason = 'collect-failed'
        out.detail = res?.error ?? 'no reply'
        return out
      }
      if (!res.ok) {
        out.reason = res.reason ?? 'collect-refused'
        out.detail = JSON.stringify(res).slice(0, 400)
        return out
      }

      out.rowsSeen = res.rowsSeen ?? 0
      out.parsed = res.parsed ?? 0
      out.added = res.added ?? 0
      out.merged = res.merged ?? 0
      out.settled = Boolean(res.settled)
      out.stoppedBecause = res.stoppedBecause ?? null

      // 8. The two completeness assertions. Order matters for the message: a short capture that
      //    also hit the deadline is a scroll-budget problem, not a login problem.
      if (!out.settled) {
        out.reason = 'not-settled'
        out.detail = `the scroll stopped because "${out.stoppedBecause}", not because the list `
          + 'ended — raise acquisition.autoScroll.maxMs or accept a partial capture'
        return out
      }
      if (out.rowsSeen < target.minRows) {
        out.reason = 'truncated'
        out.detail = `saw ${out.rowsSeen} rows, expected at least ${target.minRows}. `
          + 'A settled scroll that is short usually means the tab was not visible, or the '
          + 'session is half-logged-in.'
        return out
      }

      out.ok = true
      return out
    } finally {
      await cdp.send('Target.closeTarget', { targetId: extPage.targetId }).catch(() => {})
    }
  } catch (err) {
    out.reason = 'error'
    out.detail = err?.message ?? String(err)
    return out
  } finally {
    out.ms = Date.now() - started
    await cdp.send('Target.closeTarget', { targetId: siteTarget }).catch(() => {})
  }
}

function waitForLoad(cdp, sessionId, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { off(); reject(new Error(`page load timed out after ${timeoutMs}ms`)) }, timeoutMs)
    timer.unref?.()
    const off = cdp.on('Page.loadEventFired', (_p, sid) => {
      if (sid && sid !== sessionId) return
      clearTimeout(timer)
      off()
      resolve()
    })
  })
}

/**
 * Open a tab at `url` and resolve once its load event has fired.
 *
 * The tab is created at about:blank and navigated only AFTER the session exists, Page.enable has
 * run and the listener is in place. Creating it directly at the URL — the first version — races:
 * navigation starts before there is a session to report it, a fast or cached load fires its load
 * event before Page.enable, and the wait then times out on a page that loaded perfectly well. The
 * same race made the very next Runtime.evaluate land in the initial about:blank document, where
 * `chrome.runtime` does not exist.
 */
export async function openPage(cdp, url, timeoutMs) {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' })
  try {
    const sessionId = await cdp.attach(targetId)
    await cdp.send('Page.enable', {}, { sessionId })
    await cdp.send('Runtime.enable', {}, { sessionId })
    const loaded = waitForLoad(cdp, sessionId, timeoutMs)
    // Handled now, awaited below: if navigate throws first, a load timeout firing later must not
    // become an unhandled rejection, which Node turns into a crash.
    loaded.catch(() => {})
    const nav = await cdp.send('Page.navigate', { url }, { sessionId })
    if (nav?.errorText) throw new Error(`navigating to ${url} failed: ${nav.errorText}`)
    await loaded
    return { targetId, sessionId }
  } catch (err) {
    await cdp.send('Target.closeTarget', { targetId }).catch(() => {})
    throw err
  }
}

/**
 * Open the extension's own page and PROVE it is the extension we think it is.
 *
 * Loading a chrome-extension:// page is also what wakes a sleeping service worker: the worker is
 * started on demand by the first message sent to it. `chrome.runtime.id` inside the page is the
 * ground truth for the derived id; a mismatch, or no `chrome.runtime` at all, means the
 * extension is not loaded from where the config says it is.
 */
export async function openExtensionPage(cdp, extId, timeoutMs) {
  const url = `chrome-extension://${extId}/ui/collection.html`
  let opened
  try {
    opened = await openPage(cdp, url, timeoutMs)
  } catch (err) {
    throw new Error(`the Stashling extension is not loaded as ${extId} (${err?.message ?? err}). `
      + 'Open chrome://extensions over VNC: is it loaded unpacked from the configured extensionDir, '
      + 'and is Developer mode still ON? If its id differs, set "extensionId" in the config.')
  }
  const seen = await evaluate(cdp, opened.sessionId, 'globalThis.chrome?.runtime?.id ?? null',
    { awaitPromise: false, timeoutMs: 10_000 }).catch(() => null)
  if (seen !== extId) {
    await cdp.send('Target.closeTarget', { targetId: opened.targetId }).catch(() => {})
    throw new Error(`expected extension ${extId}, but the page reports ${seen ?? 'no extension at all'}. `
      + 'Set "extensionId" in the config to the id shown on chrome://extensions.')
  }
  return opened
}

// ── the sweep ───────────────────────────────────────────────────────────────────────────────

export async function sweep(cfg) {
  const found = await discover(cfg.profileDir, { timeoutMs: 30_000 })
  if (!found.ok) {
    throw new Error(
      `no DevTools endpoint in ${cfg.profileDir} (${found.reason}). `
      + 'Is stashling-chrome.service up? Note that since Chrome 136 a Google-branded build '
      + 'silently ignores --remote-debugging-port when --user-data-dir is the default one.',
    )
  }
  log(`devtools: ${found.browser ?? 'chrome'} on port ${found.port}`)

  const cdp = await new Cdp(found.wsUrl).open()
  try {
    const ext = resolveExtensionId(await cdp.targets(), cfg)
    if (!ext.id) {
      throw new Error('cannot determine the extension id: set "extensionDir" (or "extensionId") in the config')
    }
    const extId = ext.id
    // "asleep" is the normal state between sweeps, not a fault — opening its page wakes it.
    log(`extension: ${extId} (from ${ext.via}; worker ${ext.awake ? 'awake' : 'asleep'})`)

    const results = []
    for (const [i, target] of cfg.targets.entries()) {
      if (i > 0) {
        // Politeness, and the one-active-tab rule: strictly one target at a time, with a gap
        // that is not a metronome. The capture randomises its own scroll intervals for the same
        // reason; a perfectly regular sweep undoes that at the next level up.
        const wait = jitter(cfg.betweenTargetsMs[0], cfg.betweenTargetsMs[1])
        log(`waiting ${Math.round(wait / 1000)}s before ${target.name}`)
        await sleep(wait)
      }
      log(`--- ${target.name} ---`)
      const r = await sweepTarget(cdp, extId, target, cfg)
      results.push(r)
      if (r.ok) {
        log(`ok: ${r.rowsSeen} rows, ${r.added} new, ${r.merged} merged (${Math.round(r.ms / 1000)}s)`)
      } else {
        warn(`FAIL ${r.name}: ${r.reason} — ${r.detail ?? ''}`)
      }
    }
    return { extId, port: found.port, results }
  } finally {
    cdp.close()
  }
}

/** Pull the whole collection out as interchange JSONL. The point of the entire project. */
export async function exportAll(cfg, outFile) {
  const found = await discover(cfg.profileDir, { timeoutMs: 30_000 })
  if (!found.ok) throw new Error(`no DevTools endpoint (${found.reason})`)
  const cdp = await new Cdp(found.wsUrl).open()
  try {
    const { id: extId } = resolveExtensionId(await cdp.targets(), cfg)
    if (!extId) throw new Error('cannot determine the extension id: set "extensionDir" or "extensionId"')
    const { targetId, sessionId: page } = await openExtensionPage(cdp, extId, cfg.pageLoadTimeoutMs)
    try {
      const res = await sendMessage(cdp, page, 'exportAll', {}, 5 * 60_000)
      if (!res?.ok) throw new Error(`export failed: ${res?.error ?? 'no reply'}`)
      mkdirSync(path.dirname(outFile), { recursive: true })
      writeFileSync(outFile, res.text, 'utf8')
      return { file: outFile, count: res.count }
    } finally {
      await cdp.send('Target.closeTarget', { targetId }).catch(() => {})
    }
  } finally {
    cdp.close()
  }
}

/**
 * Prove the extension is reachable the same way a sweep reaches it, without sweeping anything.
 * doctor.sh calls this rather than looking for a running worker, which is asleep most of the time.
 */
export async function checkExtension(cfg) {
  const found = await discover(cfg.profileDir, { timeoutMs: 15_000 })
  if (!found.ok) return { ok: false, reason: `no DevTools endpoint (${found.reason})` }
  const cdp = await new Cdp(found.wsUrl).open()
  try {
    const ext = resolveExtensionId(await cdp.targets(), cfg)
    if (!ext.id) return { ok: false, reason: 'cannot determine the extension id' }
    const { targetId } = await openExtensionPage(cdp, ext.id, cfg.pageLoadTimeoutMs)
    await cdp.send('Target.closeTarget', { targetId }).catch(() => {})
    return { ok: true, id: ext.id, via: ext.via, wasAwake: ext.awake }
  } catch (err) {
    return { ok: false, reason: err?.message ?? String(err) }
  } finally {
    cdp.close()
  }
}

// ── entry point ─────────────────────────────────────────────────────────────────────────────

async function main(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      config: { type: 'string', short: 'c', default: DEFAULT_CONFIG },
      export: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      'check-extension': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  })

  if (values.help) {
    log('usage: collect.mjs [--config /etc/stashling/stashling.json] [--export FILE] [--dry-run] [--check-extension]')
    return 0
  }

  const cfg = loadConfig(values.config)

  if (values['dry-run']) {
    const found = await discover(cfg.profileDir, { timeoutMs: 5000 })
    log(JSON.stringify({ config: values.config, targets: cfg.targets.length, devtools: found }, null, 2))
    return found.ok ? 0 : 1
  }

  if (values['check-extension']) {
    const r = await checkExtension(cfg)
    log(JSON.stringify(r))
    return r.ok ? 0 : 1
  }

  const lock = takeLock(cfg.stateDir, { maxAgeMs: cfg.staleLockMs })
  if (!lock.ok) {
    // Not an error: the previous sweep is still going, which is what the lock is for. Exiting 0
    // keeps the unit green so a long run does not look like a broken one.
    warn(`a sweep is already running (${lock.held}); skipping this tick`)
    return 0
  }

  try {
    if (values.export) {
      const { file, count } = await exportAll(cfg, values.export)
      log(`exported ${count} items to ${file}`)
      return 0
    }

    const run = await sweep(cfg)
    const report = { at: new Date().toISOString(), ...run }
    mkdirSync(cfg.stateDir, { recursive: true })
    writeFileSync(path.join(cfg.stateDir, 'last-run.json'), JSON.stringify(report, null, 2))

    const failed = run.results.filter((r) => !r.ok)
    const human = failed.filter((r) => r.reason === 'needs-human')
    if (human.length) {
      warn(`\n${human.length} target(s) need a human at the VNC session:`)
      for (const r of human) warn(`  ${r.name}: ${r.detail}`)
    }
    // Non-zero puts the unit in `failed`, which is what `OnFailure=` and `systemctl --failed`
    // key off. A sweep that silently logs and exits 0 is a sweep nobody notices stopped working.
    return failed.length ? 1 : 0
  } finally {
    lock.release()
  }
}

/**
 * Run `main` only when executed directly, never when imported (doctor.sh and the tests import).
 *
 * Compared as resolved filesystem paths. The previous string comparison against
 * `file://${argv[1]}` breaks on any path that URL-encodes (a space) and on any symlinked install,
 * and in both cases it fails SILENTLY: main never runs, the process exits 0, and the unit is green
 * having done nothing at all.
 */
function invokedDirectly() {
  try {
    return Boolean(process.argv[1])
      && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (invokedDirectly()) {
  process.exitCode = await main(process.argv.slice(2)).catch((err) => {
    warn(`stashling-collect: ${err?.message ?? err}`)
    return 2
  })
}
