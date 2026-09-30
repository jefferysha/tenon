/**
 * Dashboard e2e 的种子项目：全部经真实的 Tenon CLI 落盘（init、目录、计划、运行），不手写任何 Tenon 状态文件
 * （唯一例外是测试目录 catalog.yaml——它本来就是给人编辑的配置）。
 *
 *   · `seedDemo`：git 仓库 + AGENTS.md + 一个 change（default 工作流，后端轨道），带测试计划和一次
 *     失败的 v2 运行（node:test 的一个失败用例，附截图与 trace 产物）。工作台「测试」页签读它。
 *     套件命令用 node-test 预设的 reporter 写法（`--test-reporter="${TENON_NODE_TEST_REPORTER:-junit}"`）：`tenon test run` 把随附的、
 *     每个用例都带 file 的 reporter 落在本次运行的产物目录下并经该环境变量提供，所以 Node 22（内置 junit 不写 file）与较新的
 *     Node 得到同样的用例文件归属；种子项目里不放任何 reporter 文件。
 *   · `seedSandbox`：只有 git 仓库和 AGENTS.md，项目页启停客户端会改它的文件，所以不与 demo 共用
 *     （改工作区文件会让 demo 的测试运行记录过期）。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'
import { commitBase, runTenon, writeProjectFile } from '../../../tools/lib/isolated-tenon.mjs'

export const CHANGE = 'add-login'
export const UNIT_SUITE = 'demo-unit'
export const CHECK_SUITE = 'demo-check'
export const FAILING_CASE = 'login rejects a wrong password'
export const TEST_FILE = 'tests/auth.test.mjs'

function crc32(bytes) {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1
  }
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const head = Buffer.alloc(4)
  head.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const tail = Buffer.alloc(4)
  tail.writeUInt32BE(crc32(body))
  return Buffer.concat([head, body, tail])
}

/** 一张纯色 PNG（种子用例失败时的「截图」）：用 zlib 现场编码，仓库里不放二进制。 */
export function solidPng(width, height, [red, green, blue]) {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header.set([8, 2, 0, 0, 0], 8)
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: width }, () => [red, green, blue]).flat())])
  const raw = Buffer.concat(Array.from({ length: height }, () => row))
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

const AUTH_TESTS = `import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { strictEqual } from 'node:assert'
import { test } from 'node:test'

test('login accepts a valid password', () => {
  strictEqual('welcome', 'welcome')
})

test('${FAILING_CASE}', () => {
  mkdirSync('test-results', { recursive: true })
  copyFileSync('tests/fixtures/failure.png', 'test-results/failure.png')
  writeFileSync('test-results/trace.zip', Buffer.from('504b0506000000000000000000000000000000000000', 'hex'))
  strictEqual('access denied', 'access granted')
})
`

const CATALOG = `schema: tenon-test-catalog/v1
suites:
  - id: ${UNIT_SUITE}
    label: Demo unit
    kind: unit
    runner: node-test
    command: node --test --test-reporter="\${TENON_NODE_TEST_REPORTER:-junit}" --test-reporter-destination=test-results/demo-unit.xml tests/*.test.mjs
    files:
      - tests/**/*.test.mjs
    report:
      format: junit
      path: test-results/demo-unit.xml
    artifacts:
      - test-results
  - id: ${CHECK_SUITE}
    label: Demo syntax check
    kind: typecheck
    runner: custom
    command: node --check ${TEST_FILE}
    report:
      format: exit-code
`

const SPEC = `## ADDED Requirements
### Requirement: Login
#### Scenario: Valid password signs in
- WHEN the password is valid
- THEN the user is signed in
#### Scenario: Wrong password is rejected
- WHEN the password is wrong
- THEN access is denied
`

export function seedSandbox(context) {
  writeProjectFile(context.sandbox, 'AGENTS.md', '# Sandbox\n\nClient files for the project page e2e.\n')
  commitBase(context.sandbox, context.env)
  runTenon(context.env, context.sandbox, ['init', 'sandbox-change', '--track', 'backend', '--preset', 'full'])
}

export function seedDemo(context) {
  const { env, project: root } = context
  const tenon = (...args) => runTenon(env, root, args)
  writeProjectFile(root, 'AGENTS.md', '# Demo\n\nSeed project for the dashboard e2e.\n')
  writeProjectFile(root, TEST_FILE, AUTH_TESTS)
  mkdirSync(join(root, 'tests', 'fixtures'), { recursive: true })
  writeFileSync(join(root, 'tests', 'fixtures', 'failure.png'), solidPng(320, 180, [196, 60, 52]))
  commitBase(root, env)
  tenon('init', CHANGE, '--track', 'backend', '--preset', 'full')
  writeProjectFile(root, `openspec/changes/${CHANGE}/specs/auth/spec.md`, SPEC)
  writeProjectFile(root, '.tenon/tests/catalog.yaml', CATALOG)
  tenon('test', 'catalog', 'validate')
  tenon('test', 'register', CHANGE, '--suite', UNIT_SUITE)
  tenon('test', 'register', CHANGE, '--suite', CHECK_SUITE)
  tenon('test', 'register', CHANGE, '--file', TEST_FILE, '--suite', UNIT_SUITE, '--kind', 'unit')
  tenon('test', 'register', CHANGE, '--case', 'spec:auth/Valid password signs in', '--test', `${TEST_FILE} › login accepts a valid password`)
  tenon('test', 'register', CHANGE, '--case', 'spec:auth/Wrong password is rejected', '--test', `${TEST_FILE} › ${FAILING_CASE}`)
  tenon('test', 'waive', CHANGE, '--kind', 'integration', '--reason', 'No integration surface in the demo')
  // 失败的运行以退出码 2 结束并写下记录；这正是要展示的证据。
  runTenon(env, root, ['test', 'run', CHANGE, '--stage', 'verify'], { allow: [2] })
}
