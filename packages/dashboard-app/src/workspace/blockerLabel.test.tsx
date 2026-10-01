import { describe, expect, it } from 'vitest'
import { translations, type Dict, type Lang } from '../i18n/translations'
import type { StepExitBlockerSource, TransitionReadinessBlockerSnapshot } from '../types'
import { blockerLines, mergeBlockerRows } from './blockerLabel'

interface Detail { items?: string[]; subject?: string; state?: string; count?: number }

function stepExit(source: StepExitBlockerSource, code: string, message: string, detail: Detail = {}): TransitionReadinessBlockerSnapshot {
  return { kind: 'step-exit', source, code, message, ...detail }
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

describe('blockerLines · 按阻断 code 与服务端字段的短标签', () => {
  it('tasks-incomplete：用服务端给的 count，其次 items 的个数；两者都没有就只说「未勾完」，不从文案里取数', () => {
    const message = 'open 出口：要求截至当前阶段的 tasks.md 全部勾选（仍有 1 项未勾）'
    expect(labels(stepExit('tasks', 'tasks-incomplete', message, { count: 3, items: ['a', 'b', 'c'] }))).toEqual(['tasks.md 未勾 3 项'])
    expect(labels(stepExit('tasks', 'tasks-incomplete', message, { items: ['a', 'b'] }))).toEqual(['tasks.md 未勾 2 项'])
    expect(labels(stepExit('tasks', 'tasks-incomplete', message))).toEqual(['tasks.md 未勾完'])
    expect(labels(stepExit('tasks', 'tasks-incomplete', message, { count: 1 }), 'en')).toEqual(['tasks.md: 1 unchecked'])
    expect(labels(stepExit('tasks', 'tasks-incomplete', message), 'en')).toEqual(['tasks.md incomplete'])
  })

  it('document-evidence：按 subject + state 出 缺少 / 需重新登记 / 待读取；完整 CLI 文案留在 text（进 title）', () => {
    const message = "缺少 document 'proposal'；执行 tenon document record <change> proposal <path> --producer <skill>"
    const [line] = blockerLines(stepExit('document', 'document-evidence', message, { subject: 'proposal', state: 'missing' }))
    expect(line?.text).toBe(message)
    expect(labels(stepExit('document', 'document-evidence', message, { subject: 'proposal', state: 'missing' }))).toEqual(['缺少文档 proposal'])
    expect(labels(stepExit('document', 'document-evidence', message, { subject: 'proposal', state: 'missing' }), 'en')).toEqual(['Missing document proposal'])
    expect(labels(stepExit('document', 'document-evidence', 'x', { subject: 'design', state: 'stale' }))).toEqual(['文档 design 需重新登记'])
    expect(labels(stepExit('document', 'document-evidence', 'x', { subject: 'design', state: 'unread' }))).toEqual(['文档 design 待读取'])
    expect(labels(stepExit('document', 'document-evidence', 'x', { subject: 'design', state: 'unread' }), 'en')).toEqual(['Document design unread'])
  })

  it('skill-incomplete：技能 X 未运行；已调用但未登记产出另给一词', () => {
    expect(labels(stepExit('skill', 'skill-incomplete', 'x', { subject: 'tdd', state: 'not-run' }))).toEqual(['技能 tdd 未运行'])
    expect(labels(stepExit('skill', 'skill-incomplete', 'x', { subject: 'openspec-propose', state: 'unrecorded' })))
      .toEqual(['技能 openspec-propose 未登记产出'])
  })

  it('test-evidence：测试 X 未运行 / 失败 / 过期 / 运行中', () => {
    expect(labels(stepExit('test', 'test-evidence', 'x', { subject: '单元', state: 'missing' }))).toEqual(['测试 单元 未运行'])
    expect(labels(stepExit('test', 'test-evidence', 'x', { subject: '单元', state: 'failed' }))).toEqual(['测试 单元 失败'])
    expect(labels(stepExit('test', 'test-evidence', 'x', { subject: 'e2e', state: 'stale' }), 'en')).toEqual(['Test e2e stale'])
    expect(labels(stepExit('test', 'test-evidence', 'x', { subject: 'e2e', state: 'running' }), 'en')).toEqual(['Test e2e running'])
  })

  it('不再解析服务端的中文整句：字段缺席时即使文案长得像也退回完整文案；字段在时文案内容无关紧要', () => {
    const text = "缺少 document 'proposal'；执行 tenon document record <change> proposal <path>"
    expect(labels(stepExit('document', 'document-evidence', text))).toEqual([text])
    expect(labels(stepExit('skill', 'skill-incomplete', '尚未完成声明的 skill：tdd'))).toEqual(['尚未完成声明的 skill：tdd'])
    expect(labels(stepExit('test', 'test-evidence', '测试 单元（unit）未运行；执行 tenon test run demo unit'))).toEqual(['测试 单元（unit）未运行；执行 tenon test run demo unit'])
    expect(labels(stepExit('document', 'document-evidence', 'English only message', { subject: 'tasks', state: 'missing' }))).toEqual(['缺少文档 tasks'])
  })

  it('认不出的 code、状态或缺 subject 退回完整文案', () => {
    expect(labels(stepExit('guard', 'phase-exit', 'pr_url 未设置'))).toEqual(['pr_url 未设置'])
    expect(labels(stepExit('test', 'test-evidence', '测试证据无法验证：宿主未提供用户身份'))).toEqual(['测试证据无法验证：宿主未提供用户身份'])
    expect(labels(stepExit('test', 'test-evidence', 'whole', { subject: 'unit', state: 'exploded' }))).toEqual(['whole'])
    expect(labels(stepExit('document', 'document-evidence', 'whole', { state: 'missing' }))).toEqual(['whole'])
    expect(labels({ kind: 'agents-incomplete', agents: [{ agent: 'security', reason: 'blocking' }] })).toEqual(['security · blocking'])
  })
})

describe('mergeBlockerRows · 同类阻断合并成一行', () => {
  const t = (key: string, vars: Record<string, string | number> = {}): string => translate('zh', key, vars)
  const doc = (name: string): TransitionReadinessBlockerSnapshot => stepExit('document', 'document-evidence', `缺少 document '${name}'；执行 tenon document record <change> ${name} <path>`, { subject: name, state: 'missing' })
  const merged = (blockers: TransitionReadinessBlockerSnapshot[]) => mergeBlockerRows(blockers.flatMap(blockerLines), t)

  it('同一个短标签模板的多条合成一行，名字用 · 连接；完整文案逐条进 title', () => {
    const rows = merged([doc('proposal'), doc('openspec-design'), doc('tasks')])
    expect(rows.map((row) => row.label)).toEqual(['缺少文档 proposal · openspec-design · tasks'])
    expect(rows[0]?.title.split('\n')).toEqual([
      "缺少 document 'proposal'；执行 tenon document record <change> proposal <path>",
      "缺少 document 'openspec-design'；执行 tenon document record <change> openspec-design <path>",
      "缺少 document 'tasks'；执行 tenon document record <change> tasks <path>",
    ])
  })

  it('合并行落在该类第一条的位置，其余保持原顺序；不同模板（缺少 / 需重新登记）不混', () => {
    const stale = stepExit('document', 'document-evidence', "document 'design' 已缺失或内容变化；重新执行 tenon document record 后再继续", { subject: 'design', state: 'stale' })
    const rows = merged([doc('a'), stepExit('tasks', 'tasks-incomplete', 'tasks.md 仍有 2 项未勾', { items: ['x', 'y'], count: 2 }), doc('b'), stale])
    expect(rows.map((row) => row.label)).toEqual(['缺少文档 a · b', 'tasks.md 未勾 2 项', '文档 design 需重新登记'])
  })

  it('单条不改样；认不出的 code 保持完整文案，也不参与合并', () => {
    const rows = merged([doc('proposal'), stepExit('guard', 'phase-exit', 'pr_url 未设置'), stepExit('guard', 'phase-exit', 'pr_url 未设置')])
    expect(rows.map((row) => row.label)).toEqual(['缺少文档 proposal', 'pr_url 未设置', 'pr_url 未设置'])
    expect(rows[0]?.title).toContain("缺少 document 'proposal'")
  })

  it('英文同样合并', () => {
    const rows = mergeBlockerRows([doc('proposal'), doc('tasks')].flatMap(blockerLines), (key, vars = {}) => translate('en', key, vars))
    expect(rows.map((row) => row.label)).toEqual(['Missing document proposal · tasks'])
  })

  it('技能 / 测试这类带名字的也合并；tasks 计数（n 不是名字）不合并', () => {
    const skill = (name: string): TransitionReadinessBlockerSnapshot => stepExit('skill', 'skill-incomplete', `尚未完成声明的 skill：${name}`, { subject: name, state: 'not-run' })
    expect(merged([skill('tdd'), skill('grill')]).map((row) => row.label)).toEqual(['技能 tdd · grill 未运行'])
    const tasks = stepExit('tasks', 'tasks-incomplete', 'm', { items: ['a'], count: 1 })
    expect(merged([tasks, tasks]).map((row) => row.label)).toEqual(['tasks.md 未勾 1 项', 'tasks.md 未勾 1 项'])
  })
})
