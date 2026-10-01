import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { existsSync, readFileSync } from 'node:fs'
import { createBenchFixture } from './fixture.mjs'
import { percentile, readOptions, sample, writeReport } from './measure.mjs'
import { TENON_CLI } from '../lib/isolated-tenon.mjs'

test('readOptions requires --json and validates the counts', () => {
  assert.throws(() => readOptions([]), /--json/)
  assert.throws(() => readOptions(['--json', 'x.json', '--runs', '0']), /--runs/)
  assert.throws(() => readOptions(['--json', 'x.json', '--warmup', '-1']), /--warmup/)
  const options = readOptions(['--json', 'x.json', '--runs', '3'])
  assert.equal(options.runs, 3)
  assert.equal(options.warmup, 2)
  assert.ok(options.json.endsWith('x.json'))
})

test('sample discards the warmup runs and keeps the measured ones in order', async () => {
  let calls = 0
  const samples = await sample({ runs: 4, warmup: 2 }, async () => { calls++ })
  assert.equal(calls, 6)
  assert.equal(samples.length, 4)
  assert.ok(samples.every((value) => Number.isFinite(value) && value >= 0))
})

test('writeReport emits the benchmark-json shape the runner parses', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tenon-bench-test-'))
  try {
    const path = join(directory, 'nested', 'report.json')
    writeReport(path, { status_ms: [1.5, 2.5] }, { runs: 2 })
    const report = JSON.parse(await readFile(path, 'utf8'))
    assert.deepEqual(report.metrics, { status_ms: [1.5, 2.5] })
    assert.equal(report.meta.runs, 2)
    assert.equal(report.meta.node, process.version)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('readOptions reads the scenario list, the p95 ceiling and the kept-fixture directory', () => {
  const options = readOptions(['--json', 'x.json', '--scenarios', 'cold, write', '--max-p95-ms', '1500', '--fixture-dir', 'kept'])
  assert.deepEqual(options.scenarios, ['cold', 'write'])
  assert.equal(options.maxP95Ms, 1500)
  assert.ok(options.fixtureDir.endsWith('kept'))
  const defaults = readOptions(['--json', 'x.json'])
  assert.deepEqual(defaults.scenarios, ['cold'])
  assert.equal(defaults.maxP95Ms, undefined)
  assert.equal(defaults.fixtureDir, undefined)
  assert.throws(() => readOptions(['--json', 'x.json', '--max-p95-ms', '0']), /--max-p95-ms/)
})

test('percentile interpolates the same way the test system judges a benchmark', () => {
  assert.equal(percentile([], 95), Number.NaN)
  assert.equal(percentile([7], 95), 7)
  assert.equal(percentile([1, 2, 3, 4], 50), 2.5)
  assert.equal(percentile([10, 20, 30, 40, 50], 95), 48)
  assert.equal(percentile([50, 10, 40, 20, 30], 0), 10)
})

test('createBenchFixture builds projects in parallel and a kept fixture is reused, not rebuilt', { skip: !existsSync(TENON_CLI) && 'the CLI bundle is not built' }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tenon-bench-fixture-test-'))
  try {
    const kept = join(directory, 'kept')
    const first = await createBenchFixture({ projects: 2, changes: 2, fixtureDir: kept })
    assert.equal(first.roots.length, 2)
    for (const root of first.roots) assert.ok(existsSync(join(root, 'openspec', 'changes', 'change-2', '.pipeline.yaml')), root)
    const registry = JSON.parse(readFileSync(join(kept, 'runtime', 'config', 'projects.json'), 'utf8'))
    assert.equal(registry.length, 2)
    first.cleanup()
    assert.ok(existsSync(first.roots[0]), 'a kept fixture survives cleanup')
    const again = await createBenchFixture({ projects: 2, changes: 2, fixtureDir: kept })
    assert.deepEqual(again.roots, first.roots)
    await assert.rejects(createBenchFixture({ projects: 3, changes: 2, fixtureDir: kept }), /2 × 2/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
