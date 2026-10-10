import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { exportDecoyHostRoots } from './lib/decoy-host-roots.mjs'
import { TENON_CLI } from './lib/isolated-tenon.mjs'
import { buildFixture } from './verify-action-selftest.mjs'

// The workflow and the vitest integration test (packages/cli/src/verify-action-selftest.integration.test.ts) cover the fixture's
// contents; this is the isolation: the fixture is built with the real CLI (`init`, `test register`, `test run`), and when the
// tool runs under `tenon test run` the launcher's real runtime roots are in its environment.
test('the fixture builder does not hand the host runtime roots to the CLI it drives', { skip: !existsSync(TENON_CLI) && 'the CLI bundle is not built' }, () => {
  const decoy = exportDecoyHostRoots('tenon-selftest-decoy')
  const out = realpathSync(mkdtempSync(join(tmpdir(), 'tenon-selftest-fixture-')))
  try {
    const built = buildFixture({ cli: TENON_CLI, out })
    assert.equal(built.change, 'demo')
    assert.match(built.head, /^[0-9a-f]{40}$/u)
    assert.deepEqual(decoy.written(), [], 'nothing was written under the roots the host exported')
  } finally {
    decoy.restore()
    rmSync(out, { recursive: true, force: true })
  }
})
