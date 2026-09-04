/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Persistence for the collector.
 *
 * Two stores, deliberately:
 *
 *  - IndexedDB (`items`, `attrs`, `raws`, `meta`) holds the collection. It is the only
 *    place large enough: a single saved YouTube Watch Later page is 12,725,371 bytes
 *    (measured), and `storage.local` is capped at 10 MB without `unlimitedStorage`.
 *  - `storage.local` holds ONLY the run status — a ~300-byte object the popup polls once a
 *    second. It lives there because opening a multi-megabyte IndexedDB on every poll tick is
 *    a real bug that shipped: MakerWorld's popup polled at 1.5 s and reopened the database
 *    each time, which is why `openDb()` below caches one connection with an `onclose`
 *    handler (their 0.6.2 fix).
 *
 * NOTHING in this module holds state that must survive across service-worker ticks other
 * than the cached DB handle, which is re-openable at any moment. Firefox has no MV3 service
 * worker at all (bug 1573659) and runs this code from an event page, so a module-level
 * variable is never a place to keep a fact.
 */

export const DB_NAME = 'stashling'
export const DB_VERSION = 1

export const STORES = Object.freeze({
  items: 'items',
  attrs: 'attrs',
  raws: 'raws',
  meta: 'meta',
})

/**
 * Write in batches of 20.
 *
 * MakerWorld's collector re-serialized the entire growing catalogue to `storage.local` after
 * every single model, which is O(n^2) in the number of items and took a 739-item run into
 * minutes of pure serialization. 0.6.2 fixed it with exactly this constant. IndexedDB makes
 * the original shape of that bug impossible — a `put` touches one record — but the batch
 * still earns its keep twice over: one transaction per 20 records instead of per record, and
 * a progress tick at a cadence a human can read.
 */
export const FLUSH_EVERY = 20

/**
 * Per-item cap on the lossless `raw` blob.
 *
 * MakerWorld 0.6.1 stored full-resolution 1.8 MB covers for 860 items, overran the IndexedDB
 * quota, and produced ZERO usable thumbnails — a silent total loss. An oversize blob is
 * therefore DROPPED and its absence recorded (`omitted: 'oversize'`), never truncated: a
 * truncated body that still looks like a body is worse than a recorded gap, because
 * ITEM-CONTRACT §7 says the raw is the source of truth for export and a half-blob would be
 * re-shredded as if it were whole.
 */
export const MAX_RAW_BYTES = 256 * 1024

/** How many superseded raw hashes to remember per item. See `putRaw`. */
export const MAX_RAW_HISTORY = 10

// ── connection ────────────────────────────────────────────────────────────────

let cachedDb = null

/**
 * One cached connection, dropped the moment the browser closes it.
 *
 * The `onclose` handler is not decoration. Without it a handle closed by the browser (tab
 * discarded, storage pressure, a version change from another context) stays cached and every
 * subsequent transaction throws `InvalidStateError` until the whole worker is restarted.
 */
export function openDb() {
  if (cachedDb) return Promise.resolve(cachedDb)
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)

    req.onupgradeneeded = (event) => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORES.items)) {
        db.createObjectStore(STORES.items, { keyPath: 'id' })
      }
      if (!db.objectStoreNames.contains(STORES.attrs)) {
        // The composite keyPath IS the UNIQUE(itemId, key, source) constraint from
        // ITEM-CONTRACT §5. Expressing it as the key rather than as a uniqueness index means
        // a re-run of any enricher is a plain `put` — idempotent by construction, with no
        // read-modify-write and no chance of two rows for one writer's opinion.
        const attrs = db.createObjectStore(STORES.attrs, { keyPath: ['itemId', 'key', 'source'] })
        attrs.createIndex('byItem', 'itemId', { unique: false })
        attrs.createIndex('byKey', 'key', { unique: false })
      }
      if (!db.objectStoreNames.contains(STORES.raws)) {
        db.createObjectStore(STORES.raws, { keyPath: 'id' })
      }
      if (!db.objectStoreNames.contains(STORES.meta)) {
        db.createObjectStore(STORES.meta, { keyPath: 'key' })
      }
      void event
    }

    req.onsuccess = () => {
      const db = req.result
      db.onclose = () => { cachedDb = null }
      db.onversionchange = () => { db.close(); cachedDb = null }
      cachedDb = db
      resolve(db)
    }
    req.onerror = () => reject(req.error ?? new Error('indexedDB.open failed'))
    req.onblocked = () => reject(new Error('indexedDB.open blocked by another open connection'))
  })
}

