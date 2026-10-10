import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { exportDecoyHostRoots } from './lib/decoy-host-roots.mjs'
import { INHERITED_RUNTIME_ROOT_VARS, REPO_ROOT } from './lib/isolated-tenon.mjs'

// The shell suites below run under `tenon test run` too (catalog suites hooks, bundle and oracle), so they start with the launcher's
// real runtime roots in their environment. Every TENON_RUNTIME_HOME they set for a fixture loses to those roots, so each script
// drops them before it starts anything. Running the suites themselves takes minutes; this checks the line that does it: it is the
// first statement after the `set` options, and running it in a shell that has the roots removes all of them.
const SUITES = ['tools/test-hooks.sh', 'tools/test-bundle.sh', 'tools/oracle/run.sh', 'tools/test-adapters.sh']

// The hook suites (hooks, adapters) also start with the launcher's PLUGIN_ROOT, which points at the installed release.  Hooks
// prefer it over the CLAUDE_PLUGIN_ROOT each case sets, so a case that points CLAUDE_PLUGIN_ROOT at a broken plugin silently
// runs the installed one instead (2026-10-08: two hook cases passed under `npm run test:hooks` and failed under `tenon test run`).
// The Codex installer likewise takes TENON_CODEX_PLUGIN_ROOT / TENON_HOST_PLUGIN_ROOT as a selected native root and then skips
// the static skill delivery the adapters suite asserts (ten adapter cases failed the same way).
const PLUGIN_ROOT_VARS = ['PLUGIN_ROOT', 'CLAUDE_PLUGIN_ROOT', 'TENON_HOST_PLUGIN_ROOT', 'TENON_CODEX_PLUGIN_ROOT']
const HOOK_SUITES = ['tools/test-hooks.sh', 'tools/test-adapters.sh']

function firstStatementAfterOptions(text) {
  const statements = text.split('\n').map((line) => line.trim()).filter((line) => line !== '' && !line.startsWith('#'))
  assert.match(statements[0], /^set -/u, 'the script starts with its shell options')
  return statements[1]
}

for (const suite of SUITES) {
  test(`${suite} drops the host runtime roots before it starts anything`, () => {
    const first = firstStatementAfterOptions(readFileSync(join(REPO_ROOT, suite), 'utf8'))
    assert.match(first, /^unset( TENON_RUNTIME_\w+)+$/u, 'the first statement after the options is the unset')
    for (const name of INHERITED_RUNTIME_ROOT_VARS) assert.ok(first.split(' ').includes(name), `${name} is unset`)

    const decoy = exportDecoyHostRoots('tenon-shell-suite-decoy')
    try {
      const printed = (script) => spawnSync('bash', ['-c', script], { env: process.env, encoding: 'utf8' }).stdout
      const control = printed('env')
      for (const name of INHERITED_RUNTIME_ROOT_VARS) assert.match(control, new RegExp(`^${name}=`, 'mu'), `the control: ${name} is inherited`)
      const after = printed(`${first}\nenv`)
      for (const name of INHERITED_RUNTIME_ROOT_VARS) assert.doesNotMatch(after, new RegExp(`^${name}=`, 'mu'), `${name} survived the unset`)
    } finally {
      decoy.restore()
    }
  })
}

for (const suite of HOOK_SUITES) {
  test(`${suite} drops the launcher's plugin root before it starts anything`, () => {
    const text = readFileSync(join(REPO_ROOT, suite), 'utf8')
    const statements = text.split('\n').map((line) => line.trim()).filter((line) => line !== '' && !line.startsWith('#'))
    const line = statements[2]
    assert.equal(line, `unset ${PLUGIN_ROOT_VARS.join(' ')}`, 'the plugin roots are unset right after the runtime roots')
    const env = { ...process.env, ...Object.fromEntries(PLUGIN_ROOT_VARS.map((name) => [name, '/installed/release/payload'])) }
    const after = spawnSync('bash', ['-c', `${line}\nenv`], { env, encoding: 'utf8' }).stdout
    for (const name of PLUGIN_ROOT_VARS) assert.doesNotMatch(after, new RegExp(`^${name}=`, 'mu'), `${name} survived the unset`)
  })
}
