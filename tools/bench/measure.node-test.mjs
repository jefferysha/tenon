import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { readOptions, sample, writeReport } from './measure.mjs'

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
