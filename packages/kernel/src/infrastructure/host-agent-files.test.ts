import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { renderHostAgent } from '../agents/host-native.js'
import type { AgentDefinition } from '../agents/types.js'
import { computeContentHash, parseOwnedManifest } from '../state/ownership-manifest.js'
import { ensureHostAgentFiles, ownedHostAgentNames, pruneHostAgentFiles } from './host-agent-files.js'

const definition = (name: string, description = `${name} 说明`): AgentDefinition => ({
  name, description, role: 'reviewer', skills: [], tools: ['Read', 'Grep'], model: 'sonnet', body: '\n正文\n',
})

let repo: string
const manifest = (): Record<string, string> => parseOwnedManifest(readFileSync(join(repo, '.pipeline-owned.json'), 'utf8'))
const read = (rel: string): string => readFileSync(join(repo, rel), 'utf8')

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'tenon-host-agents-'))
})

afterEach(() => {
  rmSync(repo, { recursive: true, force: true })
})

describe('ensureHostAgentFiles', () => {
  test('Claude：写文件并记所有权；再跑一遍不变', async () => {
    const first = await ensureHostAgentFiles({ repoRoot: repo, host: 'claude', agents: [{ name: 'a', definition: definition('a') }] })
    expect(first).toEqual([{
      agent: 'a', host: 'claude', path: '.claude/agents/tenon-a.md', subagentType: 'tenon-a', native: true, state: 'written',
    }])
    expect(read('.claude/agents/tenon-a.md')).toBe(renderHostAgent('claude', definition('a')))
    expect(manifest()).toEqual({ '.claude/agents/tenon-a.md': computeContentHash(read('.claude/agents/tenon-a.md')) })
    const second = await ensureHostAgentFiles({ repoRoot: repo, host: 'claude', agents: [{ name: 'a', definition: definition('a') }] })
    expect(second[0]?.state).toBe('unchanged')
  })

  test('Codex：写到 .codex/agents，保留清单里已有的其它条目', async () => {
    writeFileSync(join(repo, '.pipeline-owned.json'), '{\n  "AGENTS.md": "abc"\n}\n')
    await ensureHostAgentFiles({ repoRoot: repo, host: 'codex', agents: [{ name: 'a', definition: definition('a') }] })
    expect(read('.codex/agents/tenon-a.toml')).toContain('name = "tenon-a"')
    expect(Object.keys(manifest()).sort()).toEqual(['.codex/agents/tenon-a.toml', 'AGENTS.md'])
  })

  test('定义变了、文件没被改过 → 按新内容覆盖', async () => {
    await ensureHostAgentFiles({ repoRoot: repo, host: 'claude', agents: [{ name: 'a', definition: definition('a') }] })
    const next = await ensureHostAgentFiles({ repoRoot: repo, host: 'claude', agents: [{ name: 'a', definition: definition('a', '新说明') }] })
    expect(next[0]?.state).toBe('written')
    expect(read('.claude/agents/tenon-a.md')).toContain('新说明')
  })

  test('同名文件不归 Tenon 或被用户改过 → 不碰，退回通用子代理并写明原因', async () => {
    mkdirSync(join(repo, '.claude', 'agents'), { recursive: true })
    writeFileSync(join(repo, '.claude', 'agents', 'tenon-a.md'), '用户自己的\n')
    const foreign = await ensureHostAgentFiles({ repoRoot: repo, host: 'claude', agents: [{ name: 'a', definition: definition('a') }] })
    expect(foreign[0]).toMatchObject({ native: false, state: 'foreign', subagentType: 'general-purpose' })
    expect(read('.claude/agents/tenon-a.md')).toBe('用户自己的\n')

    await ensureHostAgentFiles({ repoRoot: repo, host: 'claude', agents: [{ name: 'b', definition: definition('b') }] })
    writeFileSync(join(repo, '.claude', 'agents', 'tenon-b.md'), '改过\n')
    const modified = await ensureHostAgentFiles({ repoRoot: repo, host: 'claude', agents: [{ name: 'b', definition: definition('b') }] })
    expect(modified[0]).toMatchObject({ native: false, state: 'modified' })
    expect(read('.claude/agents/tenon-b.md')).toBe('改过\n')
  })

  test('路径里有符号链接 → 拒绝写入', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'tenon-host-agents-outside-'))
    try {
      symlinkSync(outside, join(repo, '.claude'))
      const result = await ensureHostAgentFiles({ repoRoot: repo, host: 'claude', agents: [{ name: 'a', definition: definition('a') }] })
      expect(result[0]).toMatchObject({ native: false, state: 'failed' })
      expect(existsSync(join(outside, 'agents'))).toBe(false)
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })
})

describe('pruneHostAgentFiles', () => {
  test('只删不再被引用且没改过的；改过的保留；清单删空即删除清单', async () => {
    await ensureHostAgentFiles({
      repoRoot: repo,
      host: 'claude',
      agents: [{ name: 'a', definition: definition('a') }, { name: 'b', definition: definition('b') }, { name: 'c', definition: definition('c') }],
    })
    writeFileSync(join(repo, '.claude', 'agents', 'tenon-c.md'), '改过\n')
    expect(await ownedHostAgentNames(repo)).toEqual(['a', 'b', 'c'])
    const result = await pruneHostAgentFiles({ repoRoot: repo, keep: new Set(['b']) })
    expect(result).toEqual({ removed: ['.claude/agents/tenon-a.md'], preserved: ['.claude/agents/tenon-c.md'] })
    expect(existsSync(join(repo, '.claude', 'agents', 'tenon-a.md'))).toBe(false)
    expect(existsSync(join(repo, '.claude', 'agents', 'tenon-b.md'))).toBe(true)
    expect(read('.claude/agents/tenon-c.md')).toBe('改过\n')

    rmSync(join(repo, '.claude', 'agents', 'tenon-c.md'))
    await pruneHostAgentFiles({ repoRoot: repo, keep: new Set() })
    expect(existsSync(join(repo, '.claude', 'agents'))).toBe(false)
    expect(existsSync(join(repo, '.pipeline-owned.json'))).toBe(false)
  })

  test('清单里别的条目与用户自己的 agent 文件原样不动', async () => {
    writeFileSync(join(repo, '.pipeline-owned.json'), '{\n  "AGENTS.md": "abc"\n}\n')
    mkdirSync(join(repo, '.claude', 'agents'), { recursive: true })
    writeFileSync(join(repo, '.claude', 'agents', 'mine.md'), '用户\n')
    await ensureHostAgentFiles({ repoRoot: repo, host: 'codex', agents: [{ name: 'a', definition: definition('a') }] })
    await pruneHostAgentFiles({ repoRoot: repo, keep: new Set() })
    expect(manifest()).toEqual({ 'AGENTS.md': 'abc' })
    expect(read('.claude/agents/mine.md')).toBe('用户\n')
    expect(existsSync(join(repo, '.codex', 'agents'))).toBe(false)
  })
})
