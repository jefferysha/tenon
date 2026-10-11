/**
 * `tenon assess` e2e —— 真 kernel + 真临时 fs + 真 git。
 *
 * 开发请求在建任务前先评估轻重：用与改动风险探针（`tenon test diff-risk`）完全相同的分类规则与阈值
 * 评估一组预计要改的文件。阈值是工作流分支里 `diff-risk` 测试的 `pass.metrics`，所以这里用夹具工作流
 * （项目 `.pipeline/workflows/` 与全局存储里的文件），不依赖内建 default 模板里有没有 lite。
 *
 * 覆盖：路径只接受仓库内相对路径（绝对 / `..` / 空 / NUL / 指向仓库外的符号链接）/ 退出码 0·3·1 /
 * `--json` 形状 / 分支没有 diff-risk 测试时报错而不是猜阈值 / 全局存储覆盖过的 default 没有 lite 时不崩溃 /
 * 受保护测试文件数照探针口径 / 与探针对同一组改动给出相同的指标与结论。
 */
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { DEFAULT_WORKFLOW_SOURCE, parseWorkflow, serializeWorkflow, workflowFileCandidates } from '@tenon/kernel'
import type { TrackBranchDef, WorkflowDef } from '@tenon/kernel'
import { defaultWithLiteBranch } from '@tenon/kernel/workflow/test-support'
import { freshHarness, rm, type Harness } from './integration-harness.js'
import { FIXTURE_DATE, putFile, runGit } from './test-git-fixture.js'

const THRESHOLDS: readonly (readonly [string, number])[] = [
  ['files_changed', 8], ['contract_files', 0], ['auth_files', 0], ['dependency_files', 0],
  ['migration_files', 0], ['deleted_tests', 0], ['protected_test_files', 0],
]

const indent = (lines: readonly string[], spaces: number): string[] => lines.map((line) => `${' '.repeat(spaces)}${line}`)

/** 两步（build → done）的 YAML 列表项；`probe` 决定 build 步是否带 diff-risk 测试。 */
const stepLines = (probe: boolean): string[] => [
  '- id: build',
  '  label: 实现',
  '  gate: null',
  '  skills: []',
  '  inputs: []',
  '  outputs: []',
  ...(probe ? [
    '  tests:',
    '    - id: diff-risk',
    '      direction: diff-risk',
    '      command: tenon test diff-risk --json',
    '      label: 改动风险',
    '      timeout_s: 60',
    '      required: true',
    '      pass:',
    '        metrics:',
    ...THRESHOLDS.flatMap(([name, max]) => [`          - name: ${name}`, `            max: ${max}`]),
  ] : []),
  '  guards: []',
  '  transitions:',
  '    - event: build-complete',
  '      to: done',
  '- id: done',
  '  label: 完结',
  '  gate: null',
  '  skills: []',
  '  inputs: []',
  '  outputs: []',
  '  guards: []',
  '  transitions: []',
]

const branchLines = (id: string, label: string, probe: boolean): string[] =>
  [`  ${id}:`, `    label: ${label}`, '    steps:', ...indent(stepLines(probe), 6)]

/** 自定义工作流 `gauge`：lite（带探针）· plain（没有探针）· heavy。 */
const GAUGE = ['name: gauge', 'tracks:', ...branchLines('lite', '轻量', true), ...branchLines('plain', '普通', false), ...branchLines('heavy', '重型', false), ''].join('\n')

/** 平铺的自定义工作流 `solo`：只有隐式轨道，实现步带探针。 */
const SOLO = ['name: solo', 'steps:', ...indent(stepLines(true), 2), ''].join('\n')

/** 夹具提交（FIXTURE_DATE）早于 harness 的固定时钟（任务创建时刻 2026-07-07）；任务里的提交要晚于它。 */
const WORK_DATE = '2026-08-01T00:00:00Z'

let h: Harness
const created: string[] = []

const put = (rel: string, body = ''): Promise<void> => putFile(h.cwd, rel, body)
const vcs = (args: readonly string[], date = FIXTURE_DATE): number | null => runGit(h.cwd, args, date).status

