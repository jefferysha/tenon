import { describe, expect, it } from 'vitest'
import { translations, type Dict, type Lang } from '../i18n/translations'
import type { StepExitBlockerSource, TransitionReadinessBlockerSnapshot } from '../types'
import { blockerLines } from './blockerLabel'

function stepExit(source: StepExitBlockerSource, code: string, message: string, items?: string[]): TransitionReadinessBlockerSnapshot {
  return { kind: 'step-exit', source, code, message, ...(items === undefined ? {} : { items }) }
}

function translate(lang: Lang, key: string, vars: Record<string, string | number>): string {
  let node: string | Dict | undefined = translations[lang]
  for (const part of key.split('.')) node = typeof node === 'object' ? node[part] : undefined
  let text = typeof node === 'string' ? node : key
  for (const [name, value] of Object.entries(vars)) text = text.split(`{${name}}`).join(String(value))
  return text
}

function labels(blocker: TransitionReadinessBlockerSnapshot, lang: Lang = 'zh'): string[] {
  return blockerLines(blocker).map((line) => line.label === null ? line.text : translate(lang, line.label.key, line.label.vars))
}

describe('blockerLines · 按阻断 code 的短标签', () => {
  it('tasks-incomplete：按未勾项计数（items 优先，否则从文案取数）', () => {
    const message = 'open 出口：要求截至当前阶段的 tasks.md 全部勾选（仍有 1 项未勾）'
    expect(labels(stepExit('tasks', 'tasks-incomplete', message, ['a', 'b', 'c']))).toEqual(['tasks.md 未勾 3 项'])
    expect(labels(stepExit('tasks', 'tasks-incomplete', message))).toEqual(['tasks.md 未勾 1 项'])
    expect(labels(stepExit('tasks', 'tasks-incomplete', message), 'en')).toEqual(['tasks.md: 1 unchecked'])
  })

  it('document-evidence：缺少文档 X；完整 CLI 文案留在 text（进 title）', () => {
    const message = "缺少 document 'proposal'；执行 tenon document record <change> proposal <path> --producer <skill>"
    const [line] = blockerLines(stepExit('document', 'document-evidence', message))
    expect(line?.text).toBe(message)
    expect(labels(stepExit('document', 'document-evidence', message))).toEqual(['缺少文档 proposal'])
    expect(labels(stepExit('document', 'document-evidence', message), 'en')).toEqual(['Missing document proposal'])
    expect(labels(stepExit('document', 'document-evidence', "document 'design' 已缺失或内容变化；重新执行 tenon document record 后再继续")))
      .toEqual(['文档 design 需重新登记'])
  })

  it('skill-incomplete：技能 X 未运行；已调用但未登记产出另给一词', () => {
    expect(labels(stepExit('skill', 'skill-incomplete', '尚未完成声明的 skill：tdd'))).toEqual(['技能 tdd 未运行'])
    expect(labels(stepExit('skill', 'skill-incomplete', '尚未完成声明的 skill：openspec-propose（已调用，本次步骤访问尚未登记它产出的 document：proposal）')))
      .toEqual(['技能 openspec-propose 未登记产出'])
  })

  it('test-evidence：测试 X 未运行 / 失败 / 过期', () => {
    expect(labels(stepExit('test', 'test-evidence', '测试 单元（unit）未运行；执行 tenon test run demo unit'))).toEqual(['测试 单元 未运行'])
    expect(labels(stepExit('test', 'test-evidence', '测试 单元（unit）失败：exit-code；执行 tenon test run demo unit'))).toEqual(['测试 单元 失败'])
    expect(labels(stepExit('test', 'test-evidence', '测试 e2e（e2e）过期：代码已变；执行 tenon test run demo e2e'), 'en')).toEqual(['Test e2e stale'])
  })

  it('认不出的 code 或文案退回完整文案', () => {
    expect(labels(stepExit('guard', 'phase-exit', 'pr_url 未设置'))).toEqual(['pr_url 未设置'])
    expect(labels(stepExit('test', 'test-evidence', '测试证据无法验证：宿主未提供用户身份'))).toEqual(['测试证据无法验证：宿主未提供用户身份'])
    expect(labels({ kind: 'agents-incomplete', agents: [{ agent: 'security', reason: 'blocking' }] })).toEqual(['security · blocking'])
  })
})
