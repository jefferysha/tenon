import { describe, expect, it } from 'vitest'
import { compileWorkflow } from '../workflow/compile.js'
import type { WorkflowIR } from '../workflow/ir.js'
import { parseWorkflow } from '../workflow/parse.js'
import { serializeWorkflow } from '../workflow/serialize.js'
import { compiledDefault, targetDefaultWorkflow } from '../workflow/test-support.js'
import {
  buildRouterTable, isBuiltinRouterWorkflow, MAX_ROUTER_ROWS, ROUTER_SCHEMA,
  type RouterSourceScope, type RouterWorkflowSource,
} from './router-table.js'

const STEPS = `    steps:
      - id: open
        label: 开始
        gate: null
        skills: []
        inputs: []
        outputs: []
        guards: []
        transitions: []`

/** 带分支的工作流：`branches` 的每项是 `[分支 id, 该分支 route 的 YAML 行（缩进 4 格）]`。 */
function branched(name: string, branches: ReadonlyArray<readonly [string, string]>): string {
  const body = branches.map(([id, route]) => `  ${id}:\n    label: ${id.toUpperCase()}\n${route === '' ? '' : `${route}\n`}${STEPS}`).join('\n')
  return `name: ${name}\ntracks:\n${body}\n`
}

const FLAT_STEPS = STEPS.replace(/^ {4}/gmu, '')

function flatYaml(name: string, head = ''): string {
  return `name: ${name}\n${head === '' ? '' : `${head}\n`}${FLAT_STEPS}\n`
}

/** 以给定 YAML 文本编译出的来源条目；编译失败就是一个坏工作流。 */
function wf(
  id: string,
  content: string,
  scope: RouterSourceScope = 'template',
  builtin = isBuiltinRouterWorkflow(id),
): RouterWorkflowSource {
  let ir: WorkflowIR | Error
  try {
    ir = compileWorkflow(parseWorkflow(content))
  } catch (e) {
    ir = e instanceof Error ? e : new Error(String(e))
  }
  return { id, scope, source: content, ir, builtin }
}

/** 目标形态的 default（lite 500、backend 200 兜底；pm / frontend 没写 route），以模板范围的来源条目给出。 */
function defaultEntry(): RouterWorkflowSource {
  return { id: 'default', scope: 'template', source: serializeWorkflow(targetDefaultWorkflow()), ir: compiledDefault(), builtin: true }
}

const key = (rows: ReadonlyArray<{ workflow: string; track: string }>): string[] => rows.map((r) => `${r.workflow}:${r.track}`)

