/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A browser-shaped harness, so the extension can be exercised without a browser.
 *
 * The extension was the one layer of this repo with no tests at all, on the reasoning that it
 * needs Chrome. It does not: `store.js` needs an IndexedDB, `sw.js` needs `browser.*`, and both
 * of those are small enough to fake honestly. The first run of this harness found a `TypeError`
 * that made every collect and every saved-page import fail — a defect that had been sitting in
 * `sw.js` since it was written, because nothing had ever called the function.
 *
 * The fakes are DELIBERATELY strict where the real APIs are strict, since a permissive fake
 * proves nothing:
 *
 *  - a transaction goes inactive once control returns to the event loop with no request
 *    outstanding, so issuing a request after an unrelated `await` throws `TransactionInactiveError`
 *    exactly as a real engine would;
 *  - `structuredClone` is applied on the way in and out of the store, so a value that could not
 *    survive IndexedDB (a function, a DOM node) fails here too;
 *  - composite `keyPath` arrays are honoured, because that is what enforces
 *    UNIQUE(itemId, key, source) in the real schema.
 *
 * No dependencies, per docs/decisions/0006.
 */

// ── keys ──────────────────────────────────────────────────────────────────────

const readKeyPath = (value, keyPath) => (Array.isArray(keyPath)
  ? keyPath.map((p) => value?.[p])
  : value?.[keyPath])

/** IndexedDB orders and compares keys structurally; a JSON encoding is enough for a Map key. */
const encodeKey = (key) => JSON.stringify(key)

// ── the fake ──────────────────────────────────────────────────────────────────

/**
 * Timing here is the whole fidelity of the fake, and it is worth stating exactly.
 *
 *  - A request's success/error is dispatched as a TASK, because that is what a DOM event is.
 *    Firing it as a microtask instead loses to any caller that attaches its handler after an
 *    `await` — which `getMany` legitimately does — and the promise then never settles.
 *  - The transaction deactivates at the MICROTASK CHECKPOINT after a handler runs, not
 *    synchronously inside it. That is the rule that lets `await`-ing a promise resolved from an
 *    IDB event keep the transaction usable, while an `await` on anything else loses it. Model it
 *    the other way and `stats()` — which continues a transaction after awaiting a cursor walk —
 *    fails here while working in every real engine.
 */
class FakeRequest {
  constructor(tx = null) {
    this.tx = tx
    this.result = undefined
    this.error = null
    this.onsuccess = null
    this.onerror = null
  }

  _dispatch(handlerName) {
    setTimeout(() => {
      try {
        this[handlerName]?.({ target: this })
      } finally {
        this.tx?._settleOne()
      }
    }, 0)
  }

  _succeed(result) {
    this.result = result
    this._dispatch('onsuccess')
  }

  _fail(error) {
    this.error = error
    this._dispatch('onerror')
  }
}

class FakeObjectStore {
  constructor(tx, name, data, keyPath) {
    this.tx = tx
    this.name = name
    this.data = data
    this.keyPath = keyPath
  }

  _assertActive() {
    if (!this.tx.active) {
      const err = new Error(`TransactionInactiveError: ${this.name} used after the transaction went inactive`)
      err.name = 'TransactionInactiveError'
      throw err
    }
  }

  _assertWritable() {
    if (this.tx.mode !== 'readwrite') {
      const err = new Error('ReadOnlyError: write on a readonly transaction')
      err.name = 'ReadOnlyError'
      throw err
    }
  }

  put(value) {
    this._assertActive()
    this._assertWritable()
    const req = new FakeRequest()
    this.tx._track(req)
    const key = readKeyPath(value, this.keyPath)
    if (key === undefined || (Array.isArray(key) && key.some((k) => k === undefined))) {
      this.tx._fail(new Error(`DataError: no key for keyPath ${JSON.stringify(this.keyPath)}`))
      return req
    }
    this.data.set(encodeKey(key), structuredClone(value))
    req._succeed(key)
    return req
  }

