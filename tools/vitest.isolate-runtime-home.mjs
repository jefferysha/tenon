import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 未显式指定 TENON_RUNTIME_HOME 时，给每个 vitest worker 一个空的产品 home：
// 全局工作流存储（configRoot/workflows）随之落在临时目录，用例之间、用例与开发机之间互不可见。
if (process.env.TENON_RUNTIME_HOME === undefined && process.env.TENON_RUNTIME_ROOTS === undefined) {
  process.env.TENON_RUNTIME_HOME = mkdtempSync(join(tmpdir(), 'tenon-vitest-home-'))
}

// 声明身份默认给每个 worker 一个测试用户；用例需要第二个用户或缺失身份时自行覆盖 env。
if (process.env.TENON_USER === undefined) {
  process.env.TENON_USER = 'tester@tenon.test'
  process.env.TENON_USER_NAME ??= 'Tester'
}
