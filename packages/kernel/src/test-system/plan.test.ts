import { describe, expect, it } from 'vitest'
import { parseTestCatalog } from './catalog.js'
import {
  caseMatchesRef, fileRefMatches, formatCaseRef, formatCovers, parseCaseRef, parseCovers,
} from './covers.js'
import {
  emptyTestPlan, normalizeTestPlan, parseTestPlan, planCatalogProblems, serializeTestPlan, testPlanDigest, waiverKey,
  type TestPlan,
} from './plan.js'
import { DESIGN_CATALOG } from './test-support.js'

const CAND_A = `workspace:sha256:${'a'.repeat(64)}`

const DESIGN_PLAN = `schema: tenon-test-plan/v1
change: add-login
suites:
  - { suite: web-unit, scope: changed }
  - { suite: web-e2e,  scope: grep, pattern: "@login" }
  - { suite: api-bench, scope: full }
files:
  - { path: packages/dashboard-app/src/login/Login.test.tsx, suite: web-unit, kind: unit }
  - { path: e2e/login.spec.ts, suite: web-e2e, kind: playwright }
cases:
  - covers: "spec:auth/登录成功跳转首页"
    tests: ["e2e/login.spec.ts › 登录成功跳转首页"]
  - covers: "task:2.3"
    tests: ["Login.test.tsx › 密码为空时禁用提交"]
waivers:
  - { kind: benchmark, reason: 纯文案改动，无性能路径, approved_by: null }
`

function plan(text: string, change?: string): TestPlan {
  const result = parseTestPlan(text, change)
  if (!result.ok) throw new Error(result.issues.map((issue) => `${issue.line}: ${issue.message}`).join('\n'))
  return result.plan
}

function issues(text: string, change?: string): string {
  const result = parseTestPlan(text, change)
  if (result.ok) throw new Error('expected plan issues')
  return result.issues.map((issue) => `${issue.line}: ${issue.message}`).join('\n')
}

describe('covers 与用例引用语法', () => {
  it('spec: / task: 两种 covers', () => {
    expect(parseCovers('spec:auth/登录成功跳转首页')).toEqual({ kind: 'spec', capability: 'auth', title: '登录成功跳转首页' })
    expect(parseCovers('task:2.3')).toEqual({ kind: 'task', id: '2.3' })
    for (const bad of ['spec:/x', 'spec:Auth/x', 'spec:auth/', 'spec:auth/ x', 'task:a', 'task:', 'other:1', 'spec:auth/a\nb']) {
      expect(parseCovers(bad)).toBeUndefined()
    }
    const ref = parseCovers('spec:auth/x')
    expect(ref === undefined ? '' : formatCovers(ref)).toBe('spec:auth/x')
  })

  it('用例引用：文件尾部匹配 + 标题路径尾部匹配', () => {
    const ref = parseCaseRef('Login.test.tsx › 表单 › 密码为空时禁用提交')
    expect(ref).toEqual({ file: 'Login.test.tsx', title: ['表单', '密码为空时禁用提交'] })
    const identity = { file: 'packages/web/src/Login.test.tsx', suite_path: ['登录', '表单'], name: '密码为空时禁用提交' }
    expect(ref !== undefined && caseMatchesRef(ref, identity)).toBe(true)
    expect(caseMatchesRef({ file: 'Login.test.tsx', title: [] }, identity)).toBe(true)
    expect(caseMatchesRef({ file: 'Login.test.tsx', title: ['别的'] }, identity)).toBe(false)
    expect(caseMatchesRef({ file: 'in.test.tsx', title: [] }, identity)).toBe(false)
    expect(caseMatchesRef({ file: 'Login.test.tsx', title: ['x', '登录', '表单', '密码为空时禁用提交'] }, identity)).toBe(false)
    expect(fileRefMatches('src/Login.test.tsx', 'packages/web/src/Login.test.tsx')).toBe(true)
    expect(formatCaseRef(identity)).toBe('packages/web/src/Login.test.tsx › 登录 › 表单 › 密码为空时禁用提交')
    for (const bad of ['', ' › x', '/abs.ts › x', '../a.ts › x', 'a.ts ›  › x']) expect(parseCaseRef(bad)).toBeUndefined()
  })
})

