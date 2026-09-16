import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { TEMPLATE_WORKFLOW_NAMES, isTemplateWorkflowName } from './identifier.js'
import { templateWorkflowSource } from './template-workflows.js'
import { loadWorkflow } from './loadWorkflow.js'
import { parseWorkflow } from './parse.js'
import { validateWorkflowForStorage } from './validate.js'
import { compileEffectiveWorkflowPlan } from './effective-plan.js'
import { implicitCompletionTransition } from './implicit-completion.js'

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url))
const YAML = readFileSync(join(REPO_ROOT, 'templates', 'workflows', 'design-system.yaml'), 'utf8')

let root: string
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'tenon-template-workflow-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

describe('模板工作流', () => {
  test('名字表与来源一一对应', () => {
    expect([...TEMPLATE_WORKFLOW_NAMES]).toEqual(['default', 'design-system'])
    expect(isTemplateWorkflowName('design-system')).toBe(true)
    expect(isTemplateWorkflowName('mine')).toBe(false)
    expect(templateWorkflowSource('mine')).toBeUndefined()
    expect(templateWorkflowSource('design-system')).toBe(YAML)
  })

  test('design-system 通过存储校验：三步、门禁 review/auto/review', () => {
    const workflow = parseWorkflow(YAML)
    expect(validateWorkflowForStorage('design-system', workflow)).toEqual([])
    expect(workflow.steps.map((step) => [step.id, step.gate])).toEqual([
      ['direction', 'review'], ['generate', 'auto'], ['review', 'review'],
    ])
    expect(workflow.steps.every((step) => (step.prompt ?? '') !== '')).toBe(true)
  })

  test('预览步骤经隐式完结边收尾', () => {
    const plan = compileEffectiveWorkflowPlan('design-system', parseWorkflow(YAML), 'free')
    expect(implicitCompletionTransition(plan, 'review')?.actions).toEqual([{ type: 'archive-run' }])
    expect(implicitCompletionTransition(plan, 'direction')).toBeUndefined()
  })

  test('没有项目文件时 loadWorkflow 回落到模板；项目文件覆盖模板', async () => {
    expect(loadWorkflow(root, 'design-system')?.name).toBe('design-system')
    expect(loadWorkflow(root, 'nothing')).toBeNull()
    await mkdir(join(root, '.pipeline', 'workflows'), { recursive: true })
    await writeFile(
      join(root, '.pipeline', 'workflows', 'design-system.yaml'),
      YAML.replace('label: 方向', 'label: 我的方向'),
      'utf8',
    )
    expect(loadWorkflow(root, 'design-system')?.steps[0]?.label).toBe('我的方向')
  })

  test('生成文件里的源与仓库里的 YAML 逐字节一致', () => {
    expect(templateWorkflowSource('default')).toBe(readFileSync(join(REPO_ROOT, 'templates', 'workflows', 'default.yaml'), 'utf8'))
  })
})
