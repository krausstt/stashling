/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The popup.
 *
 * It holds no state of its own. Everything shown is read from the worker on open and re-read
 * while a run is in flight, because the worker can be terminated and restarted underneath it at
 * any moment — a popup that caches a run's progress in a variable shows a frozen number the
 * first time Chrome reclaims the worker.
 *
 * The one thing it MUST own is the permission request: `permissions.request()` only succeeds
 * inside a live user gesture, so it is wired directly to a click handler with no `await` in
 * front of it that could outlive the gesture.
 */

import * as perms from './permissions.js'

if (!globalThis.browser) globalThis.browser = chrome

const $ = (id) => document.getElementById(id)
const send = (type, payload = {}) => browser.runtime.sendMessage({ type, payload })
const show = (id, on = true) => { $(id).hidden = !on }

let tab = null
let described = null
let poll = null

async function activeTab() {
  const [t] = await browser.tabs.query({ active: true, currentWindow: true })
  return t ?? null
}

function renderTab(d) {
  if (!d?.connector) {
    show('unsupported', true)
    send('connectors').then((list) => {
      $('supported-list').innerHTML = ''
      for (const c of list ?? []) {
        const li = document.createElement('li')
        li.textContent = `${c.id} — ${c.lists.map((l) => l.label).join(', ')}`
        $('supported-list').append(li)
      }
    })
    return
  }

  show('tab-state', true)
  $('connector-id').textContent = d.connector.id
  $('list-label').textContent = d.list ? d.list.label : 'no recognised list on this page'

  // The Chrome Web Store's Limited Use policy requires what a collector reads to be disclosed
  // in the product UI, not only on the listing. This sentence is that disclosure, and it is
  // deliberately specific rather than a link to a policy nobody opens.
  $('what').textContent = d.list
    ? `Reads the rendered ${d.list.label} page in this tab and stores each row on this machine. `
      + 'Nothing is uploaded anywhere.'
    : 'Open a list page this connector recognises.'

  if (!d.hasPermission) {
    show('needs-permission', true)
    $('origins').textContent = d.origins.join('\n')
    return
  }

  if (d.list) {
    show('ready', true)
    $('scroll-note').textContent = d.autoScroll
      ? 'This list loads as you scroll, so collecting scrolls to the end first. '
        + 'You will be told if it stopped early.'
      : ''
  }
}

function renderStatus(s) {
  if (!s) return
  const running = Boolean(s.running)
  show('progress', running || s.phase === 'error')
  if (running) show('ready', false)

  $('phase').textContent = s.phase ?? ''
  const done = Number(s.done) || 0
  const total = Number(s.total) || 0
  $('counts').textContent = total ? `${done} / ${total}` : (s.seen ? `${s.seen} rows seen` : '')
  $('fill').style.width = total ? `${Math.min(100, (done / total) * 100)}%` : '0%'
  $('note').textContent = s.lastError ?? ''
}

function renderResult(r) {
  show('progress', false)
  show('ready', true)
  show('result', true)

  if (!r?.ok) {
    $('result-text').textContent = r?.error ?? `Could not collect: ${r?.reason ?? 'unknown'}`
    return
  }

  $('result-text').textContent =
    `${r.parsed} rows parsed — ${r.added ?? 0} new, ${r.merged ?? 0} updated.`

  // Never quietly under-collect. If the scroll hit its deadline the capture may be short, and
  // saying so is the whole difference between a tool you can trust with a backlog and one you
  // cannot.
  $('result-warning').textContent = r.settled === false
    ? `The list was still growing when the scroll budget ran out (${r.stoppedBecause}). `
      + 'Scroll to the end yourself and collect again to be sure you have everything.'
    : ''
}

async function refreshStats() {
  const s = await send('stats')
  if (s && !s.error) {
    $('stats').textContent = `${s.items ?? 0} items kept locally`
  }
}

async function init() {
  tab = await activeTab()
  described = await send('describeTab', { url: tab?.url })
  renderTab(described)
  renderStatus(await send('status'))
  refreshStats()
}

$('grant').addEventListener('click', async () => {
  // No await before this call: the user gesture must still be live when request() runs.
  const granted = await perms.request(described.origins)
  if (granted === true) {
    show('needs-permission', false)
    described = await send('describeTab', { url: tab?.url })
    renderTab(described)
  } else {
    $('origins').textContent = granted?.error
      ? `Could not ask for access: ${granted.error}`
      : 'Access was declined. Nothing has been read.'
  }
})

$('collect').addEventListener('click', async () => {
  $('collect').disabled = true
  show('result', false)
  show('progress', true)

  poll = setInterval(async () => renderStatus(await send('status')), 700)
  try {
    const result = await send('collect', {
      tabId: tab.id, url: tab.url, connectorId: described.connector.id,
    })
    renderResult(result)
    refreshStats()
  } finally {
    clearInterval(poll)
    $('collect').disabled = false
  }
})

$('export').addEventListener('click', async () => {
  const result = await send('exportAll')
  if (!result?.ok) return
  // A Blob URL rather than a data: URL — a data: URL of a large collection exceeds what the
  // downloads API will accept, and the failure is silent.
  const url = URL.createObjectURL(new Blob([result.text], { type: 'application/x-ndjson' }))
  await browser.downloads.download({ url, filename: result.filename, saveAs: true })
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
})

$('open-collection').addEventListener('click', () => browser.runtime.openOptionsPage())

init()
