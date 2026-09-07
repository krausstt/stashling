/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The collection page.
 *
 * This is where the generic-facet design has to earn its keep: the filters below are built from
 * the connectors' own facet manifests and applied by core's `matchesFilter`. There is not one
 * line of YouTube or MakerWorld knowledge in this file. Adding a connector adds its filters
 * here for free — that is the entire argument for the flat `metrics` map.
 */

import { applyFilters, facetRange, termCounts, readPath } from '../vendor/core/index.js'

if (!globalThis.browser) globalThis.browser = chrome

const $ = (id) => document.getElementById(id)
const send = (type, payload = {}) => browser.runtime.sendMessage({ type, payload })

let items = []
let facets = []
const filters = {}

const notice = (text) => {
  $('notice').hidden = !text
  $('notice').textContent = text ?? ''
}

/** Facet manifests from every connector, deduplicated by key. */
function facetsFrom(connectors) {
  const byKey = new Map()
  for (const c of connectors ?? []) {
    for (const f of c.facets ?? []) if (!byKey.has(f.key)) byKey.set(f.key, f)
  }
  return [...byKey.values()]
}

/**
 * Only render a facet the loaded items can actually answer.
 *
 * A range slider over a metric no item carries is worse than no slider: it invites a filter
 * that can only ever return nothing. `facetRange` returns null in exactly that case.
 */
function renderFacets() {
  $('facets').innerHTML = ''
  for (const facet of facets) {
    if (facet.type === 'range') {
      const range = facetRange(items, facet)
      if (!range) continue
      const box = document.createElement('div')
      box.className = 'facet'
      const unit = facet.unit ? ` ${facet.unit}` : ''
      box.innerHTML = `<h3>${facet.label}</h3>
        <div class="range">
          <input type="number" data-key="${facet.key}" data-side="min" placeholder="min">
          <span class="hint">–</span>
          <input type="number" data-key="${facet.key}" data-side="max" placeholder="max">
          <span class="hint">${unit}</span>
        </div>
        <div class="hint">${range.count} of ${items.length} items · ${round(range.min)}–${round(range.max)}${unit}${
          facet.capOpen && facet.cap ? ` · ${facet.cap}${unit}+ is open-ended` : ''}</div>`
      $('facets').append(box)
    } else if (facet.type === 'term') {
      const counts = termCounts(items, facet)
      if (!counts.length) continue
      const box = document.createElement('div')
      box.className = 'facet'
      const options = counts.slice(0, 40)
        .map((t) => `<option value="${escapeAttr(t.value)}">${escapeHtml(t.value)} (${t.count})</option>`)
        .join('')
      box.innerHTML = `<h3>${facet.label}</h3>
        <select data-key="${facet.key}" data-side="term"><option value="">any</option>${options}</select>`
      $('facets').append(box)
    } else if (facet.type === 'bool') {
      // Tri-state, not a checkbox. A checkbox cannot say "either" — it collapses "show me the
      // ones without AMS" and "I don't care" into the same unchecked box, so the filter would
      // silently narrow the collection the moment the facet rendered.
      const counts = termCounts(items, facet)
      if (!counts.length) continue
      const seen = (v) => counts.find((c) => c.value === v)?.count ?? 0
      const box = document.createElement('div')
      box.className = 'facet'
      box.innerHTML = `<h3>${escapeHtml(facet.label)}</h3>
        <select data-key="${escapeAttr(facet.key)}" data-side="bool">
          <option value="">either</option>
          <option value="yes">yes (${seen('true')})</option>
          <option value="no">no (${seen('false')})</option>
        </select>
        <div class="hint">${counts.reduce((n, c) => n + c.count, 0)} of ${items.length} items say</div>`
      $('facets').append(box)
    }
  }

  for (const el of $('facets').querySelectorAll('input,select')) {
    el.addEventListener('input', onFilterChange)
  }
}

function onFilterChange(event) {
  const { key, side } = event.target.dataset
  const raw = event.target.value
  const facet = facets.find((f) => f.key === key)
  if (!facet) return

  if (side === 'term') {
    if (raw) filters[key] = { any: [raw] }
    else delete filters[key]
  } else if (side === 'bool') {
    if (raw === 'yes') filters[key] = { value: true }
    else if (raw === 'no') filters[key] = { value: false }
    else delete filters[key]
  } else {
    const current = filters[key] ?? {}
    if (raw === '') delete current[side]
    else current[side] = Number(raw)
    if (current.min === undefined && current.max === undefined) delete filters[key]
    else filters[key] = current
  }
  render()
}

