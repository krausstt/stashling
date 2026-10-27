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

import { mkdirSync, writeFileSync, readFileSync, openSync, closeSync, unlinkSync } from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { Cdp, discover, evaluate } from './cdp.mjs'

const DEFAULT_CONFIG = '/etc/stashling/stashling.json'

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
    stateDir: '/var/lib/stashling/state',
    betweenTargetsMs: [20_000, 90_000],
    blockedUrlPatterns: DEFAULT_BLOCKED,
    pageLoadTimeoutMs: 60_000,
    collectTimeoutMs: 8 * 60_000,
    ...cfg,
  }
}

// ── a lock, because two sweeps at once is two Chromes fighting over one active tab ──────────

function takeLock(stateDir) {
  mkdirSync(stateDir, { recursive: true })
  const file = path.join(stateDir, 'collect.lock')
  let fd
  try {
    fd = openSync(file, 'wx')           // O_CREAT|O_EXCL — atomic
  } catch (err) {
    if (err?.code === 'EEXIST') {
      let held = ''
      try { held = readFileSync(file, 'utf8').trim() } catch { /* racing release */ }
      return { ok: false, file, held }
    }
    throw err
  }
  writeFileSync(fd, `pid=${process.pid} started=${new Date().toISOString()}\n`)
  closeSync(fd)
  return {
    ok: true,
    file,
    release() { try { unlinkSync(file) } catch { /* already gone */ } },
  }
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
  const { targetId: siteTarget } = await cdp.send('Target.createTarget', { url: target.url })
  const site = await cdp.attach(siteTarget)

  try {
    await cdp.send('Page.enable', {}, { sessionId: site })
    await cdp.send('Runtime.enable', {}, { sessionId: site })

    // 2. Wait for the load event, with a deadline of its own.
    await waitForLoad(cdp, site, cfg.pageLoadTimeoutMs)

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
    const extPage = await cdp.send('Target.createTarget', {
      url: `chrome-extension://${extId}/ui/collection.html`,
    })
    const page = await cdp.attach(extPage.targetId)
    try {
      await cdp.send('Runtime.enable', {}, { sessionId: page })
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
    const off = cdp.on('Page.loadEventFired', (_p, sid) => {
      if (sid && sid !== sessionId) return
      clearTimeout(timer)
      off()
      resolve()
    })
  })
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
    const extId = extensionIdFrom(await cdp.targets())
    if (!extId) {
      throw new Error(
        'the Stashling service worker is not running. Open chrome://extensions in the VNC '
        + 'session and check the extension is loaded and enabled.',
      )
    }
    log(`extension: ${extId}`)

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
    const extId = extensionIdFrom(await cdp.targets())
    if (!extId) throw new Error('the Stashling service worker is not running')
    const { targetId } = await cdp.send('Target.createTarget', {
      url: `chrome-extension://${extId}/ui/collection.html`,
    })
    const page = await cdp.attach(targetId)
    try {
      await cdp.send('Runtime.enable', {}, { sessionId: page })
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

// ── entry point ─────────────────────────────────────────────────────────────────────────────

async function main(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      config: { type: 'string', short: 'c', default: DEFAULT_CONFIG },
      export: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  })

  if (values.help) {
    log('usage: collect.mjs [--config /etc/stashling/stashling.json] [--export FILE] [--dry-run]')
    return 0
  }

  const cfg = loadConfig(values.config)

  if (values['dry-run']) {
    const found = await discover(cfg.profileDir, { timeoutMs: 5000 })
    log(JSON.stringify({ config: values.config, targets: cfg.targets.length, devtools: found }, null, 2))
    return found.ok ? 0 : 1
  }

  const lock = takeLock(cfg.stateDir)
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

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = await main(process.argv.slice(2)).catch((err) => {
    warn(`stashling-collect: ${err?.message ?? err}`)
    return 2
  })
}
