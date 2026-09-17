import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { compileWorkflow } from '../workflow/compile.js'
import type { WorkflowDef } from '../workflow/types.js'
import {
  AgentFreezeError, FROZEN_AGENTS_DIR, FROZEN_DIR, FROZEN_LOCK_FILE,
  agentsReferenced, ensureAgentFreeze, frozenAgentFiles, readFrozenAgents,
} from './agent-freeze.js'

const agent = (name: string, description = `${name} 说明`): string =>
  ['---', `name: ${name}`, `description: ${description}`, 'tools: [Read]', '---', '', '正文', ''].join('\n')

const definition = (agents: unknown): WorkflowDef => ({
  name: 'flow',
  steps: [{
    id: 'build', label: '实现', gate: null, skills: [], inputs: [], outputs: [], guards: [],
    transitions: [{ event: 'done', to: 'build' }],
    ...(agents === undefined ? {} : { agents }),
  }] as WorkflowDef['steps'],
})

const workflow = (agents: unknown) => compileWorkflow(definition(agents))

const library = new Map<string, string>()
const resolve = (name: string): { source: 'custom'; content: string } => {
  const content = library.get(name)
  if (content === undefined) throw new Error(`missing ${name}`)
  return { source: 'custom', content }
}

let changeDir: string

beforeEach(async () => {
  changeDir = await mkdtemp(join(tmpdir(), 'tenon-agent-freeze-'))
  library.clear()
  library.set('security', agent('security'))
  library.set('e2e', agent('e2e'))
})

afterEach(async () => {
  await rm(changeDir, { recursive: true, force: true })
})

const FINGERPRINT = 'a'.repeat(64)
const freeze = (agents: unknown, runId = 'run-1'): Promise<unknown> => ensureAgentFreeze({
  changeDir, runId, workflowFingerprint: FINGERPRINT, workflow: workflow(agents), resolve,
})

describe('agentsReferenced', () => {
  it('去重排序两个身份列表', () => {
    expect(agentsReferenced(workflow({
      executors: [{ agent: 'e2e' }],
      reviewers: [{ agent: 'security', required: true, block_at: 'high' }],
    }))).toEqual(['e2e', 'security'])
    expect(agentsReferenced(workflow(undefined))).toEqual([])
  })
})

describe('ensureAgentFreeze', () => {
  it('写文件与锁，同 run 幂等', async () => {
    const lock = await freeze({ executors: [], reviewers: [{ agent: 'security', required: true, block_at: 'high' }] })
    expect(lock).toMatchObject({ version: 1, run_id: 'run-1', workflow_fingerprint: FINGERPRINT })
    expect(await frozenAgentFiles(changeDir)).toEqual(['security.md'])
    const raw = await readFile(join(changeDir, FROZEN_DIR, FROZEN_LOCK_FILE), 'utf8')
    await freeze({ executors: [], reviewers: [{ agent: 'security', required: true, block_at: 'high' }] })
    expect(await readFile(join(changeDir, FROZEN_DIR, FROZEN_LOCK_FILE), 'utf8')).toBe(raw)
  })

  it('没有 agent 的工作流不落任何东西', async () => {
    expect(await freeze(undefined)).toBeUndefined()
    expect(await frozenAgentFiles(changeDir)).toEqual([])
  })

  it('换 run id 整份重写（创建失败重试）', async () => {
    await freeze({ executors: [{ agent: 'e2e' }], reviewers: [] })
    await freeze({ executors: [], reviewers: [{ agent: 'security', required: true, block_at: 'high' }] }, 'run-2')
    expect(await frozenAgentFiles(changeDir)).toEqual(['security.md'])
  })
})

describe('readFrozenAgents', () => {
  const read = (runId = 'run-1', fingerprint = FINGERPRINT): Promise<unknown> =>
    readFrozenAgents({ changeDir, runId, workflowFingerprint: fingerprint })

  it('核对摘要后返回定义', async () => {
    await freeze({ executors: [], reviewers: [{ agent: 'security', required: true, block_at: 'high' }] })
    const frozen = await readFrozenAgents({ changeDir, runId: 'run-1', workflowFingerprint: FINGERPRINT })
    expect(frozen.get('security')?.definition.description).toBe('security 说明')
    expect(frozen.get('security')?.source).toBe('custom')
  })

  it('锁缺失 → freeze-missing', async () => {
    await expect(read()).rejects.toThrowError(AgentFreezeError)
    await expect(read()).rejects.toMatchObject({ code: 'freeze-missing' })
  })

  it('绑定到别的 run 或指纹 → freeze-binding', async () => {
    await freeze({ executors: [], reviewers: [{ agent: 'security', required: true, block_at: 'high' }] })
    await expect(read('run-9')).rejects.toMatchObject({ code: 'freeze-binding' })
    await expect(read('run-1', 'b'.repeat(64))).rejects.toMatchObject({ code: 'freeze-binding' })
  })

  it('内容被改动 / 文件缺失 / 锁损坏 → freeze-corrupt', async () => {
    await freeze({ executors: [], reviewers: [{ agent: 'security', required: true, block_at: 'high' }] })
    const path = join(changeDir, FROZEN_DIR, FROZEN_AGENTS_DIR, 'security.md')
    await writeFile(path, agent('security', '被改过'))
    await expect(read()).rejects.toMatchObject({ code: 'freeze-corrupt' })
    await rm(path)
    await expect(read()).rejects.toMatchObject({ code: 'freeze-corrupt' })
    await writeFile(join(changeDir, FROZEN_DIR, FROZEN_LOCK_FILE), '{')
    await expect(read()).rejects.toMatchObject({ code: 'freeze-corrupt' })
  })

  it('冻结之后改库不改变读出来的内容', async () => {
    await freeze({ executors: [], reviewers: [{ agent: 'security', required: true, block_at: 'high' }] })
    library.set('security', agent('security', '库里改过了'))
    const frozen = await readFrozenAgents({ changeDir, runId: 'run-1', workflowFingerprint: FINGERPRINT })
    expect(frozen.get('security')?.definition.description).toBe('security 说明')
  })

})
