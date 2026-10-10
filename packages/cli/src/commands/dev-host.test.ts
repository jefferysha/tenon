import { mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import {
  decodeDevObservation, devHostMatches, devHostPlan, devHostReconciliation, devMarketplaceIsRepo,
  observeDevNativeHost,
} from './dev-host.js'
import { NATIVE_HOST_UPDATE_STEP_IDS } from './native-host-convergence-sequence.js'
import { parseHostPluginInventory, type NativePipelineHost } from './plugin-host.js'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function realDir(label: string): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `tenon-dev-host-${label}-`)))
  roots.push(root)
  return root
}

const VERSION = '0.3.2'

/** 按 2026-10-07 在隔离 HOME 里抓到的真实输出形态模拟宿主（Task 1 已复核）。 */
function simulator(host: NativePipelineHost) {
  const state: { marketplacePath: string | null; plugin: { version: string } | null } = {
    marketplacePath: null,
    plugin: null,
  }
  const calls: string[] = []
  const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' })
  const runCommand = (cmd: string, args: string[]) => {
    const line = [cmd, ...args].join(' ')
    calls.push(line)
    if (host === 'claude') {
      if (line === 'claude plugin marketplace list --json') {
        return ok(JSON.stringify(state.marketplacePath === null ? [] : [{
          name: 'tenon', source: 'directory', path: state.marketplacePath, installLocation: state.marketplacePath,
        }]))
      }
      if (line === 'claude plugin list --json') {
        return ok(JSON.stringify(state.plugin === null ? [] : [{
          id: 'tenon@tenon', version: state.plugin.version, scope: 'user', enabled: true,
          installPath: `/home/test/.claude/plugins/cache/tenon/tenon/${state.plugin.version}`,
          readFromFolder: state.marketplacePath, folderVersion: state.plugin.version,
        }]))
      }
      if (line === 'claude plugin uninstall tenon@tenon --scope user') { state.plugin = null; return ok() }
      if (line === 'claude plugin marketplace remove tenon') { state.marketplacePath = null; state.plugin = null; return ok() }
      if (line.startsWith('claude plugin marketplace add ')) { state.marketplacePath = realpathSync(args[3] ?? ''); return ok() }
      if (line === 'claude plugin install tenon@tenon') { state.plugin = { version: VERSION }; return ok() }
    } else {
      if (line === 'codex plugin marketplace list --json') {
        return ok(JSON.stringify({
          marketplaces: state.marketplacePath === null ? [] : [{
            name: 'tenon', root: state.marketplacePath,
            marketplaceSource: { sourceType: 'local', source: state.marketplacePath },
          }],
        }))
      }
      if (line === 'codex plugin list --json') {
        return ok(JSON.stringify({
          installed: state.plugin === null ? [] : [{
            pluginId: 'tenon@tenon', name: 'tenon', marketplaceName: 'tenon', version: state.plugin.version,
            installed: true, enabled: true, source: { source: 'local', path: state.marketplacePath },
          }],
          available: [],
        }))
      }
      if (line === 'codex plugin remove tenon@tenon --json') { state.plugin = null; return ok('{}') }
      if (line === 'codex plugin marketplace remove tenon --json') { state.marketplacePath = null; state.plugin = null; return ok('{}') }
      if (line.startsWith('codex plugin marketplace add ')) { state.marketplacePath = realpathSync(args[3] ?? ''); return ok('{}') }
      if (line === 'codex plugin add tenon@tenon --json') { state.plugin = { version: VERSION }; return ok('{}') }
    }
    return { code: 127, stdout: '', stderr: `unexpected command: ${line}` }
  }
  return { state, calls, runCommand }
}

