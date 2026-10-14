/**
 * 真实 e2e —— Dashboard 触发的完结（archived）清理升级前的版本留在项目里的宿主 agent 文件：与 CLI 同一份 kernel 清理，
 * 两条判据都认——所有权清单记着且没改过，或内容与当前库对应 agent 的渲染结果一致；库读不到时退回只按清单删并 WARN。
 * 直接调用 performTransition（server 真实使用的同一个函数），全部在临时项目里。
 */
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { describe, expect, test, vi } from 'vitest'
import {
  createHistoryWriter, createTransitionRecordStore, createWorkflowRunRepository, hostAgentPath, renderHostAgent,
  type AgentDefinition, type AgentLibrary,
} from '@tenon/kernel'
import { performTransition, type TransitionDeps } from './transition.js'
import { initChange, makeProject, newStore, testFlow, writeLegacyHostAgent } from './test-support.js'

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

async function freezeLock(root: string, change: string, agents: readonly string[]): Promise<void> {
  const dir = join(root, 'openspec', 'changes', change, '.pipeline-frozen')
  await mkdir(dir, { recursive: true })
  const entries = agents.map((name) => ({ name, source: 'builtin', digest: 'sha256:x' }))
  await writeFile(join(dir, 'lock.json'), `${JSON.stringify({ version: 1, run_id: 'r', workflow_fingerprint: 'f', agents: entries })}\n`, 'utf8')
}

