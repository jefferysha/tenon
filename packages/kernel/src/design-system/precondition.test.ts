import { describe, expect, test } from 'vitest'
import { ProjectDocumentPreconditionError, assertCreationPreconditions, type ProjectDocumentKindSpec } from './precondition.js'
import type { DocumentGovernancePolicy } from '../workflow/document-contract-model.js'
import type { DesignSystemCheck } from './check.js'

const policy = (requires: Record<string, readonly ('design-md')[]>): DocumentGovernancePolicy => ({
  id: 'document-v1',
  steps: ['open', 'build'],
  outputsByStep: {},
  mutableByStep: {},
  readsByStep: {},
  requiresByStep: requires,
})

const spec = (check: DesignSystemCheck): ProjectDocumentKindSpec => ({
  kind: 'design-md',
  paths: ['DESIGN.md', 'design/design-model.yaml'],
  readiness: () => check,
  hint: '先完成设计体系任务：tenon init <name> --workflow design-system --track free --preset <preset>',
})

const input = { workflow: 'default', track: 'frontend', firstStep: 'open', repoRoot: '/repo' }

describe('assertCreationPreconditions', () => {
  test('第一个步骤 require + 文档缺失 → 抛出，带状态与提示', () => {
    const missing = spec({ status: 'missing', problems: ['缺少 DESIGN.md'] })
    try {
      assertCreationPreconditions({ ...input, policy: policy({ open: ['design-md'] }) }, [missing])
      throw new Error('expected a refusal')
    } catch (error) {
      expect(error).toBeInstanceOf(ProjectDocumentPreconditionError)
      const refusal = error as ProjectDocumentPreconditionError
      expect(refusal.status).toBe('missing')
      expect(refusal.kind).toBe('design-md')
      expect(refusal.message).toContain('工作流 default 轨道 frontend 要求项目 DESIGN.md 就绪（当前：缺失）')
      expect(refusal.message).toContain('tenon init <name> --workflow design-system')
      expect(refusal.message).toContain('- 缺少 DESIGN.md')
    }
  })

  test('起步与不完整都拦，最多列五条问题', () => {
    const problems = ['一', '二', '三', '四', '五', '六']
    try {
      assertCreationPreconditions(
        { ...input, policy: policy({ open: ['design-md'] }) },
        [spec({ status: 'incomplete', problems })],
      )
      throw new Error('expected a refusal')
    } catch (error) {
      const message = (error as Error).message
      expect(message).toContain('当前：不完整')
      expect(message).toContain('- 五')
      expect(message).not.toContain('- 六')
    }
  })

  test('就绪 → 不抛', () => {
    expect(() => assertCreationPreconditions(
      { ...input, policy: policy({ open: ['design-md'] }) },
      [spec({ status: 'ready', problems: [] })],
    )).not.toThrow()
  })

  test('require 在后面的步骤，或没有 require 槽位 → 立项不拦', () => {
    const missing = spec({ status: 'missing', problems: ['缺少 DESIGN.md'] })
    expect(() => assertCreationPreconditions({ ...input, policy: policy({ build: ['design-md'] }) }, [missing])).not.toThrow()
    expect(() => assertCreationPreconditions({ ...input, policy: policy({}) }, [missing])).not.toThrow()
    expect(() => assertCreationPreconditions({ ...input }, [missing])).not.toThrow()
  })
})
