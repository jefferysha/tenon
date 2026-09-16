import { describe, expect, test } from 'vitest'
import { ManagedRuntimeIndeterminateError } from '../runtime/installer.js'
import type { SetupEnv } from './setupEnvironment.js'
import {
  desiredNativeHostPostcondition,
  nativeHostMatchesStableTarget,
  nativeHostStableTargetMismatch,
  observeNativeHost,
} from './managed-host-observation.js'
import { equivalentNativeHostDesired } from './managed-host-desired-identity.js'
import { TENON_RELEASE_VERSION } from './plugin-host.js'

const CURRENT_RELEASE_TAG = `v${TENON_RELEASE_VERSION}` as const

function observationEnv(state: {
  head: string
  remoteHead: string
  pluginVersion: string
  marketplaceRoot?: string
  marketplaceSource?: string
  marketplaceSourceType?: string
  pluginRoot?: string
  pluginPresent?: boolean
  marketplacePresent?: boolean
  marketplaceRemote?: string
  marketplaceRef?: string | null
  marketplaceClean?: boolean
  marketplacePluginVersion?: string
  codexConfig?: string
  omitLegacyRefMetadata?: boolean
}): SetupEnv {
  const initialRoot = '/host/tenon-marketplace'
  return {
    readText: (path) => {
      const root = state.marketplaceRoot ?? initialRoot
      if (path === '/home/observation/.codex/config.toml') return state.codexConfig
      if (path === `${root}/.codex-plugin/plugin.json`
        || path === `${root}/.claude-plugin/plugin.json`) {
        return JSON.stringify({ version: state.marketplacePluginVersion ?? '1.0.1' })
      }
      if (path === `${root}/.codex-marketplace-install.json`) {
        if (state.omitLegacyRefMetadata === true) return undefined
        return JSON.stringify({ ref_name: state.marketplaceRef ?? CURRENT_RELEASE_TAG })
      }
      return undefined
    },
    homeDir: () => '/home/observation',
    runtimeEnv: () => ({}),
    runCommand: (cmd, args) => {
      const root = state.marketplaceRoot ?? initialRoot
      const text = `${cmd} ${args.join(' ')}`
      if (text === 'codex plugin marketplace list --json') {
        return {
          code: 0,
          stdout: JSON.stringify({
            marketplaces: state.marketplacePresent === false ? [] : [{
              name: 'tenon',
              root,
              marketplaceSource: {
                sourceType: state.marketplaceSourceType ?? 'git',
                source: state.marketplaceSource ?? 'https://github.com/jefferysha/tenon.git',
              },
            }],
          }),
          stderr: '',
        }
      }
      if (text === 'codex plugin list --json') {
        return {
          code: 0,
          stdout: JSON.stringify({
            installed: state.pluginPresent === false ? [] : [{
              pluginId: 'tenon@tenon',
              version: state.pluginVersion,
              source: { path: state.pluginRoot ?? root },
            }],
          }),
          stderr: '',
        }
      }
      if (text === `git -C ${root} rev-parse HEAD`) {
        return { code: 0, stdout: `${state.head}\n`, stderr: '' }
      }
      if (text === `git -C ${root} remote get-url origin`) {
        return {
          code: 0,
          stdout: `${state.marketplaceRemote ?? 'https://github.com/jefferysha/tenon.git'}\n`,
          stderr: '',
        }
      }
      if (text === `git -C ${root} diff --quiet HEAD --`) {
        return { code: state.marketplaceClean === false ? 1 : 0, stdout: '', stderr: '' }
      }
      if (text === `git -C ${root} status --porcelain`) {
        return {
          code: 0,
          stdout: state.marketplaceClean === false ? '?? skills/brainstorming/SKILL.md\n' : '',
          stderr: '',
        }
      }
      if (text === `git -C ${root} ls-files --others --exclude-standard`) {
        return { code: 0, stdout: '', stderr: '' }
      }
      if (text === 'git ls-remote https://github.com/jefferysha/tenon.git refs/heads/main') {
        return { code: 0, stdout: `${state.remoteHead}\trefs/heads/main\n`, stderr: '' }
      }
      const stableTag = /^git ls-remote https:\/\/github\.com\/jefferysha\/tenon\.git refs\/tags\/(v[0-9]+\.[0-9]+\.[0-9]+) refs\/tags\/\1\^\{\}$/u.exec(text)?.[1]
      if (stableTag !== undefined) {
        return { code: 0, stdout: `${state.remoteHead}\trefs/tags/${stableTag}\n`, stderr: '' }
      }
      if (/^git init --bare .+$/u.test(text)) {
        return { code: 0, stdout: '', stderr: '' }
      }
      if (/^git -C .+ fetch --no-tags --depth=1 https:\/\/github\.com\/jefferysha\/tenon\.git refs\/tags\/v[0-9]+\.[0-9]+\.[0-9]+$/u.test(text)) {
        return { code: 0, stdout: '', stderr: '' }
      }
      if (/^git -C .+ rev-parse FETCH_HEAD\^\{commit\}$/u.test(text)) {
        return { code: 0, stdout: `${state.remoteHead}\n`, stderr: '' }
      }
      if (/^git -C .+ cat-file -t [a-f0-9]{40}$/u.test(text)) {
        return { code: 0, stdout: 'commit\n', stderr: '' }
      }
      return { code: 1, stdout: '', stderr: `unexpected command: ${text}` }
    },
  } as SetupEnv
}

