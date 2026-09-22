import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { evaluateSpecMigrationEvidence } from './spec-migration-evidence.js'

function digest(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex')
}

describe('主规格迁移机器证据', () => {
  let root: string
  const change = 'docs-change'
  let changeDir: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'pipeline-migration-evidence-'))
    changeDir = join(root, 'openspec', 'changes', change)
    await mkdir(join(changeDir, 'migration'), { recursive: true })
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('没有 migration receipt、也没登记过 delta spec：这份 change 不产出规格增量，判为不需要', async () => {
    await expect(evaluateSpecMigrationEvidence(root, changeDir, change)).resolves.toEqual({
      kind: 'not-required',
    })
  })

  /**
   * 历史迁移回执之外，guard 还必须回答这份 change 自己的规格应用。真机三条 track 全部走到完结，
   * 主规格目录空空如也，靠的就是一份 `--dry-run` 写下的 result=pass 回执。
   */
  describe('这份 change 自己的 delta spec 应用', () => {
    const capability = 'demo-two'
    const deltaPath = `openspec/changes/${change}/specs/${capability}/spec.md`
    const mainPath = `openspec/specs/${capability}/spec.md`
    const deltaBody = '## ADDED Requirements\n'
    const mainBody = '# demo-two\n'

    async function seedDelta(): Promise<void> {
      await mkdir(join(changeDir, 'specs', capability), { recursive: true })
      await writeFile(join(root, deltaPath), deltaBody)
      await writeFile(join(changeDir, '.pipeline-documents.json'), `${JSON.stringify({
        version: 1,
        contract: 'openspec-v1',
        createdAt: '2026-09-22T00:00:00Z',
        records: [{
          kind: 'delta-spec',
          path: deltaPath,
          sha256: digest(deltaBody),
          producer: 'openspec-propose',
          recordedAt: '2026-09-22T00:00:00Z',
          reads: [],
        }],
      }, null, 2)}\n`)
    }

    async function seedReceipt(mode: string): Promise<void> {
      await writeFile(join(changeDir, '.pipeline-spec-apply.json'), `${JSON.stringify({
        schema: 'tenon-spec-apply-v1',
        change,
        mode,
        result: 'pass',
        deltas: [{ path: deltaPath, sha256: digest(deltaBody) }],
        targets: [{
          path: mainPath, before_sha256: null, after_sha256: digest(mainBody), change: 'created',
        }],
      }, null, 2)}\n`)
    }

    it('只彩排过（mode=dry-run）：拒绝，理由点名彩排', async () => {
      await seedDelta()
      await seedReceipt('dry-run')
      await expect(evaluateSpecMigrationEvidence(root, changeDir, change)).resolves.toEqual({
        kind: 'invalid',
        reason: 'spec-apply-rehearsal-only',
      })
    })

    it('登记了 delta spec 却没跑过 spec apply：拒绝', async () => {
      await seedDelta()
      await expect(evaluateSpecMigrationEvidence(root, changeDir, change)).resolves.toEqual({
        kind: 'invalid',
        reason: 'spec-apply-receipt-missing',
      })
    })

    it('真跑过且主规格在盘上：通过', async () => {
      await seedDelta()
      await seedReceipt('apply')
      await mkdir(join(root, 'openspec', 'specs', capability), { recursive: true })
      await writeFile(join(root, mainPath), mainBody)
      await expect(evaluateSpecMigrationEvidence(root, changeDir, change)).resolves.toEqual({
        kind: 'applied',
      })
    })
  })

  it('receipt、result、delta 和当前主规格全部身份/摘要绑定时通过', async () => {
    const capability = 'docs-experience'
    const main = 'expected main\n'
    const delta = 'delta\n'
    const mainPath = `openspec/specs/${capability}/spec.md`
    const deltaPath = `openspec/changes/${change}/specs/${capability}/spec.md`
    await mkdir(join(root, 'openspec', 'specs', capability), { recursive: true })
    await mkdir(join(changeDir, 'specs', capability), { recursive: true })
    await writeFile(join(root, mainPath), main)
    await writeFile(join(root, deltaPath), delta)
    const receipt = `${JSON.stringify({
      schemaVersion: 1,
      kind: 'historical-spec-application-migration',
      change,
      capability,
      mainSpecPath: mainPath,
      deltaSpecPath: deltaPath,
      expectedAfterDigest: digest(main),
      deltaDigest: digest(delta),
    }, null, 2)}\n`
    await writeFile(join(changeDir, 'migration', 'spec-application.json'), receipt)
    await writeFile(join(changeDir, 'migration', 'spec-application-result.json'), `${JSON.stringify({
      schemaVersion: 1,
      kind: 'spec-migration-application',
      change,
      capability,
      receiptDigest: digest(receipt),
      effect: 'changed',
      targetPath: mainPath,
      expectedAfterDigest: digest(main),
      afterDigest: digest(main),
    }, null, 2)}\n`)

    await expect(evaluateSpecMigrationEvidence(root, changeDir, change)).resolves.toEqual({
      kind: 'applied',
    })
  })

  it('result 未绑定当前 receipt 时失败关闭', async () => {
    const capability = 'docs-experience'
    const mainPath = `openspec/specs/${capability}/spec.md`
    const deltaPath = `openspec/changes/${change}/specs/${capability}/spec.md`
    await mkdir(join(root, 'openspec', 'specs', capability), { recursive: true })
    await mkdir(join(changeDir, 'specs', capability), { recursive: true })
    await writeFile(join(root, mainPath), 'main\n')
    await writeFile(join(root, deltaPath), 'delta\n')
    await writeFile(join(changeDir, 'migration', 'spec-application.json'), `${JSON.stringify({
      schemaVersion: 1,
      kind: 'historical-spec-application-migration',
      change,
      capability,
      mainSpecPath: mainPath,
      deltaSpecPath: deltaPath,
      expectedAfterDigest: digest('main\n'),
      deltaDigest: digest('delta\n'),
    })}\n`)
    await writeFile(join(changeDir, 'migration', 'spec-application-result.json'), `${JSON.stringify({
      schemaVersion: 1,
      kind: 'spec-migration-application',
      change,
      capability,
      receiptDigest: 'forged',
      effect: 'no-op',
      targetPath: mainPath,
      expectedAfterDigest: digest('main\n'),
      afterDigest: digest('main\n'),
    })}\n`)

    await expect(evaluateSpecMigrationEvidence(root, changeDir, change)).resolves.toEqual({
      kind: 'invalid',
      reason: 'application-result-mismatch',
    })
  })
})
