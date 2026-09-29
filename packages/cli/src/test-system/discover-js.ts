/** JavaScript / TypeScript 工程的测试工具识别（vitest、jest、mocha、node:test、Playwright、tsc、eslint）。 */
import { join } from 'node:path'
import type { TestRunner } from '@tenon/kernel'
import { idPrefix, makeSuite, readSmallText, type DiscoveredSuite, type ProjectDir } from './discover-support.js'
import { isRecord } from './parsers/json.js'
import { RUNNER_PRESETS } from './runner-presets.js'

const TEST_EXT = '{test,spec}.{ts,tsx,js,jsx,mts,cts,mjs,cjs}'

interface Manifest {
  readonly scripts: Readonly<Record<string, string>>
  readonly deps: ReadonlySet<string>
  readonly workspaces: boolean
}

function stringMap(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {}
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
}

async function readManifest(dir: ProjectDir): Promise<Manifest | undefined> {
  if (!dir.names.has('package.json')) return undefined
  const text = await readSmallText(join(dir.abs, 'package.json'))
  if (text === undefined) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!isRecord(parsed)) return undefined
  return {
    scripts: stringMap(parsed.scripts),
    deps: new Set([...Object.keys(stringMap(parsed.dependencies)), ...Object.keys(stringMap(parsed.devDependencies))]),
    workspaces: parsed.workspaces !== undefined,
  }
}

function configFile(dir: ProjectDir, stem: string): string | undefined {
  return ['ts', 'mts', 'cts', 'js', 'mjs', 'cjs', 'json'].map((ext) => `${stem}.${ext}`).find((name) => dir.names.has(name))
}