const round = (n) => (Number.isInteger(n) ? n : Math.round(n * 10) / 10)
const escapeHtml = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))
const escapeAttr = (s) => String(s).replace(/"/g, '&quot;')

function matchesSearch(item, query) {
  if (!query) return true
  const q = query.toLowerCase()
  return [item.title, item.byline?.name, item.byline?.handle, item.source, ...(item.tags ?? [])]
    .filter(Boolean)
    .some((v) => String(v).toLowerCase().includes(q))
}

function render() {
  let shown = applyFilters(items, facets, filters)

  const query = $('search').value.trim()
  if (query) shown = shown.filter((i) => matchesSearch(i, query))
  if ($('source').value) shown = shown.filter((i) => i.source === $('source').value)
  if ($('liveness').value) shown = shown.filter((i) => i.liveness?.state === $('liveness').value)

  $('rows').innerHTML = ''
  for (const item of shown.slice(0, 1000)) {
    const tr = document.createElement('tr')
    const order = Object.values(item.order ?? {})[0] ?? ''
    const metrics = Object.entries(item.metrics ?? {})
      .map(([k, v]) => `${k} ${v.toLocaleString()}`).join('  ')
    tr.innerHTML = `
      <td class="num">${order}</td>
      <td><a href="${escapeAttr(item.url)}" target="_blank" rel="noreferrer noopener">${
        escapeHtml(item.title || item.id)}</a>${
        item.byline?.name ? `<div class="muted small">${escapeHtml(item.byline.name)}</div>` : ''}</td>
      <td class="mono">${escapeHtml(item.source)}</td>
      <td class="num">${escapeHtml(metrics)}</td>
      <td class="state ${item.liveness?.state ?? 'unknown'}">${item.liveness?.state ?? 'unknown'}${
        item.membership?.state === 'unlisted' ? '<div class="muted small">unlisted</div>' : ''}</td>`
    $('rows').append(tr)
  }

  $('empty').hidden = items.length > 0
  $('summary').textContent = `${shown.length} of ${items.length} items`
    + (shown.length === 1000 ? ' (showing the first 1000)' : '')
  $('footer-stats').textContent = `${items.length} items · `
    + `${new Set(items.map((i) => i.source)).size} sources · `
    + `${items.filter((i) => i.liveness?.state === 'gone').length} gone`
}

async function load() {
  const [result, connectors, granted] = await Promise.all([
    send('items', { limit: 100000 }), send('connectors'), send('grantedHosts'),
  ])
  items = result?.items ?? []
  facets = facetsFrom(connectors)

  $('granted').textContent = granted?.length ? granted.join(', ') : 'none yet'

  const sources = [...new Set(items.map((i) => i.source))].sort()
  $('source').innerHTML = '<option value="">every source</option>'
    + sources.map((s) => `<option value="${escapeAttr(s)}">${escapeHtml(s)}</option>`).join('')

  renderFacets()
  render()
}

$('search').addEventListener('input', render)
$('source').addEventListener('change', render)
$('liveness').addEventListener('change', render)

$('export').addEventListener('click', async () => {
  const result = await send('exportAll')
  if (!result?.ok) return notice('Export failed.')
  const url = URL.createObjectURL(new Blob([result.text], { type: 'application/x-ndjson' }))
  await browser.downloads.download({ url, filename: result.filename, saveAs: true })
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
  notice(`Exported ${result.count} items.`)
})

$('import').addEventListener('change', async (event) => {
  const file = event.target.files?.[0]
  if (!file) return
  notice(`Reading ${file.name}…`)
  const text = await file.text()
  const result = await send('importFile', { text, name: file.name })
  event.target.value = ''

  if (!result?.ok) {
    if (result?.reason === 'stale') {
      notice(`Refused: that file is generation ${result.incomingGeneration}, and this collection `
        + `is already at ${result.localGeneration}. Importing it would roll your collection back.`)
    } else if (result?.reason === 'no-connector') {
      notice('No bundled connector recognises that page, and it is not an interchange file.')
    } else {
      notice(`Import failed: ${result?.reason ?? result?.error ?? 'unknown'}`)
    }
    return
  }

  // Non-destructive, always. Items already here that are absent from the file survive.
  notice(result.kind === 'interchange'
    ? `Imported ${file.name}: ${result.added} new, ${result.merged} merged. `
      + 'Nothing was deleted — items not in the file are untouched.'
    : `Parsed ${file.name} with the ${result.connector} connector: `
      + `${result.added} new, ${result.merged} updated.`)
  await load()
})

$('clear').addEventListener('click', async () => {
  if (!confirm('Delete every collected item, annotation and export history from this browser?\n\n'
    + 'Export first if you want to keep any of it. This cannot be undone.')) return
  await send('clearAll')
  await load()
  notice('Everything deleted.')
})

load()
