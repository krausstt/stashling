/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A minimal Chrome DevTools Protocol client — enough to open a tab, bring it to the front, and
 * evaluate one expression in an extension page. Nothing more.
 *
 * ZERO DEPENDENCIES, like the rest of this repo (ADR-0006). Node has had a global `WebSocket`
 * without a flag since 22.4.0, which is the only reason this file can exist at all; `engines`
 * in the root package.json says >=20.6.0, so `requireWebSocket()` below fails loudly rather
 * than letting a Node 20 box discover this at 3 a.m. Ubuntu 24.04's own `nodejs` package is
 * Node 18 and will NOT do.
 *
 * FOUR THINGS HERE ARE NOT STYLE CHOICES.
 *
 * 1. THE PORT IS READ FROM THE PROFILE, NEVER ASSUMED. Chrome asks the OS for the port you
 *    requested and silently falls back to an ephemeral one if it is taken — a leftover zombie
 *    Chrome is enough. It then writes the port it actually got to `DevToolsActivePort` in the
 *    user-data-dir. Hardcoding 9222 is how a driver ends up talking confidently to nothing, or
 *    worse, to a different browser.
 *
 * 2. THE FILE ALONE IS NOT PROOF OF LIFE. `DevToolsActivePort` is not removed on an unclean
 *    exit, so after one crash it sits there forever naming a dead port. Every discovery does
 *    the HTTP GET as well, and the GET is what decides.
 *
 * 3. EVERY SEND HAS A DEADLINE. A CDP read with no timeout does not fail; it hangs. systemd
 *    will not restart a timer-triggered oneshot that is still running, so one hung read
 *    silently swallows every subsequent tick — `systemctl list-timers` keeps showing a healthy
 *    NEXT while nothing has run for a week. A deadline converts that into a visible failure.
 *
 * 4. NO `Origin` HEADER, SO NO `--remote-allow-origins`. Chrome 111 began rejecting CDP
 *    WebSocket upgrades carrying an unexpected `Origin`. Node's built-in WebSocket sends none,
 *    so the hole that `--remote-allow-origins=*` re-opens — any web page in any browser driving
 *    this port — stays shut. If you ever find yourself reaching for that flag, something else
 *    is wrong.
 *
 * SECURITY, STATED PLAINLY: the DevTools port has no authentication of any kind. It binds to
 * loopback (hardcoded; there is no `--remote-debugging-address` switch), but loopback is not an
 * access control. Every local uid on the box can read every cookie of every site the profile is
 * logged into. That is why `bootstrap.sh` gives this its own unprivileged user and why the
 * guide says what it says.
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'

/** Fail at the top, with the fix in the message, rather than on `new WebSocket` three calls in. */
function requireWebSocket() {
  if (typeof globalThis.WebSocket !== 'function') {
    throw new Error(
      'this Node has no global WebSocket (needs Node >= 22.4). '
      + `Running ${process.version}. Ubuntu's own nodejs package is Node 18 — install Node 22 instead.`,
    )
  }
  return globalThis.WebSocket
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * Where Chrome says its DevTools endpoint is.
 *
 * The first line of `DevToolsActivePort` is the port; the second is the browser-target path.
 * We use the port and re-derive the rest from `/json/version`, because the path in that file
 * goes stale the same way the port does.
 */
export function readActivePort(profileDir) {
  const file = path.join(profileDir, 'DevToolsActivePort')
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch (err) {
    if (err?.code === 'ENOENT') return { ok: false, reason: 'no-port-file', file }
    return { ok: false, reason: 'unreadable', file, error: err.message }
  }
  const port = Number.parseInt(String(text).split('\n')[0]?.trim(), 10)
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    return { ok: false, reason: 'unparseable', file, saw: String(text).slice(0, 80) }
  }
  return { ok: true, port, file }
}

/**
 * Find a live DevTools endpoint, waiting up to `timeoutMs` for Chrome to finish starting.
 *
 * Returns `{ ok: false, reason }` rather than throwing, because the two interesting failures —
 * "Chrome is not up yet" and "Chrome is up but was started without a usable --user-data-dir" —
 * are both things a caller wants to report differently, and the second one is invisible:
 * since Chrome 136 a Google-branded build silently ignores --remote-debugging-port when the
 * data directory is the default one. No error, no dialog, no port. Just nothing, forever.
 */
export async function discover(profileDir, { timeoutMs = 60_000, fetchImpl = fetch } = {}) {
  const deadline = Date.now() + timeoutMs
  let last = { ok: false, reason: 'never-tried' }

  for (;;) {
    const found = readActivePort(profileDir)
    if (found.ok) {
      try {
        const res = await fetchImpl(`http://127.0.0.1:${found.port}/json/version`, {
          signal: AbortSignal.timeout(2000),
        })
        if (res.ok) {
          const info = await res.json()
          if (info?.webSocketDebuggerUrl) {
            return { ok: true, port: found.port, browser: info.Browser ?? null, wsUrl: info.webSocketDebuggerUrl }
          }
          last = { ok: false, reason: 'no-websocket-url', port: found.port }
        } else {
          last = { ok: false, reason: 'http-' + res.status, port: found.port }
        }
      } catch (err) {
        // A stale port file points at a closed socket; ECONNREFUSED here is the normal shape of
        // "Chrome died and left its note behind".
        last = { ok: false, reason: 'unreachable', port: found.port, error: err?.message }
      }
    } else {
      last = found
    }

    if (Date.now() >= deadline) return { ...last, waitedMs: timeoutMs }
    await sleep(500)
  }
}

