/**
 * `tenon setup --claude --from-source <repo>` 的成功出口也要安装宿主子代理。
 * 源码安装本身（拉技能、构建、发布 dev runtime）由 source-install.test.ts 覆盖，这里把它替换成桩，
 * 只验证 cmdSetupHost 在它成功（exit 0）之后经稳定启动器执行 `agent install --host claude`，失败与 --dry-run 不执行。
 */
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { makeDeps } from '../test-support.js'
import { nativeHostCommandBinding } from './native-host-command-binding.js'
import { cmdSetupHost } from './setup.js'
import type { SetupEnv } from './setupEnvironment.js'
import { cmdSetupFromSource } from './source-install.js'

vi.mock('./source-install.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./source-install.js')>()),
  cmdSetupFromSource: vi.fn(),
  describeSourceInstallPlan: vi.fn(() => 0),
}))

const LAUNCHER = '/home/source-test/.local/bin/tenon'
let exec: Array<readonly [string, readonly string[]]>

function sourceEnv(): SetupEnv {
  return {
    homeDir: () => '/home/source-test',
    runtimeEnv: () => ({}),
    resolveHostCommand: (host) => nativeHostCommandBinding(host, 'darwin', {}),
    runCommand: (cmd, args) => {
      exec.push([cmd, args])
      return { code: 0, stdout: '', stderr: '' }
    },
  } as unknown as SetupEnv
}

beforeEach(() => {
  exec = []
  vi.mocked(cmdSetupFromSource).mockReset()
})

describe('setup --from-source 出口', () => {
  test('源码安装成功：执行 agent install --host claude', async () => {
    vi.mocked(cmdSetupFromSource).mockResolvedValue(0)

    const code = await cmdSetupHost(makeDeps(), 'claude', { claude: true, fromSource: '/work/tenon', skipBuild: true }, sourceEnv())

    expect(code).toBe(0)
    expect(exec).toEqual([[LAUNCHER, ['agent', 'install', '--host', 'claude']]])
  })

  test('源码安装失败：不执行，退出码原样返回', async () => {
    vi.mocked(cmdSetupFromSource).mockResolvedValue(1)

    expect(await cmdSetupHost(makeDeps(), 'claude', { claude: true, fromSource: '/work/tenon' }, sourceEnv())).toBe(1)
    expect(exec).toEqual([])
  })

  test('--dry-run：不执行', () => {
    expect(cmdSetupHost(makeDeps(), 'claude', { claude: true, fromSource: '/work/tenon', dryRun: true }, sourceEnv())).toBe(0)
    expect(cmdSetupFromSource).not.toHaveBeenCalled()
    expect(exec).toEqual([])
  })
})
