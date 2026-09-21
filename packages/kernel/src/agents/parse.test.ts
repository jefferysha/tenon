import { describe, expect, it } from 'vitest'
import { agentDigest, parseAgentFile } from './parse.js'
import { AGENT_FILE_MAX_BYTES, AgentFileError } from './types.js'

const file = (lines: readonly string[], body = '正文'): string => ['---', ...lines, '---', '', body, ''].join('\n')

const FULL = file([
  'name: frontend-quality',
  'description: 前端质量评审',
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
      skills: ['vercel-react-best-practices', 'web-design-guidelines'],
      tools: ['Read', 'Grep', 'Glob', 'Bash', 'Skill'],
      model: 'sonnet',
      hosts: ['claude', 'codex'],
      body: '\n正文\n',
    })
  })

  it('skills/tools 缺省是空列表，hosts 缺省缺席', () => {
    const parsed = parseAgentFile(file(['name: a', 'description: d']), 'a')
    expect(parsed.skills).toEqual([])
    expect(parsed.tools).toEqual([])
    expect(parsed.hosts).toBeUndefined()
    expect(parsed.model).toBeUndefined()
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
