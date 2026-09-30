/**
 * Dashboard 浏览器 e2e。项目：chromium 与 webkit；被测服务、种子项目与随机端口见 support/serve.mjs。
 * 报告与产物只写 test-results/、playwright-report/（工作区指纹排除它们，目录校验也要求如此）。
 * playwright-report 与 results 文件名固定，目录里的 dashboard-e2e 套件按这些路径读。
 */
import { fileURLToPath } from 'node:url'
import { defineConfig, devices } from 'playwright/test'

const root = fileURLToPath(new URL('../../', import.meta.url))
const inCi = process.env.CI !== undefined && process.env.CI !== ''

export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.ts',
  outputDir: `${root}test-results/dashboard-e2e`,
  globalSetup: './global-setup.ts',
  globalTeardown: './global-teardown.ts',
  // 所有用例共用一个被测服务和它的种子项目；串行，才不会互相踩状态。
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  retries: inCi ? 1 : 0,
  reporter: [
    ['list'],
    ['json', { outputFile: `${root}test-results/dashboard-e2e.json` }],
    ['html', { outputFolder: `${root}playwright-report`, open: 'never' }],
  ],
  use: {
    locale: 'zh-CN',
    viewport: { width: 1440, height: 900 },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    video: 'off',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
    { name: 'webkit', use: { ...devices['Desktop Safari'], viewport: { width: 1440, height: 900 } } },
  ],
})
