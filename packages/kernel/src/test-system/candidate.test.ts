import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { candidateFingerprint, catalogDeclaredOutputs, declaredTestOutputs, knownPortableCandidate, portableCandidate } from './candidate.js'
import { fingerprintWorkspace } from '../workspace/fingerprint.js'
import { parseTestCatalog } from './catalog.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function put(root: string, path: string, content: string): Promise<void> {
  await mkdir(dirname(join(root, path)), { recursive: true })
  await writeFile(join(root, path), content)
}

async function project(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'tenon-candidate-'))
  roots.push(root)
  await put(root, 'src/app.ts', 'export const a = 1\n')
  await put(root, 'web/src/view.ts', 'export const v = 1\n')
  return root
}

const CATALOG = `schema: tenon-test-catalog/v1
suites:
  - id: unit
    kind: unit
    runner: vitest
    command: npx vitest run
    report: { format: junit, path: test-results/unit.xml }
    coverage: { format: istanbul-summary, path: coverage/coverage-summary.json }
    artifacts: [test-results/screens]
  - id: web
    kind: unit
    runner: vitest
    command: npx vitest run
    cwd: web
    report: { format: vitest-json, path: test-results/web.json }
    artifacts: [playwright-report]
  - id: types
    kind: typecheck
    runner: tsc
    command: npx tsc --noEmit
`

describe('目录声明的产物路径', () => {
  it('报告、覆盖率（含 istanbul 旁的 coverage-final.json）与 artifacts 都按套件 cwd 换算成仓库相对路径', () => {
    const parsed = parseTestCatalog(CATALOG)
    if (!parsed.ok) throw new Error('catalog')
    expect(catalogDeclaredOutputs(parsed.catalog)).toEqual([
      'coverage/coverage-final.json',
      'coverage/coverage-summary.json',
      'test-results/screens',
      'test-results/unit.xml',
      'web/playwright-report',
      'web/test-results/web.json',
    ])
  })
})

describe('候选指纹（生产口径）', () => {
  it('目录声明的报告与产物不动候选；同名目录下未声明的文件、别处的 coverage/ 动候选', async () => {
    const root = await project()
    await put(root, '.tenon/tests/catalog.yaml', CATALOG)
    const first = await candidateFingerprint(root)
    await put(root, 'test-results/unit.xml', '<testsuite/>')
    await put(root, 'test-results/screens/a.png', 'png')
    await put(root, 'coverage/coverage-summary.json', '{}')
    await put(root, 'coverage/coverage-final.json', '{}')
    await put(root, 'web/test-results/web.json', '{}')
    await put(root, 'web/playwright-report/index.html', '<html/>')
    expect(await candidateFingerprint(root)).toBe(first)
    await put(root, 'test-results/notes.txt', 'not declared')
    expect(await candidateFingerprint(root)).not.toBe(first)
    await rm(join(root, 'test-results/notes.txt'))
    expect(await candidateFingerprint(root)).toBe(first)
    await put(root, 'src/coverage/payload.js', 'export {}')
    expect(await candidateFingerprint(root)).not.toBe(first)
  })

  it('没有目录（或目录无效）时没有声明：产出报告的目录计入候选', async () => {
    const root = await project()
    const first = await candidateFingerprint(root)
    await put(root, 'test-results/unit.xml', '<testsuite/>')
    expect(await candidateFingerprint(root)).not.toBe(first)
    await put(root, '.tenon/tests/catalog.yaml', 'schema: nope\n')
    expect(await declaredTestOutputs(root)).toEqual([])
  })

  it('任务冻结工作流里的内联测试输出也是声明；已归档任务的不算', async () => {
    const root = await project()
    const snapshot = (path: string): string => JSON.stringify({
      version: 1, run_id: 'r', plan: { workflow: { steps: [{ tests: [{ outputs: [{ path }] }] }, { tests: [{ outputs: [{ path: '../escape' }] }] }] } },
    })
    await put(root, 'openspec/changes/live/.pipeline-workflow-plan.json', snapshot('playwright-report'))
    await put(root, 'openspec/changes/archive/2026-01-01-old/.pipeline-workflow-plan.json', snapshot('old-report'))
    expect(await declaredTestOutputs(root)).toEqual(['playwright-report'])
    const first = await candidateFingerprint(root)
    await put(root, 'playwright-report/index.html', '<html/>')
    expect(await candidateFingerprint(root)).toBe(first)
    await put(root, 'old-report/index.html', '<html/>')
    expect(await candidateFingerprint(root)).not.toBe(first)
  })

  it('完整指纹照算宿主本地文件，可移植孪生不算；孪生由同一次遍历得到并记在表里', async () => {
    const root = await project()
    const clean = await candidateFingerprint(root)
    const cleanPortable = knownPortableCandidate(clean)
    expect(cleanPortable, '同一次遍历同时得到可移植孪生').toBeDefined()

    await put(root, '.claude/settings.local.json', '{ "permissions": { "allow": ["Bash(ls)"] } }\n')
    const full = await candidateFingerprint(root)
    expect(full).not.toBe(clean)
    expect(knownPortableCandidate(full), '没有宿主本地文件的克隆算出同一个可移植值').toBe(cleanPortable)

    // Claude Code 改写这个文件：完整指纹变了，孪生不变。
    await put(root, '.claude/settings.local.json', '{ "permissions": { "allow": ["Bash(ls)", "Bash(npm test)"] } }\n')
    const edited = await candidateFingerprint(root)
    expect(edited).not.toBe(full)
    expect(knownPortableCandidate(edited)).toBe(cleanPortable)
  })

  it('表里没有的完整指纹：重新遍历一次；树已经变了（完整指纹对不上）就不冒充孪生', async () => {
    const root = await project()
    await put(root, 'CLAUDE.local.md', 'private\n')
    // 不经 candidateFingerprint 算出来的值不在表里（例如表项被挤掉）。
    const unknown = await fingerprintWorkspace(root, { declaredOutputs: await declaredTestOutputs(root) })
    expect(knownPortableCandidate(unknown)).toBeUndefined()
    const twin = await portableCandidate(root, unknown)
    expect(twin).toBeDefined()
    expect(twin).not.toBe(unknown)
    expect(knownPortableCandidate(unknown)).toBe(twin)

    // 树自那之后变了：旧的完整指纹对不上现在的树，不能把现在的孪生冒充给它。
    await put(root, 'src/app.ts', 'export const a = 2\n')
    expect(await portableCandidate(root, unknown)).toBe(twin)
    await rm(join(root, 'src/app.ts'))
    expect(await portableCandidate(root, `workspace:sha256:${'0'.repeat(64)}`)).toBeUndefined()
    expect(await portableCandidate(join(root, 'does-not-exist'), `workspace:sha256:${'1'.repeat(64)}`)).toBeUndefined()
  })
})
