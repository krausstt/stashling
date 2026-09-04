/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Two error classes, because this CLI has exactly two kinds of bad news and a script needs to
 * tell them apart from the exit code alone:
 *
 *   2  UsageError    you asked for something impossible — bad flag, missing file, no such
 *                    connector. Nothing was inspected, so nothing is known about your data.
 *   1  FailureError  the data lost. Validation failed, a golden diff mismatched, a stale
 *                    generation was refused. The tool worked; the answer is "no".
 *
 * Conflating the two is why `if ! stashling fixture …; then` is unsafe in every CLI that
 * returns 1 for both: a typo in a flag then reads as a regression in the parser.
 */

export class UsageError extends Error {
  constructor(message, { hint } = {}) {
    super(message)
    this.name = 'UsageError'
    this.exitCode = 2
    this.hint = hint ?? null
  }
}

export class FailureError extends Error {
  constructor(message, { details } = {}) {
    super(message)
    this.name = 'FailureError'
    this.exitCode = 1
    this.details = details ?? null
  }
}

export const EXIT = Object.freeze({ OK: 0, FAILURE: 1, USAGE: 2 })
