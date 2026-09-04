/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The background worker: a message hub and the single writer.
 *
 * THREE CONSTRAINTS SHAPE EVERY LINE HERE.
 *
 * 1. NO IN-MEMORY STATE ACROSS TICKS. Chrome terminates this worker after 30 s of inactivity,
 *    after 5 minutes on one request, or after 30 s waiting on a fetch. Firefox does not support
 *    background service workers AT ALL (bug 1573659) and runs this same file as an event page;
 *    Safari's MV3 service-worker debugging is broken, so the event-page path is what people
 *    will actually use there. A module-level variable is therefore never a place to keep a
 *    fact. Everything durable goes through `store.js`; everything transient is re-derived.
 *
 * 2. STATIC IMPORTS ONLY. Dynamic `import()` is still unsupported in an MV3 background service
 *    worker (w3c/webextensions#212, open, crbug 1198822), and fetching connector code at
 *    runtime is a Chrome Web Store rejection under the remote-hosted-code policy. The connector
 *    registry is bundled and imported statically, from `vendor/`, which `npm run sync` fills
 *    from `packages/`.
 *
 * 3. A HEARTBEAT, NOT A LOCK. A lock taken by a process the platform may kill without notice is
 *    a lock nobody can release — which is exactly how the MakerWorld scraper ended up with a
 *    stuck `running: true` that no amount of clicking could clear. `isRunLive()` treats a run
 *    whose heartbeat has gone stale as dead and therefore restartable.
 */

import {
  connectors, connectorFor, listFor, allHosts,
} from './vendor/connectors/index.js'
import { mergeItems, toJsonl } from './vendor/core/index.js'
import * as store from './store.js'
import * as perms from './permissions.js'
import { capture } from './strategies/dom-active-tab.js'
import { importInterchange, importSavedPage, looksLikeInterchange } from './strategies/file-import.js'

if (!globalThis.browser) globalThis.browser = chrome

const KEEPALIVE = 'stashling-keepalive'

// ── run bookkeeping ───────────────────────────────────────────────────────────

async function beat(patch = {}) {
  await store.writeStatus({ ...patch, lastProgressAt: Date.now() })
}

async function startKeepalive() {
  // Names are capped at 1024 bytes since Chrome 150; this one is a constant, but any per-job
  // alarm name would need the cap in mind.
  try {
    await browser.alarms.create(KEEPALIVE, { periodInMinutes: 0.5 })
  } catch { /* alarms are unavailable in some test harnesses; the run still works */ }
}

async function stopKeepalive() {
  try { await browser.alarms.clear(KEEPALIVE) } catch { /* ignore */ }
}

browser.alarms?.onAlarm.addListener((alarm) => {
  // The listener existing is the point: it wakes the worker. There is nothing to do in it.
  if (alarm.name !== KEEPALIVE) return
})

// ── the collect run ───────────────────────────────────────────────────────────

/**
 * Collect the active tab.
 *
 * Permission is checked but NEVER requested here — a request must come from a user gesture, and
 * a background message is not one. The popup asks; this refuses politely if the answer is no.
 */
async function collect({ tabId, url, connectorId, listId }) {
  const existing = await store.readStatus()
  if (store.isRunLive(existing)) {
    return { ok: false, reason: 'already-running', status: existing }
  }

  const connector = connectorId
    ? connectors.find((c) => c.id === connectorId)
    : connectorFor(url)
  if (!connector) return { ok: false, reason: 'no-connector', url }

  const origins = perms.hostsFor(connector, url)
  if (!(await perms.has(origins))) {
    return { ok: false, reason: 'needs-permission', origins, connector: connector.id }
  }

  const list = listFor(connector, url)
  const resolvedList = listId ?? list?.instanceId?.(url) ?? list?.id ?? null

  await store.resetStatus()
  await beat({ running: true, phase: 'scanning', connector: connector.id, list: resolvedList, lastError: null })
  await startKeepalive()

  try {
    const page = await capture(connector, tabId, { onProgress: (p) => beat(p) })

    await beat({ phase: 'parsing', seen: page.rowsSeen })

    const now = Date.now()
    const ctx = { url: page.url ?? url, list: resolvedList, listId: resolvedList, now, strategy: 'dom-active-tab' }
    const raws = connector.parseList(page.html, ctx)

    await beat({ total: raws.length })

    // Batched, never one-at-a-time: re-serialising a growing collection per item is O(n^2) and
    // is the bug MakerWorld's storage layer shipped with until it was fixed by exactly this.
    const items = []
    const problems = []
    for (let i = 0; i < raws.length; i += 1) {
      try {
        const partial = connector.normalize(raws[i], { ...ctx, index: i })
        if (partial) items.push(partial)
      } catch (err) {
        problems.push({ index: i, message: err?.message ?? String(err) })
      }
      if (i % store.FLUSH_EVERY === 0) await beat({ done: i })
    }

    await beat({ phase: 'storing', done: raws.length })
    const written = await store.upsertItems(items, { merge: mergeItems, writer: 'connector' })

    await store.bumpGeneration()
    await beat({
      running: false,
      phase: 'done',
      done: raws.length,
      seen: page.rowsSeen,
      // Reported, never quietly assumed: autoScroll is a mitigation, not a guarantee, and a
      // capture that stopped on the deadline may be short. The UI says so.
      settled: page.settled,
      stoppedBecause: page.stoppedBecause,
      added: written?.added ?? 0,
      merged: written?.merged ?? 0,
      problems: problems.length,
    })

    return {
      ok: true,
      connector: connector.id,
      list: resolvedList,
      parsed: raws.length,
      items: items.length,
      ...written,
      settled: page.settled,
      stoppedBecause: page.stoppedBecause,
      rowsSeen: page.rowsSeen,
      problems,
    }
  } catch (err) {
    await beat({ running: false, phase: 'error', lastError: err?.message ?? String(err) })
    return { ok: false, reason: 'failed', error: err?.message ?? String(err) }
  } finally {
    await stopKeepalive()
  }
}

// ── file import ───────────────────────────────────────────────────────────────

async function importFile({ text, name, force }) {
  if (looksLikeInterchange(text)) {
    const local = { items: await store.readItems(), attrs: await store.readAttrs() }
    const state = {
      generation: await store.readGeneration(),
      lineage: await store.getMeta('lineage', null),
      force,
    }
    const result = importInterchange(text, local, state)
    if (!result.ok) return result

    await store.putMany(store.STORES.items, result.items)
    await store.upsertAttrRows(result.attrs)
    if (result.meta?.lineage && !state.lineage) await store.setMeta('lineage', result.meta.lineage)
    await store.bumpGeneration()
    return { ...result, kind: 'interchange', name }
  }

  const parsed = importSavedPage(text, { now: Date.now() })
  if (!parsed.ok) return parsed
  const written = await store.upsertItems(parsed.items, { merge: mergeItems, writer: 'connector' })
  await store.bumpGeneration()
  return { ...parsed, ...written, kind: 'saved-page', name }
}

// ── export ────────────────────────────────────────────────────────────────────

async function exportAll({ source } = {}) {
  const all = await store.readItems()
  const items = source ? all.filter((i) => i.source === source) : all
  const keep = new Set(items.map((i) => i.id))
  const attrs = (await store.readAttrs()).filter((a) => keep.has(a.itemId))
  let lineage = await store.getMeta('lineage', null)
  if (!lineage) {
    lineage = `store:${crypto.randomUUID()}`
    await store.setMeta('lineage', lineage)
  }
  return {
    ok: true,
    filename: `stashling-${source ?? 'all'}-${new Date().toISOString().slice(0, 10)}.jsonl`,
    text: toJsonl({
      items,
      attrs,
      meta: { generation: await store.readGeneration(), exportedAt: Date.now(), lineage },
    }),
    count: items.length,
  }
}

// ── message hub ───────────────────────────────────────────────────────────────

const HANDLERS = {
  status: () => store.readStatus(),
  stats: () => store.stats(),
  connectors: () => connectors.map((c) => ({
    id: c.id, kind: c.kind, version: c.version,
    hosts: c.hosts ?? [], lists: (c.lists ?? []).map((l) => ({ id: l.id, label: l.label })),
    facets: c.facets ?? [],
  })),
  allHosts: () => allHosts(),
  grantedHosts: () => perms.granted(),

  /** What would happen if the user pressed the button on this tab, without doing it. */
  async describeTab({ url }) {
    const connector = url ? connectorFor(url) : null
    if (!connector) return { connector: null, url }
    const list = listFor(connector, url)
    const origins = perms.hostsFor(connector, url)
    return {
      url,
      connector: { id: connector.id, kind: connector.kind, version: connector.version },
      list: list ? { id: list.instanceId?.(url) ?? list.id, label: list.label } : null,
      strategy: connector.acquisition?.strategy ?? null,
      scope: connector.acquisition?.scope ?? null,
      autoScroll: Boolean(connector.acquisition?.autoScroll),
      origins,
      hasPermission: await perms.has(origins),
    }
  },

  collect,
  importFile,
  exportAll,
  clearAll: () => store.clearAll().then(() => ({ ok: true })),
  items: async ({ limit = 500, source } = {}) => {
    const all = await store.readItems()
    const filtered = source ? all.filter((i) => i.source === source) : all
    return { total: filtered.length, items: filtered.slice(0, limit) }
  },
}

browser.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const handler = HANDLERS[msg?.type]
  if (!handler) {
    sendResponse({ error: `unknown message type: ${msg?.type}` })
    return false
  }
  Promise.resolve(handler(msg.payload ?? {}))
    .then((result) => sendResponse(result))
    .catch((err) => sendResponse({ error: err?.message ?? String(err) }))
  // `true` keeps the message channel open for the async response. Returning it unconditionally
  // for known types is deliberate: forgetting it produces a silently dropped reply, which is
  // one of the least debuggable failures in the whole extension surface.
  return true
})

browser.runtime.onInstalled.addListener(async () => {
  // A run interrupted by an update or a crash leaves `running: true` behind. Clearing it on
  // install is the other half of the heartbeat: the user should never have to wonder why the
  // button does nothing.
  const status = await store.readStatus()
  if (status?.running && !store.isRunLive(status)) await store.resetStatus()
})
