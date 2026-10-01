import { describe, expect, it } from 'vitest'
import { agentDigest, parseAgentFile } from './parse.js'
import { AGENT_FILE_MAX_BYTES, AgentFileError, inferAgentRole } from './types.js'

const file = (lines: readonly string[], body = '正文'): string => ['---', ...lines, '---', '', body, ''].join('\n')

const FULL = file([
  'name: frontend-quality',
  'description: 前端质量评审',
  'role: reviewer',
  'version: 1.2.0',
  'skills: [vercel-react-best-practices, web-design-guidelines]',
  'tools: [Read, Grep, Glob, Bash, Skill]',
  'model: sonnet',
  'hosts: [claude, codex]',
])

describe('parseAgentFile', () => {
  it('读全部字段', () => {
    expect(parseAgentFile(FULL, 'frontend-quality')).toEqual({
      name: 'frontend-quality',
      description: '前端质量评审',
      role: 'reviewer',
      version: '1.2.0',
      skills: ['vercel-react-best-practices', 'web-design-guidelines'],
      tools: ['Read', 'Grep', 'Glob', 'Bash', 'Skill'],
      model: 'sonnet',
      hosts: ['claude', 'codex'],
      body: '\n正文\n',
    })
  })

  it('host 是建议在哪个宿主上跑（codex | claude | any），与"能在哪些宿主上跑"的 hosts 是两件事；写错值被拒', () => {
    const parsed = parseAgentFile(file(['name: a', 'description: d', 'role: reviewer', 'hosts: [claude, codex]', 'host: codex']), 'a')
    expect(parsed).toMatchObject({ hosts: ['claude', 'codex'], host: 'codex' })
    expect(parseAgentFile(file(['name: a', 'description: d', 'host: any']), 'a').host).toBe('any')
    expect(parseAgentFile(file(['name: a', 'description: d']), 'a')).not.toHaveProperty('host')
    expect(() => parseAgentFile(file(['name: a', 'description: d', 'host: gemini']), 'a')).toThrowError(/host 必须是 codex \| claude \| any/u)
  })

  it('skills/tools 缺省是空列表，hosts 缺省缺席', () => {
    const parsed = parseAgentFile(file(['name: a', 'description: d']), 'a')
    expect(parsed.skills).toEqual([])
    expect(parsed.tools).toEqual([])
    expect(parsed.hosts).toBeUndefined()
    expect(parsed.model).toBeUndefined()
  })

  it('attach_on：路径类闭集、去重；缺省缺席；空列表与未知类拒绝', () => {
    const scoped = parseAgentFile(file(['name: a', 'description: d', 'attach_on: [auth, dependency, auth]']), 'a')
    expect(scoped.attachOn).toEqual(['auth', 'dependency'])
    expect(parseAgentFile(file(['name: a', 'description: d']), 'a').attachOn).toBeUndefined()
    expect(() => parseAgentFile(file(['name: a', 'description: d', 'attach_on: []']), 'a')).toThrow(/至少写一个路径类/)
    expect(() => parseAgentFile(file(['name: a', 'description: d', 'attach_on: [auth, secrets]']), 'a'))
      .toThrow(/attach_on 的 'secrets' 不是路径类/)
    expect(() => parseAgentFile(file(['name: a', 'description: d', 'attach_on: auth']), 'a')).toThrow(AgentFileError)
  })

  it('缺 role 时按工具推断并标记，读取照常', () => {
    const reviewer = parseAgentFile(file(['name: a', 'description: d', 'tools: [Read, Bash]']), 'a')
    expect(reviewer.role).toBe('reviewer')
    expect(reviewer.roleInferred).toBe(true)
    const executor = parseAgentFile(file(['name: a', 'description: d', 'tools: [Read, Edit]']), 'a')
    expect(executor.role).toBe('executor')
    const declared = parseAgentFile(file(['name: a', 'description: d', 'role: executor', 'tools: [Read]']), 'a')
    expect(declared.role).toBe('executor')
    expect(declared.roleInferred).toBeUndefined()
    expect(inferAgentRole(['MultiEdit'])).toBe('executor')
  })

  it('version 缺省缺席，预发布版本合法', () => {
    expect(parseAgentFile(file(['name: a', 'description: d']), 'a').version).toBeUndefined()
    expect(parseAgentFile(file(['name: a', 'description: d', 'version: 2.0.0-rc.1']), 'a').version).toBe('2.0.0-rc.1')
  })

  it('命名空间 skill id 合法', () => {
    expect(parseAgentFile(file(['name: a', 'description: d', 'skills: [superpowers:brainstorming]']), 'a').skills)
      .toEqual(['superpowers:brainstorming'])
  })

  it('CRLF 正文逐字保留，摘要随之变化', () => {
    const crlf = parseAgentFile(file(['name: a', 'description: d'], '一行\r\n二行'), 'a')
    expect(crlf.body).toContain('一行\r\n二行')
    expect(agentDigest('x')).not.toEqual(agentDigest('x\n'))
    expect(agentDigest('x')).toMatch(/^sha256:[0-9a-f]{64}$/)
  })

  const cases: readonly [string, string, string][] = [
    ['首行不是 ---', 'name: a\n---\n正文\n', '首行'],
    ['没有结束 ---', '---\nname: a\n正文\n', '结束'],
    ['未知字段', file(['name: a', 'description: d', 'color: red']), 'color'],
    ['重复字段', file(['name: a', 'description: d', 'description: e']), '重复'],
    ['不是 key: value', file(['name: a', 'description: d', 'oops']), "'key: value'"],
    ['name 非法', file(['name: A', 'description: d']), 'name'],
    ['description 空', file(['name: a', 'description: ']), 'description'],
    ['description 过长', file(['name: a', `description: ${'字'.repeat(201)}`]), 'description'],
    ['skills 不是单行列表', file(['name: a', 'description: d', 'skills: x']), 'skills'],
    ['skill id 非法', file(['name: a', 'description: d', 'skills: [a b]']), 'skills'],
    ['tool 非法', file(['name: a', 'description: d', 'tools: [1Read]']), 'tools'],
    ['model 非法', file(['name: a', 'description: d', 'model: -x']), 'model'],
    ['未知宿主', file(['name: a', 'description: d', 'hosts: [nope]']), 'hosts'],
    ['role 非法', file(['name: a', 'description: d', 'role: boss']), 'role'],
    ['version 不是 semver', file(['name: a', 'description: d', 'version: 1.0']), 'semver'],
    ['正文为空', '---\nname: a\ndescription: d\n---\n\n', '正文'],
  ]
  for (const [title, text, hint] of cases) {
    it(`拒绝：${title}`, () => {
      expect(() => parseAgentFile(text, 'a')).toThrowError(AgentFileError)
      expect(() => parseAgentFile(text, 'a')).toThrowError(new RegExp(hint.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')))
    })
  }

  it('name 与文件名不一致', () => {
    expect(() => parseAgentFile(file(['name: a', 'description: d']), 'b')).toThrowError(/不一致/u)
  })

  it('64 KiB 边界', () => {
    const head = file(['name: a', 'description: d'], '')
    const pad = 'x'.repeat(AGENT_FILE_MAX_BYTES - new TextEncoder().encode(head).length)
    expect(parseAgentFile(head + pad, 'a').body.length).toBeGreaterThan(0)
    expect(() => parseAgentFile(`${head + pad}x`, 'a')).toThrowError(/65536/u)
  })
})
