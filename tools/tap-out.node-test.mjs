import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const helper = fileURLToPath(new URL('./tap-out.sh', import.meta.url))

function run(env, directory) {
  const script = `source '${helper}'; tap_init tools/demo.sh; tap_result ok 'first case'; tap_result 'not ok' $'second\\ncase'`
  return spawnSync('bash', ['-c', script], { cwd: directory, env: { ...process.env, ...env }, encoding: 'utf8' })
}

test('tap_result writes TAP with a location per case when TENON_TAP_OUT is set', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tenon-tap-test-'))
  try {
    const out = join(directory, 'nested', 'run.tap')
    const result = run({ TENON_TAP_OUT: out }, directory)
    assert.equal(result.status, 0, result.stderr)
    const tap = await readFile(out, 'utf8')
    assert.match(tap, /^TAP version 13\n/)
    assert.match(tap, /ok - first case\n {2}---\n {2}location: 'tools\/demo\.sh:1:1'\n {2}\.\.\.\n/)
    assert.match(tap, /not ok - second case\n/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('without TENON_TAP_OUT the helper writes nothing and does not fail', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tenon-tap-test-'))
  try {
    const result = run({ TENON_TAP_OUT: '' }, directory)
    assert.equal(result.status, 0, result.stderr)
    assert.equal(existsSync(join(directory, 'nested')), false)
    assert.equal(result.stdout, '')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
