import { availableParallelism } from 'node:os'
import { configDefaults, defineConfig } from 'vitest/config'

// 真实文件系统 / 子进程 / Docker 的集成套件在多核机器上被默认并发压得超时（16 核默认约 15 个 worker 时，
// 单独跑都过的用例会超 15s / 30s）。上限固定为 8，小机器仍按核数：本地与 CI 用同一套并发规则，
// 改并发只改这一处（命令行 `--maxWorkers` 仍可覆盖）。
const MAX_TEST_WORKERS = 8

export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.test.ts'],
    // e2e/ 是 Playwright 的 *.spec.ts，由它自己的 runner 跑（e2e/dashboard/playwright.config.ts）；vitest 不认领。
    exclude: [...configDefaults.exclude, 'e2e/**'],
    maxWorkers: Math.min(MAX_TEST_WORKERS, availableParallelism()),
    // Repository integration suites exercise real filesystem and process flows.
    // Keep the timeout explicit so CI does not misclassify slow, valid cases as
    // product failures when the full workspace runs concurrently.
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // 全局工作流存储读产品 configRoot；测试进程一律指到临时目录，开发机上的全局覆盖文件不得泄漏进用例。
    setupFiles: ['./tools/vitest.isolate-runtime-home.mjs'],
  },
})
