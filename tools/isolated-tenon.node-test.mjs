import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { createScratch, freePort, isolatedEnv, removeScratch } from './lib/isolated-tenon.mjs'

test('isolatedEnv points HOME and the runtime home at the scratch root and drops host plugin variables', () => {
  const previous = { plugin: process.env.CLAUDE_PLUGIN_ROOT, port: process.env.TENON_DASHBOARD_PORT }
  process.env.CLAUDE_PLUGIN_ROOT = '/somewhere/else'
  process.env.TENON_DASHBOARD_PORT = '1234'
  const scratch = createScratch('tenon-isolated-test')
  try {
    const env = isolatedEnv(scratch)
    assert.equal(env.HOME, join(scratch.scratch, 'home'))
    assert.equal(env.TENON_RUNTIME_HOME, join(scratch.scratch, 'runtime'))
    assert.equal(env.TENON_USER, 'e2e@tenon.test')
    assert.equal(env.CLAUDE_PLUGIN_ROOT, undefined)
    assert.equal(env.TENON_DASHBOARD_PORT, undefined)
    assert.ok(existsSync(env.HOME) && existsSync(env.TENON_RUNTIME_HOME))
  } finally {
    removeScratch(scratch.scratch)
    if (previous.plugin === undefined) delete process.env.CLAUDE_PLUGIN_ROOT
    else process.env.CLAUDE_PLUGIN_ROOT = previous.plugin
    if (previous.port === undefined) delete process.env.TENON_DASHBOARD_PORT
    else process.env.TENON_DASHBOARD_PORT = previous.port
  }
  assert.equal(existsSync(scratch.scratch), false)
})

test('freePort returns a usable loopback port', async () => {
  const port = await freePort()
  assert.ok(Number.isInteger(port) && port > 0 && port < 65536)
})
