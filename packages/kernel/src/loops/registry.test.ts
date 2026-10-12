/**
 * loops registry —— 窄 YAML 解析 + schema 关键字子集校验（BACKLOG #35 / GOAL B18/D16）。
 * 真相源：老仓 skills/pipeline/scripts/loops_registry.py（validate 73-141 / load_registry 149-177）
 * + loops.schema.json。本测试覆盖：narrow parser 嵌套结构、schema 子集全关键字、fail-loud、
 * loadRegistry 四态契约（缺文件 / 坏 yaml / 校验失败 / 合法）、autonomy_level 分级放权默认 L1。
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import {
  parseLoopsYaml,
  validateSchema,
  loadRegistry,
  LOOPS_SCHEMA,
  nodeLoopIoStrict,
  RegistryReadError,
  SKILL_BUNDLE_ID_RE,
  type LoopIo,
} from './registry.js'

const VALID_LOOP = `version: 1
loops:
  - id: loop-be
    name: BE 架构编排 loop
    kind: orchestrator
    goal: P1 架构 backlog 每小时发现立项跑通
    cadence: 1h
    risk: medium
    runner: cron-session
    change_prefix: loop-be-
    phases:
      - decide
      - reconcile
      - record
    human_gates:
      - P2 战略项只写提案
    state: .superpowers/loops/progress.md
    design_doc: docs/loops/be.md
    status: active
    budget:
      max_runs_per_day: 24
      max_in_flight: 1
      on_exceed: skip
    kill_criteria:
      - backlog 连续 2 轮空
    autonomy_level: L2
`

describe('parseLoopsYaml —— 窄 YAML 解析（嵌套 mapping/sequence/scalar，零 yaml npm）', () => {
  test('嵌套结构：version int + loops 列表 + 内嵌 budget mapping + 块序列', () => {
    const { data, error } = parseLoopsYaml(VALID_LOOP)
    expect(error).toBeNull()
    const d = data as { version: number; loops: Record<string, unknown>[] }
    expect(d.version).toBe(1)
    expect(d.loops).toHaveLength(1)
    const l = d.loops[0]!
    expect(l.id).toBe('loop-be')
    expect(l.kind).toBe('orchestrator')
    expect(l.change_prefix).toBe('loop-be-')
    expect(l.phases).toEqual(['decide', 'reconcile', 'record'])
    expect(l.human_gates).toEqual(['P2 战略项只写提案'])
    expect(l.budget).toEqual({ max_runs_per_day: 24, max_in_flight: 1, on_exceed: 'skip' })
    expect(l.kill_criteria).toEqual(['backlog 连续 2 轮空'])
    expect(l.autonomy_level).toBe('L2')
  })

  test('注释行 + 空行忽略；行尾注释裁剪（裸标量）', () => {
    const { data, error } = parseLoopsYaml(`# 头注释
version: 1   # 行尾注释

loops:
  - id: x-loop
    kind: executor
`)
    expect(error).toBeNull()
    const d = data as { version: number; loops: Record<string, unknown>[] }
    expect(d.version).toBe(1)
    expect(d.loops[0]!.id).toBe('x-loop')
    expect(d.loops[0]!.kind).toBe('executor')
  })

  test('null 哨兵 / 引号标量 / 内联流式列表', () => {
    const { data } = parseLoopsYaml(`version: 1
loops:
  - id: solo
    change_prefix: null
    goal: "带 # 井号的 引号值"
    phases: [a, b, c]
`)
    const l = (data as { loops: Record<string, unknown>[] }).loops[0]!
    expect(l.change_prefix).toBeNull()
    expect(l.goal).toBe('带 # 井号的 引号值')
    expect(l.phases).toEqual(['a', 'b', 'c'])
  })

  test('顶层非 mapping（裸标量）→ error 非空', () => {
    const { data, error } = parseLoopsYaml('just a string\n')
    expect(data).toBeNull()
    expect(error).not.toBeNull()
  })
})

describe('validateSchema —— JSON Schema 关键字子集（老 validate 73-141）', () => {
  test('合法 registry → 空错误列表', () => {
    const { data } = parseLoopsYaml(VALID_LOOP)
    expect(validateSchema(data, LOOPS_SCHEMA)).toEqual([])
  })

  test('缺 required 字段 → 带 JSON 路径定位的错误', () => {
    const { data } = parseLoopsYaml(`version: 1
loops:
  - id: bad
    kind: orchestrator
`)
    const errs = validateSchema(data, LOOPS_SCHEMA)
    expect(errs.length).toBeGreaterThan(0)
    expect(errs.some((e) => e.includes('loops[0].name') && e.includes('missing required'))).toBe(true)
  })

  test('type 不符 → 定位错误（budget.max_runs_per_day 期望 integer）', () => {
    const bad = { version: 1, loops: [{ ...(parseLoopsYaml(VALID_LOOP).data as { loops: Record<string, unknown>[] }).loops[0], budget: { max_runs_per_day: 'lots', max_in_flight: 1, on_exceed: 'skip' } }] }
    const errs = validateSchema(bad, LOOPS_SCHEMA)
    expect(errs.some((e) => e.includes('loops[0].budget.max_runs_per_day') && e.includes('type'))).toBe(true)
  })

  test('enum 违规（kind 非法）+ pattern 违规（id 非法）', () => {
    const errs = validateSchema({
      version: 1,
      loops: [{ ...(parseLoopsYaml(VALID_LOOP).data as { loops: Record<string, unknown>[] }).loops[0], id: 'Bad_ID', kind: 'boss' }],
    }, LOOPS_SCHEMA)
    expect(errs.some((e) => e.includes('loops[0].id') && e.includes('pattern'))).toBe(true)
    expect(errs.some((e) => e.includes('loops[0].kind') && e.includes('one of'))).toBe(true)
  })

  test('additionalProperties:false → 未知字段报错', () => {
    const errs = validateSchema({
      version: 1,
      loops: [{ ...(parseLoopsYaml(VALID_LOOP).data as { loops: Record<string, unknown>[] }).loops[0], bogus: 'x' }],
    }, LOOPS_SCHEMA)
    expect(errs.some((e) => e.includes('loops[0].bogus') && e.includes('additional'))).toBe(true)
  })

  test('const 违规（version != 1）', () => {
    const errs = validateSchema({ version: 2, loops: [] }, LOOPS_SCHEMA)
    expect(errs.some((e) => e.includes('version') && e.includes('const'))).toBe(true)
  })

  test('minItems 违规（loops 空）', () => {
    const errs = validateSchema({ version: 1, loops: [] }, LOOPS_SCHEMA)
    expect(errs.some((e) => e.includes('loops') && e.includes('minItems'))).toBe(true)
  })

  test('autonomy_level 可选（缺 → 合法）但取值受 enum 约束', () => {
    const raw = parseLoopsYaml(VALID_LOOP).data as { loops: Record<string, unknown>[] }
    const { autonomy_level: _drop, ...noLevel } = raw.loops[0]!
    expect(validateSchema({ version: 1, loops: [noLevel] }, LOOPS_SCHEMA)).toEqual([])
    const errs = validateSchema({ version: 1, loops: [{ ...raw.loops[0], autonomy_level: 'L9' }] }, LOOPS_SCHEMA)
    expect(errs.some((e) => e.includes('autonomy_level') && e.includes('one of'))).toBe(true)
  })

  test('H9 旧 state 可兼容读取但不再是 registry 必填运行状态', () => {
    const raw = parseLoopsYaml(VALID_LOOP).data as { loops: Record<string, unknown>[] }
    const { state: _legacyState, ...withoutLegacyState } = raw.loops[0]!
    expect(validateSchema({ version: 1, loops: [withoutLegacyState] }, LOOPS_SCHEMA)).toEqual([])
  })

  test('fail-loud：schema 出现未实现关键字 → 抛（老 R3 不静默放行）', () => {
    expect(() => validateSchema(1, { type: 'integer', multipleOf: 2 })).toThrow(/unsupported schema keyword/i)
  })

  // H10 §1：skill_bundle_id 可选（缺省合法）；非空须过词法（'_all' 或工作流分支 id 形状）——
  // 存在性语义校验（manifest 是否真声明该 profile）不在本层，属后续任务。
  test('skill_bundle_id 可选（缺省/null 合法）；非空须过 _all|分支 id 词法，否则 type/pattern 报错', () => {
    const raw = parseLoopsYaml(VALID_LOOP).data as { loops: Record<string, unknown>[] }
    expect(validateSchema({ version: 1, loops: [raw.loops[0]] }, LOOPS_SCHEMA)).toEqual([]) // 字段缺席
    expect(validateSchema({ version: 1, loops: [{ ...raw.loops[0], skill_bundle_id: null }] }, LOOPS_SCHEMA)).toEqual([])
    expect(validateSchema({ version: 1, loops: [{ ...raw.loops[0], skill_bundle_id: '_all' }] }, LOOPS_SCHEMA)).toEqual([])
    expect(validateSchema({ version: 1, loops: [{ ...raw.loops[0], skill_bundle_id: 'pm' }] }, LOOPS_SCHEMA)).toEqual([])

    const badShape = validateSchema({ version: 1, loops: [{ ...raw.loops[0], skill_bundle_id: 'Bad_ID' }] }, LOOPS_SCHEMA)
    expect(badShape.some((e) => e.includes('skill_bundle_id') && e.includes('pattern'))).toBe(true)

    const badType = validateSchema({ version: 1, loops: [{ ...raw.loops[0], skill_bundle_id: 123 }] }, LOOPS_SCHEMA)
    expect(badType.some((e) => e.includes('skill_bundle_id') && e.includes('type'))).toBe(true)
  })

  test('SKILL_BUNDLE_ID_RE：工作流分支 id 词法，额外放行保留字 `_all`', () => {
    expect(SKILL_BUNDLE_ID_RE.test('_all')).toBe(true)
    expect(SKILL_BUNDLE_ID_RE.test('pm')).toBe(true)
    expect(SKILL_BUNDLE_ID_RE.test('front-end_2')).toBe(true)
    expect(SKILL_BUNDLE_ID_RE.test('')).toBe(false) // 空串非法（区别于 null 的 unwired 语义）
    expect(SKILL_BUNDLE_ID_RE.test('Bad_ID')).toBe(false) // 大写开头不合法
    expect(SKILL_BUNDLE_ID_RE.test('_secret')).toBe(false) // 下划线开头只放行 `_all` 这一个字面量
    expect(SKILL_BUNDLE_ID_RE.test('a'.repeat(33))).toBe(false) // 超 32 长度上限
  })
})

describe('loadRegistry —— 四态载入契约（老 load_registry 149-177）', () => {
  const io = (files: Record<string, string>): LoopIo => ({
    readText: (p) => (p in files ? files[p]! : null),
  })

  test('文件不存在 → (null, [])', () => {
    const r = loadRegistry('/repo', io({}))
    expect(r.data).toBeNull()
    expect(r.errors).toEqual([])
  })

  test('合法 → data 非空、errors 空、autonomy_level 缺省填 L1（分级放权默认 report-only）', () => {
    const noLevel = VALID_LOOP.replace('    autonomy_level: L2\n', '')
    const r = loadRegistry('/repo', io({ '/repo/.pipeline/loops.yaml': noLevel }))
    expect(r.errors).toEqual([])
    expect(r.data!.loops[0]!.autonomy_level).toBe('L1')
  })

  test('schema 校验失败 → (null, [定位错误])', () => {
    const r = loadRegistry('/repo', io({ '/repo/.pipeline/loops.yaml': 'version: 1\nloops:\n  - id: x\n' }))
    expect(r.data).toBeNull()
    expect(r.errors.length).toBeGreaterThan(0)
  })

  test('顶层非 mapping → (null, [错误])', () => {
    const r = loadRegistry('/repo', io({ '/repo/.pipeline/loops.yaml': 'hello\n' }))
    expect(r.data).toBeNull()
    expect(r.errors.length).toBeGreaterThan(0)
  })

  test('allowlist/denylist（v5 决议 #12 存储侧）：声明 → 原样读回；缺 → 缺省 []', () => {
    const withLists = VALID_LOOP.replace(
      '    autonomy_level: L2\n',
      '    autonomy_level: L2\n    allowlist:\n      - src/**\n    denylist:\n      - secrets/**\n      - "**/*.env"\n',
    )
    const declared = loadRegistry('/repo', io({ '/repo/.pipeline/loops.yaml': withLists }))
    expect(declared.errors).toEqual([])
    expect(declared.data!.loops[0]!.allowlist).toEqual(['src/**'])
    expect(declared.data!.loops[0]!.denylist).toEqual(['secrets/**', '**/*.env'])

    const absent = loadRegistry('/repo', io({ '/repo/.pipeline/loops.yaml': VALID_LOOP }))
    expect(absent.errors).toEqual([])
    expect(absent.data!.loops[0]!.allowlist).toEqual([])
    expect(absent.data!.loops[0]!.denylist).toEqual([])
  })

  test('allowlist/denylist 类型受 schema 约束（非字符串项 → 校验失败）', () => {
    const bad = VALID_LOOP.replace('    autonomy_level: L2\n', '    autonomy_level: L2\n    denylist:\n      - 42\n')
    const r = loadRegistry('/repo', io({ '/repo/.pipeline/loops.yaml': bad }))
    expect(r.data).toBeNull()
    expect(r.errors.some((e) => e.includes('denylist'))).toBe(true)
  })

  // H10 §1：skill_bundle_id——旧登记表兼容（缺字段/显式 null 都归一化为 null=unwired）、
  // 合法非空值原样读回、非法词法值拒绝整份 registry（fail-closed，同其余字段口径）。
  describe('skill_bundle_id（H10 §1：policy 字段，缺省/null=unwired，非空须过词法）', () => {
    test('旧 YAML 缺字段 → 归一化 null（不是空 bundle，也不是默认 bundle）', () => {
      const r = loadRegistry('/repo', io({ '/repo/.pipeline/loops.yaml': VALID_LOOP }))
      expect(r.errors).toEqual([])
      expect(r.data!.loops[0]!.skill_bundle_id).toBeNull()
    })

    test('显式 null → 与缺字段同归一化为 null', () => {
      const withNull = VALID_LOOP.replace(
        '    autonomy_level: L2\n',
        '    autonomy_level: L2\n    skill_bundle_id: null\n',
      )
      const r = loadRegistry('/repo', io({ '/repo/.pipeline/loops.yaml': withNull }))
      expect(r.errors).toEqual([])
      expect(r.data!.loops[0]!.skill_bundle_id).toBeNull()
    })

    test('合法非空值（_all / 具体 profile id）→ 原样读回', () => {
      const withAll = VALID_LOOP.replace(
        '    autonomy_level: L2\n',
        '    autonomy_level: L2\n    skill_bundle_id: _all\n',
      )
      const rAll = loadRegistry('/repo', io({ '/repo/.pipeline/loops.yaml': withAll }))
      expect(rAll.errors).toEqual([])
      expect(rAll.data!.loops[0]!.skill_bundle_id).toBe('_all')

      const withPm = VALID_LOOP.replace(
        '    autonomy_level: L2\n',
        '    autonomy_level: L2\n    skill_bundle_id: pm\n',
      )
      const rPm = loadRegistry('/repo', io({ '/repo/.pipeline/loops.yaml': withPm }))
      expect(rPm.errors).toEqual([])
      expect(rPm.data!.loops[0]!.skill_bundle_id).toBe('pm')
    })

    test('非法词法值 → 整份 registry 拒绝（data:null，errors 提及 skill_bundle_id）', () => {
      for (const bad of ['Bad_ID', '_secret', '', '123']) {
        const withBad = VALID_LOOP.replace(
          '    autonomy_level: L2\n',
          `    autonomy_level: L2\n    skill_bundle_id: "${bad}"\n`,
        )
        const r = loadRegistry('/repo', io({ '/repo/.pipeline/loops.yaml': withBad }))
        expect(r.data, `bad=${JSON.stringify(bad)}`).toBeNull()
        expect(r.errors.some((e) => e.includes('skill_bundle_id'))).toBe(true)
      }
    })
  })

  describe('H11 starter wiring 持久化字段', () => {
    test('旧 YAML 缺四个 wiring 字段仍合法，且载入不凭空持久化状态或改写 status', () => {
      const legacyPaused = VALID_LOOP.replace('    status: active\n', '    status: paused\n')
      const r = loadRegistry('/repo', io({ '/repo/.pipeline/loops.yaml': legacyPaused }))

      expect(r.errors).toEqual([])
      const loop = r.data!.loops[0]!
      expect(loop.status).toBe('paused')
      expect(loop.template_id).toBeUndefined()
      expect(loop.template_version).toBeUndefined()
      expect(loop.workflow_id).toBeUndefined()
      expect(loop.skill_bundle_id).toBeNull()
      expect(loop).not.toHaveProperty('wiring_status')
    })

    test('合法 template/version/workflow/skill bundle 字面量原样载入', () => {
      const wired = VALID_LOOP.replace(
        '    autonomy_level: L2\n',
        [
          '    autonomy_level: L2',
          '    template_id: future-template',
          '    template_version: 1',
          '    workflow_id: release-train',
          '    skill_bundle_id: pm',
          '',
        ].join('\n'),
      )
      const r = loadRegistry('/repo', io({ '/repo/.pipeline/loops.yaml': wired }))

      expect(r.errors).toEqual([])
      expect(r.data!.loops[0]).toMatchObject({
        template_id: 'future-template',
        template_version: 1,
        workflow_id: 'release-train',
        skill_bundle_id: 'pm',
      })
    })

    test('template_version 字段存在时只接受数字 1', () => {
      for (const bad of ['2', '0', '"1"']) {
        const yaml = VALID_LOOP.replace(
          '    autonomy_level: L2\n',
          `    autonomy_level: L2\n    template_version: ${bad}\n`,
        )
        const r = loadRegistry('/repo', io({ '/repo/.pipeline/loops.yaml': yaml }))

        expect(r.data, `bad=${bad}`).toBeNull()
        expect(r.errors.some((e) => e.includes('template_version'))).toBe(true)
      }
    })

    test('template_id 字段存在时须为非空安全 kebab token（registry 不校验 catalog 存在性）', () => {
      for (const bad of ['', 'CI-sweeper', 'ci_sweeper', '../ci-sweeper', '-ci', 'ci-', 'ci--sweeper']) {
        const yaml = VALID_LOOP.replace(
          '    autonomy_level: L2\n',
          `    autonomy_level: L2\n    template_id: "${bad}"\n`,
        )
        const r = loadRegistry('/repo', io({ '/repo/.pipeline/loops.yaml': yaml }))

        expect(r.data, `bad=${JSON.stringify(bad)}`).toBeNull()
        expect(r.errors.some((e) => e.includes('template_id'))).toBe(true)
      }
    })

    test('workflow_id 字段存在时须为安全 workflow identifier', () => {
      for (const bad of ['', 'Release-train', 'release_train', '../release-train', 'dir/release', '-release', 'release-', 'release--train']) {
        const yaml = VALID_LOOP.replace(
          '    autonomy_level: L2\n',
          `    autonomy_level: L2\n    workflow_id: "${bad}"\n`,
        )
        const r = loadRegistry('/repo', io({ '/repo/.pipeline/loops.yaml': yaml }))

        expect(r.data, `bad=${JSON.stringify(bad)}`).toBeNull()
        expect(r.errors.some((e) => e.includes('workflow_id'))).toBe(true)
      }
    })

    test('wiring_status 不是持久化字段，继续按 unknown key 拒绝', () => {
      const yaml = VALID_LOOP.replace(
        '    autonomy_level: L2\n',
        '    autonomy_level: L2\n    wiring_status: ready\n',
      )
      const r = loadRegistry('/repo', io({ '/repo/.pipeline/loops.yaml': yaml }))

      expect(r.data).toBeNull()
      expect(r.errors.some((e) => e.includes('wiring_status') && e.includes('additional'))).toBe(true)
    })
  })
})

