/**
 * 旧版本写进项目里的宿主 agent 文件的清理（CLI 侧）：用当前库的渲染结果作内容依据，清理失败只 WARN 不抛错。
 * 全部在临时目录，不碰真实的 ~/.claude、~/.codex。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { computeContentHash, effectiveAgent, hostAgentPath, renderHostAgent, type HostAgentHost } from '@tenon/kernel'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { builtinAgentLibrary, makeDeps } from '../test-support.js'
import { cleanupLegacyHostAgentFiles } from './agent-host.js'

let repo: string

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'tenon-agent-host-'))
})

afterEach(() => {
  rmSync(repo, { recursive: true, force: true })
})

/** 当前内建库里 `name` 在 `host` 的渲染结果。 */
const rendered = (host: HostAgentHost, name: string): string => {
  const definition = effectiveAgent(builtinAgentLibrary(), name)?.definition
  if (definition === undefined) throw new Error(`内建库里没有 ${name}`)
  return renderHostAgent(host, definition)
}

function put(rel: string, text: string): void {
  mkdirSync(dirname(join(repo, rel)), { recursive: true })
  writeFileSync(join(repo, rel), text, 'utf8')
}

const record = (entries: Record<string, string>): void =>
  writeFileSync(join(repo, '.pipeline-owned.json'), `${JSON.stringify(entries, null, 2)}\n`)

describe('cleanupLegacyHostAgentFiles', () => {
  test('不在清单、内容等于当前库渲染 → 删除并说明；清单里的未改文件同样删除', async () => {
    const unlisted = hostAgentPath('claude', 'builder')
    const listed = hostAgentPath('codex', 'researcher')
    put(unlisted, rendered('claude', 'builder'))
    put(listed, '旧版本写的\n')
    record({ [listed]: computeContentHash('旧版本写的\n') })
    const deps = makeDeps({ cwd: repo })
    await cleanupLegacyHostAgentFiles(deps)
    expect(existsSync(join(repo, unlisted))).toBe(false)
    expect(existsSync(join(repo, listed))).toBe(false)
    expect(deps.errLines.join('\n')).toContain(unlisted)
    expect(deps.errLines.join('\n')).toContain(listed)
    expect(deps.errLines.filter((line) => line.startsWith('WARN'))).toEqual([])
    expect(deps.outLines).toEqual([])
  })

  test('被改过的文件保留并 WARN，命令不受影响', async () => {
    const rel = hostAgentPath('claude', 'security')
    put(rel, '用户改过\n')
    record({ [rel]: computeContentHash(rendered('claude', 'security')) })
    const deps = makeDeps({ cwd: repo })
    await cleanupLegacyHostAgentFiles(deps)
    expect(readFileSync(join(repo, rel), 'utf8')).toBe('用户改过\n')
    expect(deps.errLines.filter((line) => line.startsWith('WARN') && line.includes(rel))).toHaveLength(1)
  })

  test('没有旧文件 → 无任何输出，也不创建 .tenon', async () => {
    const deps = makeDeps({ cwd: repo })
    await cleanupLegacyHostAgentFiles(deps)
    expect(deps.errLines).toEqual([])
    expect(deps.outLines).toEqual([])
    expect(existsSync(join(repo, '.tenon'))).toBe(false)
  })

  test('agent 库未装配 → 只按清单删，不报「库未装配」错误', async () => {
    const listed = hostAgentPath('claude', 'a')
    const unlisted = hostAgentPath('claude', 'builder')
    put(listed, '旧\n')
    put(unlisted, rendered('claude', 'builder'))
    record({ [listed]: computeContentHash('旧\n') })
    const deps = makeDeps({ cwd: repo })
    delete deps.agentLibrary
    await cleanupLegacyHostAgentFiles(deps)
    expect(existsSync(join(repo, listed))).toBe(false)
    expect(existsSync(join(repo, unlisted))).toBe(true)
    expect(deps.errLines.filter((line) => line.startsWith('ERROR'))).toEqual([])
  })

  test('agent 库读取失败 → WARN 后退回只按清单删，不抛错', async () => {
    const listed = hostAgentPath('claude', 'a')
    put(listed, '旧\n')
    record({ [listed]: computeContentHash('旧\n') })
    const deps = makeDeps({ cwd: repo })
    deps.agentLibrary = async () => { throw new Error('库坏了') }
    await expect(cleanupLegacyHostAgentFiles(deps)).resolves.toBeUndefined()
    expect(existsSync(join(repo, listed))).toBe(false)
    expect(deps.errLines.join('\n')).toMatch(/WARN.*库坏了/u)
  })

  test('清理本身失败（锁目录建不出来）→ 只 WARN，不抛错，文件原样', async () => {
    const rel = hostAgentPath('claude', 'a')
    put(rel, '旧\n')
    record({ [rel]: computeContentHash('旧\n') })
    writeFileSync(join(repo, '.tenon'), '我是个文件，不是目录')
    const deps = makeDeps({ cwd: repo })
    await expect(cleanupLegacyHostAgentFiles(deps)).resolves.toBeUndefined()
    expect(readFileSync(join(repo, rel), 'utf8')).toBe('旧\n')
    expect(deps.errLines.filter((line) => line.startsWith('WARN') && line.includes('清理失败'))).toHaveLength(1)
  })

  test('agent 定义的 hosts 不含该宿主 → 按「当前库没有它」处理，清单外的文件保留', async () => {
    const rel = hostAgentPath('codex', 'builder')
    put(rel, rendered('codex', 'builder'))
    const library = builtinAgentLibrary()
    const entries = library.entries.map((entry) =>
      entry.name === 'builder' && entry.definition !== undefined
        ? { ...entry, definition: { ...entry.definition, hosts: ['claude' as const] } }
        : entry)
    const deps = makeDeps({ cwd: repo })
    deps.agentLibrary = async () => ({ ...library, entries })
    await cleanupLegacyHostAgentFiles(deps)
    expect(existsSync(join(repo, rel))).toBe(true)
    expect(deps.errLines.filter((line) => line.startsWith('WARN') && line.includes(rel))).toHaveLength(1)
  })
})
