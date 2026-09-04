/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Terminal rendering. Nothing here knows what an Item is.
 *
 * Colour is opt-out AND opt-in-by-detection: escape codes are emitted only when the sink is a
 * TTY and `NO_COLOR` is unset. A CLI whose output is meant to be piped into `jq`, diffed in
 * CI, or pasted into an issue must not smuggle SGR codes into that text — `stashling verify`
 * output ending up in a CI log is the normal case here, not the exception.
 * NO_COLOR is honoured as specified at https://no-color.org (any value, including empty).
 */

const SGR = {
  reset: '\u001b[0m',
  bold: '\u001b[1m',
  dim: '\u001b[2m',
  red: '\u001b[31m',
  green: '\u001b[32m',
  yellow: '\u001b[33m',
  cyan: '\u001b[36m',
}

/**
 * @param {{isTTY?:boolean, env?:object}} io
 * @returns {(name:keyof SGR, text:string)=>string} identity when colour is off
 */
export function paint(io) {
  const env = io?.env ?? {}
  const on = Boolean(io?.isTTY) && !('NO_COLOR' in env)
  if (!on) return (_name, text) => String(text)
  return (name, text) => `${SGR[name] ?? ''}${text}${SGR.reset}`
}

/** Visible width, ignoring SGR sequences so a coloured cell still pads correctly. */
export function width(s) {
  return String(s).replace(/\u001b\[[0-9;]*m/g, '').length
}

function pad(cell, to, align) {
  const gap = Math.max(0, to - width(cell))
  return align === 'right' ? ' '.repeat(gap) + cell : cell + ' '.repeat(gap)
}

/**
 * Fixed-width table. Column widths are measured, not guessed, so a 60-character video title
 * does not shear the column to its right.
 *
 * @param {string[]} headers
 * @param {Array<Array<string>>} rows
 * @param {Array<'left'|'right'>} [aligns]
 * @returns {string} newline-terminated block ('' for no rows)
 */
export function table(headers, rows, aligns = []) {
  if (!rows.length) return ''
  const cols = headers.length
  const widths = []
  for (let c = 0; c < cols; c += 1) {
    widths[c] = Math.max(width(headers[c]), ...rows.map((r) => width(r[c] ?? '')))
  }
  const line = (cells) => cells
    .map((cell, c) => pad(String(cell ?? ''), widths[c], aligns[c] ?? 'left'))
    .join('  ')
    .replace(/\s+$/, '')
  const out = [line(headers), line(widths.map((w) => '-'.repeat(w)))]
  for (const row of rows) out.push(line(row))
  return `${out.join('\n')}\n`
}

/** Truncate to a display width, with an ellipsis that counts toward the budget. */
export function truncate(s, max) {
  const str = String(s ?? '')
  if (max <= 1 || str.length <= max) return str
  return `${str.slice(0, max - 1)}…`
}

/**
 * Percentages are printed to one decimal place because that is the resolution at which the
 * signal this tool exists to give you is legible: on a real 582-row page, 3 missing bylines
 * is 99.5% and 23 missing titles is 96.0%. Rounding to whole percent collapses "fine" and
 * "something changed overnight" into the same "100%".
 */
export function pct(present, total) {
  if (!total) return '  n/a'
  return `${((present / total) * 100).toFixed(1)}%`
}

/** `1 item` / `2 items` — plural agreement, because reports get read by humans. */
export function plural(n, one, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`
}

export function jsonLine(value) {
  return `${JSON.stringify(value, null, 2)}\n`
}
