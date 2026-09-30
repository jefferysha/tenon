/**
 * agent validate / add 的检查（产品评估 P2）：骨架里的占位符不能登记；工具名按宿主校验——
 * Claude 认工具名（写错就是 FAIL），Codex 不按名限制工具（只提示，不假装校验）。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { loadAgentLibrary, type AgentDefinition } from '@tenon/kernel'
import { makeDeps, type TestDeps } from '../test-support.js'
import { cmdAgentAdd, cmdAgentValidate, checkDefinition } from './agent-library.js'
import { agentBodySkeleton, cmdAgentNew, renderAgentFile } from './agent-new.js'

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..', '..')

const definition = (overrides: Partial<AgentDefinition> = {}): AgentDefinition => ({
  name: 'api-review', description: 'API 评审', role: 'reviewer', skills: [], tools: ['Read', 'Grep'],
  body: '# api-review\n\n## 方法\n\n1. 读接口定义\n2. 对照调用方\n',
  ...overrides,
})

const levels = (checks: ReturnType<typeof checkDefinition>, level: string): string[] =>
  checks.filter((check) => check.level === level).map((check) => check.message)

describe('checkDefinition · 骨架占位符', () => {
  test('骨架原样（评审者 / 执行者）：每个占位符各报一条 FAIL，补全后通过', () => {
    for (const role of ['reviewer', 'executor'] as const) {
      const skeleton = definition({ role, body: agentBodySkeleton('x', role, '说明') })
      const fails = levels(checkDefinition(skeleton, undefined), 'fail')
      expect(fails.join('\n'), role).toContain('<第一步>')
      expect(fails.join('\n'), role).toContain('<第二步>')
      expect(fails.join('\n'), role).toContain('<写报告前必须满足的条件>')
      expect(fails.join('\n'), role).toMatch(/<这个(?:评审者|执行者)负责的那一件事>/u)
    }
    const filled = definition({ body: agentBodySkeleton('x', 'reviewer', '说明')
      .replace('<这个评审者负责的那一件事>', '查接口兼容').replace('<第一步>', '读接口').replace('<第二步>', '比对').replace('<写报告前必须满足的条件>', '每条发现有位置') })
    expect(levels(checkDefinition(filled, undefined), 'fail')).toEqual([])
  })

  test('`agent new` 自己写出的骨架允许带占位符（提示补全），正文里普通的尖括号不算占位符', () => {
    const plain = definition({ body: '报告写到 <报告路径>，命令形如 tenon agent record <change> <run-id>。\n' })
    expect(levels(checkDefinition(plain, undefined), 'fail')).toEqual([])
    const skeleton = definition({ body: agentBodySkeleton('x', 'reviewer', '说明') })
    expect(levels(checkDefinition(skeleton, undefined, { allowSkeleton: true }), 'fail')).toEqual([])
  })
})

describe('checkDefinition · 工具名按宿主', () => {
  test('Claude：未知工具名 FAIL；mcp__ 前缀放行', () => {
    const fails = levels(checkDefinition(definition({ tools: ['Read', 'Shell', 'mcp__docs__search'], hosts: ['claude'] }), undefined), 'fail')
    expect(fails).toEqual(["工具 'Shell' 不是 Claude Code 的工具名"])
  })

  test('只写 Codex：未知工具名只是提示（Codex 不按名限制），并说明只读沙箱规则', () => {
    const checks = checkDefinition(definition({ tools: ['Read', 'Shell'], hosts: ['codex'] }), undefined)
    expect(levels(checks, 'fail')).toEqual([])
    expect(levels(checks, 'warn').join('\n')).toContain("工具 'Shell'")
    expect(levels(checks, 'ok').join('\n')).toContain('Codex')
    expect(levels(checks, 'ok').join('\n')).toContain('只读沙箱')
  })

  test('两个宿主都在：Claude 的规则优先（FAIL）', () => {
    expect(levels(checkDefinition(definition({ tools: ['Shell'] }), undefined), 'fail')).toHaveLength(1)
  })

  test('没有 Codex 时不出现 Codex 的说明', () => {
    const checks = checkDefinition(definition({ hosts: ['claude'] }), undefined)
    expect(checks.map((check) => check.message).join('\n')).not.toContain('Codex')
  })
})

describe('agent validate / add / new 对骨架的处理', () => {
  let sandbox: string
  let deps: TestDeps
  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), 'tenon-agent-check-'))
    deps = makeDeps({ cwd: join(sandbox, 'project') })
    const configRoot = join(sandbox, 'config')
    deps.agentPaths = () => ({ payloadRoot: REPO_ROOT, configRoot })
    deps.agentLibrary = () => loadAgentLibrary({ payloadRoot: REPO_ROOT, configRoot, projectRoot: deps.cwd })
    deps.knownSkillIds = () => new Set()
  })
  afterEach(() => { rmSync(sandbox, { recursive: true, force: true }) })

  test('`agent new` 登记骨架并提示补全；validate 此时 FAIL；补全后 PASS', async () => {
    expect(await cmdAgentNew(deps, 'api-review', { role: 'reviewer', description: 'API 评审' })).toBe(0)
    expect(deps.outLines.join('\n')).toContain('tenon agent validate api-review')
    deps.outLines.length = 0
    expect(await cmdAgentValidate(deps, 'api-review')).toBe(1)
    expect(deps.outLines.join('\n')).toContain('FAIL api-review')
    expect(deps.outLines.join('\n')).toContain('<第一步>')

    const path = join(sandbox, 'config', 'agents', 'custom', 'api-review.md')
    const text = (await import('node:fs')).readFileSync(path, 'utf8')
    writeFileSync(path, text.replace('<第一步>', '读接口').replace('<第二步>', '比对').replace(/<这个评审者负责的那一件事>/u, '查兼容').replace('<写报告前必须满足的条件>', '有位置'))
    deps.outLines.length = 0
    expect(await cmdAgentValidate(deps, 'api-review')).toBe(0)
  })

  test('`agent add` 拒绝带占位符的文件，什么也不登记', async () => {
    const file = join(sandbox, 'draft.md')
    mkdirSync(sandbox, { recursive: true })
    writeFileSync(file, renderAgentFile({ ...definition(), body: agentBodySkeleton('api-review', 'reviewer', 'API 评审') }))
    expect(await cmdAgentAdd(deps, file, {})).toBe(1)
    expect(deps.errLines.join('\n')).toContain('未登记')
    expect(deps.outLines.join('\n')).toContain('<第一步>')
  })
})
