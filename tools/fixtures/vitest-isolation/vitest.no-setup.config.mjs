import { fileURLToPath } from 'node:url'

// 对照组：同一个探针、不挂隔离脚本；在宿主上下文里它必须失败，否则探针就是空断言。
export default {
  test: {
    root: fileURLToPath(new URL('.', import.meta.url)),
    include: ['probe.check.mjs'],
  },
}
