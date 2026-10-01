import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import type { AgentDefinition } from '../agents/types.js'
import { ensureHostAgentFiles } from './host-agent-files.js'
import { pruneUnusedHostAgentFiles } from './host-agent-prune.js'

const definition = (name: string): AgentDefinition => ({
  name, description: `${name} 说明`, role: 'reviewer', skills: [], tools: ['Read', 'Grep'], body: '\n正文\n',
})

let repo: string
beforeEach(() => { repo = mkdtempSync(join(tmpdir(), 'tenon-host-prune-')) })
afterEach(() => { rmSync(repo, { recursive: true, force: true }) })

const exists = (rel: string): boolean => existsSync(join(repo, rel))

/** 一个任务冻结了这些 agent（只写锁：回收只读锁里的名字）。 */
function freeze(change: string, names: readonly string[], where = join('openspec', 'changes')): string {
  const dir = join(repo, where, change)
  mkdirSync(join(dir, '.pipeline-frozen'), { recursive: true })
  const agents = names.map((name) => ({ name, source: 'builtin', digest: 'sha256:x' }))
  writeFileSync(join(dir, '.pipeline-frozen', 'lock.json'), `${JSON.stringify({ version: 1, run_id: 'r', workflow_fingerprint: 'f', agents })}\n`)
  return dir
}

async function generate(names: readonly string[]): Promise<void> {
  await ensureHostAgentFiles({ repoRoot: repo, host: 'claude', agents: names.map((name) => ({ name, definition: definition(name) })) })
}

describe('pruneUnusedHostAgentFiles', () => {
  test('在途任务还用的名字保留，其余的删；except 与已完结的任务不算在途', async () => {
    await generate(['a', 'b', 'c'])
    freeze('done-one', ['a'])
    freeze('finished', ['b'])
    freeze('live', ['c'])
    const finishedDir = join(repo, 'openspec', 'changes', 'finished')
    const result = await pruneUnusedHostAgentFiles({
      repoRoot: repo, except: 'done-one', isFinished: async (dir) => dir === finishedDir,
    })
    expect(result.removed.sort()).toEqual(['.claude/agents/tenon-a.md', '.claude/agents/tenon-b.md'])
    expect(exists('.claude/agents/tenon-c.md')).toBe(true)
  })

  test('归档目录里的任务不算在途', async () => {
    await generate(['a'])
    freeze('old', ['a'], join('openspec', 'changes', 'archive'))
    const result = await pruneUnusedHostAgentFiles({ repoRoot: repo, isFinished: async () => false })
    expect(result.removed).toEqual(['.claude/agents/tenon-a.md'])
    expect(exists('.pipeline-owned.json')).toBe(false)
  })

  test('没有 Tenon 生成的宿主文件 → 什么都不做，也不读任务', async () => {
    let asked = 0
    const result = await pruneUnusedHostAgentFiles({ repoRoot: repo, isFinished: async () => { asked += 1; return false } })
    expect(result).toEqual({ removed: [], preserved: [] })
    expect(asked).toBe(0)
  })

  test('在途任务的冻结锁读不懂 → 整次放弃，文件原样保留', async () => {
    await generate(['a'])
    const dir = join(repo, 'openspec', 'changes', 'broken', '.pipeline-frozen')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'lock.json'), '不是 JSON')
    await expect(pruneUnusedHostAgentFiles({ repoRoot: repo, isFinished: async () => false })).rejects.toThrow()
    expect(exists('.claude/agents/tenon-a.md')).toBe(true)
  })

  test('回收后 agents 目录和 Tenon 自己建出来的空 .claude/.codex 一起消失；用户的其他文件让父目录留下（真机验收 F14）', async () => {
    await ensureHostAgentFiles({ repoRoot: repo, host: 'codex', agents: [{ name: 'x', definition: definition('x') }] })
    await generate(['a'])
    await pruneUnusedHostAgentFiles({ repoRoot: repo, isFinished: async () => false })
    expect(exists('.claude')).toBe(false)
    expect(exists('.codex')).toBe(false)
    expect(exists('.pipeline-owned.json')).toBe(false)

    await generate(['a'])
    writeFileSync(join(repo, '.claude', 'settings.json'), '{}\n')
    await pruneUnusedHostAgentFiles({ repoRoot: repo, isFinished: async () => false })
    expect(exists('.claude/agents')).toBe(false)
    expect(exists('.claude/settings.json')).toBe(true)
  })

  test('用户改过的文件保留并报出', async () => {
    await generate(['a'])
    writeFileSync(join(repo, '.claude', 'agents', 'tenon-a.md'), '改过\n')
    const result = await pruneUnusedHostAgentFiles({ repoRoot: repo, isFinished: async () => false })
    expect(result).toEqual({ removed: [], preserved: ['.claude/agents/tenon-a.md'] })
    expect(exists('.claude/agents/tenon-a.md')).toBe(true)
  })
})
