/**
 * 内建 Track 默认值逐字段断言（codex 2026-07-17 裁决钉死的默认值表）。路由默认值只来自
 * BUILTIN_ROUTER_PATTERNS；模板不得再声明旧路由字段。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'
import type { TrackDefinition } from './types.js'
import {
  BUILTIN_ROUTER_EXCLUDE_PATTERNS,
  BUILTIN_ROUTER_PATTERNS,
  BUILTIN_TRACK_DEFINITIONS,
  BUILTIN_TRACK_IDS,
  builtinTrack,
  isBuiltinTrackId,
} from './builtins.js'

function byId(id: string): TrackDefinition {
  const def = BUILTIN_TRACK_DEFINITIONS.find((t) => t.id === id)
  if (!def) throw new Error(`内建定义缺 ${id}`)
  return def
}

describe('内建 Track 定义', () => {
  test('既有顺序不变并在末尾追加 free；simple 与 standard 各绑定自己的 workflow，其余保持 default', () => {
    expect(BUILTIN_TRACK_DEFINITIONS.map((t) => t.id)).toEqual(['chat', 'simple', 'standard', 'pm', 'frontend', 'backend', 'free'])
    expect([...BUILTIN_TRACK_IDS]).toEqual(['chat', 'simple', 'standard', 'pm', 'frontend', 'backend', 'free'])
    for (const t of BUILTIN_TRACK_DEFINITIONS.filter((item) => item.id !== 'simple' && item.id !== 'standard')) {
      expect(t.builtin, t.id).toBe(true)
      expect(t.workflow, t.id).toEqual({ default: 'default', allowed: '*' })
    }
    expect(byId('simple')).toMatchObject({
      builtin: true,
      workflow: { default: 'simple', allowed: ['simple'] },
    })
    expect(byId('standard')).toMatchObject({
      builtin: true,
      workflow: { default: 'standard', allowed: ['standard'] },
    })
  })

  test('standard：实现类请求的默认通道——优先级压过领域轨、低于 simple，不进矩阵、非 AFK', () => {
    expect(byId('standard')).toEqual({
      id: 'standard',
      label: 'Standard',
      builtin: true,
      workflow: { default: 'standard', allowed: ['standard'] },
      policyProfile: {
        reviewSeed: 'pending',
        automationEligible: false,
        coverageProfile: 'none',
        routing: {
          enabled: true,
          pattern: BUILTIN_ROUTER_PATTERNS.standard,
          excludePattern: BUILTIN_ROUTER_EXCLUDE_PATTERNS.standard,
          priority: 500,
        },
        skills: { matrix: false, profile: '_all' },
      },
    })
    const priority = (id: string): number => byId(id).policyProfile.routing.enabled
      ? (byId(id).policyProfile.routing as { priority: number }).priority
      : 0
    expect(priority('simple')).toBeGreaterThan(priority('standard'))
    for (const domain of ['frontend', 'backend', 'pm']) expect(priority('standard')).toBeGreaterThan(priority(domain))
  })

  // grep -E 的方言以 router.sh 的真实执行为准（tools/test-hooks.sh）；这里用 JS 做语义烟测：审计里漏判的请求必须命中，
  // 重型请求必须被排除正则挡掉，讨论类前缀不在此判定。
  test.each([
    'add a subtract function to src/add.js',
    'refactor the add module',
    '给 src/add.js 加一个减法函数',
    '重构 add 模块',
    '修复分页的 off-by-one，并补一个回归测试',
    'Fix the null check in parseConfig',
  ])('standard 正则命中实现类请求：%s', (prompt) => {
    expect(new RegExp(BUILTIN_ROUTER_PATTERNS.standard, 'i').test(prompt)).toBe(true)
    expect(new RegExp(BUILTIN_ROUTER_EXCLUDE_PATTERNS.standard, 'i').test(prompt)).toBe(false)
  })

  test.each([
    '新增用户登录鉴权，改数据库 schema',
    'migrate the database to postgres',
    '做一个竞品调研并写 PRD',
    '重构整个项目的架构',
    'upgrade dependencies and cut a release',
  ])('standard 排除正则挡住重型请求：%s', (prompt) => {
    expect(new RegExp(BUILTIN_ROUTER_EXCLUDE_PATTERNS.standard, 'i').test(prompt)).toBe(true)
  })

  test.each(['address the committee', 'the changelog is long', 'prefix match'])('standard 英文动词带词边界：%s 不命中', (prompt) => {
    expect(new RegExp(BUILTIN_ROUTER_PATTERNS.standard, 'i').test(prompt)).toBe(false)
  })

  test('chat：pending / automation 可 / coverage none / 不路由 / 不进矩阵、profile _all', () => {
    expect(byId('chat')).toEqual({
      id: 'chat',
      label: 'Chat',
      builtin: true,
      workflow: { default: 'default', allowed: '*' },
      policyProfile: {
        reviewSeed: 'pending',
        automationEligible: true,
        coverageProfile: 'none',
        routing: { enabled: false },
        skills: { matrix: false, profile: '_all' },
      },
    })
  })

  test('simple：严格正向与否决分类、最高优先级、非 AFK、无完整 skill matrix', () => {
    expect(byId('simple')).toEqual({
      id: 'simple',
      label: 'Simple',
      builtin: true,
      workflow: { default: 'simple', allowed: ['simple'] },
      policyProfile: {
        reviewSeed: 'pending',
        automationEligible: false,
        coverageProfile: 'none',
        routing: {
          enabled: true,
          pattern: BUILTIN_ROUTER_PATTERNS.simple,
          excludePattern: BUILTIN_ROUTER_EXCLUDE_PATTERNS.simple,
          priority: 1000,
        },
        skills: { matrix: false, profile: '_all' },
      },
    })
  })

  test('free：全 Workflow 手选、非 AFK、无 coverage/矩阵且永不自动路由', () => {
    expect(byId('free')).toEqual({
      id: 'free',
      label: 'Free',
      builtin: true,
      workflow: { default: 'default', allowed: '*' },
      policyProfile: {
        reviewSeed: 'pending',
        automationEligible: false,
        coverageProfile: 'none',
        routing: { enabled: false },
        skills: { matrix: false, profile: 'free' },
      },
    })
  })

  test('pm：skipped / spec-complete 自动 AFK、保留手动 capability / coverage pm / 路由 priority 100 / 矩阵 profile pm', () => {
    expect(byId('pm')).toEqual({
      id: 'pm',
      label: 'PM',
      builtin: true,
      workflow: { default: 'default', allowed: '*' },
      policyProfile: {
        reviewSeed: 'skipped',
        autoEnqueueOnSpecComplete: true,
        automationEligible: true,
        coverageProfile: 'pm',
        routing: { enabled: true, pattern: BUILTIN_ROUTER_PATTERNS.pm, priority: 100 },
        skills: { matrix: true, profile: 'pm' },
      },
    })
  })

  test('frontend：pending / automation 可 / coverage frontend / 路由 priority 300 / 矩阵 profile frontend', () => {
    expect(byId('frontend')).toEqual({
      id: 'frontend',
      label: 'Frontend',
      builtin: true,
      workflow: { default: 'default', allowed: '*' },
      policyProfile: {
        reviewSeed: 'pending',
        automationEligible: true,
        coverageProfile: 'frontend',
        routing: { enabled: true, pattern: BUILTIN_ROUTER_PATTERNS.frontend, priority: 300 },
        skills: { matrix: true, profile: 'frontend' },
      },
    })
  })

  test('backend：pending / automation 可 / coverage backend / 路由 priority 200 / 矩阵 profile backend', () => {
    expect(byId('backend')).toEqual({
      id: 'backend',
      label: 'Backend',
      builtin: true,
      workflow: { default: 'default', allowed: '*' },
      policyProfile: {
        reviewSeed: 'pending',
        automationEligible: true,
        coverageProfile: 'backend',
        routing: { enabled: true, pattern: BUILTIN_ROUTER_PATTERNS.backend, priority: 200 },
        skills: { matrix: true, profile: 'backend' },
      },
    })
  })

  test('priority 对齐 router.sh 平手序 fe→be→pm（仅严格大于才换轨，先判者赢）：300 > 200 > 100', () => {
    const prio = (id: string): number => {
      const r = byId(id).policyProfile.routing
      if (!r.enabled) throw new Error(`${id} 未启用路由`)
      return r.priority
    }
    expect(prio('frontend')).toBeGreaterThan(prio('backend'))
    expect(prio('backend')).toBeGreaterThan(prio('pm'))
  })

  test('内建 routing 常量是默认真相源，templates manifest 不再镜像路由字段', () => {
    expect(BUILTIN_ROUTER_PATTERNS).toMatchObject({
      simple: expect.stringContaining('typo'),
      frontend:
        '(前端|UI|页面|组件|React|Vue|Next|Tailwind|样式|shadcn|\\.tsx|\\.jsx|\\.vue|web 设计|响应式|button|form|layout)',
      backend: expect.stringContaining('修复'),
      pm: '(调研|竞品|市场|竞争对手|对标|商业模式|PRD|需求|用户旅程|原型|market|立项|产品|user persona|流程图)',
    })
    expect(BUILTIN_ROUTER_EXCLUDE_PATTERNS.simple).toContain('API')

    const manifestPath = fileURLToPath(new URL('../../../../templates/manifest.yaml', import.meta.url))
    const manifest = readFileSync(manifestPath, 'utf8')
    expect(manifest).not.toMatch(/^router_patterns:/m)
  })

  test('isBuiltinTrackId / builtinTrack', () => {
    expect(isBuiltinTrackId('pm')).toBe(true)
    expect(isBuiltinTrackId('data')).toBe(false)
    expect(isBuiltinTrackId('_all')).toBe(false)
    expect(builtinTrack('chat').label).toBe('Chat')
  })
})
