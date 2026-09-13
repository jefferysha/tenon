import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.test.ts'],
    // Repository integration suites exercise real filesystem and process flows.
    // Keep the timeout explicit so CI does not misclassify slow, valid cases as
    // product failures when the full workspace runs concurrently.
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // 全局工作流存储读产品 configRoot；测试进程一律指到临时目录，开发机上的全局覆盖文件不得泄漏进用例。
    setupFiles: ['./tools/vitest.isolate-runtime-home.mjs'],
  },
})
