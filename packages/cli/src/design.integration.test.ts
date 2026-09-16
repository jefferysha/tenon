/**
 * `tenon design check/validate/propose` e2e —— 真 kernel + 真临时仓库；hue 校验器注入假实现，绝不 spawn。
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { buildProgram, CliExit } from './program.js'
import { realDeps, freshHarness, type Harness } from './integration-harness.js'
import type { CliDeps } from './deps.js'

const PREVIEWS = ['design/preview.html', 'design/component-library.html', 'design/landing-page.html', 'design/app-screen.html']
const SECTIONS = [
  'Philosophy', 'Craft Rules', 'Anti-Patterns', 'Tokens', 'Iconography', 'Hero Stage',
  'Components', 'Voice', 'Platform Mapping', 'Previews',
]

const MODEL = ['name: Ridge', 'primitives:', '  gray: {}', 'tokens:', '  light: {}', 'components:', '  button: {}', ''].join('\n')

const designMd = (): string => [
  '---', 'schema: tenon-design/v1', 'model: design/design-model.yaml', 'icons: lucide', '---', '',
  '# Ridge Design System', '',
  ...SECTIONS.flatMap((section, index) => [
    `## ${index + 1}. ${section}`, '',
    section === 'Previews' ? PREVIEWS.map((path) => `- [${path}](${path})`).join('\n') : '正文。', '',
  ]),
].join('\n')

async function seedReady(cwd: string): Promise<void> {
  await mkdir(join(cwd, 'design'), { recursive: true })
  await writeFile(join(cwd, 'DESIGN.md'), designMd(), 'utf8')
  await writeFile(join(cwd, 'design', 'design-model.yaml'), MODEL, 'utf8')
  for (const path of PREVIEWS) await writeFile(join(cwd, path), '<html></html>', 'utf8')
}

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

describe('tenon design', () => {
  let h: Harness
  beforeEach(async () => { h = await freshHarness() })
  afterEach(async () => { await rm(h.cwd, { recursive: true, force: true }) })

  test('check：空仓库缺失 exit 1；就绪 exit 0', async () => {
    const missing = await run(h.cwd, ['design', 'check'])
    expect(missing.code).toBe(1)
    expect(missing.out.join('\n')).toContain('DESIGN.md：缺失')
    await seedReady(h.cwd)
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
    await seedReady(h.cwd)
    const passed = await run(h.cwd, ['design', 'validate'])
    expect(passed.code).toBe(0)
    expect(passed.scripts).toEqual(['/fake/skills/hue/scripts/validate.mjs'])
    const failed = await run(h.cwd, ['design', 'validate'], { validatorCode: 1 })
    expect(failed.code).toBe(1)
    expect(failed.err.join('\n')).toContain('hue 校验未通过')
  })

  test('validate：hue 没装时给安装提示', async () => {
    await seedReady(h.cwd)
    const missing = await run(h.cwd, ['design', 'validate'], { validatorPath: '' })
    expect(missing.code).toBe(1)
    expect(missing.err.join('\n')).toContain('hue 技能未安装')
  })

  test('propose 写骨架；重复 propose exit 1；未合并的提案让 validate 失败', async () => {
    await seedReady(h.cwd)
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
