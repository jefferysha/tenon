/**
 * 各 runner 的推荐调用：让命令产出可解析的报告（reporter 参数）、按文件 / 按用例名选择的模板、报告与产物位置。
 * `tenon test discover` 与 `tenon test catalog add --from <方向>` 共用这一份，两处不会各写一套参数。
 */
import { NODE_TEST_REPORTER_ENV, type CatalogReport, type CatalogSelect, type TestRunner } from '@tenon/kernel'

export interface RunnerPreset {
  readonly command: string
  readonly select?: CatalogSelect
  readonly report: CatalogReport
  readonly artifacts: readonly string[]
  readonly timeout_s?: number
  /** 方向模板里「裸调用」的写法（命中时用预设命令替换，其余自定义命令原样保留）。 */
  readonly bare: readonly RegExp[]
}

const VITEST_JSON = '--reporter=default --reporter=json --outputFile.json=test-results/vitest.json'
const PLAYWRIGHT_ENV = 'PLAYWRIGHT_JSON_OUTPUT_NAME=test-results/results.json PLAYWRIGHT_HTML_OPEN=never'
const PLAYWRIGHT_REPORTERS = '--reporter=list,json,html'
// Node 22 及以前内置的 junit reporter 不写 file：tenon test run 通过 TENON_NODE_TEST_REPORTER 提供带 file 的 reporter（见 node-test-reporter.ts），
// 手工在 tenon 之外跑同一条命令时变量为空，退回内置 junit。
const NODE_TEST_JUNIT = `--test-reporter="\${${NODE_TEST_REPORTER_ENV}:-junit}" --test-reporter-destination=test-results/junit.xml`
const PYTEST_JUNIT = '--junitxml=test-results/junit.xml'

export const RUNNER_PRESETS: Readonly<Partial<Record<TestRunner, RunnerPreset>>> = {
  vitest: {
    command: `npx vitest run ${VITEST_JSON}`,
    select: { files: `npx vitest run {files} ${VITEST_JSON}`, grep: `npx vitest run -t {pattern} ${VITEST_JSON}` },
    report: { format: 'vitest-json', path: 'test-results/vitest.json' },
    artifacts: ['test-results'],
    bare: [/^(?:npx )?vitest(?: run)?$/, /^npm (?:run )?test$/],
  },
  jest: {
    command: 'npx jest --json --outputFile=test-results/jest.json',
    select: {
      files: 'npx jest {files} --json --outputFile=test-results/jest.json',
      grep: 'npx jest -t {pattern} --json --outputFile=test-results/jest.json',
    },
    report: { format: 'jest-json', path: 'test-results/jest.json' },
    artifacts: ['test-results'],
    bare: [/^(?:npx )?jest$/],
  },
  mocha: {
    command: 'npx mocha --reporter xunit --reporter-option output=test-results/mocha.xml',
    select: { files: 'npx mocha {files} --reporter xunit --reporter-option output=test-results/mocha.xml' },
    report: { format: 'junit', path: 'test-results/mocha.xml' },
    artifacts: ['test-results'],
    bare: [/^(?:npx )?mocha$/],
  },
  'node-test': {
    command: `node --test ${NODE_TEST_JUNIT}`,
    // reporter 参数必须在文件之前：`node --test <file> --test-reporter=…` 里文件后面的选项是传给测试脚本的参数，
    // reporter 不生效、报告落不了盘（report-missing）。
    select: { files: `node --test ${NODE_TEST_JUNIT} {files}` },
    report: { format: 'junit', path: 'test-results/junit.xml' },
    artifacts: ['test-results'],
    bare: [/^node --test$/],
  },
  playwright: {
    command: `${PLAYWRIGHT_ENV} npx playwright test ${PLAYWRIGHT_REPORTERS}`,
    select: {
      files: `${PLAYWRIGHT_ENV} npx playwright test {files} ${PLAYWRIGHT_REPORTERS}`,
      grep: `${PLAYWRIGHT_ENV} npx playwright test --grep {pattern} ${PLAYWRIGHT_REPORTERS}`,
    },
    report: { format: 'playwright-json', path: 'test-results/results.json' },
    artifacts: ['playwright-report', 'test-results'],
    timeout_s: 1800,
    bare: [/^(?:npx )?playwright test$/],
  },
  pytest: {
    command: `python -m pytest ${PYTEST_JUNIT}`,
    select: { files: `python -m pytest {files} ${PYTEST_JUNIT}`, grep: `python -m pytest -k {pattern} ${PYTEST_JUNIT}` },
    report: { format: 'junit', path: 'test-results/junit.xml' },
    artifacts: ['test-results'],
    bare: [/^(?:python -m )?pytest$/],
  },
  go: {
    command: 'go test -json ./... > test-results/go-test.json',
    select: { grep: 'go test -json ./... -run {pattern} > test-results/go-test.json' },
    report: { format: 'go-json', path: 'test-results/go-test.json' },
    artifacts: ['test-results'],
    bare: [/^go test(?: \.\/\.\.\.)?$/],
  },
  tsc: {
    command: 'npx tsc --noEmit',
    report: { format: 'exit-code' },
    artifacts: [],
    bare: [/^(?:npx )?tsc(?: --noEmit)?$/],
  },
}

const RUNNER_PATTERNS: ReadonlyArray<readonly [TestRunner, RegExp]> = [
  ['playwright', /\bplaywright\b/], ['vitest', /\bvitest\b/], ['jest', /\bjest\b/], ['mocha', /\bmocha\b/],
  ['pytest', /\bpytest\b/], ['go', /\bgo test\b/], ['cargo', /\bcargo (?:test|nextest)\b/], ['cypress', /\bcypress\b/],
  ['tsc', /\btsc\b/], ['eslint', /\beslint\b/], ['node-test', /\bnode\b[^|&;]*--test\b/],
]

/** 从命令文本推断 runner；推不出来是 custom。 */
export function inferRunner(command: string): TestRunner {
  return RUNNER_PATTERNS.find(([, pattern]) => pattern.test(command))?.[0] ?? 'custom'
}