describe('buildRouterTable', () => {
  it('每条分支一行：带 route 的可路由，没有 route 的也在表里（可点名）但不参与打分', () => {
    const src = branched('demo', [
      ['alpha', '    route:\n      keywords: [修复, typo]\n      exclude: [迁移]\n      priority: 500'],
      ['beta', ''],
    ])
    const table = buildRouterTable([wf('demo', src)])
    expect(table.schema).toBe(ROUTER_SCHEMA)
    expect(ROUTER_SCHEMA).toBe('router.v6')
    expect(table.rows).toEqual([
      { workflow: 'demo', track: 'alpha', label: 'ALPHA', routable: true, priority: 500, keywords: ['修复', 'typo'], exclude: ['迁移'], fallback: false, builtin: false },
      { workflow: 'demo', track: 'beta', label: 'BETA', routable: false, priority: 0, keywords: [], exclude: [], fallback: false, builtin: false },
    ])
    expect(table.warnings).toEqual([])
  })

  it('同一工作流内按优先级从高到低；内建工作流排在自定义工作流之前', () => {
    const lows = branched('zeta', [['low', '    route: { keywords: [a], priority: 10 }'], ['high', '    route: { keywords: [b], priority: 900 }']])
    const table = buildRouterTable([wf('zeta', lows, 'global'), defaultEntry()])
    expect(key(table.rows)).toEqual(['default:lite', 'default:frontend', 'default:backend', 'default:pm', 'zeta:high', 'zeta:low'])
    expect(table.rows.map((r) => r.builtin)).toEqual([true, true, true, true, false, false])
  })

  it('平铺工作流：顶层 route 成为唯一隐式分支的路由，轨道 id 就是工作流名', () => {
    const routed = buildRouterTable([wf('design-system', flatYaml('design-system', 'route: { keywords: [设计体系, token], priority: 400, fallback: true }'))])
    expect(routed.rows).toEqual([
      { workflow: 'design-system', track: 'design-system', label: 'design-system', routable: true, priority: 400, keywords: ['设计体系', 'token'], exclude: [], fallback: true, builtin: true },
    ])
    const plain = buildRouterTable([wf('notes', flatYaml('notes'))])
    expect(plain.rows).toMatchObject([{ workflow: 'notes', track: 'notes', routable: false, priority: 0, keywords: [] }])
  })

  it('坏工作流跳过并警告一行，其余工作流照常路由', () => {
    const table = buildRouterTable([
      defaultEntry(),
      { id: 'broken', scope: 'global', source: 'name: broken\n???', ir: new Error('parse'), builtin: false },
    ])
    expect(key(table.rows)).toEqual(['default:lite', 'default:frontend', 'default:backend', 'default:pm'])
    expect(table.warnings).toHaveLength(1)
    expect(table.warnings[0]).toMatch(/broken/u)
    expect(table.warnings[0]).toMatch(/global/u)
  })

  it('项目文件遮住全局和模板；遮蔽者写坏时回退到下一份可用的并警告', () => {
    const template = flatYaml('catalog', 'route: { keywords: [目录], priority: 100 }')
    const project = flatYaml('catalog', 'route: { keywords: [商品], priority: 700 }')
    const shadowed = buildRouterTable([wf('catalog', project, 'project'), wf('catalog', template, 'template')])
    expect(shadowed.rows).toMatchObject([{ workflow: 'catalog', priority: 700, keywords: ['商品'] }])
    expect(shadowed.warnings).toEqual([])

    const brokenProject: RouterWorkflowSource = { id: 'catalog', scope: 'project', source: 'name: catalog\n???', ir: new Error('坏了'), builtin: false }
    const fallback = buildRouterTable([brokenProject, wf('catalog', template, 'template')])
    expect(fallback.rows).toMatchObject([{ workflow: 'catalog', priority: 100, keywords: ['目录'] }])
    expect(fallback.warnings).toHaveLength(1)
    expect(fallback.warnings[0]).toMatch(/catalog.*project/u)

    const lateBroken = buildRouterTable([wf('catalog', project, 'project'), { ...brokenProject, scope: 'template' }])
    expect(lateBroken.warnings).toEqual([])
  })

  it('sourceDigest 覆盖每一份文件内容，包括被遮住的那份；内容不变则稳定', () => {
    const digest = (a: string, b: string): string =>
      buildRouterTable([wf('a', flatYaml('a', a), 'project'), wf('a', flatYaml('a', b), 'template')]).sourceDigest
    const base = digest('route: { keywords: [x], priority: 1 }', 'route: { keywords: [y], priority: 1 }')
    expect(base).toMatch(/^[0-9a-f]{64}$/u)
    expect(digest('route: { keywords: [x], priority: 1 }', 'route: { keywords: [y], priority: 1 }')).toBe(base)
    expect(digest('route: { keywords: [x2], priority: 1 }', 'route: { keywords: [y], priority: 1 }')).not.toBe(base)
    expect(digest('route: { keywords: [x], priority: 1 }', 'route: { keywords: [y2], priority: 1 }')).not.toBe(base)
    expect(buildRouterTable([wf('a', 'x')]).sourceDigest).not.toBe(buildRouterTable([wf('a', 'y')]).sourceDigest)
  })

  it('同样的内容放在不同范围里摘要不同；没有任何文件时摘要也有定义', () => {
    const body = flatYaml('a')
    expect(buildRouterTable([wf('a', body, 'project')]).sourceDigest).not.toBe(buildRouterTable([wf('a', body, 'global')]).sourceDigest)
    expect(buildRouterTable([]).sourceDigest).toMatch(/^[0-9a-f]{64}$/u)
    expect(buildRouterTable([]).rows).toEqual([])
  })

  it(`行数以 ${MAX_ROUTER_ROWS} 为界：多出的丢弃并警告`, () => {
    const many = branched('many', Array.from({ length: 40 }, (_, i): readonly [string, string] => [`t${i}`, `    route: { keywords: [k${i}], priority: ${i} }`]))
    const more = branched('more', Array.from({ length: 40 }, (_, i): readonly [string, string] => [`u${i}`, `    route: { keywords: [m${i}], priority: ${i} }`]))
    const table = buildRouterTable([wf('many', many), wf('more', more)])
    expect(table.rows).toHaveLength(MAX_ROUTER_ROWS)
    expect(table.warnings).toEqual([expect.stringMatching(/64/u)])
  })

  it('输入的顺序决定遮蔽优先级，但不改变输出行的相对稳定性', () => {
    const a = wf('aaa', flatYaml('aaa', 'route: { keywords: [x], priority: 5 }'))
    const b = wf('bbb', flatYaml('bbb', 'route: { keywords: [y], priority: 5 }'))
    expect(key(buildRouterTable([a, b]).rows)).toEqual(['aaa:aaa', 'bbb:bbb'])
    expect(key(buildRouterTable([b, a]).rows)).toEqual(['aaa:aaa', 'bbb:bbb'])
  })
})