/** 现 default 加一条带探针的 lite 分支（保存进存储，校验放宽后的最小实例）。 */
function defaultWithProbedLite(): WorkflowDef {
  const def = defaultWithLiteBranch()
  const lite = def.tracks?.lite
  if (lite === undefined) throw new Error('夹具缺 lite 分支')
  const probed: TrackBranchDef = {
    ...lite,
    steps: lite.steps.map((step) => step.id !== 'build' ? step : {
      ...step,
      tests: [{
        id: 'diff-risk', direction: 'diff-risk', command: 'tenon test diff-risk --json', required: true,
        pass: { metrics: THRESHOLDS.map(([name, max]) => ({ name, max })) },
      }],
    }),
  }
  return { ...def, tracks: { ...def.tracks, lite: probed } }
}

/** 基线 default 去掉 lite（用户在全局存储里覆盖过的旧 default：没有 lite）。 */
function defaultWithoutLite(): WorkflowDef {
  const def = parseWorkflow(DEFAULT_WORKFLOW_SOURCE)
  const { lite: _lite, ...kept } = def.tracks ?? {}
  return { ...def, tracks: kept }
}

async function assess(...args: string[]): Promise<{ readonly code: number; readonly json: Record<string, unknown> | undefined }> {
  const code = await h.run(['assess', ...args, '--json'])
  const text = h.out.join('\n')
  return { code, json: text.startsWith('{') ? JSON.parse(text) as Record<string, unknown> : undefined }
}

beforeEach(async () => {
  h = await freshHarness()
  await put('.pipeline/workflows/gauge.yaml', GAUGE)
  await put('.pipeline/workflows/solo.yaml', SOLO)
})
afterEach(async () => {
  await rm(h.cwd, { recursive: true, force: true })
  for (const dir of created.splice(0)) await rm(dir, { recursive: true, force: true })
})

describe('tenon assess —— 路径只接受仓库内相对路径', () => {
  test.each([
    ['../etc/passwd', '..'],
    ['src/../../etc/passwd', '..'],
    ['..\\etc\\passwd', '..'],
    ['/etc/passwd', '绝对路径'],
    ['C:\\Windows\\win.ini', '绝对路径'],
    ['', '不能为空'],
    ['   ', '不能为空'],
    ['./', '不能为空'],
    ['src/a\0.ts', 'NUL'],
  ])('%j → 退出码 1，stderr 点明原因，stdout 没有评估结果', async (bad, reason) => {
    const code = await h.run(['assess', '--files', 'src/ok.ts', bad, '--workflow', 'gauge', '--track', 'lite', '--json'])
    expect(code).toBe(1)
    expect(h.err.join('\n')).toContain(reason)
    expect(h.out).toEqual([])
  })

  test('没有 --files → 退出码 1，给出用法', async () => {
    expect(await h.run(['assess', '--workflow', 'gauge', '--track', 'lite'])).toBe(1)
    expect(h.err.join('\n')).toContain('--files')
  })

  test('不跟随仓库外的符号链接：指向仓库外的目录、文件与悬空链接都拒绝，仓库内的符号链接照常评估', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'assess-outside-'))
    created.push(outside)
    await writeFile(join(outside, 'secret.ts'), 'export {}\n', 'utf8')
    await symlink(outside, join(h.cwd, 'linked-dir'))
    await symlink(join(outside, 'secret.ts'), join(h.cwd, 'evil.ts'))
    await symlink(join(outside, 'nowhere.ts'), join(h.cwd, 'dangling.ts'))
    await put('src/real.ts', 'export {}\n')
    await symlink('real.ts', join(h.cwd, 'src', 'alias.ts'))

    for (const bad of ['linked-dir/new.ts', 'linked-dir/secret.ts', 'evil.ts', 'dangling.ts']) {
      expect(await h.run(['assess', '--files', bad, '--workflow', 'gauge', '--track', 'lite', '--json']), bad).toBe(1)
      expect(h.err.join('\n'), bad).toContain('仓库外')
    }
    const inside = await assess('--files', 'src/alias.ts', '--workflow', 'gauge', '--track', 'lite')
    expect(inside.code).toBe(0)
    expect(inside.json?.metrics).toMatchObject({ files_changed: 1 })
  })
})

