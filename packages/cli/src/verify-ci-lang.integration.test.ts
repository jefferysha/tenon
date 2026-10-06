/**
 * `tenon verify --ci` 的输出语言：text / json / markdown / sarif 里的固定文案、CI 独有的发现说明与信任边界陈述
 * 跟 CLI 的语言走（`TENON_LANG` → `LC_ALL` → `LC_MESSAGES` → `LANG`，缺省中文）。中文输出与原来逐字一致
 * （`verify-ci.integration.test.ts` 的中文断言仍然成立）；英文输出里不能剩下任何中文。
 * 退出码、发现码、级别、JSON 字段名不随语言变。
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { CiVerifyReport } from '@tenon/kernel'
import { afterEach, describe, expect, test } from 'vitest'
import { rewriteRecords, ciCheckout, devProject, type CiCheckout, type Dev } from './verify-ci-fixture.js'

const CJK = /[㐀-鿿＀-￯　-〿]/u
const EN = { TENON_LANG: 'en' }
const ZH = { TENON_LANG: 'zh' }

interface SarifLike {
  runs: { results: { message: { text: string }; ruleId: string; level: string }[]; properties: { tenon: { trust: { verified: string[]; unverifiable: string[] } } } }[]
}

describe('tenon verify --ci 的输出语言', () => {
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

  test('json / markdown / sarif / text：英文里没有一个中文字符，中文与原来一致，发现码、级别与退出码两种语言相同', async () => {
    const { ci } = await setup({ catalogEdit: 'unapproved' })
    const args = ['--change', 'demo']
    const json = (env: Record<string, string>) => ci.verify([...args, '--format', 'json'], env)

    const en = await json(EN)
    const zh = await json(ZH)
    expect(en.code, `${en.out}\n${en.err}`).toBe(2)
    expect(zh.code).toBe(2)
    expect(CJK.test(en.out), en.out).toBe(false)
    const enReport = JSON.parse(en.out) as CiVerifyReport
    const zhReport = JSON.parse(zh.out) as CiVerifyReport
    const summarize = (report: CiVerifyReport) => report.changes.flatMap((change) => change.findings).map((item) => `${item.code}:${item.severity}:${item.path ?? ''}:${item.fix ?? ''}`)
    expect(summarize(enReport)).toEqual(summarize(zhReport))
    expect(enReport.summary).toEqual(zhReport.summary)
    const unapproved = enReport.changes[0]?.findings.find((item) => item.code === 'protected-unapproved')
    expect(unapproved?.message).toContain('test catalog .tenon/tests/catalog.yaml (modified, sha256:')
    expect(unapproved?.message).toContain('has no matching review approval line')
    expect(zhReport.changes[0]?.findings.find((item) => item.code === 'protected-unapproved')?.message)
      .toContain('测试目录 .tenon/tests/catalog.yaml（修改，sha256:')
    expect(enReport.trust.unverifiable.join('\n')).toContain('HMAC key')
    expect(enReport.trust.unverifiable.join('\n')).toContain('TENON_TEST_TRUST=1 tenon test run')
    expect(zhReport.trust.unverifiable.join('\n')).toContain('没有 HMAC 密钥')

    const markdown = await ci.verify([...args, '--format', 'markdown'], EN)
    expect(markdown.code).toBe(2)
    expect(CJK.test(markdown.out), markdown.out).toBe(false)
    expect(markdown.out).toContain('## FAIL — Tenon CI verification failed: 1 changes, ')
    expect(markdown.out).toContain('| Change | Step | Policy | Record chains | Anchor | Errors | Warnings |')
    expect(markdown.out).toContain('### Findings')
    expect(markdown.out).toContain('| Level | Code | Change | Message |')
    expect(markdown.out).toContain('| error | `protected-unapproved` |')
    expect(markdown.out).toContain('### Not provable in CI')
    expect(markdown.out).toContain('### Verified in this run')
    const markdownZh = await ci.verify([...args, '--format', 'markdown'], ZH)
    expect(markdownZh.out).toContain('## FAIL — Tenon CI 校验 未通过：1 个任务')
    expect(markdownZh.out).toContain('| 任务 | 步骤 | 策略 | 记录链 | 锚点 | 失败 | 警告 |')
    expect(markdownZh.out).toContain('| 失败 | `protected-unapproved` |')

    const sarif = await ci.verify([...args, '--format', 'sarif'], EN)
    expect(sarif.code).toBe(2)
    expect(CJK.test(sarif.out), sarif.out).toBe(false)
    const log = JSON.parse(sarif.out) as SarifLike
    const result = log.runs[0]?.results.find((item) => item.ruleId === 'tenon/protected-unapproved')
    expect(result).toMatchObject({ level: 'error' })
    expect(result?.message.text).toContain('has no matching review approval line; run tenon review request demo')
    expect(log.runs[0]?.properties.tenon.trust.unverifiable.length).toBe(4)
    const sarifZh = JSON.parse((await ci.verify([...args, '--format', 'sarif'], ZH)).out) as SarifLike
    expect(sarifZh.runs[0]?.results.find((item) => item.ruleId === 'tenon/protected-unapproved')?.message.text)
      .toContain('任务历史里没有对应的评审批准行；执行 tenon review request demo')

    const text = await ci.verify(args, EN)
    expect(text.code).toBe(2)
    expect(CJK.test(text.out), text.out).toBe(false)
    expect(text.out.split('\n')[0]).toMatch(/^\[VERIFY-CI\] Tenon CI verification failed: 1 changes, \d+ errors, \d+ warnings \(--change demo\)$/u)
    expect(text.out).toContain('Change demo  step build  ')
    expect(text.out).toContain('Verified in this run:')
    expect(text.out).toContain("Not provable in CI (there is no HMAC key from the user's machine):")
    expect(text.out).toMatch(/Report format tenon-verify-ci\/v1; Tenon .*; commit [0-9a-f]{40}$/u)
    expect((await ci.verify(args, ZH)).out.split('\n')[0]).toMatch(/^\[VERIFY-CI\] Tenon CI 校验 未通过：1 个任务，\d+ 个失败，\d+ 个警告（--change demo）$/u)
  }, 240_000)

  test('--out / --also 写进文件的内容同样跟语言走', async () => {
    const { ci } = await setup()
    const run = await ci.verify(['--change', 'demo', '--out', 'out/report.md', '--format', 'markdown', '--also', 'sarif=out/report.sarif'], EN)
    expect(run.code, `${run.out}\n${run.err}`).toBe(0)
    const markdown = await readFile(join(ci.dir, 'out', 'report.md'), 'utf8')
    const sarif = await readFile(join(ci.dir, 'out', 'report.sarif'), 'utf8')
    expect(CJK.test(markdown), markdown).toBe(false)
    expect(CJK.test(sarif), sarif).toBe(false)
    expect(markdown).toContain('## PASS — Tenon CI verification passed')
    // stdout 打印 text 摘要，也是英文。
    expect(run.out).toContain('Tenon CI verification passed')
    expect(CJK.test(run.out), run.out).toBe(false)
  }, 240_000)

  test('断链的发现（记录被改动）：原因与说明按语言走，英文里没有中文', async () => {
    const { ci } = await setup()
    await rewriteRecords(ci.dir, (record) => ({ ...record, result: 'pass', machine_label: 'forged' }), { rechain: false })
    ci.commit('tamper a record')
    const en = await ci.verify(['--change', 'demo', '--format', 'json'], EN)
    expect(en.code).toBe(2)
    expect(CJK.test(en.out), en.out).toBe(false)
    const report = JSON.parse(en.out) as CiVerifyReport
    expect(report.changes[0]?.findings.map((item) => item.code)).toContain('record-chain-broken')
    expect(report.changes[0]?.findings.find((item) => item.code === 'record-chain-broken')?.message).toMatch(/^Records tampered/u)
    const zh = JSON.parse((await ci.verify(['--change', 'demo', '--format', 'json'], ZH)).out) as CiVerifyReport
    expect(zh.changes[0]?.findings.find((item) => item.code === 'record-chain-broken')?.message).toContain('测试记录被改动')
  }, 240_000)

  test('语言信号：TENON_LANG 优先；没有 TENON_LANG 时 LC_ALL / LANG；C / POSIX 与没有信号都是中文', async () => {
    const { ci } = await setup()
    const first = async (env: Record<string, string | undefined>): Promise<string> =>
      (await ci.verify(['--change', 'demo'], { TENON_LANG: undefined, LC_ALL: undefined, LC_MESSAGES: undefined, LANG: undefined, ...env })).out.split('\n')[0] ?? ''
    expect(await first({ TENON_LANG: 'en', LANG: 'zh_CN.UTF-8' })).toContain('verification passed')
    expect(await first({ TENON_LANG: 'zh', LANG: 'en_US.UTF-8' })).toContain('校验 通过')
    expect(await first({ LC_ALL: 'en_US.UTF-8' })).toContain('verification passed')
    expect(await first({ LANG: 'en_GB.UTF-8' })).toContain('verification passed')
    expect(await first({ LC_ALL: 'C', LANG: 'en_US.UTF-8' })).toContain('校验 通过')
    expect(await first({})).toContain('校验 通过')
  }, 240_000)

  test('用法错误的提示也跟语言走，退出码与 ERROR: 前缀不变', async () => {
    const { ci } = await setup()
    const en = await ci.verify(['--change', 'demo', '--format', 'xml'], EN)
    expect(en.code).toBe(1)
    expect(en.err).toBe("ERROR: --format supports only text | json | sarif | markdown (got 'xml')")
    const zh = await ci.verify(['--change', 'demo', '--format', 'xml'], ZH)
    expect(zh.code).toBe(1)
    expect(zh.err).toBe("ERROR: --format 只支持 text | json | sarif | markdown（收到 'xml'）")
    const missing = await ci.verify(['--change', 'nope'], EN)
    expect(missing.code).toBe(1)
    expect(missing.err).toContain('ERROR: change not found: nope')
    const noSelector = await ci.verify([], EN)
    expect(noSelector.code).toBe(1)
    expect(noSelector.err).toBe('ERROR: Pick exactly one change scope: --change <name> | --all-open | --since <ref>')
  }, 240_000)
})
