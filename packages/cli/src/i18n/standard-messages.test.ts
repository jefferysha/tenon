import { describe, expect, it } from 'vitest'
import { cmdDocumentRecordCommand } from '../commands/document-batch.js'
import { cmdTestDiffRisk } from '../commands/test-diff-risk.js'
import { makeDeps } from '../test-support.js'
import type { CliLocale } from './locale.js'
import { formatMessage } from './messages.js'

const CJK = /[㐀-鿿＀-￯　-〿]/u

function depsFor(locale: CliLocale): ReturnType<typeof makeDeps> {
  return Object.assign(makeDeps(), { locale })
}

describe('standard 通道命令的输出语言', () => {
  it('zh 与命令原有的中文输出逐字一致', () => {
    expect(formatMessage('zh', 'step.run.header', { change: 'c', step: 'build', label: '实现' })).toBe('[STEP] c · build（实现）')
    expect(formatMessage('zh', 'step.run.done', { ok: 2, total: 3 })).toBe('已做 2/3 项：')
    expect(formatMessage('zh', 'document.record.allSummary', { change: 'c', step: 'build', recorded: 1, total: 2 }))
      .toBe('[DOCUMENT] c · build：1/2 份已登记')
    expect(formatMessage('zh', 'document.record.placeholdersSome', { first: 'x' })).toBe('骨架里还有 若干 处占位符没替换（x）')
    expect(formatMessage('zh', 'diffRisk.label.filesChanged')).toBe('改动文件')
    expect(formatMessage('zh', 'agent.reviewerUnattached', { agent: 'security', scope: 'auth/dependency' }))
      .toBe("评审者 'security' 只在 auth/dependency 路径变化时挂载，本任务的改动没有碰到这些路径，不需要运行它")
  })

  it('观察模式的 document 命令：zh 是约定的那句话，en 不含中文，占位符都被替换', () => {
    expect(formatMessage('zh', 'document.observed.autoRecorded', { command: 'document record' }))
      .toBe('本任务的产出由 Tenon 在离开步骤时自动记录，tenon document record 只服务升级前创建的任务')
    expect(formatMessage('zh', 'document.observed.requiredMissing', { step: 'spec', path: 'docs/superpowers/plans/*.md' }))
      .toBe("step 'spec' 要求产出匹配 docs/superpowers/plans/*.md 的文件（本任务里这一步还没有写出这样的文件）")
    const english = [
      formatMessage('en', 'document.observed.autoRecorded', { command: 'artifact register' }),
      formatMessage('en', 'document.observed.pathOutsideProject', { path: '../x.md' }),
      formatMessage('en', 'document.observed.inputLine', { mark: 'UNREAD', path: 'a.md', from: 'explore', skill: 'unknown' }),
      formatMessage('en', 'document.observed.unreadSummary', { count: 2, change: 'demo' }),
      formatMessage('en', 'document.observed.requiredMissing', { step: 'spec', path: 'a.md' }),
      formatMessage('en', 'document.observed.pass'),
    ]
    for (const line of english) {
      expect(CJK.test(line), line).toBe(false)
      expect(line, line).not.toMatch(/\{[A-Za-z]+\}/u)
    }
  })

  it('assess 读不出路径是否存在：两种语言都点名路径与原因', () => {
    const params = { path: '"src/a.ts"', reason: 'EACCES' }
    expect(formatMessage('zh', 'assess.path.unreadable', params)).toBe('无法确认路径是否存在（EACCES）：评估不猜，请先修好读取权限："src/a.ts"')
    const en = formatMessage('en', 'assess.path.unreadable', params)
    expect(en).toContain('EACCES')
    expect(en).toContain('"src/a.ts"')
    expect(CJK.test(en)).toBe(false)
  })

  it('test diff-risk 的错误：zh 保持原文，en 是英文', async () => {
    const zh = depsFor('zh')
    expect(await cmdTestDiffRisk(zh, 'bad name!')).toBe(1)
    expect(zh.errLines).toEqual(["ERROR: 非法任务名 'bad name!'"])
    const en = depsFor('en')
    expect(await cmdTestDiffRisk(en, 'bad name!')).toBe(1)
    expect(en.errLines).toEqual(["ERROR: invalid task name 'bad name!'"])
    expect(CJK.test(en.errLines.join('\n'))).toBe(false)
  })

  it('document record 的用法错误：zh 保持原文，en 是英文', async () => {
    const zh = depsFor('zh')
    expect(await cmdDocumentRecordCommand(zh, 'c', undefined, undefined, {})).toBe(1)
    expect(zh.errLines).toEqual(['ERROR: 用法：tenon document record <change> <kind> <path> --producer <skill-id>；或 tenon document record <change> --all'])
    const en = depsFor('en')
    expect(await cmdDocumentRecordCommand(en, 'c', 'k', undefined, { all: true })).toBe(1)
    expect(en.errLines).toEqual(['ERROR: --all takes no kind / path and cannot be combined with --backfill'])
    expect(CJK.test(en.errLines.join('\n'))).toBe(false)
  })
})