describe('tenon assess —— 退出码与输出', () => {
  test('三个普通文件 → 退出码 0，--json 形状：workflow / track / metrics / exceeded / reasons / recommendation', async () => {
    await put('src/add.js')
    const { code, json } = await assess('--files', 'src/add.js', 'src/calc.js', 'test/add.test.js', '--workflow', 'gauge', '--track', 'lite')
    expect(code).toBe(0)
    expect(h.err).toEqual([])
    expect(json).toEqual({
      workflow: 'gauge',
      track: 'lite',
      metrics: {
        files_changed: 3, contract_files: 0, auth_files: 0, dependency_files: 0,
        migration_files: 0, deleted_tests: 0, protected_test_files: 0,
      },
      exceeded: false,
      reasons: [],
      recommendation: 'lite',
    })
  })

  test('含鉴权路径的文件 → 退出码 3，reasons 含 auth_files，推荐重型轨道', async () => {
    const { code, json } = await assess('--files', 'src/a.ts', 'packages/server/src/auth/login.ts', '--workflow', 'gauge', '--track', 'lite')
    expect(code).toBe(3)
    expect(json).toMatchObject({ exceeded: true, track: 'lite', metrics: { files_changed: 2, auth_files: 1 } })
    expect(json?.reasons).toEqual(['auth_files 1 > 0'])
    expect(json?.recommendation).toEqual(expect.stringContaining('plain / heavy'))
    expect(json?.recommendation).toEqual(expect.stringContaining('--workflow gauge'))
  })

  test('文件数恰为 8 不超限，9 超限；重复与 ./ 前缀的同一路径只算一次', async () => {
    const files = (count: number) => Array.from({ length: count }, (_, index) => `src/f${index}.js`)
    expect((await assess('--files', ...files(8), '--workflow', 'gauge', '--track', 'lite')).code).toBe(0)
    const nine = await assess('--files', ...files(9), '--workflow', 'gauge', '--track', 'lite')
    expect(nine.code).toBe(3)
    expect(nine.json?.reasons).toEqual(['files_changed 9 > 8'])
    const twice = await assess('--files', 'src/a.js', './src/a.js', 'src//a.js', '--workflow', 'gauge', '--track', 'lite')
    expect(twice.json?.metrics).toMatchObject({ files_changed: 1 })
  })

  test('多项超限一次列出全部', async () => {
    const { code, json } = await assess('--files', 'package.json', 'db/migrations/001_init.sql', 'api/openapi.yaml', '--workflow', 'gauge', '--track', 'lite')
    expect(code).toBe(3)
    expect(json?.reasons).toEqual(['contract_files 1 > 0', 'dependency_files 1 > 0', 'migration_files 1 > 0'])
  })

  test('人读输出：逐项指标、结论、推荐；超限仍是退出码 3', async () => {
    expect(await h.run(['assess', '--files', 'src/a.ts', '--workflow', 'gauge', '--track', 'lite'])).toBe(0)
    expect(h.out.join('\n')).toContain('gauge:lite')
    expect(h.out.join('\n')).toContain('改动文件  1')
    expect(h.out.join('\n')).toContain('未超限')
    expect(h.out.join('\n')).toContain('推荐：lite')
    expect(await h.run(['assess', '--files', 'src/auth/login.ts', '--workflow', 'gauge', '--track', 'lite'])).toBe(3)
    expect(h.out.join('\n')).toContain('auth_files 1 > 0')
    expect(h.err).toEqual([])
  })

  test('英文环境：帮助与结论走英文目录', async () => {
    expect(await h.run(['assess', '--files', 'src/auth/login.ts', '--workflow', 'gauge', '--track', 'lite'], { env: { TENON_LANG: 'en' } })).toBe(3)
    expect(h.out.join('\n')).toContain('exceeded')
    expect(h.out.join('\n')).not.toMatch(/[㐀-鿿]/u)
  })

  test('受保护测试文件数照探针口径：已存在的测试目录算，还没建的（新增）不算', async () => {
    await put('.tenon/tests/catalog.yaml', 'version: 1\n')
    const existing = await assess('--files', '.tenon/tests/catalog.yaml', '--workflow', 'gauge', '--track', 'lite')
    expect(existing.code).toBe(3)
    expect(existing.json?.reasons).toEqual(['protected_test_files 1 > 0'])
    const absent = await assess('--files', '.tenon/tests/known-failures.yaml', '--workflow', 'gauge', '--track', 'lite')
    expect(absent.code).toBe(0)
    const workflowFile = await assess('--files', '.pipeline/workflows/gauge.yaml', '--workflow', 'gauge', '--track', 'lite')
    expect(workflowFile.json?.reasons).toEqual(['protected_test_files 1 > 0'])
  })
})

