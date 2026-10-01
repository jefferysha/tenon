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
