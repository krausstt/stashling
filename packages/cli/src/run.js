/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The command router.
 *
 * `run(argv, io)` RETURNS an exit code and never calls `process.exit`. That is what makes the
 * whole CLI testable in-process: a command that exits the process can only be tested by
 * spawning one, and a test suite that spawns a process per assertion stops being run.
 * `bin/stashling.js` is the only file allowed to know about `process`.
 *
 * Every I/O path goes through the injected `io`, for the same reason.
 */

import { parseArgs } from 'node:util'
import { readFileSync } from 'node:fs'
import { UsageError, FailureError, EXIT } from './errors.js'

import parse from './cmd-parse.js'
import importCmd from './cmd-import.js'
import exportCmd from './cmd-export.js'
import verify from './cmd-verify.js'
import fixture from './cmd-fixture.js'
import connectors from './cmd-connectors.js'

export const COMMANDS = [parse, importCmd, exportCmd, verify, fixture, connectors]

const byName = new Map(COMMANDS.map((c) => [c.name, c]))

export function version() {
  try {
    return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
  } catch {
    return '0.0.0'
  }
}

export function defaultIo() {
  return {
    out: (s) => process.stdout.write(s),
    err: (s) => process.stderr.write(s),
    outStream: process.stdout,
    isTTY: Boolean(process.stdout.isTTY),
    env: process.env,
  }
}

const GLOBAL_HELP = () => `stashling ${version()} — keep what you find, like and collect

usage: stashling <command> [options]

commands:
${COMMANDS.map((c) => `  ${c.name.padEnd(11)}${c.summary}`).join('\n')}

  stashling <command> --help   for the options of one command

exit codes:
  0  success
  1  the data lost — validation failed, a golden diff mismatched, a stale generation refused
  2  usage — a bad flag, a missing file, an unknown connector. Nothing was inspected.
`

function commandHelp(cmd) {
  const lines = [`stashling ${cmd.name} — ${cmd.summary}`, '', `usage: ${cmd.usage}`]
  if (cmd.help) lines.push('', cmd.help.trim())
  return `${lines.join('\n')}\n`
}

/**
 * `parseArgs` in strict mode, with its errors translated.
 *
 * Node's message for an unknown option is accurate but tells you nothing about what WAS
 * allowed, and an unknown flag is the single most common way to misuse a CLI — so the
 * command's own usage line is attached to every one.
 */
function parseCommandArgs(cmd, argv) {
  try {
    return parseArgs({
      args: argv,
      options: { help: { type: 'boolean', short: 'h' }, ...cmd.options },
      allowPositionals: true,
      strict: true,
    })
  } catch (err) {
    throw new UsageError(err.message, { hint: `usage: ${cmd.usage}` })
  }
}

async function dispatch(argv, io) {
  const [name, ...rest] = argv

  if (!name || name === 'help' || name === '--help' || name === '-h') {
    // `--help` is a successful request for help, not a usage error. A CLI that exits non-zero
    // on `--help` breaks `set -e` scripts that print their own usage.
    if (!name) {
      io.err(GLOBAL_HELP())
      return EXIT.USAGE
    }
    const target = byName.get(rest[0])
    io.out(target ? commandHelp(target) : GLOBAL_HELP())
    return EXIT.OK
  }

  if (name === '--version' || name === '-v' || name === 'version') {
    io.out(`${version()}\n`)
    return EXIT.OK
  }

  const cmd = byName.get(name)
  if (!cmd) {
    throw new UsageError(`unknown command "${name}"`, {
      hint: `known commands: ${COMMANDS.map((c) => c.name).join(', ')}`,
    })
  }

  const { values, positionals } = parseCommandArgs(cmd, rest)
  if (values.help) {
    io.out(commandHelp(cmd))
    return EXIT.OK
  }

  return cmd.run({ values, positionals, io })
}

/**
 * @param {string[]} argv  argv WITHOUT node and the script path
 * @param {object} [io]
 * @returns {Promise<number>} the exit code
 */
export async function run(argv, io = defaultIo()) {
  try {
    return (await dispatch(argv ?? [], io)) ?? EXIT.OK
  } catch (err) {
    if (err instanceof UsageError) {
      io.err(`stashling: ${err.message}\n`)
      if (err.hint) io.err(`  ${err.hint}\n`)
      return EXIT.USAGE
    }
    if (err instanceof FailureError) {
      io.err(`stashling: ${err.message}\n`)
      if (err.details) io.err(`${err.details}\n`)
      return EXIT.FAILURE
    }
    // An unexpected throw is a defect in this tool, and the stack is the useful part. It is
    // reported as a failure (1) rather than usage (2): the arguments were fine.
    io.err(`stashling: internal error\n${err?.stack ?? err}\n`)
    return EXIT.FAILURE
  }
}