describe('parseTestPlan', () => {
  it('解析设计样例', () => {
    const parsed = plan(DESIGN_PLAN, 'add-login')
    expect(parsed.suites).toEqual([
      { suite: 'web-unit', scope: 'changed' },
      { suite: 'web-e2e', scope: 'grep', pattern: '@login' },
      { suite: 'api-bench', scope: 'full' },
    ])
    expect(parsed.files[1]).toEqual({ path: 'e2e/login.spec.ts', suite: 'web-e2e', kind: 'playwright' })
    expect(parsed.waivers).toEqual([{ kind: 'benchmark', reason: '纯文案改动，无性能路径', approved_by: null }])
  })

  it('步骤测试豁免 test：解析、waiverKey 为 test:<id>、写出可读回', () => {
    const text = DESIGN_PLAN.replace(
      'waivers:\n', 'waivers:\n  - { test: code-size, reason: 迁移脚本一次性生成，超限属实, approved_by: null }\n')
    const parsed = plan(text, 'add-login')
    expect(parsed.waivers).toContainEqual({ test: 'code-size', reason: '迁移脚本一次性生成，超限属实', approved_by: null })
    expect(parsed.waivers.map(waiverKey).sort()).toEqual(['kind:benchmark', 'test:code-size'])
    const written = serializeTestPlan(parsed)
    expect(written).toContain('test: code-size')
    expect(plan(written, 'add-login')).toEqual(normalizeTestPlan(parsed))
    expect(serializeTestPlan(plan(written, 'add-login'))).toBe(written)
    const approved = plan(text.replace('approved_by: null }\n', 'approved_by: boss@x.io }\n'), 'add-login')
    expect(approved.waivers).toContainEqual({ test: 'code-size', reason: '迁移脚本一次性生成，超限属实', approved_by: 'boss@x.io' })
  })

  it('已批准的 test 豁免带被批准的候选 approved_candidate：解析、写出可读回，批准绑定的代码随计划字节一起落盘', () => {
    const text = DESIGN_PLAN.replace(
      'waivers:\n', `waivers:\n  - { test: code-size, reason: 迁移脚本一次性生成，超限属实, approved_by: boss@x.io, approved_candidate: "${CAND_A}" }\n`)
    const parsed = plan(text, 'add-login')
    expect(parsed.waivers).toContainEqual({
      test: 'code-size', reason: '迁移脚本一次性生成，超限属实', approved_by: 'boss@x.io', approved_candidate: CAND_A,
    })
    const written = serializeTestPlan(parsed)
    expect(written).toContain('approved_candidate:')
    expect(plan(written, 'add-login')).toEqual(normalizeTestPlan(parsed))
    expect(serializeTestPlan(plan(written, 'add-login'))).toBe(written)
    // 候选不同的批准是不同的计划内容：摘要不能把它们混为一谈。
    const other = plan(text.replace('a'.repeat(64), 'b'.repeat(64)), 'add-login')
    expect(testPlanDigest(other)).not.toBe(testPlanDigest(parsed))
    // 没有候选的批准（旧版本留下的）仍然能读：它只是不再算「已批准」，判定在 evaluate。
    const legacy = plan(DESIGN_PLAN.replace('waivers:\n', 'waivers:\n  - { test: code-size, reason: 旧, approved_by: boss@x.io }\n'), 'add-login')
    expect(legacy.waivers).toContainEqual({ test: 'code-size', reason: '旧', approved_by: 'boss@x.io' })
  })

  it('test 豁免与同名的 kind 豁免键不冲突，同一个 test 写两次才算重复', () => {
    const same = DESIGN_PLAN.replace(
      'waivers:\n', 'waivers:\n  - { test: unit, reason: 步骤测试, approved_by: null }\n  - { kind: unit, reason: 种类, approved_by: null }\n')
    expect(plan(same).waivers.map(waiverKey).sort()).toEqual(['kind:benchmark', 'kind:unit', 'test:unit'])
    const twice = DESIGN_PLAN.replace(
      'waivers:\n', 'waivers:\n  - { test: code-size, reason: a, approved_by: null }\n  - { test: code-size, reason: b, approved_by: null }\n')
    expect(issues(twice)).toMatch(/豁免 'test:code-size' 重复/)
  })

  it.each([
    ['schema 不对', DESIGN_PLAN.replace('tenon-test-plan/v1', 'x/v1'), /schema 必须是/],
    ['属于别的任务', DESIGN_PLAN, /属于任务 'add-login'，不是 'other'/, 'other'],
    ['未知键', `${DESIGN_PLAN}extra: 1\n`, /不认识键 'extra'/],
    ['grep 缺 pattern', DESIGN_PLAN.replace(', pattern: "@login"', ''), /需要 pattern/],
    ['pattern 只给 grep', DESIGN_PLAN.replace('scope: changed }', 'scope: changed, pattern: x }'), /只有 scope grep 才写 pattern/],
    ['files 范围缺文件', DESIGN_PLAN.replace('scope: changed }', 'scope: files }'), /需要非空 files/],
    ['files 只给 files 范围', DESIGN_PLAN.replace('scope: changed }', 'scope: changed, files: [a.ts] }'), /只有 scope files 才写 files/],
    ['files 范围路径越界', DESIGN_PLAN.replace('scope: changed }', 'scope: files, files: [../a.ts] }'), /仓库内相对路径/],
    ['范围未知', DESIGN_PLAN.replace('scope: changed }', 'scope: some }'), /scope 'some' 不在闭集/],
    ['套件 id 非法', DESIGN_PLAN.replace('suite: web-unit, scope', 'suite: Web, scope'), /suite 'Web' 非法/],
    ['文件路径越界', DESIGN_PLAN.replace('path: e2e/login.spec.ts', 'path: /abs.ts'), /仓库内相对路径/],
    ['文件种类未知', DESIGN_PLAN.replace('kind: playwright }', 'kind: ui }'), /kind 'ui' 不在闭集/],
    ['covers 非法', DESIGN_PLAN.replace('"task:2.3"', '"step:1"'), /covers 'step:1' 非法/],
    ['用例引用非法', DESIGN_PLAN.replace('"Login.test.tsx › 密码为空时禁用提交"', '"../x › y"'), /用例引用 '\.\.\/x › y' 非法/],
    ['映射没有用例', DESIGN_PLAN.replace('tests: ["Login.test.tsx › 密码为空时禁用提交"]', 'tests: []'), /至少需要一个用例/],
    ['豁免同时写 kind 与 covers', DESIGN_PLAN.replace('{ kind: benchmark,', '{ kind: benchmark, covers: "task:1",'), /恰好写 kind、covers 或 test 之一/],
    ['豁免同时写 kind 与 test', DESIGN_PLAN.replace('{ kind: benchmark,', '{ kind: benchmark, test: code-size,'), /恰好写 kind、covers 或 test 之一/],
    ['豁免同时写 covers 与 test', DESIGN_PLAN.replace('{ kind: benchmark,', '{ covers: "task:1", test: code-size,'), /恰好写 kind、covers 或 test 之一/],
    ['豁免三者都没写', DESIGN_PLAN.replace('{ kind: benchmark,', '{'), /恰好写 kind、covers 或 test 之一/],
    ['豁免 covers 非法', DESIGN_PLAN.replace('{ kind: benchmark,', '{ covers: "x",'), /豁免 covers 'x' 非法/],
    ['豁免 test 含非法字符', DESIGN_PLAN.replace('{ kind: benchmark,', '{ test: "a/b",'), /豁免 test 'a\/b' 非法/],
    ['豁免 test 含空格', DESIGN_PLAN.replace('{ kind: benchmark,', '{ test: "code size",'), /豁免 test 'code size' 非法/],
    ['豁免 test 超过 64 字符', DESIGN_PLAN.replace('{ kind: benchmark,', `{ test: ${'a'.repeat(65)},`), /豁免 test 'a{65}' 非法/],
    ['豁免批准人类型不对', DESIGN_PLAN.replace('approved_by: null', 'approved_by: 1'), /approved_by 必须是 null 或批准人/],
    [
      'approved_candidate 写在 kind 豁免上',
      DESIGN_PLAN.replace('approved_by: null', `approved_by: boss@x.io, approved_candidate: "${CAND_A}"`),
      /approved_candidate 只能写在已批准的 test 豁免上/,
    ],
    [
      'approved_candidate 写在 covers 豁免上',
      DESIGN_PLAN.replace('{ kind: benchmark,', '{ covers: "task:1",').replace('approved_by: null', `approved_by: boss@x.io, approved_candidate: "${CAND_A}"`),
      /approved_candidate 只能写在已批准的 test 豁免上/,
    ],
    [
      'approved_candidate 没有批准人（approved_by: null）',
      DESIGN_PLAN.replace('{ kind: benchmark,', '{ test: code-size,').replace('approved_by: null', `approved_by: null, approved_candidate: "${CAND_A}"`),
      /approved_candidate 只能写在已批准的 test 豁免上/,
    ],
    [
      'approved_candidate 没有批准人（缺 approved_by）',
      DESIGN_PLAN.replace('{ kind: benchmark,', '{ test: code-size,').replace(', approved_by: null', `, approved_candidate: "${CAND_A}"`),
      /approved_candidate 只能写在已批准的 test 豁免上/,
    ],
    [
      'approved_candidate 不是工作区指纹',
      DESIGN_PLAN.replace('{ kind: benchmark,', '{ test: code-size,').replace('approved_by: null', 'approved_by: boss@x.io, approved_candidate: "not-a-fingerprint"'),
      /approved_candidate 'not-a-fingerprint' 非法/,
    ],
    [
      'approved_candidate 为空',
      DESIGN_PLAN.replace('{ kind: benchmark,', '{ test: code-size,').replace('approved_by: null', 'approved_by: boss@x.io, approved_candidate: ""'),
      /approved_candidate 必须是非空字符串/,
    ],
    ['豁免缺原因', DESIGN_PLAN.replace(' reason: 纯文案改动，无性能路径,', ''), /reason 缺失/],
    ['套件重复', DESIGN_PLAN.replace('suite: api-bench', 'suite: web-unit'), /套件 'web-unit' 重复/],
    ['YAML 语法错误', 'schema: [x\n', /未闭合/],
    ['不是映射', '- a\n', /测试计划 必须是映射/],
  ])('%s → 拒绝', (_name, text, pattern, change?: string) => {
    expect(issues(text, change)).toMatch(pattern)
  })
})

