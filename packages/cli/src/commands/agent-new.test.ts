import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { loadAgentLibrary, parseAgentFile } from '@tenon/kernel'
import { makeDeps, type TestDeps } from '../test-support.js'
import type { InitWizardEnv } from './init.js'
import { agentBodySkeleton, cmdAgentNew, renderAgentFile } from './agent-new.js'

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..', '..')

let sandbox: string
let deps: TestDeps

function scripted(answers: readonly string[], interactive = true): InitWizardEnv & { readonly asked: string[] } {
  const asked: string[] = []
  let index = 0
  return {
    asked,
    isInteractive: () => interactive,
    makePrompter: () => ({
      ask: async (prompt: string) => {
        asked.push(prompt)
        return answers[index++] ?? ''
      },
      close: () => {},
    }),
  }
}

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'tenon-agent-new-'))
  deps = makeDeps({ cwd: join(sandbox, 'project') })
  const configRoot = join(sandbox, 'config')
  deps.agentPaths = () => ({ payloadRoot: REPO_ROOT, configRoot })
  deps.agentLibrary = () => loadAgentLibrary({ payloadRoot: REPO_ROOT, configRoot, projectRoot: deps.cwd })
  deps.knownSkillIds = () => new Set(['security-review', 'test-driven-development'])
})

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true })
})

describe('cmdAgentNew 交互补全', () => {
  test('只问缺的必填项；可选项回车收默认；非法名字就地重问', async () => {
    const env = scripted(['Bad Name', 'api-review', 'reviewer', 'API 评审', '', '', ''])
    expect(await cmdAgentNew(deps, undefined, {}, env)).toBe(0)
    expect(env.asked[0]).toContain('名称')
    expect(env.asked[1]).toContain('名称')
    expect(env.asked.some((prompt) => prompt.startsWith('工具（逗号分隔） [Read,Grep,Glob,Bash]'))).toBe(true)
    const text = readFileSync(join(sandbox, 'config', 'agents', 'custom', 'api-review.md'), 'utf8')
    const parsed = parseAgentFile(text, 'api-review')
    expect(parsed).toMatchObject({ role: 'reviewer', description: 'API 评审', tools: ['Read', 'Grep', 'Glob', 'Bash'] })
    expect(parsed.roleInferred).toBeUndefined()
  })

  test('参数给全时一问不问', async () => {
    const env = scripted([])
    expect(await cmdAgentNew(deps, 'impl', { role: 'executor', description: '实现', skills: 'test-driven-development' }, env)).toBe(0)
    expect(env.asked).toEqual([])
    const parsed = parseAgentFile(readFileSync(join(sandbox, 'config', 'agents', 'custom', 'impl.md'), 'utf8'), 'impl')
    expect(parsed.tools).toEqual(['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob', 'Skill'])
  })

  test('非交互缺项 exit 1；未知宿主 exit 1', async () => {
    expect(await cmdAgentNew(deps, 'x', { role: 'reviewer' }, scripted([], false))).toBe(1)
    expect(deps.errLines.join('\n')).toContain('--description')
    expect(await cmdAgentNew(deps, 'x', { role: 'reviewer', description: 'd', hosts: 'nope' }, scripted([], false))).toBe(1)
    expect(deps.errLines.join('\n')).toContain('不是已知宿主')
  })

  test('没装配 agent 库 exit 1', async () => {
    delete deps.agentPaths
    expect(await cmdAgentNew(deps, 'x', { role: 'reviewer', description: 'd' }, scripted([], false))).toBe(1)
  })
})

describe('renderAgentFile / agentBodySkeleton', () => {
  test('骨架按身份给出结构与 tenon-result 示例，能被解析器读回', () => {
    for (const role of ['executor', 'reviewer'] as const) {
      const body = agentBodySkeleton('demo', role, '示例')
      for (const heading of ['## 职责', '## 只做与不做', '## 方法', '## 自检', '## 报告']) expect(body).toContain(heading)
      const text = renderAgentFile({ name: 'demo', description: '示例', role, version: '0.1.0', skills: [], tools: ['Read'], body })
      expect(parseAgentFile(text, 'demo')).toMatchObject({ role, version: '0.1.0' })
    }
    expect(agentBodySkeleton('demo', 'executor', '示例')).toContain('"result":"done"')
  })
})
