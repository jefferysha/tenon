import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import type { StepTestIR, TestInputDef, TestOutputDef, TestOutputKind } from '@tenon/kernel'
import { collectTestInputs, collectTestOutputs } from './collect.js'

const roots: string[] = []

async function freshRepo(): Promise<{ repoRoot: string; changeDir: string; runDir: string }> {
  const repoRoot = await mkdtemp(join(tmpdir(), 'tenon-test-collect-'))
  roots.push(repoRoot)
  const changeDir = join(repoRoot, 'openspec', 'changes', 'demo')
  const runDir = join(repoRoot, '.tenon', 'users', 'a-at-x.io', 'local', 'artifacts', 'demo', 'run')
  await mkdir(changeDir, { recursive: true })
  await mkdir(runDir, { recursive: true })
  return { repoRoot, changeDir, runDir }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function test_(
  inputs: readonly TestInputDef[] = [],
  outputs: readonly (TestOutputDef & { kind: TestOutputKind; required: boolean })[] = [],
): StepTestIR {
  return {
    id: 'unit', direction: 'unit', command: 'npm test', cwd: '.', timeout_s: 900, required: true,
    keep_runs: 5, pass: { exit_code: 0, metrics: [] }, inputs, outputs,
  }
}

async function seedLedger(changeDir: string, records: readonly { kind: string; path: string }[]): Promise<void> {
  await writeFile(join(changeDir, '.pipeline-documents.json'), JSON.stringify({
    version: 1,
    contract: 'openspec-v1',
    createdAt: '2026-09-15T10:00:00Z',
    records: records.map((record) => ({
      ...record, sha256: 'a'.repeat(64), producer: 'openspec-propose',
      recordedAt: '2026-09-15T10:00:00Z', reads: [],
    })),
  }))
}

describe('collectTestInputs', () => {
  test('文档输入按台账逐条记录当前摘要；没有记录即 present false', async () => {
    const { repoRoot, changeDir } = await freshRepo()
    const path = 'openspec/changes/demo/specs/capability/spec.md'
    await mkdir(join(repoRoot, path, '..'), { recursive: true })
    await writeFile(join(repoRoot, path), '# delta\n')
    await seedLedger(changeDir, [{ kind: 'delta-spec', path }])
    const [present] = await collectTestInputs(repoRoot, changeDir, test_([{ kind: 'document', ref: 'delta-spec' }]), join(repoRoot, 'key'))
    expect(present).toMatchObject({ kind: 'document', ref: 'delta-spec', present: true })
    if (present?.kind !== 'document') throw new Error('expected a document input')
    expect(present.entries[0]?.path).toBe(path)
    expect(present.entries[0]?.digest).toMatch(/^sha256:[a-f0-9]{64}$/u)

    const [absent] = await collectTestInputs(repoRoot, changeDir, test_([{ kind: 'document', ref: 'plan' }]), join(repoRoot, 'key'))
    expect(absent).toEqual({ kind: 'document', ref: 'plan', present: false, entries: [] })
  })

  test('目录输入的清单摘要稳定且与内容绑定；缺失与符号链接都 present false', async () => {
    const { repoRoot, changeDir } = await freshRepo()
    await mkdir(join(repoRoot, 'fixtures', 'nested'), { recursive: true })
    await writeFile(join(repoRoot, 'fixtures', 'a.json'), '{"a":1}')
    await writeFile(join(repoRoot, 'fixtures', 'nested', 'b.json'), '{"b":2}')
    const key = join(repoRoot, '.tenon', 'users', 'a-at-x.io', 'local', 'env.key')
    const collect = async (path: string) =>
      (await collectTestInputs(repoRoot, changeDir, test_([{ kind: 'file', path }]), key))[0]

    const first = await collect('fixtures')
    const second = await collect('fixtures')
    expect(first).toEqual(second)
    expect(first).toMatchObject({ present: true, files: 2 })
    await writeFile(join(repoRoot, 'fixtures', 'a.json'), '{"a":2}')
    expect(await collect('fixtures')).not.toEqual(first)

    expect(await collect('missing')).toMatchObject({ present: false, digest: null })
    await symlink(join(repoRoot, 'fixtures'), join(repoRoot, 'link'))
    expect(await collect('link')).toMatchObject({ present: false })
  })

  test('环境变量只落 HMAC 摘要：同值稳定、异值不同，密钥 0600 落在本机目录', async () => {
    const { repoRoot, changeDir } = await freshRepo()
    const key = join(repoRoot, '.tenon', 'users', 'a-at-x.io', 'local', 'env.key')
    const collect = async () =>
      (await collectTestInputs(repoRoot, changeDir, test_([{ kind: 'env', name: 'TENON_COLLECT_PROBE' }]), key))[0]

    process.env.TENON_COLLECT_PROBE = 'one'
    const first = await collect()
    expect(first).toMatchObject({ kind: 'env', name: 'TENON_COLLECT_PROBE', present: true })
    expect(await collect()).toEqual(first)
    process.env.TENON_COLLECT_PROBE = 'two'
    expect(await collect()).not.toEqual(first)
    delete process.env.TENON_COLLECT_PROBE
    expect(await collect()).toMatchObject({ present: false, digest: null })
  })

  test('服务输入原样登记，不做探测', async () => {
    const { repoRoot, changeDir } = await freshRepo()
    const inputs: readonly TestInputDef[] = [
      { kind: 'service', name: 'database' },
      { kind: 'service', name: 'redis', url: 'redis://localhost:6379' },
    ]
    expect(await collectTestInputs(repoRoot, changeDir, test_(inputs), join(repoRoot, 'key'))).toEqual(inputs)
  })
})

describe('collectTestOutputs', () => {
  test('文件输出登记摘要并复制进产物目录', async () => {
    const { repoRoot, runDir } = await freshRepo()
    await mkdir(join(repoRoot, 'test-results'), { recursive: true })
    await writeFile(join(repoRoot, 'test-results', 'junit.xml'), '<testsuite/>')
    const [record] = await collectTestOutputs(
      repoRoot,
      test_([], [{ path: 'test-results/junit.xml', kind: 'report', required: true }]),
      runDir,
    )
    expect(record).toMatchObject({ present: true, files: 1, artifact: 'outputs/test-results/junit.xml' })
    expect(record?.digest).toMatch(/^sha256:[a-f0-9]{64}$/u)
  })

  test('目录输出登记清单摘要并整棵复制', async () => {
    const { repoRoot, runDir } = await freshRepo()
    await mkdir(join(repoRoot, 'playwright-report', 'data'), { recursive: true })
    await writeFile(join(repoRoot, 'playwright-report', 'index.html'), '<html></html>')
    await writeFile(join(repoRoot, 'playwright-report', 'data', 'trace.zip'), 'zip')
    const [record] = await collectTestOutputs(
      repoRoot,
      test_([], [{ path: 'playwright-report', kind: 'report', required: false }]),
      runDir,
    )
    expect(record).toMatchObject({ present: true, files: 2, artifact: 'outputs/playwright-report' })
  })

  test('缺失与符号链接输出判为不存在（必需时由调用方记 output-missing）', async () => {
    const { repoRoot, runDir } = await freshRepo()
    await mkdir(join(repoRoot, 'outside'), { recursive: true })
    await writeFile(join(repoRoot, 'outside', 'real.xml'), '<x/>')
    await mkdir(join(repoRoot, 'test-results'), { recursive: true })
    await symlink(join(repoRoot, 'outside', 'real.xml'), join(repoRoot, 'test-results', 'link.xml'))
    const records = await collectTestOutputs(
      repoRoot,
      test_([], [
        { path: 'test-results/missing.xml', kind: 'report', required: true },
        { path: 'test-results/link.xml', kind: 'report', required: true },
      ]),
      runDir,
    )
    expect(records.map((record) => record.present)).toEqual([false, false])
    expect(records.map((record) => record.artifact)).toEqual([null, null])
  })
})
