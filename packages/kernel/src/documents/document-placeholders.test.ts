import { describe, expect, test } from 'vitest'
import { DOCUMENT_LOCALES, DOCUMENT_TEMPLATE_IDS } from './document-presentation-registry.js'
import { findDocumentPlaceholders } from './document-placeholders.js'
import { renderDocumentTemplate } from './document-template-renderer.js'

describe('findDocumentPlaceholders —— 模板记号即判定', () => {
  test.each(DOCUMENT_LOCALES.flatMap((locale) => DOCUMENT_TEMPLATE_IDS.map((id) => [locale, id] as const)))(
    // design-md 的骨架只有标题（DESIGN.md 由设计体系技能整份产出），其余模板都带待写记号。
    '%s %s 的骨架：带正文提示的模板都能被认出', (locale, id) => {
      const found = findDocumentPlaceholders(renderDocumentTemplate(id, locale, { change: 'demo' }))
      if (id === 'design-md') expect(found).toEqual([])
      else expect(found.length, `${locale} ${id}`).toBeGreaterThan(0)
    })

  test('写成真内容后没有占位符；行号从 1 起', () => {
    expect(findDocumentPlaceholders('# 提案\n\n## Why\n\n登录要支持邮箱。\n- [x] 实现登录\n')).toEqual([])
    expect(findDocumentPlaceholders('# 提案\n> [待填写:open] 写原因\n')).toEqual([{ line: 2, text: '> [待填写:open] 写原因' }])
    expect(findDocumentPlaceholders('### Requirement: Pending\n- **WHEN** Pending\n')).toHaveLength(2)
  })

  test('tasks.md 的阶段提示任务勾上也仍是提示词；真任务不算', () => {
    expect(findDocumentPlaceholders('## 实现\n\n- [x] 将本阶段目标拆成可验证任务。 (build)\n')).toHaveLength(1)
    expect(findDocumentPlaceholders('- [ ] Break this phase goal into verifiable tasks.\n')).toHaveLength(1)
    expect(findDocumentPlaceholders('- [ ] 实现登录接口\n- [x] 写单测\n')).toEqual([])
  })
})