/**
 * One WebSocket to the browser endpoint, with flattened sessions.
 *
 * `flatten: true` on attach is what lets every message carry its own `sessionId` over this one
 * socket instead of the old nested `Target.sendMessageToTarget` wrapping. It has been the
 * recommended mode for years and is the only one this client speaks.
 */
export class Cdp {
  #ws = null
  #nextId = 1
  #pending = new Map()
  #listeners = new Map()
  #closed = null

  constructor(wsUrl, { defaultTimeoutMs = 30_000 } = {}) {
    this.wsUrl = wsUrl
    this.defaultTimeoutMs = defaultTimeoutMs
  }

  async open() {
    const WS = requireWebSocket()
    const ws = new WS(this.wsUrl)
    this.#ws = ws

    await new Promise((resolve, reject) => {
      const onOpen = () => { cleanup(); resolve() }
      const onErr = () => { cleanup(); reject(new Error(`cannot connect to ${this.wsUrl}`)) }
      const cleanup = () => {
        ws.removeEventListener('open', onOpen)
        ws.removeEventListener('error', onErr)
      }
      ws.addEventListener('open', onOpen)
      ws.addEventListener('error', onErr)
    })

    ws.addEventListener('message', (ev) => this.#onMessage(ev))
    // A socket that closes with calls in flight must reject them. Leaving them pending is how a
    // oneshot unit hangs until its TimeoutStartSec instead of reporting that Chrome went away.
    ws.addEventListener('close', () => this.#reap(new Error('devtools socket closed')))
    ws.addEventListener('error', () => this.#reap(new Error('devtools socket errored')))
    return this
  }

  #onMessage(ev) {
    let msg
    try {
      msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data))
    } catch {
      return
    }

    if (msg.id !== undefined) {
      const waiter = this.#pending.get(msg.id)
      if (!waiter) return
      this.#pending.delete(msg.id)
      clearTimeout(waiter.timer)
      if (msg.error) {
        const err = new Error(`${waiter.method}: ${msg.error.message ?? 'CDP error'}`)
        err.cdp = msg.error
        waiter.reject(err)
      } else {
        waiter.resolve(msg.result ?? {})
      }
      return
    }

    for (const fn of this.#listeners.get(msg.method) ?? []) {
      try { fn(msg.params ?? {}, msg.sessionId ?? null) } catch { /* a listener must not kill the socket */ }
    }
  }

  #reap(err) {
    this.#closed = this.#closed ?? err
    for (const [, waiter] of this.#pending) {
      clearTimeout(waiter.timer)
      waiter.reject(err)
    }
    this.#pending.clear()
  }

  on(method, fn) {
    const list = this.#listeners.get(method) ?? []
    list.push(fn)
    this.#listeners.set(method, list)
    return () => this.#listeners.set(method, (this.#listeners.get(method) ?? []).filter((f) => f !== fn))
  }

  /** @returns {Promise<object>} the `result` of the command. */
  send(method, params = {}, { sessionId = null, timeoutMs = this.defaultTimeoutMs } = {}) {
    if (this.#closed) return Promise.reject(this.#closed)
    const id = this.#nextId++
    const payload = { id, method, params }
    if (sessionId) payload.sessionId = sessionId

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        reject(new Error(`${method} timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      // `unref` so a stray timer cannot hold the process open past its work.
      timer.unref?.()
      this.#pending.set(id, { resolve, reject, timer, method })
      try {
        this.#ws.send(JSON.stringify(payload))
      } catch (err) {
        this.#pending.delete(id)
        clearTimeout(timer)
        reject(err)
      }
    })
  }

  async attach(targetId, opts = {}) {
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true }, opts)
    return sessionId
  }

  async targets() {
    const { targetInfos } = await this.send('Target.getTargets')
    return targetInfos ?? []
  }

  close() {
    this.#reap(new Error('closed by caller'))
    try { this.#ws?.close() } catch { /* already gone */ }
  }
}

/**
 * Evaluate an expression in a target and return its value, unwrapping CDP's two distinct
 * failure shapes — a protocol error and a thrown-inside-the-page error — into one thrown Error.
 *
 * `awaitPromise` matters: every handler on the other side of `chrome.runtime.sendMessage` is
 * async, so without it you get a `Promise` object description and a run that reports success
 * having waited for nothing.
 */
export async function evaluate(cdp, sessionId, expression, { timeoutMs, awaitPromise = true } = {}) {
  const res = await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise,
    returnByValue: true,
    // NOT `userGesture: true`. It looks like it would help and it does nothing: V8's
    // `V8InspectorClient::beginUserGesture()` has an empty body and nothing in Blink overrides
    // it, so it confers no transient activation. `chrome.permissions.request()` therefore
    // cannot be driven from here at all — see GUIDE.md, "the one thing a human must do".
  }, { sessionId, timeoutMs })

  if (res.exceptionDetails) {
    const d = res.exceptionDetails
    throw new Error(`page threw: ${d.exception?.description ?? d.text ?? 'unknown'}`)
  }
  return res.result?.value
}
