import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { TENON_PROJECT_GITIGNORE } from '../users/user-paths.js'
import {
  PROJECT_CLIENTS_FILE, inferProjectClients, normalizeProjectClients, parseProjectClients, serializeProjectClients,
} from './clients.js'

describe('project clients codec', () => {
  it('只收已知客户端 id；去重并按字母序', () => {
    expect(normalizeProjectClients(['codex', 'claude', 'codex'])).toEqual({ ok: true, enabled: ['claude', 'codex'] })
    expect(normalizeProjectClients([])).toEqual({ ok: true, enabled: [] })
    expect(normalizeProjectClients(['claude', 'vim', 'vim'])).toEqual({ ok: false, unknown: ['vim'] })
    expect(normalizeProjectClients('claude')).toBeNull()
    expect(normalizeProjectClients([1])).toBeNull()
  })

  it('序列化与解析往返；schema 或 id 不对按损坏处理', () => {
    const text = serializeProjectClients(['claude', 'codex'])
    expect(text).toBe('{\n  "schema": "tenon-clients/v1",\n  "enabled": [\n    "claude",\n    "codex"\n  ]\n}\n')
    expect(parseProjectClients(text)).toEqual(['claude', 'codex'])
    expect(parseProjectClients('{"schema":"tenon-clients/v2","enabled":[]}')).toBeNull()
    expect(parseProjectClients('{"schema":"tenon-clients/v1","enabled":["vim"]}')).toBeNull()
    expect(parseProjectClients('{"schema":"tenon-clients/v1"}')).toBeNull()
    expect(parseProjectClients('not json')).toBeNull()
    expect(parseProjectClients('[]')).toBeNull()
  })

  it('推断：CLAUDE.md → claude、AGENTS.md → codex、GEMINI.md → gemini', () => {
    expect(inferProjectClients((file) => file === 'AGENTS.md' || file === 'CLAUDE.md')).toEqual(['claude', 'codex'])
    expect(inferProjectClients((file) => file === 'GEMINI.md')).toEqual(['gemini'])
    expect(inferProjectClients(() => false)).toEqual([])
  })

  it('.tenon/.gitignore 不忽略 clients.json：它随项目提交', () => {
    const repo = mkdtempSync(join(tmpdir(), 'tenon-clients-git-'))
    try {
      execFileSync('git', ['init', '-q'], { cwd: repo })
      mkdirSync(join(repo, '.tenon', 'users', 'me-at-x', 'local'), { recursive: true })
      writeFileSync(join(repo, '.tenon', '.gitignore'), TENON_PROJECT_GITIGNORE)
      writeFileSync(join(repo, '.tenon', PROJECT_CLIENTS_FILE), serializeProjectClients(['codex']))
      writeFileSync(join(repo, '.tenon', 'users', 'me-at-x', 'local', 'x'), '')
      const ignored = (path: string): boolean => {
        try {
          execFileSync('git', ['check-ignore', '-q', path], { cwd: repo })
          return true
        } catch {
          return false
        }
      }
      expect(ignored(`.tenon/${PROJECT_CLIENTS_FILE}`)).toBe(false)
      // 对照：同一份 .gitignore 确实在生效。
      expect(ignored('.tenon/users/me-at-x/local/x')).toBe(true)
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })
})