describe('devHostPlan', () => {
  test('claude: uninstall, marketplace remove, add the directory, install, list', () => {
    expect(devHostPlan('claude', '/work/tenon')).toEqual([
      { cmd: 'claude', args: ['plugin', 'uninstall', 'tenon@tenon', '--scope', 'user'] },
      { cmd: 'claude', args: ['plugin', 'marketplace', 'remove', 'tenon'] },
      { cmd: 'claude', args: ['plugin', 'marketplace', 'add', '/work/tenon'] },
      { cmd: 'claude', args: ['plugin', 'install', 'tenon@tenon'] },
      { cmd: 'claude', args: ['plugin', 'list', '--json'] },
    ])
  })

  test('codex: the same five positions with --json', () => {
    const plan = devHostPlan('codex', '/work/tenon')
    expect(plan).toHaveLength(NATIVE_HOST_UPDATE_STEP_IDS.length)
    expect(plan[2]).toEqual({ cmd: 'codex', args: ['plugin', 'marketplace', 'add', '/work/tenon', '--json'] })
    expect(plan[4]).toEqual({ cmd: 'codex', args: ['plugin', 'list', '--json'] })
  })
})

describe('decodeDevObservation', () => {
  test('rejects a journaled observation whose shape is not exactly the written one', () => {
    const valid = { version: 1, host: 'claude', marketplace: { sourceType: 'directory', path: '/r' }, plugin: null }
    expect(decodeDevObservation(JSON.stringify(valid)).host).toBe('claude')
    for (const broken of [
      { ...valid, host: 'cursor' },
      { ...valid, marketplace: { sourceType: 'directory', path: 3 } },
      { ...valid, plugin: { enabled: 'yes', version: null, root: null } },
      { ...valid, plugin: { enabled: true, version: 1, root: null } },
    ]) {
      expect(() => decodeDevObservation(JSON.stringify(broken))).toThrow(/schema 非法/u)
    }
  })
})

describe('observeDevNativeHost', () => {
  test.each(['claude', 'codex'] as const)('%s: reports the directory marketplace and the enabled plugin', (host) => {
    const repo = realDir(host)
    const sim = simulator(host)
    sim.state.marketplacePath = repo
    sim.state.plugin = { version: VERSION }
    const observation = decodeDevObservation(observeDevNativeHost({ runCommand: sim.runCommand }, host))
    expect(observation.marketplace).toEqual({ sourceType: host === 'claude' ? 'directory' : 'local', path: repo })
    expect(observation.plugin).toMatchObject({ enabled: true, version: VERSION })
    expect(devHostMatches(observation, repo, VERSION)).toBe(true)
    expect(devHostMatches(observation, repo, '9.9.9')).toBe(false)
  })

  test('the real plugin list output still parses with the existing inventory parser', () => {
    const repo = realDir('inventory')
    const sim = simulator('claude')
    sim.state.marketplacePath = repo
    sim.state.plugin = { version: VERSION }
    const parsed = parseHostPluginInventory('claude', sim.runCommand('claude', ['plugin', 'list', '--json']).stdout)
    expect(parsed).toMatchObject({ tenonVersion: VERSION, tenonRegistered: true })
    expect(parsed?.tenonRoot).toBe(`/home/test/.claude/plugins/cache/tenon/tenon/${VERSION}`)
  })

  test('absent registrations are null; garbage output fails closed', () => {
    const sim = simulator('claude')
    const observation = decodeDevObservation(observeDevNativeHost({ runCommand: sim.runCommand }, 'claude'))
    expect(observation).toMatchObject({ marketplace: null, plugin: null })
    expect(() => observeDevNativeHost({ runCommand: () => ({ code: 0, stdout: 'not json', stderr: '' }) }, 'claude'))
      .toThrow('不是合法 JSON')
    expect(() => observeDevNativeHost({ runCommand: () => ({ code: 1, stdout: '', stderr: 'boom' }) }, 'claude'))
      .toThrow('读取失败')
  })
})

describe('devMarketplaceIsRepo', () => {
  test('compares realpaths, so a symlinked repo path still matches what the host reports', () => {
    const repo = realDir('real')
    const link = join(realDir('link'), 'repo-link')
    symlinkSync(repo, link)
    const observation = { version: 1 as const, host: 'codex' as const, marketplace: { sourceType: 'local', path: repo }, plugin: null }
    expect(devMarketplaceIsRepo(observation, link)).toBe(true)
    expect(devMarketplaceIsRepo(observation, join(repo, 'other'))).toBe(false)
  })

  test('a github marketplace is never the repository', () => {
    const observation = { version: 1 as const, host: 'claude' as const, marketplace: { sourceType: 'github', path: '/tmp/x' }, plugin: null }
    expect(devMarketplaceIsRepo(observation, '/tmp/x')).toBe(false)
  })
})