describe('managed native-host observation', () => {
  test('Codex configured ref is read from the real config.toml marketplace section', () => {
    const target = { version: '1.2.3', tag: 'v1.2.3', commit: 'b'.repeat(40) }
    const state = {
      head: target.commit,
      remoteHead: target.commit,
      pluginVersion: target.version,
      marketplacePluginVersion: target.version,
      omitLegacyRefMetadata: true,
      codexConfig: '[marketplaces.tenon]\nsource_type = "git"\nref = "main"\n',
    }
    const env = observationEnv(state)
    expect(nativeHostMatchesStableTarget(env, 'codex', target)).toBe(false)
    state.codexConfig = '[marketplaces.tenon]\nsource_type = "git"\nref = "v1.2.3"\n'
    expect(nativeHostMatchesStableTarget(env, 'codex', target)).toBe(true)
  })

  test('冻结目标不匹配时点名漂移字段，而不是只给一个拒绝', () => {
    const target = { version: '1.2.3', tag: 'v1.2.3', commit: 'b'.repeat(40) }
    const state = {
      head: target.commit,
      remoteHead: target.commit,
      pluginVersion: target.version,
      marketplacePluginVersion: target.version,
      omitLegacyRefMetadata: true,
      codexConfig: '[marketplaces.tenon]\nsource_type = "git"\nref = "v1.2.3"\n',
      marketplaceClean: false,
    }
    // 脏克隆是 upstream skill 安装后最容易踩的一条，拒绝必须自己说出是 clean 这一项。
    const dirty = nativeHostStableTargetMismatch(observationEnv(state), 'codex', target) ?? ''
    expect(dirty).toContain('marketplace.clean=false')
    expect(dirty).toContain('skills/brainstorming/SKILL.md')
    state.marketplaceClean = true
    expect(nativeHostStableTargetMismatch(observationEnv(state), 'codex', target)).toBe(null)
    state.head = 'c'.repeat(40)
    const drifted = nativeHostStableTargetMismatch(observationEnv(state), 'codex', target) ?? ''
    expect(drifted).toContain(`marketplace.head=${'c'.repeat(40)}`)
    expect(drifted).toContain(target.commit)
  })

  test('Codex configured ref rejects duplicate and malformed config values', () => {
    const state = {
      head: 'b'.repeat(40),
      remoteHead: 'b'.repeat(40),
      pluginVersion: '1.2.3',
      omitLegacyRefMetadata: true,
      codexConfig: '[marketplaces.tenon]\nref = "v1.2.3"\nref = "main"\n',
    }
    expect(() => observeNativeHost(observationEnv(state), 'codex'))
      .toThrow(ManagedRuntimeIndeterminateError)
    state.codexConfig = '[marketplaces.tenon]\nref = dynamic\n'
    expect(() => observeNativeHost(observationEnv(state), 'codex'))
      .toThrow(ManagedRuntimeIndeterminateError)
  })

  test('versioned Codex rebind proves absent states, target commit, and target plugin version', () => {
    const target = { version: '1.2.3', tag: 'v1.2.3', commit: 'b'.repeat(40) }
    const state = {
      head: 'a'.repeat(40),
      remoteHead: 'f'.repeat(40),
      pluginVersion: '1.0.1',
      pluginPresent: true,
      marketplacePresent: true,
      marketplaceRef: 'v1.0.1',
    }
    const env = observationEnv(state)

    const pluginAbsent = desiredNativeHostPostcondition(env, 'codex', 'plugin-remove', target)
    expect(pluginAbsent.isDesired(observeNativeHost(env, 'codex'))).toBe(false)
    state.pluginPresent = false
    expect(pluginAbsent.isDesired(observeNativeHost(env, 'codex'))).toBe(true)

    const marketplaceAbsent = desiredNativeHostPostcondition(env, 'codex', 'marketplace-remove', target)
    expect(marketplaceAbsent.isDesired(observeNativeHost(env, 'codex'))).toBe(false)
    state.marketplacePresent = false
    expect(marketplaceAbsent.isDesired(observeNativeHost(env, 'codex'))).toBe(true)

    const marketplaceTarget = desiredNativeHostPostcondition(env, 'codex', 'marketplace-register', target)
    state.marketplacePresent = true
    state.head = target.commit
    state.marketplaceRef = target.tag
    expect(marketplaceTarget.isDesired(observeNativeHost(env, 'codex'))).toBe(true)

    const pluginTarget = desiredNativeHostPostcondition(env, 'codex', 'plugin-install', target)
    state.pluginPresent = true
    expect(pluginTarget.isDesired(observeNativeHost(env, 'codex'))).toBe(false)
    state.pluginVersion = target.version
    expect(pluginTarget.isDesired(observeNativeHost(env, 'codex'))).toBe(true)
  })

  test('completed transient remove checkpoints accept only successors owned by the same frozen target', () => {
    const target = { version: '1.2.3', tag: 'v1.2.3', commit: 'b'.repeat(40) }
    const state = {
      head: 'a'.repeat(40),
      remoteHead: target.commit,
      pluginVersion: '1.0.1',
      marketplacePluginVersion: '1.2.3',
      marketplaceRef: 'v1.0.1',
      pluginPresent: true,
    }
    const env = observationEnv(state)
    const pluginAbsent = desiredNativeHostPostcondition(env, 'codex', 'plugin-remove', target)
    state.pluginPresent = false
    const marketplaceAbsent = desiredNativeHostPostcondition(env, 'codex', 'marketplace-remove', target)

    state.head = target.commit
    state.marketplaceRef = target.tag
    state.pluginPresent = true
    state.pluginVersion = target.version
    const converged = observeNativeHost(env, 'codex')
    expect(pluginAbsent.isCompletedCompatible?.(converged)).toBe(true)
    expect(marketplaceAbsent.isCompletedCompatible?.(converged)).toBe(true)

    state.pluginVersion = '9.9.9'
    const thirdState = observeNativeHost(env, 'codex')
    expect(pluginAbsent.isCompletedCompatible?.(thirdState)).toBe(false)
    expect(marketplaceAbsent.isCompletedCompatible?.(thirdState)).toBe(false)
  })

  test('marketplace registration recovery keeps a persisted unknown root as a one-way wildcard', () => {
    const target = { version: '1.2.3', tag: 'v1.2.3', commit: 'b'.repeat(40) }
    const state = {
      head: target.commit,
      remoteHead: target.commit,
      pluginVersion: target.version,
      marketplacePluginVersion: target.version,
      marketplacePresent: false,
      marketplaceRef: target.tag,
    }
    const env = observationEnv(state)
    const persisted = desiredNativeHostPostcondition(env, 'codex', 'marketplace-register', target)
    expect(JSON.parse(persisted.serialized)).toMatchObject({ root: null })

    state.marketplacePresent = true
    const recovered = desiredNativeHostPostcondition(env, 'codex', 'marketplace-register', target)
    expect(recovered.isEquivalentDesired(persisted.serialized)).toBe(true)
    expect(recovered.isDesired(observeNativeHost(env, 'codex'))).toBe(true)
  })

  test('a marketplace still configured to main is never exact even when HEAD equals the target tag commit', () => {
    const target = { version: '1.2.3', tag: 'v1.2.3', commit: 'b'.repeat(40) }
    const state = {
      head: target.commit,
      remoteHead: target.commit,
      pluginVersion: target.version,
      marketplacePluginVersion: target.version,
      marketplaceRef: 'main',
    }
    const env = observationEnv(state)
    expect(nativeHostMatchesStableTarget(env, 'codex', target)).toBe(false)
    state.marketplaceRef = target.tag
    expect(nativeHostMatchesStableTarget(env, 'codex', target)).toBe(true)
  })

  test('native desired identity tolerates only incidental marketplace HEAD drift', () => {
    const state = {
      head: 'a'.repeat(40),
      remoteHead: 'b'.repeat(40),
      pluginVersion: '1.0.0',
    }
    const env = observationEnv(state)
    const persisted = desiredNativeHostPostcondition(env, 'codex', 'marketplace-refresh')

    state.head = state.remoteHead
    const current = desiredNativeHostPostcondition(env, 'codex', 'marketplace-refresh')
    expect(current.isEquivalentDesired(persisted.serialized)).toBe(true)

    const original = JSON.parse(persisted.serialized) as Record<string, unknown>
    const marketplace = original.marketplace as Record<string, unknown>
    const changed = (value: Record<string, unknown>) => JSON.stringify(value)
    expect(current.isEquivalentDesired(changed({ ...original, head: 'c'.repeat(40) }))).toBe(false)
    expect(current.isEquivalentDesired(changed({
      ...original,
      marketplace: { ...marketplace, root: '/host/other-marketplace' },
    }))).toBe(false)
    expect(current.isEquivalentDesired(changed({
      ...original,
      marketplace: { ...marketplace, source: 'https://github.com/example/fork.git' },
    }))).toBe(false)
    expect(current.isEquivalentDesired(changed({
      ...original,
      marketplace: { ...marketplace, sourceType: 'local' },
    }))).toBe(false)
    expect(current.isEquivalentDesired(changed({
      ...original,
      marketplace: { ...marketplace, head: 'not-a-git-head' },
    }))).toBe(false)
    expect(current.isEquivalentDesired(changed({
      ...original,
      marketplace: { ...marketplace, head: 'A'.repeat(40) },
    }))).toBe(false)
    expect(current.isEquivalentDesired(changed({ ...original, unexpected: true }))).toBe(false)
    expect(current.isEquivalentDesired('{not-json')).toBe(false)
  })

  test('plugin desired identity preserves plugin root and version while tolerating marketplace HEAD drift', () => {
    const state = {
      head: 'a'.repeat(40),
      remoteHead: 'b'.repeat(40),
      pluginVersion: '1.0.0',
      pluginRoot: '/plugins/tenon/1.0.0',
    }
    const env = observationEnv(state)
    const persisted = desiredNativeHostPostcondition(env, 'codex', 'plugin-install')

    state.head = state.remoteHead
    const current = desiredNativeHostPostcondition(env, 'codex', 'plugin-install')
    expect(current.isEquivalentDesired(persisted.serialized)).toBe(true)

    const original = JSON.parse(persisted.serialized) as Record<string, unknown>
    expect(current.isEquivalentDesired(JSON.stringify({
      ...original,
      pluginRoot: '/plugins/tenon/other',
    }))).toBe(false)
    expect(current.isEquivalentDesired(JSON.stringify({
      ...original,
      pluginVersion: '9.9.9',
    }))).toBe(false)
  })

  test('Claude plugin install recovery accepts only the one-way null-to-authoritative plugin root upgrade', () => {
    const marketplace = {
      root: '/host/tenon-marketplace',
      source: 'jefferysha/tenon',
      sourceType: 'github',
      head: 'a'.repeat(40),
      ref: 'v1.0.2',
      clean: true,
    }
    const persisted = JSON.stringify({
      version: 1,
      kind: 'plugin-version',
      marketplace,
      pluginRoot: null,
      pluginVersion: '1.0.2',
    })
    const current = JSON.stringify({
      version: 1,
      kind: 'plugin-version',
      marketplace,
      pluginRoot: '/host/claude-cache/tenon',
      pluginVersion: '1.0.2',
    })
    expect(equivalentNativeHostDesired(persisted, current)).toBe(true)
    expect(equivalentNativeHostDesired(current, persisted)).toBe(false)
    expect(equivalentNativeHostDesired(persisted, JSON.stringify({
      version: 1,
      kind: 'plugin-version',
      marketplace: { ...marketplace, ref: 'main' },
      pluginRoot: '/host/claude-cache/tenon',
      pluginVersion: '1.0.2',
    }))).toBe(false)
  })

  test('marketplace refresh desired state is the remote revision, not command stdout', () => {
    const state = {
      head: 'a'.repeat(40),
      remoteHead: 'b'.repeat(40),
      pluginVersion: '1.0.0',
    }
    const env = observationEnv(state)
    const desired = desiredNativeHostPostcondition(env, 'codex', 'marketplace-refresh')

    expect(desired.isDesired(observeNativeHost(env, 'codex'))).toBe(false)
    state.head = state.remoteHead
    expect(desired.isDesired(observeNativeHost(env, 'codex'))).toBe(true)
  })

  test('plugin mutation proves the target manifest version against a fresh inventory', () => {
    const state = {
      head: 'a'.repeat(40),
      remoteHead: 'a'.repeat(40),
      pluginVersion: '1.0.0',
    }
    const env = observationEnv(state)
    const desired = desiredNativeHostPostcondition(env, 'codex', 'plugin-install')

    expect(desired.isDesired(observeNativeHost(env, 'codex'))).toBe(false)
    state.pluginVersion = '1.0.1'
    expect(desired.isDesired(observeNativeHost(env, 'codex'))).toBe(true)
  })

  test('marketplace desired state rejects lookalike sources and changed roots', () => {
    const state = {
      head: 'a'.repeat(40),
      remoteHead: 'b'.repeat(40),
      pluginVersion: '1.0.1',
    }
    const env = observationEnv(state)
    const registerDesired = desiredNativeHostPostcondition(env, 'codex', 'marketplace-register')
    expect(registerDesired.isDesired(observeNativeHost(env, 'codex'))).toBe(false)
    state.head = state.remoteHead
    expect(registerDesired.isDesired(observeNativeHost(env, 'codex'))).toBe(true)

    state.marketplaceSource = 'https://github.com/jefferysha/tenon-fork.git'
    expect(registerDesired.isDesired(observeNativeHost(env, 'codex'))).toBe(false)

    state.marketplaceSource = 'https://github.com/jefferysha/tenon.git'
    const refreshDesired = desiredNativeHostPostcondition(env, 'codex', 'marketplace-refresh')
    state.head = state.remoteHead
    state.marketplaceRoot = '/host/other-tenon-marketplace'
    expect(refreshDesired.isDesired(observeNativeHost(env, 'codex'))).toBe(false)
  })

  test('empty inventory registration rejects a local lookalike and requires the canonical remote', () => {
    const state = {
      head: 'a'.repeat(40),
      remoteHead: 'b'.repeat(40),
      pluginVersion: '1.0.1',
      marketplacePresent: false,
    }
    const env = observationEnv(state)
    const desired = desiredNativeHostPostcondition(env, 'codex', 'marketplace-register')

    state.marketplacePresent = true
    state.marketplaceRoot = '/tmp/untrusted-local-tenon'
    state.marketplaceSource = 'jefferysha/tenon'
    state.marketplaceSourceType = 'local'
    expect(desired.isDesired(observeNativeHost(env, 'codex'))).toBe(false)

    state.marketplaceSourceType = 'git'
    state.marketplaceRemote = 'https://github.com/jefferysha/tenon-fork.git'
    expect(desired.isDesired(observeNativeHost(env, 'codex'))).toBe(false)

    state.marketplaceRemote = 'https://github.com/jefferysha/tenon.git'
    expect(desired.isDesired(observeNativeHost(env, 'codex'))).toBe(false)
    state.head = state.remoteHead
    expect(desired.isDesired(observeNativeHost(env, 'codex'))).toBe(true)
  })

  test('local refresh and plugin desired state preserve the observed source and roots', () => {
    const state = {
      head: 'a'.repeat(40),
      remoteHead: 'b'.repeat(40),
      pluginVersion: '1.0.0',
      marketplaceSourceType: 'local',
      marketplaceSource: '/source/tenon',
      pluginRoot: '/plugins/tenon/1.0.0',
    }
    const env = observationEnv(state)
    const refreshDesired = desiredNativeHostPostcondition(env, 'codex', 'marketplace-refresh')
    expect(refreshDesired.isDesired(observeNativeHost(env, 'codex'))).toBe(true)
    state.marketplaceSource = '/source/other'
    expect(refreshDesired.isDesired(observeNativeHost(env, 'codex'))).toBe(false)

    state.marketplaceSource = '/source/tenon'
    const pluginDesired = desiredNativeHostPostcondition(env, 'codex', 'plugin-install')
    state.pluginVersion = '1.0.1'
    expect(pluginDesired.isDesired(observeNativeHost(env, 'codex'))).toBe(true)
    state.pluginRoot = '/plugins/tenon/other-root'
    expect(pluginDesired.isDesired(observeNativeHost(env, 'codex'))).toBe(false)
  })

  test('local marketplace without a readable Git HEAD keeps its explicit target sentinel', () => {
    const state = {
      head: 'unavailable',
      remoteHead: 'b'.repeat(40),
      pluginVersion: '1.0.0',
      marketplaceSourceType: 'local',
      marketplaceSource: '/source/tenon',
      pluginRoot: '/plugins/tenon/1.0.0',
    }
    const env = observationEnv(state)
    const desired = desiredNativeHostPostcondition(env, 'codex', 'marketplace-refresh')

    expect(JSON.parse(desired.serialized)).toMatchObject({
      head: 'local-marketplace',
      marketplace: { head: null },
    })
    expect(desired.isDesired(observeNativeHost(env, 'codex'))).toBe(true)
    expect(desired.isEquivalentDesired(desired.serialized)).toBe(true)
  })

  test('malformed host inventory fails closed before any mutation can be checkpointed', () => {
    const env = {
      runCommand: () => ({ code: 0, stdout: 'not-json', stderr: '' }),
    } as unknown as SetupEnv
    expect(() => observeNativeHost(env, 'codex')).toThrow(ManagedRuntimeIndeterminateError)
  })

  test('duplicate tenon marketplace or plugin identities are indeterminate', () => {
    const env = observationEnv({
      head: 'a'.repeat(40),
      remoteHead: 'b'.repeat(40),
      pluginVersion: '1.0.1',
    })
    const base = env.runCommand
    env.runCommand = (cmd, args) => {
      const result = base(cmd, args)
      if (cmd === 'codex' && args.join(' ') === 'plugin marketplace list --json') {
        const parsed = JSON.parse(result.stdout) as { marketplaces: unknown[] }
        parsed.marketplaces.push(parsed.marketplaces[0])
        return { ...result, stdout: JSON.stringify(parsed) }
      }
      return result
    }
    expect(() => observeNativeHost(env, 'codex')).toThrow(/marketplace identity.*重复/)

    const pluginEnv = observationEnv({
      head: 'a'.repeat(40),
      remoteHead: 'b'.repeat(40),
      pluginVersion: '1.0.1',
    })
    const pluginBase = pluginEnv.runCommand
    pluginEnv.runCommand = (cmd, args) => {
      const result = pluginBase(cmd, args)
      if (cmd === 'codex' && args.join(' ') === 'plugin list --json') {
        const parsed = JSON.parse(result.stdout) as { installed: unknown[] }
        parsed.installed.push(parsed.installed[0])
        return { ...result, stdout: JSON.stringify(parsed) }
      }
      return result
    }
    expect(() => observeNativeHost(pluginEnv, 'codex')).toThrow(/plugin identity.*重复/)
  })

  test('disabled tenon plugin remains observable for remove/reinstall reconciliation', () => {
    const env = observationEnv({
      head: 'a'.repeat(40),
      remoteHead: 'b'.repeat(40),
      pluginVersion: '1.0.1',
    })
    const base = env.runCommand
    env.runCommand = (cmd, args) => {
      const result = base(cmd, args)
      if (cmd === 'codex' && args.join(' ') === 'plugin list --json') {
        const parsed = JSON.parse(result.stdout) as {
          installed: Array<Record<string, unknown>>
        }
        parsed.installed[0] = { ...parsed.installed[0], enabled: false }
        return { ...result, stdout: JSON.stringify(parsed) }
      }
      return result
    }
    expect(JSON.parse(observeNativeHost(env, 'codex'))).toMatchObject({
      plugin: { enabled: false, version: '1.0.1' },
    })
  })
})
