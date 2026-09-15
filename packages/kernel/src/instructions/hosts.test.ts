import { describe, expect, test } from 'vitest'
import { ADAPTER_CAPABILITY_ROWS } from '../catalog/adapter-capabilities.generated.js'
import { ABSENT_DIGEST, instructionDigest } from './digest.js'
import {
  INSTRUCTION_HOSTS, hasUserInstructionFile, instructionHost, projectTargetsFor, userInstructionPath, zedEffectiveFile,
} from './hosts.js'
import { instructionLibraryRoot } from './library-paths.js'

const context = { homeDir: '/home/me', env: {}, platform: 'darwin' as const }

describe('instruction hosts', () => {
  test('宿主集合与适配器生成表一致', () => {
    expect(INSTRUCTION_HOSTS.map((host) => host.id).sort()).toEqual(ADAPTER_CAPABILITY_ROWS.map((row) => row.host_id).sort())
  })

  test('项目级目标按宿主顺序去重', () => {
    expect(projectTargetsFor(['claude', 'codex'])).toEqual(['CLAUDE.md', 'AGENTS.md'])
    expect(projectTargetsFor(['codex', 'cursor', 'gemini', 'aider', 'unknown'])).toEqual(['AGENTS.md', 'GEMINI.md'])
  })

  test('两级加载关系', () => {
    expect(instructionHost('claude')?.levels).toBe('joined')
    expect(instructionHost('copilot')?.levels).toBe('user-wins')
    expect(instructionHost('cursor')?.levels).toBe('project-only')
    expect(instructionHost('zed')?.levels).toBe('project-wins')
    expect(instructionHost('aider')).toEqual({ id: 'aider', projectFile: null, levels: 'needs-config' })
  })

  test('用户级路径：home 下的相对段；没有文件位置的宿主为 null', () => {
    expect(userInstructionPath('claude', context)).toEqual(['/home/me', '.claude', 'CLAUDE.md'])
    expect(userInstructionPath('gemini', context)).toEqual(['/home/me', '.gemini', 'GEMINI.md'])
    expect(userInstructionPath('zed', context)).toEqual(['/home/me', '.config', 'zed', 'AGENTS.md'])
    for (const id of ['copilot', 'cursor', 'continue', 'aider']) {
      expect(userInstructionPath(id, context)).toBeNull()
      expect(hasUserInstructionFile(id)).toBe(false)
    }
  })

  test('CODEX_HOME 为绝对路径时生效，相对路径忽略', () => {
    expect(userInstructionPath('codex', { ...context, env: { CODEX_HOME: '/opt/codex/' } })).toEqual(['/opt/codex', 'AGENTS.md'])
    expect(userInstructionPath('codex', { ...context, env: { CODEX_HOME: 'relative/codex' } })).toEqual(['/home/me', '.codex', 'AGENTS.md'])
  })

  test('Zed 在 Windows 用 %APPDATA%\\Zed\\AGENTS.md', () => {
    const win = { homeDir: 'C:\\Users\\me', platform: 'win32' as const }
    expect(userInstructionPath('zed', { ...win, env: { APPDATA: 'C:\\Users\\me\\AppData\\Roaming' } })).toEqual(['C:\\Users\\me\\AppData\\Roaming', 'Zed', 'AGENTS.md'])
    expect(userInstructionPath('zed', { ...win, env: {} })).toEqual(['C:\\Users\\me', 'AppData', 'Roaming', 'Zed', 'AGENTS.md'])
  })

  test('Zed 生效文件：顺序表里第一个存在的，否则 AGENTS.md', () => {
    expect(zedEffectiveFile((file) => file === '.rules' || file === 'AGENTS.md')).toBe('.rules')
    expect(zedEffectiveFile((file) => file === 'CLAUDE.md')).toBe('CLAUDE.md')
    expect(zedEffectiveFile(() => false)).toBe('AGENTS.md')
  })
})

describe('instruction digest and library root', () => {
  test('缺失为 absent，否则 sha256 前缀', () => {
    expect(instructionDigest(null)).toBe(ABSENT_DIGEST)
    expect(instructionDigest(new TextEncoder().encode('abc'))).toBe('sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })

  test('模板库在 configRoot/templates/instructions', () => {
    expect(instructionLibraryRoot({ env: { TENON_RUNTIME_HOME: '/tmp/tenon-home' }, platform: 'linux' })).toBe('/tmp/tenon-home/config/templates/instructions')
  })
})