/** Drop the cached handle. Used by the collection page before a destructive operation. */
export function closeDb() {
  if (cachedDb) cachedDb.close()
  cachedDb = null
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error ?? new Error('transaction failed'))
    tx.onabort = () => reject(tx.error ?? new Error('transaction aborted'))
  })
}

function reqDone(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('request failed'))
  })
}

// ── generic reads ─────────────────────────────────────────────────────────────

export async function getAll(storeName) {
  const db = await openDb()
  return reqDone(db.transaction(storeName, 'readonly').objectStore(storeName).getAll())
}

export async function getOne(storeName, key) {
  const db = await openDb()
  return reqDone(db.transaction(storeName, 'readonly').objectStore(storeName).get(key))
}

export async function countOf(storeName) {
  const db = await openDb()
  return reqDone(db.transaction(storeName, 'readonly').objectStore(storeName).count())
}

/**
 * Put a batch inside ONE transaction, issuing every request before yielding.
 *
 * There is no `await` between the puts on purpose. An IndexedDB transaction commits as soon
 * as control returns to the event loop with no request outstanding; interleaving a non-IDB
 * promise inside a transaction is the classic way to get `TransactionInactiveError` on the
 * engines that implement the spec strictly.
 */
export async function putMany(storeName, records) {
  if (!records.length) return 0
  const db = await openDb()
  const tx = db.transaction(storeName, 'readwrite')
  const os = tx.objectStore(storeName)
  for (const record of records) os.put(record)
  await txDone(tx)
  return records.length
}

async function getMany(storeName, keys) {
  const out = new Map()
  if (!keys.length) return out
  const db = await openDb()
  const tx = db.transaction(storeName, 'readonly')
  const os = tx.objectStore(storeName)
  const pending = keys.map((key) => reqDone(os.get(key)).then((value) => { if (value) out.set(key, value) }))
  await Promise.all(pending)
  await txDone(tx)
  return out
}

// ── items ─────────────────────────────────────────────────────────────────────

export function readItems() {
  return getAll(STORES.items)
}

export function readItem(id) {
  return getOne(STORES.items, id)
}

async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return `sha256-${[...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')}`
}

/**
 * Split an Item into the record that goes in `items` and the blob that goes in `raws`.
 *
 * `raw` is held in its own store so that reading the collection — which the popup, the
 * collection page and every export do — never drags 582 verbatim HTML chunks through
 * structured clone. ITEM-CONTRACT §7 keeps `raw` as the source of truth for export; it does
 * not require it to be in the hot path.
 */
async function splitRaw(item) {
  const raw = item?.raw
  if (!raw || typeof raw.body !== 'string') return { item: { ...item, raw: null }, rawRecord: null }

  const bytes = new TextEncoder().encode(raw.body)
  if (bytes.length > MAX_RAW_BYTES) {
    return {
      item: { ...item, raw: null },
      rawRecord: {
        id: item.id,
        omitted: 'oversize',
        bytes: bytes.length,
        limit: MAX_RAW_BYTES,
        contentType: raw.contentType ?? 'text/html',
        capturedAt: raw.capturedAt ?? 0,
        connectorVersion: raw.connectorVersion ?? null,
      },
    }
  }

  // A connector MAY supply the hash; when it does not we compute it, because §7's whole
  // argument for carrying one is that a re-import can skip unchanged items, and that only
  // works if the hash is always there.
  const hash = raw.hash ?? await sha256Hex(bytes)
  return {
    item: { ...item, raw: null },
    rawRecord: {
      id: item.id,
      body: raw.body,
      contentType: raw.contentType ?? 'text/html',
      hash,
      bytes: bytes.length,
      capturedAt: raw.capturedAt ?? 0,
      connectorVersion: raw.connectorVersion ?? null,
      supersededHashes: [],
    },
  }
}

/**
 * Merge and write items in batches.
 *
 * The merge itself is core's — this module must never invent a merge rule, because the zone
 * ownership in ITEM-CONTRACT §1 is the entire design and a second implementation of it is a
 * second place for the `user`-zone deletion bug to come back.
 *
 * @param {Array<object>} incoming
 * @param {object} [opts]
 * @param {(mergeFn:Function)} opts.mergeItems  core's mergeItems, injected by the caller
 * @param {'connector'|'import'|'user'} [opts.writer='connector']
 * @param {(progress:{done:number,total:number})=>void} [opts.onFlush]
 * @returns {Promise<{added:number, merged:number, rawsStored:number, rawsOmitted:number}>}
 */
