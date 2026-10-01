/**
 * `tenon verify --ci` 的端到端场景：开发者仓库里走真实流程产出记录并提交，克隆成没有本机封存、没有用户身份的「CI」，
 * 再逐项篡改已提交的内容——改记录、重算整条链后删用例、候选代码过期、测试文件被删、记录挪位置、
 * 受保护文件缺批准、锚点对不上——每一项都必须让 CI 失败；干净的仓库必须通过。
 */
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { CiVerifyReport } from '@tenon/kernel'
import { afterEach, describe, expect, test } from 'vitest'
import { git } from './integration-harness-tests.js'
import { CATALOG_PATH, SLUG, ciCheckout, devProject, rewriteRecords, type CiCheckout, type Dev } from './verify-ci-fixture.js'

interface Result {
  code: number
  report: CiVerifyReport
  out: string
  err: string
}

function codes(result: Result, severity: 'error' | 'warning' | 'note' = 'error'): string[] {
  return result.report.changes.flatMap((change) => change.findings).filter((item) => item.severity === severity).map((item) => item.code)
}

describe('tenon verify --ci', () => {
  const cleanups: Array<() => Promise<void>> = []
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup()
  })

  async function setup(options: Parameters<typeof devProject>[0] = {}): Promise<{ dev: Dev; ci: CiCheckout }> {
    const dev = await devProject(options)
    cleanups.push(dev.cleanup)
    const ci = await ciCheckout(dev)
    cleanups.push(ci.cleanup)
    return { dev, ci }
  }

  async function verify(ci: CiCheckout, ...args: string[]): Promise<Result> {
    const run = await ci.verify(['--change', 'demo', '--format', 'json', ...args])
    return { ...run, report: JSON.parse(run.out) as CiVerifyReport }
  }

  test('干净的提交：通过，信任边界随报告带出，CI 里没有本机封存', async () => {
    const { ci } = await setup()
    const result = await verify(ci)
    expect(result.code, `${result.out}\n${result.err}`).toBe(0)
    expect(codes(result)).toEqual([])
    const [change] = result.report.changes
    expect(change).toMatchObject({ change: 'demo', step: 'build', policy: 'pass', evaluatedUser: SLUG, anchor: 'none' })
    expect(change?.chains).toEqual([expect.objectContaining({ user: SLUG, state: 'intact', records: 1 })])
    expect(result.report.summary).toMatchObject({ pass: true, errors: 0 })
    expect(result.report.trust.unverifiable.join('\n')).toContain('HMAC')
    expect(result.report.trust.unverifiable.join('\n')).toContain('TENON_TEST_TRUST=1')
    // 本机封存确实不在 CI 检出里。
    const users = await readdir(join(ci.dir, '.tenon', 'users', SLUG))
    expect(users).not.toContain('local')
    const text = await ci.verify(['--change', 'demo'])
    expect(text.code).toBe(0)
    expect(text.out).toContain('Tenon CI 校验 通过')
    expect(text.out).toContain('CI 里无法证明')
  }, 180_000)

  test('篡改记录内容（没重算摘要）：记录链断，CI 失败', async () => {
    const { ci } = await setup()
    await rewriteRecords(ci.dir, (record) => ({ ...record, result: 'pass', machine_label: 'forged' }), { rechain: false })
    ci.commit('tamper a record')
    const result = await verify(ci)
    expect(result.code).toBe(2)
    expect(codes(result)).toContain('record-chain-broken')
    expect(result.report.summary.pass).toBe(false)
  }, 180_000)

  test('重算整条链后删掉一个已登记的用例：记录自洽但登记的用例没出现在记录里，CI 失败', async () => {
    const { ci } = await setup()
    await rewriteRecords(ci.dir, (record) => ({
      ...record,
      suites: record.suites.map((suite) => ({
        ...suite,
        cases: suite.cases.filter((item) => item.name !== 'bad'),
        totals: { ...suite.totals, cases: suite.totals.cases - 1, pass: suite.totals.pass - 1 },
      })),
    }), { rechain: true })
    ci.commit('forge: drop a case and recompute every digest')
    const result = await verify(ci)
    expect(result.code).toBe(2)
    expect(result.report.changes[0]?.chains[0]?.state).toBe('intact')
    expect(codes(result)).toContain('registered-test-not-executed')
  }, 180_000)

  test('记录自己的结论与明细矛盾（摘要都重算过）：CI 以 record-inconsistent 失败；用例总数对不上的记录连解码都过不了', async () => {
    const { ci } = await setup()
    await rewriteRecords(ci.dir, (record) => ({ ...record, result: 'fail' }), { rechain: true })
    ci.commit('forge: contradictory verdict')
    const contradictory = await verify(ci)
    expect(contradictory.code).toBe(2)
    expect(codes(contradictory)).toContain('record-inconsistent')

    await rewriteRecords(ci.dir, (record) => ({
      ...record,
      suites: record.suites.map((suite) => ({ ...suite, totals: { ...suite.totals, pass: suite.totals.pass - 1 } })),
    }), { rechain: true })
    ci.commit('forge: totals no longer add up')
    const undecodable = await verify(ci)
    expect(undecodable.code).toBe(2)
    expect(codes(undecodable)).toContain('record-chain-broken')
  }, 180_000)

  test('候选代码过期：测试之后改了实现文件，CI 失败；--candidate warn 降为警告，off 不比对', async () => {
    const { ci } = await setup()
    await writeFile(join(ci.dir, 'src/feature.js'), 'export const feature = () => 2\n', 'utf8')
    ci.commit('change the implementation after the tests ran')
    const strict = await verify(ci)
    expect(strict.code).toBe(2)
    expect(codes(strict)).toContain('candidate-mismatch')
    expect(codes(strict)).not.toContain('test-stale')
    const warn = await verify(ci, '--candidate', 'warn')
    expect(warn.code, warn.out).toBe(0)
    expect(codes(warn, 'warning')).toContain('candidate-mismatch')
    const off = await verify(ci, '--candidate', 'off')
    expect(off.code).toBe(0)
    expect(codes(off, 'note')).toContain('candidate-unchecked')
  }, 180_000)

  test('计划登记的测试文件在 PR 里被删：CI 失败', async () => {
    const { ci } = await setup()
    await rm(join(ci.dir, 'src/a.test.js'))
    ci.commit('delete a registered test file')
    const result = await verify(ci)
    expect(result.code).toBe(2)
    expect(codes(result)).toContain('plan-file-missing')
  }, 180_000)

  test('记录挪进别的用户目录、删掉链上的记录：CI 失败', async () => {
    const { dev, ci } = await setup()
    // 再跑一次，链上有两条记录；删掉第一条 = 中间缺记录。
    expect(await dev.tenon(['test', 'run', 'demo', '--stage']), dev.err()).toBe(0)
    dev.commit('second run')
    const second = await ciCheckout(dev)
    cleanups.push(second.cleanup)
    const base = join(second.dir, '.tenon', 'users', SLUG, 'tests', 'demo')
    const names = (await readdir(base)).filter((name) => name.endsWith('.json')).sort()
    expect(names).toHaveLength(2)
    expect((await verify(second)).code).toBe(0)
    await rm(join(base, names[0] ?? ''))
    second.commit('drop the first record')
    const broken = await verify(second)
    expect(broken.code).toBe(2)
    expect(codes(broken)).toContain('record-chain-broken')

    // 别人的记录抄进另一个用户目录。
    const other = join(ci.dir, '.tenon', 'users', 'evil-at-x.io', 'tests', 'demo')
    const record = (await readdir(join(ci.dir, '.tenon', 'users', SLUG, 'tests', 'demo')))[0] ?? ''
    const text = await readFile(join(ci.dir, '.tenon', 'users', SLUG, 'tests', 'demo', record), 'utf8')
    await mkdir(other, { recursive: true })
    await writeFile(join(other, record), text, 'utf8')
    ci.commit('copy a record into another user directory')
    const misplaced = await verify(ci)
    expect(misplaced.code).toBe(2)
    expect(codes(misplaced)).toContain('record-misplaced')
  }, 240_000)

  test('--since：只校验 PR 改到的任务；PR 没碰受治理的任务就没有可校验的内容', async () => {
    const { ci } = await setup()
    const touched = await ci.verify(['--since', 'main', '--format', 'json'])
    expect(touched.code, `${touched.out}\n${touched.err}`).toBe(0)
    expect((JSON.parse(touched.out) as CiVerifyReport).changes.map((change) => change.change)).toEqual(['demo'])
    await rewriteRecords(ci.dir, (record) => ({ ...record, machine_label: 'forged' }), { rechain: false })
    ci.commit('tamper')
    const tampered = await ci.verify(['--since', 'origin/main'])
    expect(tampered.code).toBe(2)
    expect(tampered.out).toContain('record-chain-broken')

    git(ci.dir, ['checkout', '-q', '-B', 'docs-only', 'origin/main'])
    await writeFile(join(ci.dir, 'README.md'), '# docs\n', 'utf8')
    ci.commit('docs only')
    const none = await ci.verify(['--since', 'origin/main', '--format', 'json'])
    expect(none.code).toBe(0)
    expect((JSON.parse(none.out) as CiVerifyReport).changes).toEqual([])
  }, 240_000)

  test('--all-open 校验未完结的任务；任务被移进归档目录后 --change 与 --since 仍能找到它', async () => {
    const { ci } = await setup()
    const open = await ci.verify(['--all-open', '--format', 'json'])
    expect(open.code, open.out).toBe(0)
    expect((JSON.parse(open.out) as CiVerifyReport).changes.map((change) => change.change)).toEqual(['demo'])

    await mkdir(join(ci.dir, 'openspec/changes/archive'), { recursive: true })
    git(ci.dir, ['mv', 'openspec/changes/demo', 'openspec/changes/archive/2026-08-01-demo'])
    ci.commit('archive the change')
    const archivedAll = await ci.verify(['--all-open', '--format', 'json'])
    expect((JSON.parse(archivedAll.out) as CiVerifyReport).changes).toEqual([])
    const named = await verify(ci)
    expect(named.code, `${named.out}\n${named.err}`).toBe(0)
    expect(named.report.changes[0]?.dir).toBe('openspec/changes/archive/2026-08-01-demo')
    const since = await ci.verify(['--since', 'origin/main', '--format', 'json'])
    expect((JSON.parse(since.out) as CiVerifyReport).changes.map((change) => change.change)).toEqual(['demo'])
  }, 180_000)

  test('浅克隆缺少任务起点之前的历史：受保护文件的批准无法核对，失败关闭而不是拿整棵树当改动', async () => {
    const dev = await devProject()
    cleanups.push(dev.cleanup)
    const shallow = await ciCheckout(dev, { shallow: true })
    cleanups.push(shallow.cleanup)
    const result = await verify(shallow)
    expect(result.code).toBe(2)
    expect(codes(result)).toEqual(['protected-diff-unavailable'])
    expect(result.report.changes[0]?.findings.find((item) => item.code === 'protected-diff-unavailable')?.message).toContain('fetch-depth: 0')
  }, 180_000)

  test('用法错误：缺 --ci 的选择器、任务不存在、未知格式都是 exit 1', async () => {
    const { ci } = await setup()
    expect((await ci.verify([])).code).toBe(1)
    expect((await ci.verify(['--change', 'nope'])).code).toBe(1)
    expect((await ci.verify(['--change', 'demo', '--format', 'xml'])).code).toBe(1)
    expect((await ci.verify(['--change', 'demo', '--all-open'])).code).toBe(1)
    expect(await ci.h.run(['verify', '--change', 'demo'])).toBe(1)
  }, 180_000)

  test('受保护的目录改动：没有评审批准行 CI 失败；批准过则通过；批准之后再改又失败', async () => {
    const unapproved = await setup({ catalogEdit: 'unapproved' })
    const missing = await verify(unapproved.ci)
    expect(missing.code).toBe(2)
    expect(codes(missing)).toContain('protected-unapproved')

    const approved = await setup({ catalogEdit: 'approved' })
    const ok = await verify(approved.ci)
    expect(ok.code, `${ok.out}\n${ok.err}`).toBe(0)
    const history = await readFile(join(approved.ci.dir, 'openspec/changes/demo/.pipeline-history.jsonl'), 'utf8')
    expect(history).toContain('test:protected-approve')
    expect(history).toContain(`digests=${CATALOG_PATH}@sha256:`)

    // 删掉批准行（历史是明文，可以手改）：回到未批准。
    const stripped = history.split('\n').filter((line) => !line.includes('test:protected-approve')).join('\n')
    await writeFile(join(approved.ci.dir, 'openspec/changes/demo/.pipeline-history.jsonl'), stripped, 'utf8')
    approved.ci.commit('remove the approval line')
    expect(codes(await verify(approved.ci))).toContain('protected-unapproved')

    // 恢复批准行，但批准之后目录又被改：摘要对不上。
    await writeFile(join(approved.ci.dir, 'openspec/changes/demo/.pipeline-history.jsonl'), history, 'utf8')
    await writeFile(join(approved.ci.dir, CATALOG_PATH), `${await readFile(join(approved.ci.dir, CATALOG_PATH), 'utf8')}# 事后加的\n`, 'utf8')
    approved.ci.commit('edit the catalog after the approval')
    expect(codes(await verify(approved.ci))).toContain('protected-changed-after-approval')
  }, 300_000)
})
