import { describe, expect, it } from 'vitest'
import { hasErrors, knownPlaceholders, slugOf, starterBody, validateTemplateDraft, type TemplateDraft } from './templateDraft'

const draft = (over: Partial<TemplateDraft> = {}): TemplateDraft => ({ title: '团队后端', category: 'backend', frameworks: [], body: '## 后端\n\n- 规则\n', ...over })
const KNOWN = new Set(knownPlaceholders(null))

describe('validateTemplateDraft', () => {
  it('合法草稿没有错误', () => {
    expect(hasErrors(validateTemplateDraft(draft(), { known: KNOWN }))).toBe(false)
  })

  it('名称：空 = 必填（标 required，字段动过才显示）；超过 80 字符', () => {
    expect(validateTemplateDraft(draft({ title: '  ' }), { known: KNOWN }).title).toEqual({ key: 'required', required: true })
    expect(validateTemplateDraft(draft({ title: 'x'.repeat(81) }), { known: KNOWN }).title).toEqual({ key: 'title_too_long' })
  })

  it('标识只在新建时校验：必填、格式、同分类重名', () => {
    expect(validateTemplateDraft(draft(), { known: KNOWN }).id).toBeUndefined()
    expect(validateTemplateDraft(draft(), { known: KNOWN, id: '' }).id).toEqual({ key: 'required', required: true })
    expect(validateTemplateDraft(draft(), { known: KNOWN, id: 'Team_Go' }).id).toEqual({ key: 'id_invalid' })
    expect(validateTemplateDraft(draft(), { known: KNOWN, id: 'mine', takenIds: new Set(['mine']) }).id).toEqual({ key: 'id_duplicate' })
    expect(validateTemplateDraft(draft(), { known: KNOWN, id: 'team-go', takenIds: new Set(['mine']) }).id).toBeUndefined()
  })

  it('状态管理 / 样式必须选框架；前端可以不选', () => {
    expect(validateTemplateDraft(draft({ category: 'state', body: '### 状态\n' }), { known: KNOWN }).frameworks).toEqual({ key: 'frameworks_required' })
    expect(validateTemplateDraft(draft({ category: 'styling', frameworks: ['react'], body: '### 样式\n' }), { known: KNOWN }).frameworks).toBeUndefined()
    expect(validateTemplateDraft(draft({ category: 'frontend' }), { known: KNOWN }).frameworks).toBeUndefined()
  })

  it('正文：空 = 必填；首行须是 ##/### 标题；围栏外不能有一级标题', () => {
    expect(validateTemplateDraft(draft({ body: '\n  \n' }), { known: KNOWN }).body).toEqual({ key: 'required', required: true })
    expect(validateTemplateDraft(draft({ category: 'state', frameworks: ['react'], body: '规则\n' }), { known: KNOWN }).body)
      .toEqual({ key: 'body_heading', vars: { level: '###' } })
    expect(validateTemplateDraft(draft({ body: '## 后端\n# 顶级\n' }), { known: KNOWN }).body).toEqual({ key: 'body_h1' })
    expect(validateTemplateDraft(draft({ body: '## 后端\n```\n# 注释\n```\n' }), { known: KNOWN }).body).toBeUndefined()
  })

  it('占位符：未知名称报错（带原文），转义 \\{{ 不查；known = null 时整项不查', () => {
    expect(validateTemplateDraft(draft({ body: '## 后端\n{{project.name}} {{nope}}\n' }), { known: KNOWN }).body)
      .toEqual({ key: 'body_placeholder', vars: { name: '{{nope}}' } })
    expect(validateTemplateDraft(draft({ body: '## 后端\n\\{{nope}}\n' }), { known: KNOWN }).body).toBeUndefined()
    expect(validateTemplateDraft(draft({ body: '## 后端\n{{nope}}\n' }), { known: null }).body).toBeUndefined()
  })
})

describe('辅助', () => {
  it('knownPlaceholders：项目名、目录表、变量、声明的资源分类与 catalog.ref', () => {
    expect(knownPlaceholders({
      title: 'x', frameworks: [], directory: null, directory_label: null, catalog: ['icons'], catalog_ref: 'lucide',
      variables: [{ key: 'component.soft', default: '200' }],
    })).toEqual(['project.name', 'directories', 'component.soft', 'catalog.icons', 'catalog.ref'])
  })

  it('slugOf：ASCII 连成小写 - 串；全中文为空', () => {
    expect(slugOf('Team Go (v2)')).toBe('team-go-v2')
    expect(slugOf('团队后端')).toBe('')
    expect(slugOf(`${'a'.repeat(70)}`)).toHaveLength(64)
  })

  it('starterBody：分类级别标题 + 空列表项', () => {
    expect(starterBody('backend', '后端')).toBe('## 后端\n\n- \n')
    expect(starterBody('styling', '样式')).toBe('### 样式\n\n- \n')
  })
})
