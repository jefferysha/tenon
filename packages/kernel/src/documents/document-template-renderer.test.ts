import { describe, expect, test } from 'vitest'
import {
  DEFAULT_DOCUMENT_LOCALE,
  DOCUMENT_WORKFLOW_STEP_LABELS,
  DOCUMENT_TEMPLATE_IDS,
  documentPathForKind,
  documentTemplateIdForKind,
  renderDocumentTemplate,
  validateDocumentPresentationRegistry,
} from './document-template-renderer.js'

describe('Document Presentation Registry', () => {
  test('项目文档 design-md 的路径是仓库根 DESIGN.md', () => {
    expect(documentPathForKind('design-md', { change: 'demo' })).toBe('DESIGN.md')
    expect(documentTemplateIdForKind('design-md')).toBe('design-md')
  })

  test('默认 locale 是中文，且中文与英文模板结构完全等价', () => {
    expect(DEFAULT_DOCUMENT_LOCALE).toBe('zh-CN')
    expect(() => validateDocumentPresentationRegistry()).not.toThrow()
  })

  test('中文 proposal 保留稳定文件语义并产生确定输出', () => {
    const first = renderDocumentTemplate('openspec-proposal', 'zh-CN', {
      change: 'demo-change',
    })
    const second = renderDocumentTemplate('openspec-proposal', 'zh-CN', {
      change: 'demo-change',
    })
    expect(first).toBe(second)
    expect(first).toContain('# 提案')
    expect(first).toContain('## Why')
    expect(first).toContain('## What Changes')
    expect(first).toContain('## Capabilities')
    expect(first).toContain('### New Capabilities')
    expect(first).toContain('### Modified Capabilities')
    expect(first).toContain('## Impact')
    expect(first).not.toContain('## 目标')
    expect(first).toContain('[待填写:open]')
    expect(first.endsWith('\n')).toBe(true)
  })

  test('英文模板可显式选择，未知 locale fail-loud', () => {
    expect(renderDocumentTemplate('openspec-proposal', 'en', { change: 'demo' }))
      .toContain('# Proposal')
    expect(() => renderDocumentTemplate(
      'openspec-proposal',
      'fr' as 'en',
      { change: 'demo' },
    )).toThrow(/locale/i)
  })

  test('document kind 的模板与路径都由 Registry 投影，delta capability 必须显式提供', () => {
    expect(documentTemplateIdForKind('proposal')).toBe('openspec-proposal')
    expect(documentPathForKind('proposal', { change: 'demo' }))
      .toBe('openspec/changes/demo/proposal.md')
    expect(documentPathForKind('delta-spec', { change: 'demo', capability: 'routing' }))
      .toBe('openspec/changes/demo/specs/routing/spec.md')
    expect(() => documentPathForKind('delta-spec', { change: 'demo' })).toThrow(/capability/)
  })

  test('十类模板均完整本地化，不产生另一语言的占位文案', () => {
    for (const templateId of DOCUMENT_TEMPLATE_IDS) {
      const chinese = renderDocumentTemplate(templateId, 'zh-CN', { change: 'demo' })
      const english = renderDocumentTemplate(templateId, 'en', { change: 'demo' })
      expect(chinese, templateId).not.toContain('> [pending]')
      expect(english, templateId).not.toMatch(/[\u4e00-\u9fff]/u)
    }
  })

  test('tasks 使用调用方传入的真实 workflow label，不硬编码 custom 阶段', () => {
    const output = renderDocumentTemplate('workflow-tasks', 'zh-CN', {
      change: 'custom',
      workflowSteps: [
        { id: 'draft', label: '起草' },
        { id: 'approve', label: '批准' },
      ],
    })
    expect(output).toContain('## 起草')
    expect(output).toContain('## 批准')
    expect(output).not.toContain('## 立项')
  })

  test('英文 default tasks 将内建阶段 label 本地化，custom label 保持调用方定义', () => {
    expect(DOCUMENT_WORKFLOW_STEP_LABELS['zh-CN']).toMatchObject({
      open: '立项',
      explore: '调研',
      build: '实现',
    })
    expect(DOCUMENT_WORKFLOW_STEP_LABELS.en).toMatchObject({
      open: 'Open',
      explore: 'Explore',
      build: 'Build',
    })
    const output = renderDocumentTemplate('workflow-tasks', 'en', {
      change: 'english-default',
      workflowStepLabelSource: 'localized-builtin',
      workflowSteps: [
        { id: 'open', label: '立项' },
        { id: 'explore', label: '调研' },
        { id: 'custom-review', label: 'Editorial review' },
      ],
    })
    expect(output).toContain('## Open')
    expect(output).toContain('## Explore')
    expect(output).toContain('## Editorial review')
    expect(output).not.toContain('## 立项')
    expect(output).not.toContain('## 调研')
  })

  test('custom workflow 即使复用内建 step id，也逐字保留显式 label', () => {
    const chinese = renderDocumentTemplate('workflow-tasks', 'zh-CN', {
      change: 'custom-labels',
      workflowStepLabelSource: 'workflow-defined',
      workflowSteps: [
        { id: 'open', label: '收集素材' },
        { id: 'build', label: '编辑成稿' },
      ],
    })
    const english = renderDocumentTemplate('workflow-tasks', 'en', {
      change: 'custom-labels',
      workflowStepLabelSource: 'workflow-defined',
      workflowSteps: [
        { id: 'open', label: 'Collect sources' },
        { id: 'build', label: 'Edit manuscript' },
      ],
    })
    expect(chinese).toContain('## 收集素材')
    expect(chinese).toContain('## 编辑成稿')
    expect(chinese).not.toContain('## 立项')
    expect(english).toContain('## Collect sources')
    expect(english).toContain('## Edit manuscript')
    expect(english).not.toContain('## Open')
  })
})
