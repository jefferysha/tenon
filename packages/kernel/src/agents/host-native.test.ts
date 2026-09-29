import { describe, expect, it } from 'vitest'
import {
  claudeAgentModel, codexAgentModel, hostAgentName, hostAgentPath, parseHostAgentPath, renderHostAgent,
} from './host-native.js'
import { parseAgentFile } from './parse.js'
import type { AgentDefinition } from './types.js'

const definition = (overrides: Partial<AgentDefinition> = {}): AgentDefinition => ({
  name: 'sql-review',
  description: 'SQL 评审：查注入与索引',
  role: 'reviewer',
  skills: ['security-review'],
  tools: ['Read', 'Grep', 'Glob'],
  model: 'sonnet',
  body: '\n# sql-review\n\n只读。\n',
  ...overrides,
})

describe('宿主 agent 路径', () => {
  it('tenon- 前缀，Claude 用 md、Codex 用 toml；可反解', () => {
    expect(hostAgentName('builder')).toBe('tenon-builder')
    expect(hostAgentPath('claude', 'builder')).toBe('.claude/agents/tenon-builder.md')
    expect(hostAgentPath('codex', 'builder')).toBe('.codex/agents/tenon-builder.toml')
    expect(parseHostAgentPath('.claude/agents/tenon-builder.md')).toEqual({ host: 'claude', name: 'builder' })
    expect(parseHostAgentPath('.codex/agents/tenon-a-b.toml')).toEqual({ host: 'codex', name: 'a-b' })
    expect(parseHostAgentPath('.claude/agents/mine.md')).toBeNull()
    expect(parseHostAgentPath('.claude/agents/tenon-../x.md')).toBeNull()
    expect(parseHostAgentPath('AGENTS.md')).toBeNull()
  })
})

describe('型号映射', () => {
  it('Claude 只收 Claude 别名与 claude-* id', () => {
    expect(claudeAgentModel('sonnet')).toBe('sonnet')
    expect(claudeAgentModel('claude-opus-4-1')).toBe('claude-opus-4-1')
    expect(claudeAgentModel('gpt-5.6')).toBeUndefined()
    expect(claudeAgentModel(undefined)).toBeUndefined()
  })

  it('Codex 只收 OpenAI 型号，Claude 别名省略', () => {
    expect(codexAgentModel('gpt-5.6')).toBe('gpt-5.6')
    expect(codexAgentModel('o4-mini')).toBe('o4-mini')
    expect(codexAgentModel('sonnet')).toBeUndefined()
    expect(codexAgentModel('opus')).toBeUndefined()
  })
})

describe('renderHostAgent', () => {
  it('Claude：name / description / tools / model + 正文', () => {
    expect(renderHostAgent('claude', definition())).toBe([
      '---',
      'name: tenon-sql-review',
      'description: "SQL 评审：查注入与索引"',
      'tools: Read, Grep, Glob',
      'model: sonnet',
      '---',
      '',
      '# sql-review\n\n只读。\n',
    ].join('\n'))
  })

  it('Claude：空工具表省略 tools（继承全部），外宿主型号省略', () => {
    const text = renderHostAgent('claude', definition({ tools: [], model: 'gpt-5.6' }))
    expect(text).not.toContain('tools:')
    expect(text).not.toContain('model:')
  })

  it('Claude：description 里的冒号与引号不破坏 frontmatter', () => {
    const text = renderHostAgent('claude', definition({ description: 'a: "b" #c' }))
    expect(text).toContain('description: "a: \\"b\\" #c"')
  })

  it('Codex：TOML 字段，Claude 别名省略，无写/执行工具时只读沙箱', () => {
    expect(renderHostAgent('codex', definition())).toBe([
      'name = "tenon-sql-review"',
      'description = "SQL 评审：查注入与索引"',
      'sandbox_mode = "read-only"',
      'developer_instructions = """',
      '# sql-review\n\n只读。\n"""',
      '',
    ].join('\n'))
  })

  it('Codex：有 Bash 或写工具就不加沙箱限制；OpenAI 型号保留', () => {
    const text = renderHostAgent('codex', definition({ tools: ['Read', 'Bash'], model: 'gpt-5.6' }))
    expect(text).not.toContain('sandbox_mode')
    expect(text).toContain('model = "gpt-5.6"')
  })

  it('Codex：正文里的引号、反斜杠与控制字符都被转义', () => {
    const text = renderHostAgent('codex', definition({ body: 'a """ b \\ c \u0001\n' }))
    expect(text).toContain('a \\"\\"\\" b \\\\ c \\u0001\n"""')
  })

  it('官方 builder 能渲染两种宿主文件', async () => {
    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const text = readFileSync(join(import.meta.dirname, '..', '..', '..', '..', 'templates', 'agents', 'builder.md'), 'utf8')
    const builder = parseAgentFile(text, 'builder')
    expect(renderHostAgent('claude', builder)).toContain('tools: Read, Write, Edit, Bash, Grep, Glob, Skill')
    expect(renderHostAgent('codex', builder)).toContain('name = "tenon-builder"')
  })
})
