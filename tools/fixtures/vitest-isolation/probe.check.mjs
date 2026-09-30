import { tmpdir } from 'node:os'
import { expect, it } from 'vitest'

// 由 tools/vitest-isolation.node-test.mjs 在“宿主已声明身份与运行时根”的环境里启动。
it('宿主的身份、运行时根与 change 上下文被隔离脚本覆盖或清除', () => {
  expect(process.env.TENON_USER).toBe('tester@tenon.test')
  expect(process.env.TENON_USER_NAME).toBe('Tester')
  expect(process.env.TENON_RUNTIME_HOME?.startsWith(tmpdir())).toBe(true)
  expect(process.env.TENON_RUNTIME_HOME).not.toBe(process.env.PROBE_HOST_RUNTIME_HOME)
  expect(process.env.TENON_RUNTIME_ROOTS).toBeUndefined()
  expect(process.env.TENON_BASE_BRANCH).toBeUndefined()
  expect(process.env.TENON_CHANGE_NAME).toBeUndefined()
})
