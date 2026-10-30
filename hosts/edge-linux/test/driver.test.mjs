/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The pure parts of the edge-linux driver.
 *
 * What is NOT tested here is the CDP conversation itself, and the guide says so out loud: it
 * needs a real Chrome, a real X display and a real logged-in profile, which is exactly the
 * thing `doctor.sh` exists to exercise on the box. What IS tested is every decision made
 * *before* a socket is opened — because those are the ones that decide whether a sweep that
 * collects 7% of a list is reported as a failure or merged into the store as a success.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import {
  validateConfig, loadConfig, extensionIdFrom, unpackedExtensionId, resolveExtensionId, lockIsStale,
} from '../driver/collect.mjs'
import { readActivePort } from '../driver/cdp.mjs'

const okTarget = { name: 'wl', url: 'https://www.youtube.com/playlist?list=WL', minRows: 20 }
const okConfig = { profileDir: '/var/lib/stashling/chrome-profile', targets: [okTarget] }

test('validateConfig accepts a complete config', () => {
  assert.deepEqual(validateConfig(okConfig), [])
})

test('validateConfig requires a profile directory', () => {
  const problems = validateConfig({ targets: [okTarget] })
  assert.equal(problems.length, 1)
  assert.match(problems[0], /profileDir/)
})

test('validateConfig refuses a target with no row floor', () => {
  // The whole point. A target without `minRows` cannot distinguish "the list is short today"
  // from "the tab was never visible and we scraped the first screenful", and the second one
  // merges cleanly into the store and looks like success.
  for (const bad of [undefined, 0, -1, 1.5, '20', null]) {
    const problems = validateConfig({ ...okConfig, targets: [{ ...okTarget, minRows: bad }] })
    assert.equal(problems.length, 1, `minRows: ${JSON.stringify(bad)} should be rejected`)
    assert.match(problems[0], /minRows/)
  }
})

test('validateConfig accepts a row floor of exactly 1', () => {
  assert.deepEqual(validateConfig({ ...okConfig, targets: [{ ...okTarget, minRows: 1 }] }), [])
})

test('validateConfig refuses a non-https target', () => {
  // The box holds live session cookies for every platform it is logged into. A plain-http
  // target on the same machine is a downgrade waiting for a hostile DNS answer.
  const problems = validateConfig({ ...okConfig, targets: [{ ...okTarget, url: 'http://example.com/x' }] })
  assert.equal(problems.length, 1)
  assert.match(problems[0], /https/)
})

test('validateConfig refuses an empty target list', () => {
  assert.match(validateConfig({ ...okConfig, targets: [] })[0], /non-empty/)
})

test('validateConfig reports every problem at once, not just the first', () => {
  const problems = validateConfig({ targets: [{ url: 'http://x.test/' }] })
  assert.ok(problems.length >= 4, `expected profileDir + name + https + minRows, got ${problems.length}`)
})

