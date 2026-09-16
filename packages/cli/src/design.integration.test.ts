/**
 * `tenon design check/validate/propose` e2e —— 真 kernel + 真临时仓库；hue 校验器注入假实现，绝不 spawn。
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { writeReadyDesignSystem } from '@tenon/kernel/design-system/test-support'
import { buildProgram, CliExit } from './program.js'
import { realDeps, freshHarness, type Harness } from './integration-harness.js'
import type { CliDeps } from './deps.js'

const MODEL = ['name: Ridge', 'primitives:', '  gray: {}', 'tokens:', '  light: {}', 'components:', '  button: {}', ''].join('\n')

const seedReady = (cwd: string): void => writeReadyDesignSystem(cwd)

interface Run { code: number; out: string[]; err: string[]; scripts: string[] }

/** 单独跑一条命令：注入假 hue 校验器（返回 validatorCode），其余用真 deps。 */
async function run(cwd: string, args: string[], options: { validatorCode?: number; validatorPath?: string } = {}): Promise<Run> {
  const out: string[] = []
  const err: string[] = []
  const scripts: string[] = []
  const base = realDeps(cwd, out, err, { ...process.env, TENON_USER: 'tester@tenon.test', TENON_USER_NAME: 'Tester' })
  const deps: CliDeps = {
    ...base,
    designValidator: {
      path: () => options.validatorPath ?? '/fake/skills/hue/scripts/validate.mjs',
      run: async (script) => { scripts.push(script); return options.validatorCode ?? 0 },
    },
  }
  try {
    await buildProgram(deps).parseAsync(['node', 'tenon', ...args])
  } catch (error) {
    if (error instanceof CliExit) return { code: error.code, out, err, scripts }
    throw error
  }
  return { code: 0, out, err, scripts }
}

/** 第一个步骤声明 design-md require 的项目工作流：立项前置条件的最小载体。 */
const REQUIRE_WORKFLOW = `name: needs-design
openspec: true
document_contract:
  version: v1
  slots:
    - { kind: design-md, owner_step: draft, role: require }
  reads: []
steps:
  - id: draft
    label: draft
    gate: null
    skills: []
    inputs: []
    outputs: []
    guards: []
    transitions:
      - event: complete
        to: done
  - id: done
    label: done
    gate: null
    skills: []
    inputs: []
    outputs: []
    guards: []
    transitions: []
`

describe('tenon design', () => {
  let h: Harness
  beforeEach(async () => { h = await freshHarness() })
  afterEach(async () => { await rm(h.cwd, { recursive: true, force: true }) })

  test('check：空仓库缺失 exit 1；就绪 exit 0', async () => {
    const missing = await run(h.cwd, ['design', 'check'])
    expect(missing.code).toBe(1)
    expect(missing.out.join('\n')).toContain('DESIGN.md：缺失')
    seedReady(h.cwd)
    const ready = await run(h.cwd, ['design', 'check'])
    expect(ready.code).toBe(0)
    expect(ready.out.join('\n')).toContain('DESIGN.md：就绪')
  })

  test('check --json：品牌起步文件是 seed', async () => {
    await writeFile(join(h.cwd, 'DESIGN.md'), '# Claude\n', 'utf8')
    const seed = await run(h.cwd, ['design', 'check', '--json'])
    expect(seed.code).toBe(1)
    expect(JSON.parse(seed.out.join('\n'))).toEqual({
      status: 'seed',
      problems: ['DESIGN.md 缺少 schema: tenon-design/v1'],
    })
  })

  test('validate：结构未就绪不跑校验器；就绪则透传退出码', async () => {
    const blocked = await run(h.cwd, ['design', 'validate'])
    expect(blocked.code).toBe(1)
    expect(blocked.scripts).toEqual([])
    seedReady(h.cwd)
    const passed = await run(h.cwd, ['design', 'validate'])
    expect(passed.code).toBe(0)
    expect(passed.scripts).toEqual(['/fake/skills/hue/scripts/validate.mjs'])
    const failed = await run(h.cwd, ['design', 'validate'], { validatorCode: 1 })
    expect(failed.code).toBe(1)
    expect(failed.err.join('\n')).toContain('hue 校验未通过')
  })

  test('validate：hue 没装时给安装提示', async () => {
    seedReady(h.cwd)
    const missing = await run(h.cwd, ['design', 'validate'], { validatorPath: '' })
    expect(missing.code).toBe(1)
    expect(missing.err.join('\n')).toContain('hue 技能未安装')
  })

  test('propose 写骨架；重复 propose exit 1；未合并的提案让 validate 失败', async () => {
    seedReady(h.cwd)
    const proposed = await run(h.cwd, ['design', 'propose', 'add-cards'])
    expect(proposed.code).toBe(0)
    const path = join(h.cwd, 'openspec', 'changes', 'add-cards', 'design-system.md')
    const text = await readFile(path, 'utf8')
    expect(text).toContain('schema: tenon-design-proposal/v1')
    expect(text).toContain('change: add-cards')
    expect(text).toMatch(/base: sha256:[0-9a-f]{64}/u)

    expect((await run(h.cwd, ['design', 'propose', 'add-cards'])).code).toBe(1)

    const unmerged = await run(h.cwd, ['design', 'validate', '--change', 'add-cards'])
    expect(unmerged.code).toBe(1)
    expect(unmerged.err.join('\n')).toContain('设计变更未合并：按 openspec/changes/add-cards/design-system.md')

    await writeFile(join(h.cwd, 'design', 'design-model.yaml'), `${MODEL}extra: {}\n`, 'utf8')
    const merged = await run(h.cwd, ['design', 'validate', '--change', 'add-cards'])
    expect(merged.code).toBe(0)
  })

  test('propose：项目没有 DESIGN.md 时拒绝', async () => {
    const refused = await run(h.cwd, ['design', 'propose', 'add-cards'])
    expect(refused.code).toBe(1)
    expect(refused.err.join('\n')).toContain('先完成设计体系任务')
  })

  test('bare design（无子命令）→ usage exit 1', async () => {
    const usage = await run(h.cwd, ['design'])
    expect(usage.code).toBe(1)
    expect(usage.err.join('\n')).toContain('用法：tenon design')
  })
})

