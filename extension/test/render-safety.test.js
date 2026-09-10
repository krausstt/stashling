/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The collection page's security boundary.
 *
 * These had no coverage at all until an adversarial review of the commit that introduced them
 * found two holes in `safeHref` by inspection. Every case below is one of those holes or a
 * regression guard for the injection the escaping exists to stop.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { escapeHtml, escapeAttr, safeHref, safeLivenessClass } from '../ui/render-safety.js'

test('escapeHtml neutralises every character that can break out of text or an attribute', () => {
  assert.equal(escapeHtml('<img src=x>'), '&lt;img src=x&gt;')
  assert.equal(escapeHtml('"><img src=x>'), '&quot;&gt;&lt;img src=x&gt;')
  assert.equal(escapeHtml("' onload='alert(1)"), '&#39; onload=&#39;alert(1)')
  assert.equal(escapeHtml('a & b'), 'a &amp; b')
  assert.equal(escapeAttr, escapeHtml, 'one function, so the rule is checkable')
})

test('escapeHtml coerces non-strings rather than throwing on them', () => {
  assert.equal(escapeHtml(42), '42')
  assert.equal(escapeHtml(null), 'null')
  assert.equal(escapeHtml(undefined), 'undefined')
})

test('THE INJECTION: a hostile liveness.state cannot escape its class attribute', () => {
  // Measured against the real page before the fix: this exact value injected three elements.
  const hostile = '"><img src=https://evil.example/?c=1>'
  assert.equal(escapeHtml(hostile).includes('<img'), false)
  // …and it can never choose the class either.
  assert.equal(safeLivenessClass(hostile), 'unknown')
})

test('safeLivenessClass admits only the four contract states', () => {
  for (const s of ['live', 'gone', 'restricted', 'unknown']) assert.equal(safeLivenessClass(s), s)
  assert.equal(safeLivenessClass('LIVE'), 'unknown', 'case-exact, or the class is attacker-chosen')
  assert.equal(safeLivenessClass(''), 'unknown')
  assert.equal(safeLivenessClass(undefined), 'unknown')
})

test('safeHref allows absolute http(s) and nothing else', () => {
  assert.equal(safeHref('https://example.com/x?a=1#f'), 'https://example.com/x?a=1#f')
  assert.equal(safeHref('http://example.com/'), 'http://example.com/')
  assert.equal(safeHref('javascript:alert(1)'), null)
  assert.equal(safeHref('data:text/html,<script>alert(1)</script>'), null)
  assert.equal(safeHref('file:///C:/Windows/System32/'), null)
  assert.equal(safeHref('chrome-extension://abc/popup.html'), null)
  assert.equal(safeHref('vbscript:msgbox(1)'), null)
})

test('safeHref REJECTS a protocol-relative URL', () => {
  // The first version resolved against a placeholder base, which silently promoted this to
  // https and pointed the link at the attacker's host — while the comment claimed it rendered
  // as inert text.
  assert.equal(safeHref('//evil.example/beacon?c=1'), null)
  assert.equal(safeHref('\\\\evil.example\\beacon'), null)
})

test('safeHref REJECTS a relative URL and an empty one', () => {
  // `createItem` defaults `url` to '', so with a base URL every item lacking a link rendered as
  // a live-looking link to the placeholder host, making the "(no usable link)" fallback nearly
  // unreachable.
  assert.equal(safeHref(''), null)
  assert.equal(safeHref('   '), null)
  assert.equal(safeHref(null), null)
  assert.equal(safeHref(undefined), null)
  assert.equal(safeHref('foo.html'), null)
  assert.equal(safeHref('/relative/path'), null)
})

test('safeHref tolerates surrounding whitespace on an otherwise good URL', () => {
  assert.equal(safeHref('  https://example.com/x  '), 'https://example.com/x')
})