/** 配置文本里 `include: [ 'a', "b" ]` 的字符串。 */
function includeGlobs(config: string | undefined): string[] {
  const body = config === undefined ? undefined : /\binclude\s*:\s*\[([^\]]*)\]/.exec(config)?.[1]
  return body === undefined ? [] : [...body.matchAll(/['"`]([^'"`]+)['"`]/g)].map((match) => match[1] ?? '').filter((glob) => glob !== '')
}

function stringOption(config: string | undefined, key: string): string | undefined {
  return config === undefined ? undefined : new RegExp(`\\b${key}\\s*:\\s*['"\`]([^'"\`]+)['"\`]`).exec(config)?.[1]
}

function projectNames(config: string | undefined): string[] {
  if (config === undefined) return []
  const start = config.search(/\bprojects\s*:/)
  if (start < 0) return []
  const names = [...config.slice(start).matchAll(/\bname\s*:\s*['"`]([^'"`]+)['"`]/g)].map((match) => match[1] ?? '')
  return [...new Set(names.filter((name) => /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,63}$/.test(name)))]
}

function unitFiles(dir: ProjectDir, included: readonly string[]): string[] {
  if (included.length > 0) return [...included]
  return [dir.names.has('src') ? `src/**/*.${TEST_EXT}` : `**/*.${TEST_EXT}`]
}

function scriptRunsNodeTest(scripts: Readonly<Record<string, string>>): boolean {
  return Object.values(scripts).some((script) => /\bnode\b[^&|;]*--test\b/.test(script))
}

function preset(runner: TestRunner) {
  const found = RUNNER_PRESETS[runner]
  if (found === undefined) throw new Error(`没有 ${runner} 的推荐调用`)
  return found
}

export async function discoverJsTools(dir: ProjectDir, notes: string[]): Promise<readonly DiscoveredSuite[]> {
  const manifest = await readManifest(dir)
  const found: DiscoveredSuite[] = []
  const prefix = idPrefix(dir.rel)
  const where = dir.rel === '.' ? '' : `${dir.rel}/`
  const vitestConfig = configFile(dir, 'vitest.config')
  const jestConfig = configFile(dir, 'jest.config')
  const playwrightConfig = configFile(dir, 'playwright.config')
  const isVitest = vitestConfig !== undefined || manifest?.deps.has('vitest') === true
  const isJest = jestConfig !== undefined || (manifest?.deps.has('jest') === true && !isVitest)
  const isMocha = manifest?.deps.has('mocha') === true || dir.names.has('.mocharc.json') || dir.names.has('.mocharc.js')
  const playwrightText = playwrightConfig === undefined ? undefined : await readSmallText(join(dir.abs, playwrightConfig))
  const e2eDir = stringOption(playwrightText, 'testDir')?.replace(/^\.\//, '')
  const bareWorkspaceRoot = manifest?.workspaces === true && dir.rel === '.' && vitestConfig === undefined && jestConfig === undefined
    && playwrightConfig === undefined
  const label = dir.rel === '.' ? '单测' : `${dir.rel.split('/').at(-1) ?? dir.rel} 单测`

  if (isVitest && !bareWorkspaceRoot) {
    const vitest = preset('vitest')
    const included = includeGlobs(vitestConfig === undefined ? undefined : await readSmallText(join(dir.abs, vitestConfig)))
    const hasCoverageTool = manifest?.deps.has('@vitest/coverage-v8') === true || manifest?.deps.has('@vitest/coverage-istanbul') === true
    found.push({
      source: `${where}${vitestConfig ?? 'package.json'}`,
      suite: makeSuite({
        id: `${prefix}unit`, label, kind: 'unit', runner: 'vitest', cwd: dir.rel,
        command: hasCoverageTool ? `${vitest.command} --coverage --coverage.reporter=json-summary --coverage.reporter=json` : vitest.command,
        files: unitFiles(dir, included),
        covers: dir.names.has('src') ? ['src/**'] : [],
        ...(vitest.select === undefined ? {} : { select: vitest.select }),
        report: vitest.report,
        ...(hasCoverageTool ? { coverage: { format: 'istanbul-summary' as const, path: 'coverage/coverage-summary.json' } } : {}),
        artifacts: hasCoverageTool ? [...vitest.artifacts, 'coverage'] : vitest.artifacts,
      }),
    })
  } else if (isJest) {
    const jest = preset('jest')
    found.push({
      source: `${where}${jestConfig ?? 'package.json'}`,
      suite: makeSuite({
        id: `${prefix}unit`, label, kind: 'unit', runner: 'jest', cwd: dir.rel, command: jest.command,
        files: unitFiles(dir, []),
        ...(jest.select === undefined ? {} : { select: jest.select }), report: jest.report, artifacts: jest.artifacts,
      }),
    })
  } else if (isMocha) {
    const mocha = preset('mocha')
    found.push({
      source: `${where}package.json`,
      suite: makeSuite({
        id: `${prefix}unit`, label, kind: 'unit', runner: 'mocha', cwd: dir.rel, command: mocha.command,
        files: unitFiles(dir, []),
        ...(mocha.select === undefined ? {} : { select: mocha.select }), report: mocha.report, artifacts: mocha.artifacts,
      }),
    })
  } else if (manifest !== undefined && scriptRunsNodeTest(manifest.scripts)) {
    const nodeTest = preset('node-test')
    found.push({
      source: `${where}package.json`,
      suite: makeSuite({
        id: `${prefix}unit`, label, kind: 'unit', runner: 'node-test', cwd: dir.rel, command: nodeTest.command,
        files: unitFiles(dir, []),
        ...(nodeTest.select === undefined ? {} : { select: nodeTest.select }), report: nodeTest.report, artifacts: nodeTest.artifacts,
      }),
    })
  }

  if (playwrightConfig !== undefined) {
    const playwright = preset('playwright')
    found.push({
      source: `${where}${playwrightConfig}`,
      suite: makeSuite({
        id: `${prefix}e2e`, label: '浏览器 e2e', kind: 'playwright', runner: 'playwright', cwd: dir.rel,
        command: playwright.command,
        files: [`${e2eDir ?? 'e2e'}/**/*.${TEST_EXT}`],
        ...(playwright.select === undefined ? {} : { select: playwright.select }),
        report: playwright.report,
        artifacts: playwright.artifacts,
        browsers: projectNames(playwrightText),
        ...(playwright.timeout_s === undefined ? {} : { timeout_s: playwright.timeout_s }),
      }),
    })
    if (playwrightText !== undefined && /\bwebServer\s*:/.test(playwrightText)) {
      notes.push(`${where}${playwrightConfig} 用 webServer 自己启动服务：由 Playwright 管理，Tenon 不重复启动；想让 Tenon 管服务，先删掉 webServer 再用 tenon test catalog add --service`)
    }
  }

  if (manifest !== undefined) {
    const script = ['typecheck', 'type-check'].find((name) => manifest.scripts[name] !== undefined)
    if (script !== undefined || manifest.scripts.tsc !== undefined || (manifest.deps.has('typescript') && dir.names.has('tsconfig.json') && dir.rel === '.')) {
      found.push({
        source: `${where}package.json`,
        suite: makeSuite({
          id: `${prefix}typecheck`, label: '类型检查', kind: 'typecheck', runner: 'tsc', cwd: dir.rel,
          command: script === undefined ? 'npx tsc --noEmit' : `npm run ${script}`,
          covers: ['**/*.{ts,tsx,mts,cts}'],
          report: { format: 'exit-code' },
        }),
      })
    }
    if (manifest.scripts.lint !== undefined) {
      found.push({
        source: `${where}package.json`,
        suite: makeSuite({
          id: `${prefix}lint`, label: 'Lint', kind: 'lint', runner: 'eslint', cwd: dir.rel,
          command: 'npm run lint', report: { format: 'exit-code' },
        }),
      })
    }
    const bench = manifest.scripts.bench ?? manifest.scripts.benchmark
    if (bench !== undefined) {
      notes.push(`${where}package.json 有基准脚本（${bench}）：基准套件必须声明指标与阈值，请手工用 tenon test catalog add --kind benchmark 登记（报告格式 benchmark-json / k6-summary）`)
    }
  }
  if (dir.names.has('cypress.config.ts') || dir.names.has('cypress.config.js')) {
    notes.push(`${where}cypress.config：Cypress 套件需要 junit reporter（每个 spec 一个文件），请手工登记为 kind browser`)
  }
  return found
}