export async function upsertItems(incoming, opts = {}) {
  const { mergeItems, writer = 'connector', onFlush = null, flushEvery = FLUSH_EVERY } = opts
  if (typeof mergeItems !== 'function') throw new TypeError('upsertItems: opts.mergeItems is required')

  let added = 0
  let merged = 0
  let rawsStored = 0
  let rawsOmitted = 0
  let done = 0

  for (let offset = 0; offset < incoming.length; offset += flushEvery) {
    const batch = incoming.slice(offset, offset + flushEvery)
    const ids = batch.map((it) => it.id).filter(Boolean)
    const existingItems = await getMany(STORES.items, ids)
    const existingRaws = await getMany(STORES.raws, ids)

    const itemRecords = []
    const rawRecords = []

    for (const item of batch) {
      if (!item?.id) continue
      const split = await splitRaw(item)
      const prior = existingItems.get(item.id)

      // The stored item has `raw: null` (it lives in `raws`), so hand the merge the raw it
      // actually has, or `mergeItems` would see a null incoming raw and keep a null.
      const next = prior
        ? mergeItems({ ...prior, raw: null }, split.item, { writer })
        : split.item
      itemRecords.push({ ...next, raw: null })
      if (prior) merged += 1
      else added += 1

      if (split.rawRecord) {
        if (split.rawRecord.omitted) {
          rawsOmitted += 1
        } else {
          const priorRaw = existingRaws.get(item.id)
          // Full raw history would need a compound key; v1 keeps the CURRENT body plus the
          // hashes it displaced, which is enough to answer "did the source change under me?"
          // without unbounded growth. ITEM-CONTRACT §7's "previous kept" is only partly
          // honoured here and the README says so.
          const history = priorRaw?.hash && priorRaw.hash !== split.rawRecord.hash
            ? [priorRaw.hash, ...(priorRaw.supersededHashes ?? [])].slice(0, MAX_RAW_HISTORY)
            : (priorRaw?.supersededHashes ?? [])
          rawRecords.push({ ...split.rawRecord, supersededHashes: history })
          rawsStored += 1
        }
      }
    }

    await putMany(STORES.items, itemRecords)
    if (rawRecords.length) await putMany(STORES.raws, rawRecords)

    done += batch.length
    if (onFlush) onFlush({ done, total: incoming.length })
  }

  return { added, merged, rawsStored, rawsOmitted }
}

// ── attrs ─────────────────────────────────────────────────────────────────────

export function readAttrs() {
  return getAll(STORES.attrs)
}

/** A plain put, because the composite keyPath already enforces one row per writer per key. */
export function upsertAttrRows(rows) {
  const clean = (rows ?? []).filter((r) => r && r.itemId && r.key && r.source)
  return putMany(STORES.attrs, clean)
}

// ── raws ──────────────────────────────────────────────────────────────────────

export function readRaw(id) {
  return getOne(STORES.raws, id)
}

// ── meta ──────────────────────────────────────────────────────────────────────

export async function getMeta(key, fallback = null) {
  const row = await getOne(STORES.meta, key)
  return row === undefined || row === null ? fallback : row.value
}

export function setMeta(key, value) {
  return putMany(STORES.meta, [{ key, value }])
}

/**
 * The monotonic export generation from ITEM-CONTRACT §8.
 *
 * Bumped on every export so a consumer can discard a stale payload rather than import it.
 * It is deliberately NOT reset by `clearAll()` — a counter that goes backwards after a wipe
 * would let an old file overwrite a fresh collection, which is the exact failure the counter
 * exists to prevent.
 */
export async function bumpGeneration() {
  const current = Number(await getMeta('generation', 0)) || 0
  const next = current + 1
  await setMeta('generation', next)
  return next
}

export async function readGeneration() {
  return Number(await getMeta('generation', 0)) || 0
}

// ── stats ─────────────────────────────────────────────────────────────────────

/**
 * Counts for the collection page. Uses a cursor rather than `getAll` so the numbers stay
 * cheap as the collection grows past what is comfortable to materialize.
 */
