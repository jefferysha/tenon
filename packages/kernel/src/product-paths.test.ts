import { describe, expect, it } from 'vitest'
import {
  resolveProductPaths,
  serializeProductRootContract,
} from './product-paths.js'

describe('resolveProductPaths —— Tenon 自有机器状态的唯一平台路径模型', () => {
  it('Linux 遵守 XDG，并始终在标准根下使用 tenon 命名空间', () => {
    expect(resolveProductPaths({
      platform: 'linux',
      homeDir: '/home/demo',
      env: {
        XDG_DATA_HOME: '/var/demo/data',
        XDG_STATE_HOME: '/var/demo/state',
        XDG_CONFIG_HOME: '/var/demo/config',
      },
    })).toMatchObject({
      dataRoot: '/var/demo/data/tenon',
      stateRoot: '/var/demo/state/tenon',
      configRoot: '/var/demo/config/tenon',
      registryPath: '/var/demo/config/tenon/projects.json',
      secretsPath: '/var/demo/config/tenon/secrets.json',
      dashboardTokenPath: '/var/demo/state/tenon/dashboard-token.json',
      dashboardPidfilePath: '/var/demo/state/tenon/dashboard-server.json',
      managedTransactionRoot: '/var/demo/state/tenon/managed-release-transaction',
      migrationsRoot: '/var/demo/state/tenon/migrations',
      channelsRoot: '/var/demo/state/tenon/channels',
    })
  })

  it('macOS 使用 Application Support 下的单一 Tenon 产品域', () => {
    expect(resolveProductPaths({
      platform: 'darwin',
      homeDir: '/Users/demo',
      env: {},
    })).toMatchObject({
      dataRoot: '/Users/demo/Library/Application Support/tenon',
      stateRoot: '/Users/demo/Library/Application Support/tenon/state',
      configRoot: '/Users/demo/Library/Application Support/tenon/config',
      registryPath: '/Users/demo/Library/Application Support/tenon/config/projects.json',
      secretsPath: '/Users/demo/Library/Application Support/tenon/config/secrets.json',
    })
  })

  it('Windows 把漫游配置与本机数据状态分开', () => {
    expect(resolveProductPaths({
      platform: 'win32',
      homeDir: 'C:\\Users\\demo',
      env: {
        LOCALAPPDATA: 'C:\\Users\\demo\\AppData\\Local',
        APPDATA: 'C:\\Users\\demo\\AppData\\Roaming',
      },
    })).toMatchObject({
      dataRoot: 'C:\\Users\\demo\\AppData\\Local\\tenon',
      stateRoot: 'C:\\Users\\demo\\AppData\\Local\\tenon\\state',
      configRoot: 'C:\\Users\\demo\\AppData\\Roaming\\tenon',
    })
  })

  it('TENON_RUNTIME_HOME 是唯一隔离覆盖，统管 data/state/config 及产品文件', () => {
    expect(resolveProductPaths({
      platform: 'linux',
      homeDir: '/home/demo',
      env: {
        TENON_RUNTIME_HOME: '/tmp/tenon-runtime',
        TENON_DASHBOARD_HOME: '/tmp/legacy-override-must-not-win',
      },
    })).toMatchObject({
      dataRoot: '/tmp/tenon-runtime/data',
      stateRoot: '/tmp/tenon-runtime/state',
      configRoot: '/tmp/tenon-runtime/config',
      registryPath: '/tmp/tenon-runtime/config/projects.json',
      secretsPath: '/tmp/tenon-runtime/config/secrets.json',
      dashboardTokenPath: '/tmp/tenon-runtime/state/dashboard-token.json',
      dashboardPidfilePath: '/tmp/tenon-runtime/state/dashboard-server.json',
      decisionObservationKeyPath: '/tmp/tenon-runtime/state/decision-observation-identity.key',
      managedTransactionRoot: '/tmp/tenon-runtime/state/managed-release-transaction',
      migrationsRoot: '/tmp/tenon-runtime/state/migrations',
      channelsRoot: '/tmp/tenon-runtime/state/channels',
    })
  })

  it('稳定 launcher 传递一个版本化 root contract，子进程不重新猜平台目录', () => {
    const parent = resolveProductPaths({
      platform: 'linux',
      homeDir: '/home/demo',
      env: {
        XDG_DATA_HOME: '/mnt/data',
        XDG_STATE_HOME: '/mnt/state',
        XDG_CONFIG_HOME: '/mnt/config',
      },
    })
    const contract = serializeProductRootContract(parent)
    expect(JSON.parse(contract)).toEqual({
      version: 1,
      dataRoot: '/mnt/data/tenon',
      stateRoot: '/mnt/state/tenon',
      configRoot: '/mnt/config/tenon',
    })
    expect(resolveProductPaths({
      platform: 'darwin',
      homeDir: '/Users/child',
      env: { TENON_RUNTIME_ROOTS: contract },
    })).toMatchObject({
      dataRoot: parent.dataRoot,
      stateRoot: parent.stateRoot,
      configRoot: parent.configRoot,
      registryPath: '/mnt/config/tenon/projects.json',
    })
  })

  it('损坏或相对路径的 internal root contract fail-closed', () => {
    expect(() => resolveProductPaths({
      platform: 'linux',
      homeDir: '/home/demo',
      env: {
        TENON_RUNTIME_ROOTS: JSON.stringify({
          version: 1,
          dataRoot: 'relative',
          stateRoot: '/tmp/state',
          configRoot: '/tmp/config',
        }),
      },
    })).toThrow(/TENON_RUNTIME_ROOTS/)
  })
})
