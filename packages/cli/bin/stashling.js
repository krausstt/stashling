#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The only file in this package allowed to know about `process`.
 *
 * Everything else takes an injected `io` and returns an exit code, which is what lets the whole
 * CLI be tested in-process. See `src/run.js`.
 */

import { run, defaultIo } from '../src/run.js'

// EPIPE is what `stashling export … | head` looks like from in here. It is the pipeline working
// as intended, not an error, and printing a stack trace for it is noise in every shell script
// anyone ever writes around this tool.
process.stdout.on('error', (err) => {
  if (err?.code === 'EPIPE') process.exit(0)
  throw err
})

process.exitCode = await run(process.argv.slice(2), defaultIo())