export async function stats() {
  const db = await openDb()
  const tx = db.transaction([STORES.items, STORES.attrs, STORES.raws], 'readonly')

  const bySource = {}
  const byList = {}
  let items = 0
  let annotated = 0
  let gone = 0
  let unlisted = 0

  await new Promise((resolve, reject) => {
    const req = tx.objectStore(STORES.items).openCursor()
    req.onerror = () => reject(req.error)
    req.onsuccess = () => {
      const cursor = req.result
      if (!cursor) { resolve(); return }
      const it = cursor.value
      items += 1
      bySource[it.source] = (bySource[it.source] ?? 0) + 1
      for (const list of it.lists ?? []) byList[list] = (byList[list] ?? 0) + 1
      if (it.user && Object.keys(it.user).length) annotated += 1
      if (it.liveness?.state === 'gone') gone += 1
      if (it.membership?.state === 'unlisted') unlisted += 1
      cursor.continue()
    }
  })

  const attrs = await reqDone(tx.objectStore(STORES.attrs).count())
  const raws = await reqDone(tx.objectStore(STORES.raws).count())

  let quota = null
  try {
    if (navigator?.storage?.estimate) quota = await navigator.storage.estimate()
  } catch {
    // Firefox private windows and some enterprise policies reject estimate(); a missing
    // number is not an error, it just means the quota panel says "unknown".
    quota = null
  }

  return {
    items, attrs, raws, annotated, gone, unlisted, bySource, byList,
    generation: await readGeneration(),
    quota: quota ? { usage: quota.usage ?? null, quota: quota.quota ?? null } : null,
  }
}

/**
 * Wipe the collection. Keeps `meta` (see `bumpGeneration`).
 *
 * The caller is required to have shown the user how many items carry a non-empty `user`
 * zone. MakerWorld's only refresh path was Clear, and because `userMeta` lived inside the
 * catalogue record, refreshing your data meant destroying your annotations with no warning
 * and no undo. The count is the warning.
 */
export async function clearAll() {
  const db = await openDb()
  const tx = db.transaction([STORES.items, STORES.attrs, STORES.raws], 'readwrite')
  tx.objectStore(STORES.items).clear()
  tx.objectStore(STORES.attrs).clear()
  tx.objectStore(STORES.raws).clear()
  await txDone(tx)
}

// ── run status (storage.local, not IndexedDB) ────────────────────────────────

// Chrome has had the `browser` namespace natively since 148 (all extensions since 152).
// This is Chrome's own documented fallback and it is why there is no webextension-polyfill
// in this package: that polyfill was ARCHIVED, last published 2024-05-14, and its README
// says it "has served its purpose, and will not receive any further updates".
if (!globalThis.browser) globalThis.browser = globalThis.chrome

export const STATUS_KEY = 'status'

/**
 * ONE staleness threshold, exported, imported by both the worker and the popup.
 *
 * MakerWorld shipped two: `STALE_MS = 60000` in background.js decided whether a run was
 * resumable, and 35000 in popup.js decided whether to show the stall banner. For 25 seconds
 * of every dead run the UI said "stalled" while the worker refused to start a new one. There
 * is exactly one number here for exactly that reason.
 */
export const STALE_MS = 60000

export const INITIAL_STATUS = Object.freeze({
  running: false,
  phase: 'idle',
  total: 0,
  done: 0,
  seen: 0,
  claimed: null,
  lastError: null,
  lastProgressAt: 0,
  runId: null,
  connectorId: null,
  listId: null,
  tabUrl: null,
  startedAt: 0,
  finishedAt: 0,
  stop: null,
  cancelRequested: false,
  added: 0,
  merged: 0,
  rawsOmitted: 0,
  problems: [],
})

export async function readStatus() {
  const bag = await browser.storage.local.get(STATUS_KEY)
  return { ...INITIAL_STATUS, ...(bag?.[STATUS_KEY] ?? {}) }
}

/** Patch the status and stamp the heartbeat. Every write is a heartbeat, by construction. */
export async function writeStatus(patch) {
  const next = { ...(await readStatus()), ...patch, lastProgressAt: Date.now() }
  await browser.storage.local.set({ [STATUS_KEY]: next })
  return next
}

export async function resetStatus() {
  await browser.storage.local.set({ [STATUS_KEY]: { ...INITIAL_STATUS } })
}

/**
 * Is a run actually alive, as opposed to a `running: true` left behind by a dead worker?
 *
 * This is a heartbeat, NOT a lock, and the distinction is the whole point: MV3 terminates the
 * worker after 30 s of inactivity or 5 minutes on one request, and a lock taken by a process
 * the platform is allowed to kill without notice is a lock nobody can release. A stale
 * heartbeat means "start again", which is a state a user can get out of by clicking the
 * button they already clicked.
 */
export function isRunLive(status, now = Date.now()) {
  if (!status?.running) return false
  const beat = Number(status.lastProgressAt) || 0
  return beat > 0 && (now - beat) < STALE_MS
}
