import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll } from 'vitest'

// 每个测试文件都在自己的声明身份与产品 home 里跑，宿主进程里已有的同名变量一律不算数。
// 在 Tenon 会话里执行 `npm test` 时，宿主会带着 TENON_USER / TENON_RUNTIME_HOME（tenon test run 还会注入
// TENON_BASE_BRANCH / TENON_CHANGE_NAME）；只在这些变量缺席时才隔离，会让身份与 base 断言失败，
// 还会把用例写进真实的运行时根。所以这里无条件保存、清掉、覆盖，文件结束后再还原。
const ISOLATED_ENV = [
  'TENON_RUNTIME_HOME',
  'TENON_RUNTIME_ROOTS',
  'TENON_USER',
  'TENON_USER_NAME',
  'TENON_BASE_BRANCH',
  'TENON_CHANGE_NAME',
]

const saved = new Map(ISOLATED_ENV.map((name) => [name, process.env[name]]))
for (const name of ISOLATED_ENV) delete process.env[name]

// 空的产品 home：全局工作流存储（configRoot/workflows）随之落在临时目录，
// 用例之间、用例与开发机之间互不可见。
process.env.TENON_RUNTIME_HOME = mkdtempSync(join(tmpdir(), 'tenon-vitest-home-'))
// 声明身份给每个文件一个测试用户；用例需要第二个用户或缺失身份时自行覆盖 env。
process.env.TENON_USER = 'tester@tenon.test'
process.env.TENON_USER_NAME = 'Tester'

afterAll(() => {
  for (const [name, value] of saved) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
})
