import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { agentDigest } from '../agents/parse.js'
import {
  AgentStoreError, agentScope, agentStoreRoot, deleteAgent, deleteCustomAgent, effectiveAgent, loadAgentLibrary,
  renameAgentContent, resolveAgent, writeAgent, writeCustomAgent,
} from './agent-store.js'

function agent(name: string, description = `${name} 说明`): string {
  return ['---', `name: ${name}`, `description: ${description}`, 'tools: [Read]', '---', '', '正文', ''].join('\n')
}

let sandbox: string
let payloadRoot: string
let configRoot: string
const options = (): { payloadRoot: string; configRoot: string } => ({ payloadRoot, configRoot })
const storeRoot = (): string => agentStoreRoot(configRoot)

function writePayload(name: string, text = agent(name)): void {
  const path = join(payloadRoot, 'templates', 'agents', `${name}.md`)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}

function writeCustomFile(name: string, text = agent(name)): void {
  const path = join(storeRoot(), 'custom', `${name}.md`)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'tenon-agent-store-'))
  payloadRoot = join(sandbox, 'payload')
  configRoot = join(sandbox, 'config')
  mkdirSync(payloadRoot, { recursive: true })
  mkdirSync(configRoot, { recursive: true })
})

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true })
})

describe('loadAgentLibrary', () => {
  test('同步内建、第二次是 no-op、custom 不被触碰', async () => {
    writePayload('reviewer')
    writeCustomFile('mine')
    const first = await loadAgentLibrary(options())
    expect(first.sync.state).toBe('updated')
    expect(first.entries.map((entry) => `${entry.source}:${entry.name}`)).toEqual(['builtin:reviewer', 'custom:mine'])
    const builtinPath = join(storeRoot(), 'builtin', 'reviewer.md')
    const before = statSync(builtinPath).mtimeMs
    const customBefore = readFileSync(join(storeRoot(), 'custom', 'mine.md'), 'utf8')
    const second = await loadAgentLibrary(options())
    expect(second.sync.state).toBe('unchanged')
    expect(statSync(builtinPath).mtimeMs).toBe(before)
    expect(readFileSync(join(storeRoot(), 'custom', 'mine.md'), 'utf8')).toBe(customBefore)
  })

  test('payload 变化重写内建', async () => {
    writePayload('reviewer')
    await loadAgentLibrary(options())
    writePayload('reviewer', agent('reviewer', '改过的说明'))
    const library = await loadAgentLibrary(options())
    expect(library.sync.state).toBe('updated')
    expect(library.entries[0]?.definition?.description).toBe('改过的说明')
  })

  test('坏文件只让自己进 error，其余照常返回', async () => {
    writeCustomFile('good')
    writeCustomFile('bad', 'no frontmatter\n')
    const library = await loadAgentLibrary(options())
    expect(library.entries.find((entry) => entry.name === 'good')?.definition).toBeDefined()
    expect(library.entries.find((entry) => entry.name === 'bad')?.error).toContain('首行')
  })

  test('同名冲突：custom 记为冲突并排除', async () => {
    writePayload('reviewer')
    await loadAgentLibrary(options())
    writeCustomFile('reviewer')
    const library = await loadAgentLibrary(options())
    const custom = library.entries.find((entry) => entry.source === 'custom')
    expect(custom?.error).toBe('名称冲突')
    expect(() => resolveAgent(library, 'reviewer')).toThrowError(/名称冲突/u)
  })

  test('内建文件非法时整库同步失败，旧内建原样保留', async () => {
    writePayload('reviewer')
    await loadAgentLibrary(options())
    writePayload('reviewer', 'broken\n')
    const library = await loadAgentLibrary(options())
    expect(library.sync.state).toBe('failed')
    expect(library.entries.find((entry) => entry.name === 'reviewer')?.definition).toBeDefined()
  })

  test('templates/agents 下的每个内建 agent 都能解析', async () => {
    const repoAgents = join(import.meta.dirname, '..', '..', '..', '..', 'templates', 'agents')
    const names = readdirSync(repoAgents).filter((name) => name.endsWith('.md'))
    expect(names.length).toBe(9)
    for (const name of names) writePayload(name.slice(0, -3), readFileSync(join(repoAgents, name), 'utf8'))
    const library = await loadAgentLibrary(options())
    expect(library.sync.state).toBe('updated')
    expect(library.entries.filter((entry) => entry.definition !== undefined)).toHaveLength(9)
  })
})

describe('resolveAgent', () => {
  test('缺失与不合法各有错误码', async () => {
    writeCustomFile('bad', 'no frontmatter\n')
    const library = await loadAgentLibrary(options())
    expect(() => resolveAgent(library, 'nope')).toThrowError(AgentStoreError)
    try {
      resolveAgent(library, 'nope')
    } catch (error) {
      expect((error as AgentStoreError).code).toBe('agent-missing')
    }
    try {
      resolveAgent(library, 'bad')
    } catch (error) {
      expect((error as AgentStoreError).code).toBe('agent-invalid')
    }
  })
})

