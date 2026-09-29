/**
 * 真实 e2e —— Dashboard 触发的完结（archived）回收宿主 agent 文件：与 CLI 同一份 kernel 判定。
 * 直接调用 performTransition（server 真实使用的同一个函数），全部在临时项目里。
 */
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, test, vi } from 'vitest'
import {
  createHistoryWriter, createTransitionRecordStore, createWorkflowRunRepository, ensureHostAgentFiles,
} from '@tenon/kernel'
import type { AgentDefinition } from '@tenon/kernel'
import { performTransition, type TransitionDeps } from './transition.js'
import { initChange, makeProject, newStore, testFlow } from './test-support.js'

const WF = `name: finish
steps:
  - id: one
    label: One
    gate: null
    skills: []
    inputs: []
    outputs: []
    guards: []
    transitions:
      - event: one-complete
        to: done
  - id: done
    label: Done
    gate: null
    skills: []
    inputs: []
    outputs: []
    guards: []
    transitions: []
`

const definition = (name: string): AgentDefinition => ({
  name, description: `${name} 说明`, role: 'reviewer', skills: [], tools: ['Read', 'Grep'], body: '\n正文\n',
})

async function freezeLock(root: string, change: string, agents: readonly string[]): Promise<void> {
  const dir = join(root, 'openspec', 'changes', change, '.pipeline-frozen')
  await mkdir(dir, { recursive: true })
  const entries = agents.map((name) => ({ name, source: 'builtin', digest: 'sha256:x' }))
  await writeFile(join(dir, 'lock.json'), `${JSON.stringify({ version: 1, run_id: 'r', workflow_fingerprint: 'f', agents: entries })}\n`, 'utf8')
}

describe('真实 e2e —— Dashboard 完结任务后回收宿主 agent 文件', () => {
  async function setup(): Promise<{ deps: TransitionDeps; root: string }> {
    const store = newStore()
    const root = await makeProject()
    await mkdir(join(root, '.pipeline', 'workflows'), { recursive: true })
    await writeFile(join(root, '.pipeline', 'workflows', 'finish.yaml'), WF, 'utf8')
    await initChange(store, root, 'demo', {
      track: 'simple',
      initialWorkflow: { workflow: 'finish', phase: 'one', openspecContract: false },
    })
    await ensureHostAgentFiles({
      repoRoot: root, host: 'claude', agents: ['builder', 'code-size'].map((name) => ({ name, definition: definition(name) })),
    })
    const deps: TransitionDeps = {
      store,
      runRepo: createWorkflowRunRepository({ store, recordStore: createTransitionRecordStore(), clock: () => '2026-07-16T00:00:00Z' }),
      flow: testFlow(),
      clock: () => '2026-07-16T00:00:00Z',
      history: createHistoryWriter(),
    }
    return { deps, root }
  }

  test('完结后删掉没有在途任务引用的 tenon- 文件；另一个在途任务还用的保留', async () => {
    const { deps, root } = await setup()
    await freezeLock(root, 'other', ['code-size'])
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    try {
      expect((await performTransition(deps, root, 'demo', 'one-complete')).code).toBe(200)
      // 还没完结：什么都不回收。
      expect(existsSync(join(root, '.claude', 'agents', 'tenon-builder.md'))).toBe(true)
      expect((await performTransition(deps, root, 'demo', 'archived')).code).toBe(200)
      expect(stderr.mock.calls.map((call) => String(call[0])).join('')).toContain('已回收宿主 agent 文件')
    } finally {
      stderr.mockRestore()
    }
    expect(existsSync(join(root, '.claude', 'agents', 'tenon-builder.md'))).toBe(false)
    expect(existsSync(join(root, '.claude', 'agents', 'tenon-code-size.md'))).toBe(true)
  })

  test('在途任务的冻结锁读不懂 → 回收放弃、文件保留，完结本身照样成功', async () => {
    const { deps, root } = await setup()
    const broken = join(root, 'openspec', 'changes', 'broken', '.pipeline-frozen')
    await mkdir(broken, { recursive: true })
    await writeFile(join(broken, 'lock.json'), '不是 JSON', 'utf8')
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    try {
      expect((await performTransition(deps, root, 'demo', 'one-complete')).code).toBe(200)
      expect((await performTransition(deps, root, 'demo', 'archived')).code).toBe(200)
      expect(stderr.mock.calls.map((call) => String(call[0])).join('')).toContain('回收失败')
    } finally {
      stderr.mockRestore()
    }
    expect(existsSync(join(root, '.claude', 'agents', 'tenon-builder.md'))).toBe(true)
  })
})
