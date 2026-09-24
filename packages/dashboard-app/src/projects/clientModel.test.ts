import { describe, expect, it } from 'vitest'
import type { InstructionHostRow, InstructionTarget } from '../api/instructionsDecoders'
import { canEnable, clientName, fileNameOf, fileStatus, groupByProjectFile } from './clientModel'

const HOSTS: InstructionHostRow[] = [
  { id: 'claude', levels: 'joined', target: 'CLAUDE.md' },
  { id: 'codex', levels: 'joined', target: 'AGENTS.md' },
  { id: 'gemini', levels: 'joined', target: 'GEMINI.md' },
  { id: 'cline', levels: 'joined', target: 'AGENTS.md' },
  { id: 'zed', levels: 'project-wins', target: 'AGENTS.md', effective_file: 'AGENTS.md' },
  { id: 'aider', levels: 'needs-config', target: null },
]

const target = (id: string, over: Partial<InstructionTarget> = {}): InstructionTarget => ({
  id, path: `/repo/${id}`, exists: true, digest: `sha256:${id}`, text: '# x\n', managed: [], bytes: 4, error: null, ...over,
})

const TARGETS = [target('AGENTS.md'), target('CLAUDE.md'), target('GEMINI.md', { exists: false })]

describe('clientModel', () => {
  // 回归：用户级目标 id 是宿主 id，「文件」处曾显示 claude / codex 而不是文件名。
  it('文件名取自路径：用户级 claude → CLAUDE.md，codex → AGENTS.md', () => {
    expect(fileNameOf({ id: 'claude', path: '/Users/me/.claude/CLAUDE.md' })).toBe('CLAUDE.md')
    expect(fileNameOf({ id: 'codex', path: '/Users/me/.codex/AGENTS.md' })).toBe('AGENTS.md')
    expect(fileNameOf({ id: 'zed', path: 'C:\\Users\\me\\AppData\\Roaming\\Zed\\AGENTS.md' })).toBe('AGENTS.md')
    expect(fileNameOf({ id: 'AGENTS.md', path: '/repo/AGENTS.md' })).toBe('AGENTS.md')
    expect(fileNameOf({ id: 'claude', path: '' })).toBe('claude')
  })

  it('显示名只有一个；未知 id 原样', () => {
    expect(clientName('claude')).toBe('Claude Code')
    expect(clientName('codex')).toBe('Codex')
    expect(clientName('mystery')).toBe('mystery')
  })

  it('共享同一项目级文件的已启用客户端合并成一组，按宿主表顺序', () => {
    expect(groupByProjectFile(HOSTS, TARGETS, ['cline', 'claude', 'codex'])).toEqual([
      { file: 'CLAUDE.md', clients: ['claude'] },
      { file: 'AGENTS.md', clients: ['codex', 'cline'] },
    ])
  })

  it('Zed 按实际读取的文件归组；实际文件不可编辑时按声明文件', () => {
    const readsClaude = HOSTS.map((host) => (host.id === 'zed' ? { ...host, effective_file: 'CLAUDE.md' } : host))
    expect(groupByProjectFile(readsClaude, TARGETS, ['claude', 'zed'])).toEqual([{ file: 'CLAUDE.md', clients: ['claude', 'zed'] }])
    const readsRules = HOSTS.map((host) => (host.id === 'zed' ? { ...host, effective_file: '.rules' } : host))
    expect(groupByProjectFile(readsRules, TARGETS, ['zed'])).toEqual([{ file: 'AGENTS.md', clients: ['zed'] }])
  })

  it('需配置的客户端不进组，也不能直接启用', () => {
    expect(groupByProjectFile(HOSTS, TARGETS, ['aider'])).toEqual([])
    expect(canEnable(HOSTS[5] as InstructionHostRow)).toBe(false)
    expect(canEnable(HOSTS[0] as InstructionHostRow)).toBe(true)
  })

  it('文件状态：错误 / 缺失 / 一致 / 不同', () => {
    expect(fileStatus(target('A', { error: 'not-file' }), '')).toBe('error')
    expect(fileStatus(target('A', { exists: false }), '')).toBe('missing')
    expect(fileStatus(target('A'), '# x\n')).toBe('same')
    expect(fileStatus(target('A'), 'y')).toBe('different')
  })
})