  get(key) {
    this._assertActive()
    const req = new FakeRequest()
    this.tx._track(req)
    const hit = this.data.get(encodeKey(key))
    req._succeed(hit === undefined ? undefined : structuredClone(hit))
    return req
  }

  getAll() {
    this._assertActive()
    const req = new FakeRequest()
    this.tx._track(req)
    req._succeed([...this.data.values()].map((v) => structuredClone(v)))
    return req
  }

  count() {
    this._assertActive()
    const req = new FakeRequest()
    this.tx._track(req)
    req._succeed(this.data.size)
    return req
  }

  clear() {
    this._assertActive()
    this._assertWritable()
    const req = new FakeRequest()
    this.tx._track(req)
    this.data.clear()
    req._succeed(undefined)
    return req
  }

  openCursor() {
    this._assertActive()
    const req = new FakeRequest()
    this.tx._track(req)
    const rows = [...this.data.values()].map((v) => structuredClone(v))
    let i = 0
    const step = () => {
      if (i >= rows.length) { req._succeed(null); return }
      const value = rows[i]
      i += 1
      req._succeed({ value, continue: () => { this.tx._track(req); step() } })
    }
    step()
    return req
  }

  createIndex() { /* the store's indexes are not read back in these paths */ }
}

class FakeTransaction {
  constructor(db, names, mode) {
    this.db = db
    this.names = names
    this.mode = mode
    this.active = true
    this.pending = 0
    this.error = null
    this.oncomplete = null
    this.onerror = null
    this.onabort = null
    this._settled = false

    // The real deactivation rule: once the microtask queue drains with nothing outstanding, the
    // transaction commits. Modelling it is the point — it is what catches an `await` on a
    // non-IDB promise in the middle of a transaction.
    queueMicrotask(() => this._maybeCommit())
  }

  _track(req) {
    req.tx = this
    this.pending += 1
  }

  /**
   * One request finished. The commit check is deferred to the microtask checkpoint so that a
   * continuation awaiting this request — which is itself a microtask, queued earlier — gets to
   * issue its follow-up request first and re-raise `pending`.
   */
  _settleOne() {
    this.pending -= 1
    queueMicrotask(() => this._maybeCommit())
  }

  _maybeCommit() {
    if (this._settled || this.pending > 0) return
    this._settled = true
    this.active = false
    setTimeout(() => this.oncomplete?.({ target: this }), 0)
  }

  _fail(error) {
    if (this._settled) return
    this._settled = true
    this.active = false
    this.error = error
    setTimeout(() => (this.onerror ?? this.onabort)?.({ target: this }), 0)
  }

  objectStore(name) {
    if (!this.names.includes(name)) throw new Error(`NotFoundError: ${name} not in this transaction`)
    const store = this.db._stores.get(name)
    if (!store) throw new Error(`NotFoundError: object store ${name}`)
    return new FakeObjectStore(this, name, store.data, store.keyPath)
  }

  abort() { this._fail(new Error('AbortError')) }
}

class FakeDatabase {
  constructor(name, version) {
    this.name = name
    this.version = version
    this._stores = new Map()
    this.onclose = null
    this.onversionchange = null
    this.closed = false
    this.objectStoreNames = {
      contains: (n) => this._stores.has(n),
      get length() { return 0 },
    }
  }

  createObjectStore(name, opts = {}) {
    this._stores.set(name, { data: new Map(), keyPath: opts.keyPath })
    // The upgrade-time handle only ever has `createIndex` called on it, but it still needs the
    // full transaction shape: a fake that throws on an unused path is a fake nobody trusts.
    const upgradeTx = { active: true, mode: 'readwrite', _track() {}, _settleOne() {}, _fail() {} }
    return new FakeObjectStore(upgradeTx, name, this._stores.get(name).data, opts.keyPath)
  }