describe('tenon assess —— 工作流与轨道', () => {
  test('分支没有 diff-risk 测试 → 退出码 1，说明该轨道没有改动风险阈值，不猜阈值', async () => {
    expect(await h.run(['assess', '--files', 'a.ts', '--workflow', 'gauge', '--track', 'plain', '--json'])).toBe(1)
    expect(h.err.join('\n')).toContain('该轨道没有改动风险阈值')
    expect(h.out).toEqual([])
  })

  test('平铺工作流不必指定轨道；有分支的非 default 工作流不写 --track 时列出可选轨道', async () => {
    const flat = await assess('--files', 'a.ts', 'b.ts', '--workflow', 'solo')
    expect(flat.code).toBe(0)
    expect(flat.json).toMatchObject({ workflow: 'solo', track: 'solo', exceeded: false })
    expect(await h.run(['assess', '--files', 'a.ts', '--workflow', 'gauge', '--json'])).toBe(1)
    expect(h.err.join('\n')).toContain('lite, plain, heavy')
  })

  test('默认 --workflow default --track lite：项目里 default 带 lite 探针时直接评估', async () => {
    await put('.pipeline/workflows/default.yaml', serializeWorkflow(defaultWithProbedLite()))
    const ok = await assess('--files', 'a.ts', 'b.ts', 'c.ts')
    expect(ok.code).toBe(0)
    expect(ok.json).toMatchObject({ workflow: 'default', track: 'lite', exceeded: false, recommendation: 'lite' })
    const heavy = await assess('--files', 'src/auth/login.ts')
    expect(heavy.code).toBe(3)
    expect(heavy.json?.recommendation).toEqual(expect.stringContaining('backend'))
  })

  test('全局存储覆盖过的 default 没有 lite：退出码 1 并说明该轨道没有改动风险阈值，不崩溃', async () => {
    const globalFile = workflowFileCandidates(h.cwd, 'default')[1]
    if (globalFile === undefined) throw new Error('没有全局存储候选路径')
    await mkdir(dirname(globalFile), { recursive: true })
    await writeFile(globalFile, serializeWorkflow(defaultWithoutLite()), 'utf8')
    expect(await h.run(['assess', '--files', 'a.ts'])).toBe(1)
    expect(h.err.join('\n')).toContain('该轨道没有改动风险阈值')
    expect(h.err.join('\n')).toContain("'lite'")
  })

  test('工作流不存在或名字非法 → 退出码 1，不创建任何东西', async () => {
    expect(await h.run(['assess', '--files', 'a.ts', '--workflow', 'ghost', '--track', 'lite'])).toBe(1)
    expect(h.err.join('\n')).toContain('ghost')
    expect(await h.run(['assess', '--files', 'a.ts', '--workflow', '../gauge', '--track', 'lite'])).toBe(1)
    expect(h.err.join('\n')).toContain('非法')
  })
})