describe('规范化写出与摘要', () => {
  it('列表排序去重、同键后写者胜；写出可读回；摘要不受声明顺序影响', () => {
    const parsed = plan(DESIGN_PLAN)
    const shuffled: TestPlan = {
      ...parsed,
      suites: [...parsed.suites].reverse(),
      files: [...parsed.files].reverse(),
      cases: parsed.cases.map((item) => ({ ...item, tests: [...item.tests, ...item.tests] })).reverse(),
    }
    expect(serializeTestPlan(shuffled)).toBe(serializeTestPlan(parsed))
    expect(testPlanDigest(shuffled)).toBe(testPlanDigest(parsed))
    const text = serializeTestPlan(parsed)
    expect(plan(text)).toEqual(normalizeTestPlan(parsed))
    expect(serializeTestPlan(plan(text))).toBe(text)
    const approved = { ...parsed, waivers: [{ kind: 'benchmark' as const, reason: 'x', approved_by: 'reviewer@x' }] }
    expect(testPlanDigest(approved)).not.toBe(testPlanDigest(parsed))
  })

  it('空计划可写出与读回', () => {
    const empty = emptyTestPlan('demo')
    expect(plan(serializeTestPlan(empty), 'demo')).toEqual(empty)
  })
})

describe('planCatalogProblems', () => {
  it('套件不在目录、文件指向不存在的套件、种类与套件不符', () => {
    const catalogResult = parseTestCatalog(DESIGN_CATALOG)
    if (!catalogResult.ok) throw new Error('catalog')
    const parsed = plan(DESIGN_PLAN)
    expect(planCatalogProblems(parsed, catalogResult.catalog)).toEqual([])
    const broken: TestPlan = {
      ...parsed,
      suites: [...parsed.suites, { suite: 'gone', scope: 'full' }],
      files: [
        { path: 'a.test.ts', suite: 'nope' },
        { path: 'b.test.ts', suite: 'web-unit', kind: 'e2e' },
      ],
    }
    expect(planCatalogProblems(broken, catalogResult.catalog).map((problem) => problem.message)).toEqual([
      "计划登记的套件 'gone' 不在目录中",
      "测试文件 'a.test.ts' 指向的套件 'nope' 不在目录中",
      "测试文件 'b.test.ts' 声明种类 e2e，但套件 'web-unit' 是 unit",
    ])
  })
})
