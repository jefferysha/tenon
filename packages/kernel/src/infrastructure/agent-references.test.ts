import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { agentWorkflowReferences } from './agent-references.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function workflow(name: string, agent: string, stepId = 'build'): string {
  return `name: ${name}
steps:
  - id: ${stepId}
    label: 实现
    gate: null
    skills: []
    inputs: []
    outputs: []
    agents:
      reviewers:
        - agent: ${agent}
          required: true
          block_at: high
    guards: []
    transitions: []
`
}

function seed(root: string, name: string, text: string): void {
  const dir = join(root, '.pipeline', 'workflows')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${name}.yaml`), text, 'utf8')
}

function dirs(): { configRoot: string; project: string } {
  const configRoot = mkdtempSync(join(tmpdir(), 'tenon-refs-config-'))
  const project = mkdtempSync(join(tmpdir(), 'tenon-refs-project-'))
  roots.push(configRoot, project)
  return { configRoot, project }
}

describe('agentWorkflowReferences', () => {
  it('给出项目根时扫项目库 <项目>/.pipeline/workflows（真机验收 F1）；不给则看不到', () => {
    const { configRoot, project } = dirs()
    seed(project, 'team-flow', workflow('team-flow', 'mine'))
    expect(agentWorkflowReferences({ configRoot }, 'mine')).toEqual([])
    expect(agentWorkflowReferences({ configRoot, projectRoot: project }, 'mine')).toEqual([
      { workflow: 'team-flow', track: null, step: 'build', label: '实现', role: 'reviewer' },
    ])
  })

  it('项目里覆盖同名工作流时，全局那份仍被别的项目使用：两处引用都列出，相同位置只列一次', () => {
    const { configRoot, project } = dirs()
    seed(join(configRoot, 'workflows'), 'shared', workflow('shared', 'mine', 'check'))
    seed(project, 'shared', workflow('shared', 'mine', 'build'))
    const found = agentWorkflowReferences({ configRoot, projectRoot: project }, 'mine')
    expect(found.map((item) => `${item.workflow}:${item.step}`).sort()).toEqual(['shared:build', 'shared:check'])
    seed(join(configRoot, 'workflows'), 'shared', workflow('shared', 'mine', 'build'))
    expect(agentWorkflowReferences({ configRoot, projectRoot: project }, 'mine')).toHaveLength(1)
  })

  it('项目覆盖了 default：内建 default 不再重复扫描', () => {
    const { configRoot, project } = dirs()
    seed(project, 'simple', workflow('simple', 'other'))
    const found = agentWorkflowReferences({ configRoot, projectRoot: project }, 'security')
    expect(found.some((item) => item.workflow === 'default')).toBe(true)
    expect(found.some((item) => item.workflow === 'simple')).toBe(false)
  })
})
