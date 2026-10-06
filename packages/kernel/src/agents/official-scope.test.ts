import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { officialAttachOn, withAttachOnLine, withOfficialAttachOn } from './official-scope.js'
import { parseAgentFile } from './parse.js'
import type { AgentDefinition } from './types.js'

const definition = (name: string, extra: Partial<AgentDefinition> = {}): AgentDefinition => ({
  name, description: 'd', role: 'reviewer', skills: [], tools: ['Read'], body: 'b', ...extra,
})

describe('官方评审者的默认挂载范围', () => {
  it('security 在鉴权 / 依赖 / 契约路径上挂载，其余官方 agent 没有声明（总是挂载）', () => {
    expect(officialAttachOn('security')).toEqual(['auth', 'dependency', 'contract'])
    for (const name of ['code-review', 'code-size', 'spec-consistency', 'backend-quality', 'architecture', 'e2e', 'builder', 'constructor', 'toString']) {
      expect(officialAttachOn(name), name).toBeUndefined()
    }
  })

  it('只对来源是 builtin 的定义补上范围；文件里自己写的优先；其余原样返回同一个对象', () => {
    const security = definition('security')
    expect(withOfficialAttachOn('builtin', security).attachOn).toEqual(['auth', 'dependency', 'contract'])
    expect(withOfficialAttachOn('custom', security)).toBe(security)
    expect(withOfficialAttachOn('project', security)).toBe(security)
    const own = definition('security', { attachOn: ['migration'] })
    expect(withOfficialAttachOn('builtin', own)).toBe(own)
    const other = definition('code-review')
    expect(withOfficialAttachOn('builtin', other)).toBe(other)
  })

  it('复制官方 agent 时把范围写进副本的 frontmatter（结束的 --- 之前），已有该行或没有 frontmatter 时原样返回', () => {
    const file = '---\nname: sec\ndescription: d\nrole: reviewer\nskills: []\ntools: [Read]\n---\n\n正文\n'
    const written = withAttachOnLine(file, ['auth', 'contract'])
    expect(written).toContain('tools: [Read]\nattach_on: [auth, contract]\n---\n\n正文')
    expect(parseAgentFile(written, 'sec').attachOn).toEqual(['auth', 'contract'])
    expect(withAttachOnLine(written, ['migration'])).toBe(written)
    expect(withAttachOnLine('没有 frontmatter\n', ['auth'])).toBe('没有 frontmatter\n')
  })

  it('CRLF 文件（首行是 ---\\r）也写进范围：插入的行沿用 CRLF，已有该行时原样返回', () => {
    const lf = '---\nname: sec\ndescription: d\nrole: reviewer\nskills: []\ntools: [Read]\n---\n\n正文\n'
    const toCrlf = (text: string): string => text.replace(/\n/gu, '\r\n')
    const crlf = toCrlf(lf)
    const written = withAttachOnLine(crlf, ['auth', 'contract'])
    expect(written).toBe(toCrlf(withAttachOnLine(lf, ['auth', 'contract'])))
    expect(written).toContain('tools: [Read]\r\nattach_on: [auth, contract]\r\n---\r\n\r\n正文')
    expect(written.replace(/\r\n/gu, '')).not.toMatch(/[\r\n]/u)
    expect(withAttachOnLine(written, ['migration'])).toBe(written)
    // 没有结束分隔行的 CRLF 文件不动
    expect(withAttachOnLine('---\r\nname: sec\r\n', ['auth'])).toBe('---\r\nname: sec\r\n')
  })
})

describe('随包的官方 agent 文件（上一个发行版读得了的形状）', () => {
  const dir = fileURLToPath(new URL('../../../../templates/agents/', import.meta.url))

  it('security.md 的 frontmatter 不写 attach_on，解析后在 builtin 来源下仍得到默认范围', () => {
    const text = readFileSync(`${dir}security.md`, 'utf8')
    expect(text.split('\n---\n')[0]).not.toContain('attach_on')
    const parsed = parseAgentFile(text, 'security')
    expect(parsed.attachOn).toBeUndefined()
    expect(withOfficialAttachOn('builtin', parsed).attachOn).toEqual(['auth', 'dependency', 'contract'])
  })
})