describe('tenon assess —— 与 tenon test diff-risk 同一套规则', () => {
  const CHANGE = 'fix-add'
  const REAL_DIFF = { env: { TENON_TEST_REAL_DIFF: '1' } }
  const ORDINARY = ['src/add.js', 'src/util.js', 'test/add.test.js']

  async function seedRepo(): Promise<void> {
    await put('package.json', `${JSON.stringify({ name: 'adder', private: true }, null, 2)}\n`)
    await put('src/add.js', 'export const add = (a, b) => a - b\n')
    await put('test/add.test.js', 'export {}\n')
    expect(vcs(['init', '-q'])).toBe(0)
    expect(vcs(['add', '-A'])).toBe(0)
    expect(vcs(['commit', '-q', '-m', 'fixture'])).toBe(0)
    expect(await h.run(['init', CHANGE, '--workflow', 'gauge', '--track', 'lite']), h.err.join('\n')).toBe(0)
  }

  /** 改 src/add.js 并提交，其余文件写进工作区不提交：已提交与未提交的任务改动都算（内容各不相同，都是真改动）。 */
  async function workOn(files: readonly string[], extra: readonly string[] = []): Promise<void> {
    await put('src/add.js', 'export const add = (a, b) => a + b\n')
    expect(vcs(['add', '--', 'src/add.js'], WORK_DATE)).toBe(0)
    expect(vcs(['commit', '-q', '-m', 'fix add'], WORK_DATE)).toBe(0)
    for (const rel of [...files, ...extra].filter((rel) => rel !== 'src/add.js')) await put(rel, `export const touched = ${JSON.stringify(rel)}\n`)
  }

  async function probe(): Promise<Record<string, unknown>> {
    expect(await h.run(['test', 'diff-risk', CHANGE, '--json'], REAL_DIFF), h.err.join('\n')).toBe(0)
    return JSON.parse(h.out.join('\n')) as Record<string, unknown>
  }

  test('三个普通文件：探针与评估给出相同的 metrics 与结论', async () => {
    await seedRepo()
    await workOn(ORDINARY)
    const measured = await probe()
    const { exceeded, reasons, ...metrics } = measured
    const assessed = await assess('--files', ...ORDINARY, '--workflow', 'gauge', '--track', 'lite')
    expect(assessed.json?.metrics).toEqual(metrics)
    expect(assessed.json?.exceeded).toBe(exceeded)
    expect(assessed.json?.reasons).toEqual(reasons)
    expect(exceeded).toBe(false)
    expect(metrics).toMatchObject({ files_changed: 3 })
  })

  test('越线的改动：两边同样的 metrics、同样的 reasons，评估退出码 3', async () => {
    await seedRepo()
    const files = [...ORDINARY, 'src/auth/login.js']
    await workOn(files)
    await put('package.json', `${JSON.stringify({ name: 'adder', private: true, dependencies: { leftpad: '1.0.0' } }, null, 2)}\n`)
    const measured = await probe()
    const { exceeded, reasons, ...metrics } = measured
    const assessed = await assess('--files', ...files, 'package.json', '--workflow', 'gauge', '--track', 'lite')
    expect(assessed.code).toBe(3)
    expect(assessed.json?.metrics).toEqual(metrics)
    expect(exceeded).toBe(true)
    expect(reasons).toEqual(['auth_files 1 > 0', 'dependency_files 1 > 0'])
    expect(assessed.json?.reasons).toEqual(reasons)
  })

  test('探针的输出字段保持兼容：七项指标原样在顶层，只新增 exceeded 与 reasons；退出码仍是 0', async () => {
    await seedRepo()
    await workOn(ORDINARY, ['src/auth/login.js'])
    const measured = await probe()
    expect(Object.keys(measured)).toEqual([
      'files_changed', 'contract_files', 'auth_files', 'dependency_files', 'migration_files',
      'deleted_tests', 'protected_test_files', 'exceeded', 'reasons',
    ])
    expect(measured).toMatchObject({ exceeded: true, reasons: ['auth_files 1 > 0'] })
  })

  test('探针的人读输出带结论', async () => {
    await seedRepo()
    await workOn(ORDINARY, ['src/auth/login.js'])
    expect(await h.run(['test', 'diff-risk', CHANGE], REAL_DIFF)).toBe(0)
    expect(h.out.join('\n')).toContain('改动文件  4')
    expect(h.out.join('\n')).toContain('超限（auth_files 1 > 0）')
  })

  test('任务所在分支没有 diff-risk 测试：探针只给指标，不编造结论', async () => {
    await seedRepo()
    expect(await h.run(['init', 'plain-task', '--workflow', 'gauge', '--track', 'plain']), h.err.join('\n')).toBe(0)
    await workOn(ORDINARY)
    expect(await h.run(['test', 'diff-risk', 'plain-task', '--json'], REAL_DIFF), h.err.join('\n')).toBe(0)
    const measured = JSON.parse(h.out.join('\n')) as Record<string, unknown>
    expect(measured).not.toHaveProperty('exceeded')
    expect(measured).not.toHaveProperty('reasons')
    expect(measured).toMatchObject({ files_changed: 3 })
  })
})
