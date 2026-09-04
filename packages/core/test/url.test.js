/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  canonicalizeUrl, unwrapAmp, urlsplit, parseQsl, percentDecode, quotePlus,
} from '../src/url.js'

test('urlsplit never throws and handles scheme-less input', () => {
  assert.deepEqual(urlsplit('example.com/a?b=1#c'), {
    scheme: '', netloc: 'example.com', path: '/a', query: 'b=1', fragment: 'c',
  })
  assert.deepEqual(urlsplit(''), { scheme: '', netloc: '', path: '', query: '', fragment: '' })
  assert.doesNotThrow(() => urlsplit('::::not a url::::'))
})

test('percentDecode flushes consecutive %XX bytes as one UTF-8 sequence', () => {
  // Three bytes, one character. Decoding them individually yields mojibake.
  assert.equal(percentDecode('%E2%9C%93'), '✓')
  assert.equal(percentDecode('a+b', true), 'a b')
  assert.equal(percentDecode('a+b', false), 'a+b')
  assert.equal(percentDecode('100%'), '100%') // a trailing bare % is literal, not an error
})

test('parseQsl mirrors Python parse_qsl(keep_blank_values=True)', () => {
  assert.deepEqual(parseQsl('a=1&b=&c&d=x=y'), [['a', '1'], ['b', ''], ['c', ''], ['d', 'x=y']])
  assert.deepEqual(parseQsl(''), [])
})

test('quotePlus matches java.net.URLEncoder, NOT encodeURIComponent', () => {
  // The whole point: a space is "+", not "%20". A one-character difference here silently
  // splits the dedup key across runtimes.
  assert.equal(quotePlus('esp32 audio board'), 'esp32+audio+board')
  assert.notEqual(quotePlus('a b'), encodeURIComponent('a b'))
  // URLEncoder's unreserved set is A-Za-z0-9 . - * _ — everything else is escaped.
  assert.equal(quotePlus('a.b-c*d_e'), 'a.b-c*d_e')
  assert.equal(quotePlus("!~'()"), '%21%7E%27%28%29')
  assert.equal(quotePlus('ü'), '%C3%BC')
})

test('tracking params: prefix families vs anchored exact matches', () => {
  assert.equal(
    canonicalizeUrl('https://example.com/p?utm_source=x&utm_medium=y&keep=1'),
    'https://example.com/p?keep=1',
  )
  assert.equal(canonicalizeUrl('https://example.com/p?gclid=abc&id=7'), 'https://example.com/p?id=7')
  // `si` is stripped as an EXACT match...
  assert.equal(canonicalizeUrl('https://example.com/p?si=abc&x=1'), 'https://example.com/p?x=1')
  // ...but `size` survives. A prefix rule for `si` would eat it. This is the documented scar.
  assert.equal(canonicalizeUrl('https://example.com/p?size=42'), 'https://example.com/p?size=42')
})

test('youtube keeps only the v param', () => {
  assert.equal(
    canonicalizeUrl('https://www.youtube.com/watch?v=gPW_mitgosw&list=WL&index=1&pp=iAQBsAgC'),
    'https://youtube.com/watch?v=gPW_mitgosw',
  )
  // Substring match, so the mobile and music hosts are covered too.
  assert.equal(
    canonicalizeUrl('https://m.youtube.com/watch?v=abc&t=90'),
    'https://m.youtube.com/watch?v=abc',
  )
  // youtu.be is NOT covered by the host rule; its `si` goes via the generic tracking strip.
  assert.equal(canonicalizeUrl('https://youtu.be/abc?si=track'), 'https://youtu.be/abc')
})

test('host is lowercased but path case is preserved', () => {
  assert.equal(
    canonicalizeUrl('https://Medium.COM/@author/Some-Post-1a2b3c'),
    'https://medium.com/@author/Some-Post-1a2b3c',
  )
})

test('trailing slashes collapse; a bare host becomes /', () => {
  assert.equal(canonicalizeUrl('https://example.com/a/b///'), 'https://example.com/a/b')
  assert.equal(canonicalizeUrl('https://example.com'), 'https://example.com/')
  assert.equal(canonicalizeUrl('https://example.com/'), 'https://example.com/')
})

test('scheme is forced to https and the fragment is dropped by default', () => {
  assert.equal(canonicalizeUrl('http://example.com/a#section'), 'https://example.com/a')
  // ...but both are per-connector escape hatches, because they are data decisions.
  assert.equal(
    canonicalizeUrl('http://example.com/a#section', { keepFragment: true, forceHttps: false }),
    'http://example.com/a#section',
  )
})

test('unwrapAmp: google /url, google /amp/s, ampproject, ampshare, /v/s', () => {
  assert.equal(
    unwrapAmp('https://www.google.com/url?q=https://example.com/story&sa=U'),
    'https://example.com/story',
  )
  assert.equal(unwrapAmp('https://www.google.com/amp/s/example.com/story.amp'), 'https://example.com/story')
  assert.equal(
    unwrapAmp('https://example-com.cdn.ampproject.org/v/s/example.com/story.amp'),
    'https://example.com/story',
  )
  // Fragment is searched BEFORE query — the order is load-bearing.
  assert.equal(
    unwrapAmp('https://example-com.cdn.ampproject.org/x?ampshare=https%3A%2F%2Fa.example%2Fq#ampshare=https%3A%2F%2Fb.example%2Fq'),
    'https://b.example/q',
  )
  assert.equal(unwrapAmp('https://example.com/plain'), 'https://example.com/plain')
})

test('AMP leftovers are dropped and /amp path suffixes stripped', () => {
  assert.equal(
    canonicalizeUrl('https://example.com/story/amp?amp_js_v=1&usqp=x&real=1'),
    'https://example.com/story?real=1',
  )
})

test('query param order and key case are preserved', () => {
  assert.equal(canonicalizeUrl('https://example.com/p?B=2&a=1'), 'https://example.com/p?B=2&a=1')
})

test('canonicalization is idempotent', () => {
  const inputs = [
    'https://www.youtube.com/watch?v=abc&list=WL',
    'http://Example.com/A/b/?utm_source=x#frag',
    'https://www.google.com/url?q=https://example.com/story',
    'example.com',
  ]
  for (const input of inputs) {
    const once = canonicalizeUrl(input)
    assert.equal(canonicalizeUrl(once), once, `not idempotent for ${input}`)
  }
})

test('empty and nullish input canonicalize to empty string, not a throw', () => {
  assert.equal(canonicalizeUrl(''), '')
  assert.equal(canonicalizeUrl(null), '')
  assert.equal(canonicalizeUrl(undefined), '')
})
