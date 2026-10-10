/**
 * Test support for tools/*.node-test.mjs: pretend the machine's stable launcher exported its runtime roots, the way it does
 * for everything run under `tenon test run` (packages/cli/src/runtime/launchers.ts). The roots point at empty temporary
 * directories, so a child process that inherits them and touches Tenon state leaves files there, and the test can assert it
 * did not (`written()` stays empty) without going anywhere near the developer's real state.
 */
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { INHERITED_RUNTIME_ROOT_VARS } from './runtime-roots.mjs'

function entriesUnder(directory, base) {
  const found = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    found.push(relative(base, path))
    if (entry.isDirectory()) found.push(...entriesUnder(path, base))
  }
  return found
}

/**
 * Sets `TENON_RUNTIME_ROOTS` and the three per-root variables in this process to a decoy contract and returns
 * `{ roots, written, restore }`: `written()` lists every file or directory created under the decoy roots since this call,
 * `restore()` puts the previous values back and deletes the decoy (call it in `finally`).
 */
export function exportDecoyHostRoots(prefix = 'tenon-decoy-host-roots') {
  const base = realpathSync(mkdtempSync(join(tmpdir(), `${prefix}-`)))
  const roots = { dataRoot: join(base, 'data'), stateRoot: join(base, 'state'), configRoot: join(base, 'config') }
  for (const directory of Object.values(roots)) mkdirSync(directory)
  const previous = new Map(INHERITED_RUNTIME_ROOT_VARS.map((name) => [name, process.env[name]]))
  process.env.TENON_RUNTIME_ROOTS = JSON.stringify({ version: 1, ...roots })
  process.env.TENON_RUNTIME_DATA_ROOT = roots.dataRoot
  process.env.TENON_RUNTIME_STATE_ROOT = roots.stateRoot
  process.env.TENON_RUNTIME_CONFIG_ROOT = roots.configRoot
  return {
    roots,
    written: () => entriesUnder(base, base).filter((path) => !['data', 'state', 'config'].includes(path)).sort(),
    restore: () => {
      for (const [name, value] of previous) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
      rmSync(base, { recursive: true, force: true })
    },
  }
}
