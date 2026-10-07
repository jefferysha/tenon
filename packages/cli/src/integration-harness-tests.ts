/**
 * 测试体系集成用例的夹具：在临时项目里铺一个真实的 vitest 工程 / Playwright 工程（node_modules 软链到本仓，
 * 用本仓已安装的 vitest 与 playwright 真跑），并提供最小的 git 操作（提交日期可控，「自任务起点以来」的 diff 才可测）。
 * 只给集成测试用；不进 dist（tsconfig 排除），也不属于任何生产路径。
 */
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { REPO_ROOT } from './integration-harness.js'
import { isRecord } from './test-system/parsers/json.js'
import { majorOfInstalledVersion } from './test-system/vitest-version.js'

export async function writeFiles(cwd: string, files: Readonly<Record<string, string>>): Promise<void> {
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(cwd, path)), { recursive: true })
    await writeFile(join(cwd, path), text, 'utf8')
  }
}

export async function linkNodeModules(cwd: string): Promise<void> {
  await symlink(join(REPO_ROOT, 'node_modules'), join(cwd, 'node_modules'), 'dir')
}

const GIT_ENV = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' }

export function git(cwd: string, args: readonly string[], date?: string): string {
  return execFileSync('git', ['-c', 'user.email=t@t.test', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], {
    cwd, encoding: 'utf8',
    env: { ...process.env, ...GIT_ENV, ...(date === undefined ? {} : { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }) },
  })
}

export function initGit(cwd: string): void {
  git(cwd, ['init', '-q', '-b', 'main'])
  // 测试产物、依赖与 Tenon 自己的状态不进提交（.tenon 里的记录由 tenon 管，不是被测代码）。
  execFileSync('sh', ['-c', "printf 'node_modules\\ntest-results\\nplaywright-report\\ncoverage\\n.tenon\\nopenspec\\n.pipeline\\n.pipeline-*\\n' > .gitignore"], { cwd })
}

export function commitAll(cwd: string, message: string, date: string): void {
  git(cwd, ['add', '-A'])
  git(cwd, ['commit', '-q', '-m', message, '--allow-empty'], date)
}

export const VITEST_FILES: Readonly<Record<string, string>> = {
  'package.json': '{ "name": "fixture", "private": true, "type": "module" }\n',
  'vitest.config.ts': "import { defineConfig } from 'vitest/config'\nexport default defineConfig({ test: { include: ['src/**/*.test.ts'] } })\n",
  'src/math.ts': 'export const add = (a: number, b: number): number => a + b\nexport const sub = (a: number, b: number): number => a - b\n',
  'src/math.test.ts': "import { describe, expect, test } from 'vitest'\nimport { add } from './math'\ndescribe('math', () => {\n  test('adds', () => { expect(add(1, 2)).toBe(3) })\n  test('adds negatives', () => { expect(add(-1, -2)).toBe(-3) })\n})\n",
}

/**
 * vitest 5 的 bench 写法：`bench` 是测试里的 fixture，`bench(名字, 选项?, 函数).run(运行选项?)`（time / iterations 在运行选项里，压短耗时）。
 * vitest ≤4 的 `import { bench } from 'vitest'` 在 5 上直接 "bench is not a function"，所以夹具按装的主版本选写法。
 */
export const VITEST5_BENCH_FILE = `import { describe, test } from 'vitest'
const RUN = { time: 30, iterations: 5, warmupTime: 0, warmupIterations: 0 }
describe('sorting', () => {
  test('sorts', async ({ bench }) => {
    await bench('native sort', () => { [3, 1, 2].sort() }).run(RUN)
    await bench('reverse sort', () => { [3, 1, 2].sort().reverse() }).run(RUN)
  })
})
`

/** 本仓 node_modules 里装的 vitest 主版本（linkNodeModules 软链的就是它）。 */
export async function repoVitestMajor(): Promise<number> {
  const manifest: unknown = JSON.parse(await readFile(join(REPO_ROOT, 'node_modules', 'vitest', 'package.json'), 'utf8'))
  const version = isRecord(manifest) ? manifest.version : undefined
  const major = typeof version === 'string' ? majorOfInstalledVersion(version) : undefined
  if (major === undefined) throw new Error('本仓 node_modules/vitest/package.json 里读不出 vitest 版本')
  return major
}

export function playwrightFiles(options: { readonly port: number; readonly projects: readonly string[] }): Record<string, string> {
  const projects = options.projects.map((name) => `{ name: '${name}', use: { ...devices['${name === 'chromium' ? 'Desktop Chrome' : name === 'webkit' ? 'Desktop Safari' : 'Desktop Firefox'}'] } }`).join(', ')
  return {
    'server.mjs': [
      "import { createServer } from 'node:http'",
      "createServer((request, response) => {",
      "  response.setHeader('content-type', 'text/html')",
      "  response.end('<!doctype html><title>Home</title><h1 id=\"title\">Hello Tenon</h1>')",
      `}).listen(${options.port}, '127.0.0.1', () => console.log('server ready'))`,
      '',
    ].join('\n'),
    'playwright.config.ts': [
      "import { defineConfig, devices } from 'playwright/test'",
      'export default defineConfig({',
      "  testDir: 'e2e',",
      `  use: { baseURL: 'http://127.0.0.1:${options.port}', screenshot: 'only-on-failure', trace: 'retain-on-failure' },`,
      `  projects: [${projects}],`,
      '})',
      '',
    ].join('\n'),
    'e2e/home.spec.ts': [
      "import { expect, test } from 'playwright/test'",
      "test('home page shows the title', async ({ page }) => {",
      "  await page.goto('/')",
      "  await expect(page.locator('#title')).toHaveText('Hello Tenon')",
      '})',
      '',
    ].join('\n'),
  }
}