/**
 * nodeLoopIoStrict（Stage B 返工 #2）：admission reserve 用——**只** ENOENT→null（合法「无 registry」），
 * 其它真实 I/O 故障（EISDIR/EACCES…）throw RegistryReadError，绝不吞成「文件不存在」。区别于宽容的 nodeLoopIo
 * （不可读→null）。真 fs 临时目录覆盖三态：缺文件 / 合法读回 / 路径是目录（真 EISDIR）。
 */
describe('nodeLoopIoStrict —— 严格 I/O 区分（ENOENT→null；其它 I/O→throw RegistryReadError）', () => {
  let dir: string
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'reg-strict-')) })
  afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

  test('文件不存在（ENOENT）→ null（合法无 registry，不 throw）', () => {
    expect(nodeLoopIoStrict.readText(join(dir, 'nope.yaml'))).toBeNull()
    // 经 loadRegistry：ENOENT → (null, []) 四态契约不变
    expect(loadRegistry(dir, nodeLoopIoStrict)).toEqual({ data: null, errors: [] })
  })

  test('合法文件 → 读回原文', async () => {
    const p = join(dir, 'ok.yaml')
    await writeFile(p, 'version: 1\n', 'utf8')
    expect(nodeLoopIoStrict.readText(p)).toBe('version: 1\n')
  })

  test('路径是目录（真 EISDIR）→ throw RegistryReadError（不吞成 null）', async () => {
    const p = join(dir, 'isdir.yaml')
    await mkdir(p, { recursive: true }) // 路径被目录占据 → readFileSync EISDIR
    expect(() => nodeLoopIoStrict.readText(p)).toThrow(RegistryReadError)
    // 经 loadRegistry：真实 I/O 故障 fail-loud 上抛（不返 (null,[]) 假装无 registry）
    expect(() => loadRegistry(dir, { readText: () => nodeLoopIoStrict.readText(p) })).toThrow(RegistryReadError)
  })
})