describe('devHostReconciliation', () => {
  test.each(['claude', 'codex'] as const)('%s: the five-step plan converges through the managed-step contract', (host) => {
    const repo = realDir(`walk-${host}`)
    const sim = simulator(host)
    // 先有一份正式版登记，开发安装要把它换掉。
    sim.state.marketplacePath = '/some/stable/checkout'
    sim.state.plugin = { version: '0.3.1' }
    const reconcile = devHostReconciliation({ runCommand: sim.runCommand }, repo, VERSION)
    const plan = devHostPlan(host, repo)
    for (const [index, id] of ['plugin-remove', 'marketplace-remove', 'marketplace-register', 'plugin-install'].entries()) {
      const item = plan[index]
      if (item === undefined) throw new Error('plan too short')
      const step = reconcile(host, id, item)
      const before = step.observe()
      if (!step.isDesired(before)) {
        const result = sim.runCommand(item.cmd, [...item.args])
        expect(result.code).toBe(0)
      }
      expect(step.isDesired(step.observe())).toBe(true)
    }
    const final = decodeDevObservation(observeDevNativeHost({ runCommand: sim.runCommand }, host))
    expect(devHostMatches(final, repo, VERSION)).toBe(true)
  })

  test('a step already at its postcondition is recognised before any mutation', () => {
    const repo = realDir('noop')
    const sim = simulator('claude')
    const reconcile = devHostReconciliation({ runCommand: sim.runCommand }, repo, VERSION)
    const step = reconcile('claude', 'plugin-remove', { cmd: 'claude', args: [] })
    expect(step.isDesired(step.observe())).toBe(true)
    expect(sim.calls.every((call) => call.endsWith('list --json'))).toBe(true)
  })

  test('completed removal checkpoints stay valid once a later step re-registers the repository', () => {
    const repo = realDir('compat')
    const sim = simulator('claude')
    sim.state.marketplacePath = repo
    sim.state.plugin = { version: VERSION }
    const reconcile = devHostReconciliation({ runCommand: sim.runCommand }, repo, VERSION)
    const afterInstall = observeDevNativeHost({ runCommand: sim.runCommand }, 'claude')
    expect(reconcile('claude', 'plugin-remove', { cmd: 'claude', args: [] }).isCompletedCompatible?.(afterInstall)).toBe(true)
    expect(reconcile('claude', 'marketplace-remove', { cmd: 'claude', args: [] }).isCompletedCompatible?.(afterInstall)).toBe(true)
    sim.state.marketplacePath = '/some/other/checkout'
    const drifted = observeDevNativeHost({ runCommand: sim.runCommand }, 'claude')
    expect(reconcile('claude', 'marketplace-remove', { cmd: 'claude', args: [] }).isCompletedCompatible?.(drifted)).toBe(false)
  })

  test('the desired state names the repository and version, so another repository cannot resume the WAL', () => {
    const sim = simulator('claude')
    const first = devHostReconciliation({ runCommand: sim.runCommand }, '/work/a', VERSION)('claude', 'marketplace-register', { cmd: 'claude', args: [] })
    const second = devHostReconciliation({ runCommand: sim.runCommand }, '/work/b', VERSION)('claude', 'marketplace-register', { cmd: 'claude', args: [] })
    expect(first.desired).not.toBe(second.desired)
  })

  test('an unknown step id fails closed', () => {
    const sim = simulator('claude')
    expect(() => devHostReconciliation({ runCommand: sim.runCommand }, '/work/a', VERSION)('claude', 'surprise', { cmd: 'claude', args: [] }))
      .toThrow('没有对应的 desired-state')
  })
})
