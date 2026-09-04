/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Streaming interchange I/O — the only part of the CLI that touches the filesystem.
 *
 * TWO RULES, BOTH LOAD-BEARING:
 *
 * 1. **The CLI does not own a second parser for the interchange format.** Line classification,
 *    the "unknown `type` is ignored by contract" rule and the "a malformed line is recorded
 *    and skipped, never fatal" rule all live in `@stashling/core`'s `fromJsonl`. A streaming
 *    host that reimplements that switch is how two readers of the same format drift — so this
 *    file streams lines off disk, hands core fixed-size BATCHES of them, and only fixes up the
 *    line numbers in the errors that come back. Batching (rather than one `fromJsonl` per
 *    line) is purely to keep the per-line allocation down; the semantics are identical either
 *    way because `fromJsonl` splits on `/\r?\n/` and skips blanks.
 *
 * 2. **A store file is replaced atomically or not at all.** `import --into` writes a sibling
 *    temp file and renames over the target, so a process killed mid-write leaves the previous
 *    store intact. The alternative — truncating the user's only copy of their collection and
 *    then streaming into it — is the one bug in this file that would be unrecoverable.
 */

import { createReadStream, createWriteStream } from 'node:fs'
import { rename, copyFile, unlink, stat } from 'node:fs/promises'
import { once } from 'node:events'
import { createInterface } from 'node:readline'
import path from 'node:path'
import { fromJsonl, toJsonl } from '../../core/src/interchange.js'
import { UsageError } from './errors.js'

/** Lines handed to `fromJsonl` at a time. Big enough to amortise, small enough to stay flat. */
const BATCH = 512

/** Recorded malformed lines are capped: pointing a JSONL reader at a 12 MB HTML file should
 *  report "this is not JSONL", not 300,000 identical parse errors. The COUNT is still exact. */
const ERROR_SAMPLE_LIMIT = 100

export async function assertReadable(file, what = 'file') {
  try {
    const s = await stat(file)
    if (s.isDirectory()) throw new UsageError(`${what} is a directory: ${file}`)
  } catch (err) {
    if (err instanceof UsageError) throw err
    throw new UsageError(`cannot read ${what}: ${file}`, { hint: err.code === 'ENOENT' ? 'no such file' : err.message })
  }
}

/** Lines off disk, one at a time, `\r\n` and a missing trailing newline both tolerated. */
export async function* readLines(file) {
  const rl = createInterface({ input: createReadStream(file, 'utf8'), crlfDelay: Infinity })
  try {
    for await (const line of rl) yield line
  } finally {
    rl.close()
  }
}

/**
 * Read an interchange file without holding the text in memory.
 *
 * The RECORDS are still collected — merging and validating are whole-collection operations —
 * but a 200 MB export never exists as a single 200 MB string, which is the allocation that
 * actually kills `JSON.parse`-the-whole-file readers.
 *
 * @returns {Promise<{meta:object|null, items:Array, attrs:Array, signals:Array,
 *                    unknown:Array, errors:Array, errorCount:number, lines:number}>}
 */
export async function readBundle(file) {
  await assertReadable(file, 'interchange file')

  const bundle = {
    meta: null, items: [], attrs: [], signals: [], unknown: [],
    errors: [], errorCount: 0, lines: 0,
  }

  let batch = []
  let batchStart = 1

  const flush = () => {
    if (!batch.length) return
    const part = fromJsonl(batch.join('\n'))
    // `fromJsonl` takes the LAST meta line it sees; preserve that across batches by only
    // overwriting when this batch actually carried one.
    if (part.meta) bundle.meta = part.meta
    for (const it of part.items) bundle.items.push(it)
    for (const a of part.attrs) bundle.attrs.push(a)
    for (const s of part.signals) bundle.signals.push(s)
    for (const u of part.unknown) bundle.unknown.push(u)
    for (const e of part.errors) {
      bundle.errorCount += 1
      if (bundle.errors.length < ERROR_SAMPLE_LIMIT) {
        bundle.errors.push({ ...e, line: batchStart + e.line - 1 })
      }
    }
    batch = []
  }

  for await (const line of readLines(file)) {
    if (!batch.length) batchStart = bundle.lines + 1
    bundle.lines += 1
    batch.push(line)
    if (batch.length >= BATCH) flush()
  }
  flush()

  return bundle
}

// ── writing ───────────────────────────────────────────────────────────────────

function writeChunk(stream, chunk) {
  // `write` returning false means the kernel buffer is full. Ignoring it is how an export
  // piped into a slow consumer balloons in RSS until the process dies.
  return stream.write(chunk) ? null : once(stream, 'drain')
}

/**
 * A line sink. `file` null means "the io's stdout".
 * Writing to a file goes through a sibling temp file and an atomic rename (rule 2 above).
 */
export function openSink(file, io) {
  if (!file) {
    const stream = io?.outStream
    return {
      target: '-',
      async write(line) {
        if (stream) {
          const wait = writeChunk(stream, line)
          if (wait) await wait
        } else {
          io.out(line)
        }
      },
      async end() {},
    }
  }

  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.tmp-${process.pid}`)
  const stream = createWriteStream(tmp, 'utf8')
  return {
    target: file,
    async write(line) {
      const wait = writeChunk(stream, line)
      if (wait) await wait
    },
    async end() {
      stream.end()
      await once(stream, 'close')
      try {
        await rename(tmp, file)
      } catch (err) {
        // Windows renames fail with EPERM/EBUSY when a sync client (OneDrive is the local
        // reality here) or a virus scanner holds a transient handle on the destination.
        // Copy-then-unlink is not atomic, but losing the store to a scanner is worse.
        if (err.code !== 'EPERM' && err.code !== 'EBUSY' && err.code !== 'EACCES') throw err
        await copyFile(tmp, file)
        await unlink(tmp).catch(() => {})
      }
    },
  }
}

/**
 * The meta header, produced by core so its shape has exactly one definition.
 *
 * `toJsonl` derives `count` from the array it is handed, and a streaming writer deliberately
 * does not hand it one — so the line is round-tripped through JSON and the count patched in.
 * Re-deriving the whole meta shape here instead would put a second definition of the header
 * in the tree, which is the drift this file's rule 1 exists to prevent.
 */
export function metaLine(meta, count) {
  const header = JSON.parse(toJsonl({ items: [], meta }))
  header.count = Number(count) || 0
  return JSON.stringify(header)
}

/**
 * Stream a bundle out. Records are stringified one at a time rather than via `toJsonl`, whose
 * array-join would materialise the whole export as one string — the thing this file exists to
 * avoid. The meta line still comes from core.
 *
 * @returns {Promise<number>} records written, meta line excluded
 */
export async function writeBundle(sink, { items = [], attrs = [], signals = [], meta = {} } = {}) {
  await sink.write(`${metaLine(meta, items.length)}\n`)
  let n = 0
  for (const item of items) {
    await sink.write(`${JSON.stringify({ type: 'item', ...item })}\n`)
    n += 1
  }
  for (const attr of attrs) {
    await sink.write(`${JSON.stringify({ type: 'attr', ...attr })}\n`)
    n += 1
  }
  for (const signal of signals) {
    await sink.write(`${JSON.stringify({ type: 'signal', ...signal })}\n`)
    n += 1
  }
  return n
}