test('extensionIdFrom finds the id from the service-worker target', () => {
  const targets = [
    { type: 'page', url: 'https://www.youtube.com/playlist?list=WL' },
    { type: 'service_worker', url: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/sw.js' },
  ]
  assert.equal(extensionIdFrom(targets), 'abcdefghijklmnopabcdefghijklmnop')
})

test('extensionIdFrom ignores a different extension running its own service worker', () => {
  // A real profile has more than one extension, and several of them have a service worker.
  // Matching on the path is what keeps this from attaching to a password manager.
  const targets = [
    { type: 'service_worker', url: 'chrome-extension://ponmlkjihgfedcbaponmlkjihgfedcba/background.js' },
    { type: 'service_worker', url: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/sw.js' },
  ]
  assert.equal(extensionIdFrom(targets), 'abcdefghijklmnopabcdefghijklmnop')
})

test('extensionIdFrom does not mistake an extension PAGE for the worker', () => {
  const targets = [
    { type: 'page', url: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/ui/collection.html' },
  ]
  assert.equal(extensionIdFrom(targets), null)
})

test('extensionIdFrom returns null when no worker target exists — which includes an asleep worker', () => {
  assert.equal(extensionIdFrom([{ type: 'page', url: 'https://example.com/' }]), null)
  assert.equal(extensionIdFrom([]), null)
})

// ── the extension id, when the worker is asleep ─────────────────────────────────────────────

test('unpackedExtensionId maps SHA-256 hex digits 0-f onto a-p', () => {
  // SHA-256("abc") = ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad, a standard
  // published vector. The first 32 hex digits, mapped by hand (0->a … f->p), pin the mapping
  // against something this code did not produce.
  assert.equal(unpackedExtensionId('abc'), 'lkhibglpipabmpokebebeanofnkocccd')
  const id = unpackedExtensionId('/opt/stashling/extension')
  assert.match(id, /^[a-p]{32}$/)
  assert.equal(id, unpackedExtensionId('/opt/stashling/extension'), 'deterministic')
  assert.notEqual(id, unpackedExtensionId('/opt/stashling/extension2'), 'path-specific')
})

test('resolveExtensionId does not need a running worker — that is the bug it fixes', () => {
  // Between sweeps the MV3 worker is asleep and has NO DevTools target. The old driver read the
  // id only from that target, so most half-hourly sweeps would have failed "not running".
  const ext = resolveExtensionId([], { extensionDir: '/opt/stashling/extension' })
  assert.equal(ext.id, unpackedExtensionId('/opt/stashling/extension'))
  assert.equal(ext.via, 'path')
  assert.equal(ext.awake, false, 'asleep is reported, not treated as missing')
})

test('resolveExtensionId reports the worker awake when its target is ours', () => {
  const id = unpackedExtensionId('/opt/stashling/extension')
  const ext = resolveExtensionId(
    [{ type: 'service_worker', url: `chrome-extension://${id}/sw.js` }],
    { extensionDir: '/opt/stashling/extension' },
  )
  assert.equal(ext.awake, true)
})

test('resolveExtensionId never adopts ANOTHER extension that happens to have a /sw.js', () => {
  // The old heuristic matched any worker ending in /sw.js — a password manager would do.
  const other = 'ponmlkjihgfedcbaponmlkjihgfedcba'
  const ext = resolveExtensionId(
    [{ type: 'service_worker', url: `chrome-extension://${other}/sw.js` }],
    { extensionDir: '/opt/stashling/extension' },
  )
  assert.notEqual(ext.id, other)
  assert.equal(ext.awake, false)
})

test('an explicit extensionId wins over derivation', () => {
  const ext = resolveExtensionId([], { extensionDir: '/x', extensionId: 'abcdefghijklmnopabcdefghijklmnop' })
  assert.equal(ext.id, 'abcdefghijklmnopabcdefghijklmnop')
  assert.equal(ext.via, 'config')
})

test('loadConfig defaults extensionDir to where bootstrap.sh installs the extension', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'stashling-'))
  try {
    const file = path.join(dir, 'c.json')
    writeFileSync(file, JSON.stringify(okConfig))
    const cfg = loadConfig(file)
    assert.equal(cfg.extensionDir, '/opt/stashling/extension')
    assert.ok(cfg.staleLockMs > 20 * 60_000, 'must outlast the unit TimeoutStartSec of 20 min')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── the lock that must never outlive its sweep ──────────────────────────────────────────────

const NOW = Date.parse('2026-10-30T12:00:00Z')
const lockText = (pid, ago) => `pid=${pid} started=${new Date(NOW - ago).toISOString()}`

test('a lock held by a live, recent sweep is respected', () => {
  const v = lockIsStale(lockText(4242, 60_000), { now: NOW, isAlive: () => true })
  assert.equal(v.stale, false)
})

test('a lock whose process is gone is stale — systemd killed it and finally never ran', () => {
  // The failure this prevents: one hung sweep killed at TimeoutStartSec leaves the lock behind
  // (across reboots, it lives in /var/lib), and every later tick exits 0 "already running".
  const v = lockIsStale(lockText(4242, 60_000), { now: NOW, isAlive: () => false })
  assert.equal(v.stale, true)
  assert.match(v.why, /not running/)
})

test('a lock older than any sweep could run is stale even if the pid is alive', () => {
  // After a reboot the recorded pid may belong to an unrelated process.
  const v = lockIsStale(lockText(1, 3 * 60 * 60_000), { now: NOW, isAlive: () => true })
  assert.equal(v.stale, true)
  assert.match(v.why, /older than/)
})

test('an unparseable lock is stale', () => {
  for (const junk of ['', 'garbage', 'pid=abc started=x', 'pid=12', 'started=2026-01-01T00:00:00Z']) {
    assert.equal(lockIsStale(junk, { now: NOW, isAlive: () => true }).stale, true, `"${junk}"`)
  }
})

test('readActivePort reads the port from the first line', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'stashling-'))
  try {
    // Chrome writes the port on line 1 and the browser-target path on line 2.
    writeFileSync(path.join(dir, 'DevToolsActivePort'), '45321\n/devtools/browser/abc-def\n')
    assert.deepEqual(readActivePort(dir), { ok: true, port: 45321, file: path.join(dir, 'DevToolsActivePort') })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('readActivePort reports a missing file rather than guessing 9222', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'stashling-'))
  try {
    const got = readActivePort(dir)
    assert.equal(got.ok, false)
    assert.equal(got.reason, 'no-port-file')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('readActivePort refuses a truncated or garbage port file', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'stashling-'))
  try {
    for (const junk of ['', '\n', 'not-a-port\n', '0\n', '99999\n', '-1\n']) {
      writeFileSync(path.join(dir, 'DevToolsActivePort'), junk)
      const got = readActivePort(dir)
      assert.equal(got.ok, false, `"${junk.trim()}" should not parse as a port`)
      assert.equal(got.reason, 'unparseable')
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
