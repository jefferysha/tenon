/**
 * 平铺工作流（没有 `tracks:`）可在顶层写 `route`，作为它唯一隐式分支的路由数据（设计 §1）。
 * 与分支 `route` 同一套语法与值域校验；没写时解析 / 编译 / 序列化结果与之前逐字相同。
 */
import { describe, expect, it } from 'vitest'
import { compileWorkflow } from './compile.js'
import { parseWorkflow } from './parse.js'
import { resolveTrack } from './resolve-track.js'
import { serializeWorkflow } from './serialize.js'
import { validateWorkflowForStorage, workflowBranches } from './validate.js'

const STEPS = `steps:
  - id: open
    label: 开始
    gate: null
    skills: []
    inputs: []
    outputs: []
    guards: []
    transitions: []
`
const flat = (head: string): string => `name: demo\n${head}\n${STEPS}`

describe('平铺工作流顶层 route · 解析', () => {
  it('块写法与单行 flow map 等价，exclude / fallback 缺省补默认', () => {
    const block = parseWorkflow(flat('route:\n  keywords: [设计体系, token]\n  exclude: [迁移]\n  priority: 400'))
    expect(block.route).toEqual({ keywords: ['设计体系', 'token'], exclude: ['迁移'], priority: 400, fallback: false })
    const inline = parseWorkflow(flat('route: { keywords: [设计体系, token], exclude: [迁移], priority: 400 }'))
    expect(inline).toEqual(block)
  })

  it('不写 route 的平铺工作流不带 route 键', () => {
    expect(parseWorkflow(flat('openspec: true'))).not.toHaveProperty('route')
  })

  it('route 之后的顶层键照常解析（键顺序无关）', () => {
    const wf = parseWorkflow(`name: demo\nroute:\n  keywords: [a]\n  priority: 1\nopenspec: true\n${STEPS}`)
    expect(wf.openspec).toBe(true)
    expect(wf.route?.keywords).toEqual(['a'])
    expect(wf.steps).toHaveLength(1)
  })

  it('重复声明、缺必填项、未知键 fail-loud 并点名顶层 route', () => {
    expect(() => parseWorkflow(flat('route: { keywords: [a], priority: 1 }\nroute: { keywords: [b], priority: 2 }'))).toThrow(/route 重复声明/)
    expect(() => parseWorkflow(flat('route:\n  priority: 1'))).toThrow(/route 缺 keywords/)
    expect(() => parseWorkflow(flat('route:\n  keywords: [a]'))).toThrow(/route 缺 priority/)
    expect(() => parseWorkflow(flat('route:\n  keywords: [a]\n  priority: 1\n  colour: red'))).toThrow(/colour/)
  })

  it('有 tracks 的工作流顶层不得写 route，错误指向分支', () => {
    const src = `name: demo\nroute: { keywords: [a], priority: 1 }\ntracks:\n  x:\n    steps:\n      - id: open\n        gate: null\n        transitions: []\n`
    expect(() => parseWorkflow(src)).toThrow(/tracks\.<id> 下/)
  })
})

describe('平铺工作流顶层 route · 编译、序列化与分支视图', () => {
  const src = flat('route:\n  keywords: [设计体系, token]\n  priority: 400\n  fallback: true')

  it('route 进入 IR 且深冻结；结构化输入与 YAML 走同一条值域校验', () => {
    const ir = compileWorkflow(parseWorkflow(src))
    expect(ir.route).toEqual({ keywords: ['设计体系', 'token'], exclude: [], priority: 400, fallback: true })
    expect(Object.isFrozen(ir.route)).toBe(true)
    expect(Object.isFrozen(ir.route?.keywords)).toBe(true)
    expect(() => compileWorkflow({ ...parseWorkflow(flat('')), route: { keywords: ['a'], priority: -1 } })).toThrow(/route\.priority/)
    expect(() => compileWorkflow({ ...parseWorkflow(flat('')), route: { keywords: ['a,b'], priority: 1 } })).toThrow(/route\.keywords\[0\]/)
    expect(() => compileWorkflow({ ...parseWorkflow(flat('')), route: 'fast' })).toThrow(/route/)
  })

  it('有 tracks 时顶层 route 编译失败；没写 route 的 IR 不出现 route 键（旧指纹不变）', () => {
    const tracked = parseWorkflow(`name: demo\ntracks:\n  x:\n    steps:\n      - id: open\n        gate: null\n        transitions: []\n`)
    expect(() => compileWorkflow({ ...tracked, route: { keywords: ['a'], priority: 1 } })).toThrow(/route.*tracks\.<id>/)
    expect(compileWorkflow(parseWorkflow(flat('')))).not.toHaveProperty('route')
  })

  it('serialize → parse 往返保真，没写 route 时不输出 route 行', () => {
    const def = parseWorkflow(src)
    const text = serializeWorkflow(def)
    expect(text).toContain('route:\n  keywords: [设计体系, token]\n  priority: 400\n  fallback: true\n')
    expect(parseWorkflow(text)).toEqual(def)
    expect(compileWorkflow(parseWorkflow(text))).toEqual(compileWorkflow(def))
    expect(serializeWorkflow(parseWorkflow(flat('')))).not.toMatch(/^route:/mu)
  })

  it('隐式分支带出顶层 route；resolveTrack 的隐式分支同样带出', () => {
    const ir = compileWorkflow(parseWorkflow(src))
    expect(workflowBranches(ir)).toMatchObject([{ track: '', implicit: true, route: { priority: 400, fallback: true } }])
    expect(resolveTrack(ir).route).toEqual(ir.route)
    expect(resolveTrack(compileWorkflow(parseWorkflow(flat('')))).route).toBeUndefined()
  })

  it('存储校验把越界的顶层 route 报成编译错误', () => {
    const bad = { ...parseWorkflow(flat('')), route: { keywords: ['a'], exclude: [], priority: -1, fallback: false } }
    expect(validateWorkflowForStorage('demo', bad)).toContainEqual(expect.stringMatching(/route\.priority/))
    expect(validateWorkflowForStorage('demo', parseWorkflow(src))).toEqual([])
  })
})
