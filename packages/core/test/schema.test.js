/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The JSON Schema is a published artifact — other people's tools will validate against it — so it
 * must not drift from the code. There is no schema validator in the dependency tree (there are no
 * dependencies at all), so instead of validating documents we assert that the schema and the
 * runtime agree about the contract.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { REQUIRED_KEYS, ZONES, LIVENESS_STATES, MEMBERSHIP_STATES, createItem, SCHEMA_VERSION } from '../src/item.js'

const schema = JSON.parse(
  readFileSync(fileURLToPath(new URL('../src/schema/item.schema.json', import.meta.url)), 'utf8'),
)

test('the schema parses and identifies itself', () => {
  assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema')
  assert.match(schema.$id, new RegExp(`item-v${SCHEMA_VERSION}\\.json$`))
  assert.equal(schema.type, 'object')
})

test('schema required[] matches REQUIRED_KEYS exactly', () => {
  assert.deepEqual([...schema.required].sort(), [...REQUIRED_KEYS].sort())
})

test('schema properties cover every zone key, and nothing extra', () => {
  assert.deepEqual(Object.keys(schema.properties).sort(), Object.keys(ZONES).sort())
})

test('a freshly created Item has exactly the schema top-level keys', () => {
  // additionalProperties:false at the top level means a stray key is a contract violation, so the
  // constructor and the schema have to agree on the whole set, not just the required subset.
  const item = createItem({ source: 'youtube', sourceId: 'abc', kind: 'video', title: 't' })
  assert.deepEqual(Object.keys(item).sort(), Object.keys(schema.properties).sort())
  assert.equal(schema.additionalProperties, false)
})

test('the open zones stay open and the closed ones stay closed', () => {
  // If someone ever "tidies" these two lines, the user zone starts silently dropping keys again.
  assert.equal(schema.properties.user.additionalProperties, true)
  assert.equal(schema.properties.ext.additionalProperties, true)
  assert.equal(schema.properties.byline.additionalProperties, false)
  assert.equal(schema.properties.raw.additionalProperties, false)
})

test('state enums match the runtime constants', () => {
  assert.deepEqual(schema.properties.liveness.properties.state.enum, [...LIVENESS_STATES])
  assert.deepEqual(schema.properties.membership.properties.state.enum, [...MEMBERSHIP_STATES])
})

test('metrics is constrained to numbers', () => {
  assert.deepEqual(schema.properties.metrics.additionalProperties, { type: 'number' })
})
