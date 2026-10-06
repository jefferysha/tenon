/**
 * 目录与环境里 v0.3 才有的三个选项在 CI 里的表现（v0.3.0 真机验收「未覆盖」里的最后一项）：
 *   · `TENON_RECORD_RETENTION=<n>`：清理后的记录链（只剩最新 n 条 + `chain-base` 标记）经提交进 CI，照常校验；
 *     标记被改或被删、链上的记录被删都让 CI 失败，不是因为「清理过」就放行；
 *   · 目录顶层 `profile: coarse`：用粗口径画像写下的记录在 CI 里照常校验；目录之后改回（受保护文件）要批准；
 *   · 目录里的 `not_applicable:`：批准过的声明让没有套件的种类不再被要求，CI 通过；还没批准、或手写 approved_by 都不行。
 * 本地一侧（清理张数、画像口径、声明的批准）各有自己的集成测试：test-records-retention / test-system-bench / test-flow；
 * 这里补的是它们提交之后、在没有本机封存的 CI 检出里的结论。
 */
import { readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { CiVerifyReport } from '@tenon/kernel'
import { afterEach, describe, expect, test } from 'vitest'
import { CATALOG_PATH, SLUG, USER, ciCheckout, devProject, type CiCheckout, type Dev, type DevProjectOptions } from './verify-ci-fixture.js'

interface Result {
  code: number
  report: CiVerifyReport
  out: string
  err: string
}

const errors = (result: Result): string[] => result.report.changes.flatMap((change) => change.findings).filter((item) => item.severity === 'error').map((item) => item.code)

describe('tenon verify --ci 与目录 / 环境选项', () => {
  const cleanups: Array<() => Promise<void>> = []
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup()
  })

  async function dev(options: DevProjectOptions = {}): Promise<Dev> {
    const project = await devProject(options)
    cleanups.push(project.cleanup)
    return project
  }

  async function checkout(project: Dev): Promise<CiCheckout> {
    const ci = await ciCheckout(project)
    cleanups.push(ci.cleanup)
    return ci
  }

  async function verify(ci: CiCheckout): Promise<Result> {
    const run = await ci.verify(['--change', 'demo', '--format', 'json'])
    return { ...run, report: JSON.parse(run.out) as CiVerifyReport }
  }

  describe('TENON_RECORD_RETENTION', () => {
    async function pruned(): Promise<Dev> {
      const project = await dev()
      // devProject 已经跑了一次；再跑三次，上限 2：只留最新两条，最老的两条被清掉。
      for (let run = 0; run < 3; run += 1) {
        expect(await project.tenon(['test', 'run', 'demo', '--stage'], { ...USER, TENON_RECORD_RETENTION: '2' }), `${project.out()}\n${project.err()}`).toBe(0)
      }
      project.commit('prune the record chain')
      const names = await readdir(project.recordsDir())
      expect(names.filter((name) => name.endsWith('.json'))).toHaveLength(2)
      expect(names).toContain('chain-base')
      return project
    }

    const markerOf = (ci: CiCheckout): string => join(ci.dir, '.tenon', 'users', SLUG, 'tests', 'demo', 'chain-base')

    test('清理过的链：CI 里照常通过，报告里是完好的链、只有保留下来的 2 条', async () => {
      const ci = await checkout(await pruned())
      const result = await verify(ci)
      expect(result.code, `${result.out}\n${result.err}`).toBe(0)
      expect(errors(result)).toEqual([])
      expect(result.report.changes[0]?.chains).toEqual([expect.objectContaining({ user: SLUG, state: 'intact', records: 2 })])
      // 标记随提交进了 CI 检出（CI 没有本机封存，只靠它和链上的摘要接上被清掉的前缀）。
      expect(JSON.parse(await readFile(markerOf(ci), 'utf8'))).toMatchObject({ schema: 'tenon-record-chain-base/v1' })
    }, 240_000)

    test('清理不是后门：改掉链基点标记里的 base、删掉标记、删掉保留下来的最老一条，CI 都失败', async () => {
      const project = await pruned()

      const forgedBase = await checkout(project)
      const marker = JSON.parse(await readFile(markerOf(forgedBase), 'utf8')) as { base: string }
      await writeFile(markerOf(forgedBase), `${JSON.stringify({ ...marker, base: `sha256:${'0'.repeat(64)}` }, null, 2)}\n`, 'utf8')
      forgedBase.commit('forge the chain base')
      const forged = await verify(forgedBase)
      expect(forged.code, `${forged.out}\n${forged.err}`).toBe(2)
      expect(errors(forged)).toContain('record-chain-broken')

      const noMarker = await checkout(project)
      await rm(markerOf(noMarker))
      noMarker.commit('drop the chain base marker')
      const dropped = await verify(noMarker)
      expect(dropped.code, `${dropped.out}\n${dropped.err}`).toBe(2)
      expect(errors(dropped)).toContain('record-chain-broken')

      // 删掉保留下来的两条里较老的一条：留下的那条的 prev_digest 指向一个不在链上、也不是链基点的摘要。
      const oldestGone = await checkout(project)
      const records = (await readdir(join(oldestGone.dir, '.tenon', 'users', SLUG, 'tests', 'demo'))).filter((name) => name.endsWith('.json')).sort()
      await rm(join(oldestGone.dir, '.tenon', 'users', SLUG, 'tests', 'demo', records[0] ?? ''))
      oldestGone.commit('delete the oldest retained record')
      const gap = await verify(oldestGone)
      expect(gap.code, `${gap.out}\n${gap.err}`).toBe(2)
      expect(errors(gap)).toContain('record-chain-broken')
    }, 300_000)
  })

  describe('profile: coarse', () => {
    test('粗口径画像写下的记录在 CI 里照常通过；画像标签是 OS-架构-核数-Node 主版本，不含 CPU 型号', async () => {
      const project = await dev({ catalog: { profile: 'coarse' } })
      const [record] = await project.records()
      expect(record?.machine_label, '粗口径的标签不带 CPU 型号').toMatch(/^[a-z0-9]+-[a-z0-9]+-\d+c-node\d+$/u)
      const result = await verify(await checkout(project))
      expect(result.code, `${result.out}\n${result.err}`).toBe(0)
      expect(errors(result)).toEqual([])
    }, 240_000)

    test('目录里的 profile 之后被改回缺省：记录绑定的目录摘要对不上，CI 以 test-stale 失败，受保护文件的改动也要批准', async () => {
      const project = await dev({ catalog: { profile: 'coarse' } })
      const ci = await checkout(project)
      const path = join(ci.dir, CATALOG_PATH)
      await writeFile(path, (await readFile(path, 'utf8')).replace('profile: coarse\n', ''), 'utf8')
      ci.commit('drop profile: coarse')
      const result = await verify(ci)
      expect(result.code, `${result.out}\n${result.err}`).toBe(2)
      expect(errors(result)).toEqual(expect.arrayContaining(['test-stale', 'protected-unapproved']))
    }, 240_000)
  })

  describe('not_applicable', () => {
    // 文档里的流程：任务里把声明写进目录（受保护文件），评审确认一次批准它，批准人写回目录。
    // build 步骤的策略要求 typecheck，但项目里没有任何 typecheck 套件，所以没有声明（或声明没批准）就过不了。
    const declaredInTask: DevProjectOptions = {
      catalogInTask: { notApplicable: [{ kind: 'typecheck', reason: '纯 JavaScript 项目，没有类型检查' }] },
      policyRun: ['unit', 'typecheck'],
    }

    test('任务里声明并经评审批准：没有套件的种类不再被要求，CI 通过；批准人写回了目录，批准行绑的是写回之后的内容', async () => {
      const project = await dev({ ...declaredInTask, catalogEdit: 'approved' })
      const ci = await checkout(project)
      const result = await verify(ci)
      expect(result.code, `${result.out}\n${result.err}`).toBe(0)
      expect(errors(result)).toEqual([])
      expect(await readFile(join(ci.dir, CATALOG_PATH), 'utf8')).toMatch(/approved_by: a@x\.io/u)
    }, 240_000)

    test('声明了但没批准：策略仍要求这个种类（waiver-unapproved），目录的改动也没有批准行，CI 失败', async () => {
      const project = await dev({ ...declaredInTask, catalogEdit: 'unapproved' })
      const result = await verify(await checkout(project))
      expect(result.code, `${result.out}\n${result.err}`).toBe(2)
      expect(errors(result)).toEqual(expect.arrayContaining(['waiver-unapproved', 'protected-unapproved']))
    }, 240_000)

    test('在 PR 里手写 approved_by 不能绕过评审：声明不再算「待批准」，但目录是受保护文件，没有批准行照样失败', async () => {
      const project = await dev({ ...declaredInTask, catalogEdit: 'unapproved' })
      const ci = await checkout(project)
      const path = join(ci.dir, CATALOG_PATH)
      await writeFile(path, (await readFile(path, 'utf8')).replace('approved_by: null', 'approved_by: someone@x.io'), 'utf8')
      ci.commit('approve the declaration by hand')
      const result = await verify(ci)
      expect(result.code, `${result.out}\n${result.err}`).toBe(2)
      expect(errors(result)).toContain('protected-unapproved')
      expect(errors(result)).not.toContain('waiver-unapproved')
    }, 240_000)
  })
})
