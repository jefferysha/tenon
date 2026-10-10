import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { FIXTURE_ENTRIES, parseAcceptanceArgs } from './source-install-acceptance.mjs'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

test('parseAcceptanceArgs defaults to every host and validates --host', () => {
  assert.deepEqual(parseAcceptanceArgs([]), { hosts: ['claude', 'codex'], explicitHost: false, evidence: undefined })
  assert.deepEqual(parseAcceptanceArgs(['--host', 'codex', '--evidence', 'out.json']),
    { hosts: ['codex'], explicitHost: true, evidence: 'out.json' })
  assert.throws(() => parseAcceptanceArgs(['--host', 'cursor']), /unknown --host/u)
})

test('every fixture entry exists in this checkout, so the copy cannot silently drop one', () => {
  for (const entry of FIXTURE_ENTRIES) assert.ok(existsSync(join(repoRoot, entry)), `${entry} is missing from the checkout`)
})

test('the fixture carries the four source-repository criteria', () => {
  assert.ok(FIXTURE_ENTRIES.includes('package.json'))
  assert.ok(FIXTURE_ENTRIES.includes('.claude-plugin/marketplace.json'))
  assert.ok(FIXTURE_ENTRIES.includes('skills'))
  assert.ok(FIXTURE_ENTRIES.includes('runtime/tenon-bootstrap.mjs'))
  assert.ok(existsSync(join(repoRoot, 'skills', 'sources.yaml')))
})

test('package.json wires test:source-install to this script and its unit test', () => {
  const scripts = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')).scripts
  assert.match(scripts['test:source-install'], /source-install-acceptance\.node-test\.mjs/u)
  assert.match(scripts['test:source-install'], /source-install-acceptance\.mjs/u)
})
