import { fileURLToPath } from 'node:url'

// 只服务 tools/vitest-isolation.node-test.mjs：用真实的隔离脚本跑一个探针文件。
export default {
  test: {
    root: fileURLToPath(new URL('.', import.meta.url)),
    include: ['probe.check.mjs'],
    setupFiles: [fileURLToPath(new URL('../../vitest.isolate-runtime-home.mjs', import.meta.url))],
  },
}