  transaction(names, mode = 'readonly') {
    if (this.closed) {
      const err = new Error('InvalidStateError: database is closed')
      err.name = 'InvalidStateError'
      throw err
    }
    return new FakeTransaction(this, Array.isArray(names) ? names : [names], mode)
  }

  close() {
    this.closed = true
    this.onclose?.()
  }
}

/**
 * Install a fake `indexedDB`, `crypto.subtle` passthrough and `structuredClone` on globalThis.
 * @returns {{reset:Function, db:() => FakeDatabase|null, openCount:() => number}}
 */
export function installIndexedDB() {
  let db = null
  let openCount = 0

  globalThis.indexedDB = {
    open(name, version) {
      openCount += 1
      const req = new FakeRequest()
      req.onupgradeneeded = null
      req.onblocked = null
      queueMicrotask(() => {
        const fresh = db === null
        if (fresh) db = new FakeDatabase(name, version)
        req.result = db
        if (fresh) req.onupgradeneeded?.({ target: req, oldVersion: 0, newVersion: version })
        req.onsuccess?.({ target: req })
      })
      return req
    },
    deleteDatabase() {
      db = null
      const req = new FakeRequest()
      queueMicrotask(() => req.onsuccess?.({ target: req }))
      return req
    },
  }

  return {
    reset() { db = null; openCount = 0 },
    db: () => db,
    openCount: () => openCount,
  }
}

/**
 * Install a fake `browser` (`chrome`) namespace.
 *
 * `storage.local` is a real in-memory bag rather than a stub returning `{}`, because the run
 * status is a read-modify-write and a stub would hide every ordering bug in it.
 */
export function installBrowser(overrides = {}) {
  const local = new Map()
  const granted = new Set(overrides.grantedOrigins ?? [])
  const calls = { executeScript: [], download: [], alarms: [] }

  const api = {
    storage: {
      local: {
        async get(key) {
          if (key === null || key === undefined) return Object.fromEntries(local)
          const keys = Array.isArray(key) ? key : [key]
          const out = {}
          for (const k of keys) if (local.has(k)) out[k] = structuredClone(local.get(k))
          return out
        },
        async set(bag) {
          for (const [k, v] of Object.entries(bag)) local.set(k, structuredClone(v))
        },
        async remove(key) { local.delete(key) },
        async clear() { local.clear() },
      },
    },
    permissions: {
      async contains({ origins = [] }) { return origins.every((o) => granted.has(o)) },
      async request({ origins = [] }) { for (const o of origins) granted.add(o); return true },
      async remove({ origins = [] }) { for (const o of origins) granted.delete(o); return true },
      async getAll() { return { origins: [...granted], permissions: [] } },
    },
    scripting: {
      async executeScript(args) {
        calls.executeScript.push(args)
        const result = await (overrides.executeScript?.(args) ?? Promise.resolve(null))
        return [{ result }]
      },
    },
    alarms: {
      async create(name, info) { calls.alarms.push(['create', name, info]) },
      async clear(name) { calls.alarms.push(['clear', name]) },
      onAlarm: { addListener() {} },
    },
    downloads: {
      async download(opts) { calls.download.push(opts); return 1 },
    },
    runtime: {
      _listener: null,
      onMessage: { addListener(fn) { api.runtime._listener = fn } },
      onInstalled: { addListener() {} },
      openOptionsPage() {},
      async sendMessage(msg) {
        return new Promise((resolve, reject) => {
          const ok = api.runtime._listener?.(msg, {}, resolve)
          if (!ok) reject(new Error(`no handler kept the channel open for ${msg?.type}`))
        })
      },
    },
    tabs: { async query() { return [{ id: 1, url: overrides.tabUrl ?? 'https://example.com/' }] } },
  }

  globalThis.browser = api
  globalThis.chrome = api
  return { api, local, granted, calls }
}

/** Drive the service worker's message hub the way a popup or the collection page would. */
export function send(type, payload = {}) {
  return globalThis.browser.runtime.sendMessage({ type, payload })
}
