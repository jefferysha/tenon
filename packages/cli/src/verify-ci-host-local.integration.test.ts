/**
 * `tenon verify --ci` 与宿主本地文件：作者的工作区里有被 gitignore 的 `.claude/settings.local.json`（Claude Code 自己写的
 * 权限允许列表）、`CLAUDE.local.md`，干净克隆里没有它们。测试记录绑定的候选指纹不能把这些文件算进去，否则每个用 Claude Code 的
 * 项目在 CI 上都会 `candidate-mismatch`；而 0.3.0 写下的、绑了完整指纹的记录在作者本机仍然要保持新鲜。
 */
import { appendFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { candidateFingerprint, fingerprintWorkspaceTwins, declaredTestOutputs, type CiVerifyReport } from '@tenon/kernel'
import { afterEach, describe, expect, test } from 'vitest'
import { writeFiles } from './integration-harness-tests.js'
import {
  HOST_LOCAL_SETTINGS_PATH, TRACKED_HOST_LOCAL_CODE, USER, ciCheckout, devProject, rewriteRecords, writeHostLocalFiles, type CiCheckout, type Dev,
} from './verify-ci-fixture.js'

interface Run {
  readonly code: number
  readonly report: CiVerifyReport
  readonly out: string
}

describe('tenon verify --ci：宿主本地文件', () => {
  const cleanups: Array<() => Promise<void>> = []
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup()
  })

  async function author(): Promise<Dev> {
    const dev = await devProject({ hostLocalFiles: true })
    cleanups.push(dev.cleanup)
    return dev
  }

  async function clone(dev: Dev): Promise<CiCheckout> {
    const ci = await ciCheckout(dev)
    cleanups.push(ci.cleanup)
    return ci
  }

  async function verifyIn(ci: CiCheckout, ...args: string[]): Promise<Run> {
    const run = await ci.verify(['--change', 'demo', '--format', 'json', ...args])
    return { code: run.code, out: `${run.out}\n${run.err}`, report: JSON.parse(run.out) as CiVerifyReport }
  }

  /** 在作者的工作区里跑同一条 `verify --ci`（那里有宿主本地文件）。 */
  async function verifyAtAuthor(dev: Dev, ...args: string[]): Promise<Run> {
    const code = await dev.tenon(['verify', '--ci', '--change', 'demo', '--format', 'json', ...args], USER)
    return { code, out: `${dev.out()}\n${dev.err()}`, report: JSON.parse(dev.out()) as CiVerifyReport }
  }

  const codes = (run: Run, severity: 'error' | 'warning' | 'note' = 'error'): string[] =>
    run.report.changes.flatMap((change) => change.findings).filter((item) => item.severity === severity).map((item) => item.code)

  const mismatch = (run: Run): string => run.report.changes.flatMap((change) => change.findings).find((item) => item.code === 'candidate-mismatch')?.message ?? ''

  test('作者的工作区有 .claude/settings.local.json 与 CLAUDE.local.md（被忽略）：干净克隆照样通过，记录绑的是不含它们的候选', async () => {
    const dev = await author()
    const [record] = await dev.records()
    const twins = await fingerprintWorkspaceTwins(dev.dir, { declaredOutputs: await declaredTestOutputs(dev.dir) })
    expect(twins.full, '夹具里确实有宿主本地文件，两个指纹不同').not.toBe(twins.portable)
    expect(record?.bindings.candidate).toBe(twins.portable)

    const ci = await clone(dev)
    const result = await verifyIn(ci)
    expect(result.code, result.out).toBe(0)
    expect(codes(result)).toEqual([])
    expect(result.report.changes[0]).toMatchObject({ policy: 'pass', step: 'build' })
  }, 180_000)

  test('作者本机：权限允许列表被 Claude Code 改写之后记录仍然新鲜；改了实现文件才过期', async () => {
    const dev = await author()
    expect((await verifyAtAuthor(dev)).code).toBe(0)
    // Claude Code 每次回答权限提示都会改写这个文件。
    await writeHostLocalFiles(dev.dir, '{ "permissions": { "allow": ["Bash(ls)", "Bash(npm test)"] } }\n')
    await appendFile(join(dev.dir, 'CLAUDE.local.md'), 'one more private note\n', 'utf8')
    const afterClick = await verifyAtAuthor(dev)
    expect(afterClick.code, afterClick.out).toBe(0)
    expect(codes(afterClick)).toEqual([])

    await writeFile(join(dev.dir, 'src/feature.js'), 'export const feature = () => 2\n', 'utf8')
    const changed = await verifyAtAuthor(dev)
    expect(changed.code).toBe(2)
    expect(codes(changed)).toContain('candidate-mismatch')
  }, 180_000)

  test('0.3.0 写下的记录（绑完整指纹）：作者本机照样新鲜，不因升级而过期；宿主本地文件被改了才像 0.3.0 一样过期；干净克隆复现不了它，错误里点明原因', async () => {
    const dev = await author()
    const full = await candidateFingerprint(dev.dir)
    const [record] = await dev.records()
    expect(record?.bindings.candidate, '新写的记录绑可移植指纹').not.toBe(full)
    await rewriteRecords(dev.dir, (item) => ({ ...item, bindings: { ...item.bindings, candidate: full } }), { rechain: true })

    const atAuthor = await verifyAtAuthor(dev)
    expect(atAuthor.code, atAuthor.out).toBe(0)
    expect(codes(atAuthor)).toEqual([])

    // 完整指纹把宿主本地文件算进去：改了它，旧口径的记录像 0.3.0 一样过期。
    await writeHostLocalFiles(dev.dir, '{ "permissions": { "allow": ["Bash(rm:*)"] } }\n')
    expect(codes(await verifyAtAuthor(dev))).toContain('candidate-mismatch')
    await writeHostLocalFiles(dev.dir)

    dev.commit('commit the records written by 0.3.0')
    const ci = await clone(dev)
    const result = await verifyIn(ci, '--candidate', 'error')
    expect(result.code).toBe(2)
    expect(codes(result)).toContain('candidate-mismatch')
    expect(mismatch(result)).toContain(HOST_LOCAL_SETTINGS_PATH)
    expect(mismatch(result)).toContain('0.3.0')
    expect(result.report.changes[0]?.findings.find((item) => item.code === 'candidate-mismatch')?.fix).toBe('tenon test run demo --stage')
  }, 180_000)

  test('候选不一致的错误点名真正的原因：只有测试之后才改过的文件，交付提交里的文件不算', async () => {
    const dev = await author()
    const ci = await clone(dev)
    expect((await verifyIn(ci)).code).toBe(0)
    await writeFiles(ci.dir, { 'src/later.js': 'export const later = 1\n' })
    ci.commit('add a file after the tests ran')
    const result = await verifyIn(ci)
    expect(result.code).toBe(2)
    const message = mismatch(result)
    expect(message).toContain('src/later.js')
    expect(message, '交付提交里的 src/feature.js 在测试时就在工作区里，不是「测试之后改的」').not.toContain('src/feature.js')

    // 英文报告同一条线索。
    const en = await ci.verify(['--change', 'demo', '--format', 'json'], { TENON_LANG: 'en' })
    expect(en.code).toBe(2)
    expect(en.out).toContain('candidate files changed after commit')
    expect(en.out).toContain('src/later.js')
  }, 180_000)

  test('检出里多出被忽略或未跟踪的候选文件（构建产物）：错误点名它们，不把交付提交里的文件当成原因', async () => {
    const dev = await author()
    const ci = await clone(dev)
    await writeFiles(ci.dir, { 'dist/bundle.js': 'built output\n' })
    const result = await verifyIn(ci)
    expect(result.code).toBe(2)
    const message = mismatch(result)
    expect(message).toContain('dist/')
    expect(message).not.toContain('src/feature.js')
    // 测试之后没有任何提交改过候选文件：差异在测试时的工作区本身，不在后来的提交里。
    expect(message).toContain('之后没有再改过候选文件')
  }, 180_000)

  test('被 git 跟踪的代码放在宿主本地清单的路径下（.claude/worktrees/x.js）、测试命令在用它：它是仓库的一部分，改了它记录必须过期', async () => {
    const dev = await devProject({ trackedHostLocalCode: true, hostLocalFiles: true })
    cleanups.push(dev.cleanup)
    // 作者本机：记录新鲜；改了被跟踪的代码，记录过期。
    expect((await verifyAtAuthor(dev)).code).toBe(0)
    await writeFile(join(dev.dir, TRACKED_HOST_LOCAL_CODE), 'export const marker = 2\n', 'utf8')
    const atAuthor = await verifyAtAuthor(dev)
    expect(atAuthor.code, atAuthor.out).toBe(2)
    expect(codes(atAuthor)).toContain('candidate-mismatch')
    await writeFile(join(dev.dir, TRACKED_HOST_LOCAL_CODE), 'export const marker = 1\n', 'utf8')

    // 干净克隆：被跟踪的文件在克隆里，作者绑定时也算了它，所以通过；之后改了它，CI 失败并点名。
    const ci = await clone(dev)
    const clean = await verifyIn(ci)
    expect(clean.code, clean.out).toBe(0)
    await writeFile(join(ci.dir, TRACKED_HOST_LOCAL_CODE), 'export const marker = 2\n', 'utf8')
    ci.commit('change the code the test command imports from the host-local path')
    const changed = await verifyIn(ci)
    expect(changed.code, changed.out).toBe(2)
    expect(codes(changed)).toContain('candidate-mismatch')
    expect(mismatch(changed)).toContain(TRACKED_HOST_LOCAL_CODE)
  }, 180_000)

  test('测试时没被跟踪、之后才提交进仓库的宿主本地路径：克隆里它计入候选，记录对不上，CI 失败并点名', async () => {
    const dev = await author()
    await writeFiles(dev.dir, { [TRACKED_HOST_LOCAL_CODE]: 'export const marker = 1\n' })
    dev.commit('commit code under the host-local list after the tests ran')
    const ci = await clone(dev)
    const result = await verifyIn(ci)
    expect(result.code, result.out).toBe(2)
    expect(codes(result)).toContain('candidate-mismatch')
    const message = mismatch(result)
    expect(message).toContain('git 跟踪着宿主本地清单上的路径')
    expect(message).toContain(TRACKED_HOST_LOCAL_CODE)
  }, 180_000)
})