describe('writeCustomAgent / deleteCustomAgent', () => {
  test('新建、覆盖与摘要比对', async () => {
    const created = await writeCustomAgent(storeRoot(), 'mine', agent('mine'), { create: true })
    expect(created.source).toBe('custom')
    await expect(writeCustomAgent(storeRoot(), 'mine', agent('mine'), { create: true }))
      .rejects.toThrowError(/已存在/u)
    await expect(writeCustomAgent(storeRoot(), 'mine', agent('mine', '新'), { digest: 'sha256:0' }))
      .rejects.toThrowError(/请刷新/u)
    const updated = await writeCustomAgent(storeRoot(), 'mine', agent('mine', '新'), { digest: created.digest })
    expect(updated.digest).toBe(agentDigest(agent('mine', '新')))
  })

  test('name 与文件名不一致、内容非法都拒绝', async () => {
    await expect(writeCustomAgent(storeRoot(), 'mine', agent('other'), { create: true }))
      .rejects.toThrowError(/不一致/u)
    await expect(writeCustomAgent(storeRoot(), 'mine', 'broken\n', { create: true }))
      .rejects.toThrowError(AgentStoreError)
  })

  test('内建只读', async () => {
    writePayload('reviewer')
    await loadAgentLibrary(options())
    await expect(writeCustomAgent(storeRoot(), 'reviewer', agent('reviewer'), {}))
      .rejects.toThrowError(/只读/u)
    await expect(deleteCustomAgent(storeRoot(), 'reviewer')).rejects.toThrowError(/只读/u)
  })

  test('删除要求摘要一致', async () => {
    const created = await writeCustomAgent(storeRoot(), 'mine', agent('mine'), { create: true })
    await expect(deleteCustomAgent(storeRoot(), 'mine', 'sha256:0')).rejects.toThrowError(/请刷新/u)
    await deleteCustomAgent(storeRoot(), 'mine', created.digest)
    await expect(deleteCustomAgent(storeRoot(), 'mine')).rejects.toThrowError(/不存在/u)
  })
})

describe('项目级 agent（.tenon/agents）', () => {
  const projectRoot = (): string => join(sandbox, 'project')
  const projectOptions = (): { payloadRoot: string; configRoot: string; projectRoot: string } =>
    ({ payloadRoot, configRoot, projectRoot: projectRoot() })

  function writeProjectFile(name: string, text = agent(name)): void {
    const path = join(projectRoot(), '.tenon', 'agents', `${name}.md`)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, text)
  }

  test('project 与 custom 同名时 project 生效，custom 记为被覆盖并列出', async () => {
    writeCustomFile('mine', agent('mine', '用户级'))
    writeProjectFile('mine', agent('mine', '项目级'))
    const library = await loadAgentLibrary(projectOptions())
    expect(library.entries.map((entry) => `${entry.source}:${entry.name}`)).toEqual(['custom:mine', 'project:mine'])
    expect(library.entries.find((entry) => entry.source === 'custom')?.shadowedBy).toBe('project')
    expect(resolveAgent(library, 'mine').definition.description).toBe('项目级')
    expect(effectiveAgent(library, 'mine')?.source).toBe('project')
  })

  test('与官方同名的项目级 agent 是冲突，官方不被覆盖', async () => {
    writePayload('reviewer')
    writeProjectFile('reviewer')
    const library = await loadAgentLibrary(projectOptions())
    expect(library.entries.find((entry) => entry.source === 'project')?.error).toBe('名称冲突')
    expect(() => resolveAgent(library, 'reviewer')).toThrowError(/名称冲突/u)
  })

  test('不给项目根就不读项目层', async () => {
    writeProjectFile('mine')
    const library = await loadAgentLibrary(options())
    expect(library.entries).toEqual([])
  })

  test('writeAgent / deleteAgent 写项目层；官方名字拒绝', async () => {
    writePayload('reviewer')
    await loadAgentLibrary(projectOptions())
    const scope = agentScope('project', projectOptions())
    const created = await writeAgent(scope, 'team', agent('team'), { create: true })
    expect(created.source).toBe('project')
    expect(readFileSync(join(projectRoot(), '.tenon', 'agents', 'team.md'), 'utf8')).toBe(agent('team'))
    await expect(writeAgent(scope, 'reviewer', agent('reviewer'), { create: true })).rejects.toThrowError(/已存在/u)
    await deleteAgent(scope, 'team', created.digest)
    expect(readdirSync(join(projectRoot(), '.tenon', 'agents')).filter((name) => name.endsWith('.md'))).toEqual([])
  })

  test('项目层需要项目根', () => {
    expect(() => agentScope('project', { configRoot })).toThrowError(/项目根/u)
  })

  test('renameAgentContent 只改 name 行', () => {
    expect(renameAgentContent(agent('a'), 'b')).toBe(agent('a').replace('name: a', 'name: b'))
  })
})