describe('立项前置条件', () => {
  let h: Harness
  beforeEach(async () => {
    h = await freshHarness()
    await mkdir(join(h.cwd, '.pipeline', 'workflows'), { recursive: true })
    await writeFile(join(h.cwd, '.pipeline', 'workflows', 'needs-design.yaml'), REQUIRE_WORKFLOW, 'utf8')
  })
  afterEach(async () => { await rm(h.cwd, { recursive: true, force: true }) })

  const init = (args: string[]) => run(h.cwd, ['init', ...args])

  test('DESIGN.md 未就绪 → exit 1，不留 change 目录', async () => {
    const refused = await init(['ui-work', '--track', 'free', '--workflow', 'needs-design', '--preset', 'full'])
    expect(refused.code).toBe(1)
    expect(refused.err.join('\n')).toContain('要求项目 DESIGN.md 就绪（当前：缺失）')
    expect(refused.err.join('\n')).toContain('tenon init <name> --workflow design-system --track free')
    await expect(readFile(join(h.cwd, 'openspec', 'changes', 'ui-work', '.pipeline.yaml'), 'utf8')).rejects.toThrow()
  })

  test('品牌起步文件也拦：状态是起步', async () => {
    await writeFile(join(h.cwd, 'DESIGN.md'), '# Claude\n', 'utf8')
    const refused = await init(['ui-work', '--track', 'free', '--workflow', 'needs-design', '--preset', 'full'])
    expect(refused.code).toBe(1)
    expect(refused.err.join('\n')).toContain('当前：起步')
  })

  test('就绪后立项通过', async () => {
    seedReady(h.cwd)
    const created = await init(['ui-work', '--track', 'free', '--workflow', 'needs-design', '--preset', 'full'])
    expect(created.code).toBe(0)
    expect(await readFile(join(h.cwd, 'openspec', 'changes', 'ui-work', '.pipeline.yaml'), 'utf8')).toContain('workflow: needs-design')
  })

  test('require 不在第一个步骤的工作流不拦立项', async () => {
    await writeFile(
      join(h.cwd, '.pipeline', 'workflows', 'late-design.yaml'),
      REQUIRE_WORKFLOW.replace('name: needs-design', 'name: late-design').replace('owner_step: draft', 'owner_step: done'),
      'utf8',
    )
    const created = await init(['late-work', '--track', 'free', '--workflow', 'late-design', '--preset', 'full'])
    expect(created.code).toBe(0)
  })
})