describe('真实 e2e —— Dashboard 完结任务后清理旧版本留下的宿主 agent 文件', () => {
  async function setup(): Promise<{ deps: TransitionDeps; root: string }> {
    const store = newStore()
    const root = await makeProject()
    await mkdir(join(root, '.pipeline', 'workflows'), { recursive: true })
    await writeFile(join(root, '.pipeline', 'workflows', 'finish.yaml'), WF, 'utf8')
    await initChange(store, root, 'demo', {
      track: 'simple',
      initialWorkflow: { workflow: 'finish', phase: 'one', openspecContract: false },
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

  /** 跑一段会写 stderr 的转换序列，返回这段时间写到 stderr 的全部文本。 */
  async function captureStderr(run: () => Promise<void>): Promise<string> {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    try {
      await run()
      return stderr.mock.calls.map((call) => String(call[0])).join('')
    } finally {
      stderr.mockRestore()
    }
  }

  test('完结后清单记着且没改过的 tenon- 文件被删除；另一个在途任务引用同一个 agent 也照删', async () => {
    const { deps, root } = await setup()
    const builder = await writeLegacyHostAgent(root, 'builder')
    const reviewer = await writeLegacyHostAgent(root, 'code-size')
    await freezeLock(root, 'other', ['code-size'])
    const log = await captureStderr(async () => {
      expect((await performTransition(deps, root, 'demo', 'one-complete')).code).toBe(200)
      // 还没完结：什么都不清理。
      expect(existsSync(join(root, builder))).toBe(true)
      expect((await performTransition(deps, root, 'demo', 'archived')).code).toBe(200)
    })
    expect(log).toContain('已清理旧版本写进项目的宿主 agent 文件')
    expect(existsSync(join(root, builder))).toBe(false)
    expect(existsSync(join(root, reviewer))).toBe(false)
    expect(existsSync(join(root, '.pipeline-owned.json'))).toBe(false)
  })

  test('被改过的旧文件保留并警告，完结本身照样成功', async () => {
    const { deps, root } = await setup()
    const edited = await writeLegacyHostAgent(root, 'builder', '用户改过\n')
    const log = await captureStderr(async () => {
      expect((await performTransition(deps, root, 'demo', 'one-complete')).code).toBe(200)
      expect((await performTransition(deps, root, 'demo', 'archived')).code).toBe(200)
    })
    expect(log).toMatch(/WARN: .*tenon-builder\.md/u)
    expect(await readFile(join(root, edited), 'utf8')).toBe('用户改过\n')
  })

  test('在途任务的冻结锁读不懂不再拦住清理（清理不读冻结锁）', async () => {
    const { deps, root } = await setup()
    const file = await writeLegacyHostAgent(root, 'builder')
    const broken = join(root, 'openspec', 'changes', 'broken', '.pipeline-frozen')
    await mkdir(broken, { recursive: true })
    await writeFile(join(broken, 'lock.json'), '不是 JSON', 'utf8')
    await captureStderr(async () => {
      expect((await performTransition(deps, root, 'demo', 'one-complete')).code).toBe(200)
      expect((await performTransition(deps, root, 'demo', 'archived')).code).toBe(200)
    })
    expect(existsSync(join(root, file))).toBe(false)
  })

  test('清理本身失败（锁目录建不出来）→ 只警告，完结照样成功，文件原样', async () => {
    const { deps, root } = await setup()
    const file = await writeLegacyHostAgent(root, 'builder')
    await writeFile(join(root, '.tenon'), '我是个文件，不是目录', 'utf8')
    const log = await captureStderr(async () => {
      expect((await performTransition(deps, root, 'demo', 'one-complete')).code).toBe(200)
      expect((await performTransition(deps, root, 'demo', 'archived')).code).toBe(200)
    })
    expect(log).toContain('清理失败')
    expect(existsSync(join(root, file))).toBe(true)
  })

  const LIBRARY_AGENT: AgentDefinition = {
    name: 'builder', description: '库里的 builder', role: 'executor', skills: [], tools: ['Read', 'Edit'], body: '\n库里的正文\n',
  }
  const libraryWith = (definition: AgentDefinition): AgentLibrary => ({
    entries: [{ name: definition.name, source: 'custom', digest: 'sha256:x', content: '', definition }],
    sync: { id: 'agents', state: 'unchanged' },
  })

  /** 写一个旧版本留下的宿主 agent 文件，但清单里没有它（清单丢了这一项）。 */
  async function writeUnlisted(root: string, name: string, text: string): Promise<string> {
    const rel = hostAgentPath('claude', name)
    await mkdir(dirname(join(root, rel)), { recursive: true })
    await writeFile(join(root, rel), text, 'utf8')
    return rel
  }

  async function archiveDemo(deps: TransitionDeps, root: string): Promise<string> {
    return captureStderr(async () => {
      expect((await performTransition(deps, root, 'demo', 'one-complete')).code).toBe(200)
      expect((await performTransition(deps, root, 'demo', 'archived')).code).toBe(200)
    })
  }

  test('清单条目丢失但内容与当前库的渲染结果一致 → Dashboard 完结时被删', async () => {
    const { deps, root } = await setup()
    const rel = await writeUnlisted(root, 'builder', renderHostAgent('claude', LIBRARY_AGENT))
    const log = await archiveDemo({ ...deps, hostAgentLibrary: async () => libraryWith(LIBRARY_AGENT) }, root)
    expect(existsSync(join(root, rel))).toBe(false)
    expect(log).toContain('已清理旧版本写进项目的宿主 agent 文件')
  })

  test('清单条目丢失且内容被改过（与当前库渲染不一致）→ 保留并警告，完结照样成功', async () => {
    const { deps, root } = await setup()
    const rel = await writeUnlisted(root, 'builder', '用户改过\n')
    const log = await archiveDemo({ ...deps, hostAgentLibrary: async () => libraryWith(LIBRARY_AGENT) }, root)
    expect(await readFile(join(root, rel), 'utf8')).toBe('用户改过\n')
    expect(log).toMatch(/WARN: .*tenon-builder\.md/u)
  })

  test('没有装配库读取 → 清单外的文件即使内容一致也保留（只按清单删）', async () => {
    const { deps, root } = await setup()
    const rel = await writeUnlisted(root, 'builder', renderHostAgent('claude', LIBRARY_AGENT))
    await archiveDemo(deps, root)
    expect(existsSync(join(root, rel))).toBe(true)
  })

  test('库读取失败 → WARN 后退回只按清单删：清单里的未改文件照删，清单外的保留，完结照样成功', async () => {
    const { deps, root } = await setup()
    const listed = await writeLegacyHostAgent(root, 'code-size')
    const unlisted = await writeUnlisted(root, 'builder', renderHostAgent('claude', LIBRARY_AGENT))
    const log = await archiveDemo({ ...deps, hostAgentLibrary: async () => { throw new Error('库坏了') } }, root)
    expect(log).toMatch(/WARN: .*库坏了/u)
    expect(existsSync(join(root, listed))).toBe(false)
    expect(existsSync(join(root, unlisted))).toBe(true)
  })
})
