import { execFile, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { accessSync, constants as fsConstants, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { readAutomationJson, readUpstreamSkillView } from '@tenon/automation'
import {
  loadManifest,
  readSecrets,
  skillTextModelInvocable,
} from '@tenon/kernel'
import { tapStatus } from '@tenon/tap'
import type { DoctorProbes } from '../deps.js'
import { probeAfkReadiness } from '../afkReadiness.js'
import { probeCodexAuth } from '../codexAuth.js'
import { detectHostEnvironment } from '../hostKind.js'
import { createDoctorProductIdentityProbe } from './doctor-product-identity.js'
import { parseHostPluginInventory } from './plugin-host.js'
import { resolveCommandOnPath } from './commandExists.js'
import { REAL_RUNTIME_INSTALLER } from '../runtime/installer.js'
import type { RuntimeScopeSnapshot } from '../runtime/scope.js'
import { freezeTrustedExecutable, type TrustedExecutable } from './trusted-executable.js'

export interface DoctorProbeRuntime {
  /** Resolve a physical executable binding from the current runtime scope. */
  resolveTrustedCommand?: (
    command: 'bash' | 'git' | 'node' | 'codex' | 'claude',
    scope: RuntimeScopeSnapshot,
  ) => TrustedExecutable | undefined
  /** Injectable verifier runner used by deterministic probe tests. */
  run?: (
    file: string,
    args: readonly string[],
    options?: { readonly timeoutMs?: number },
  ) => Promise<{ readonly code: number; readonly output: string }>
}

function safeReaddirDirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() || e.isSymbolicLink())
      .map((e) => e.name)
  } catch {
    return []
  }
}

function readDisabledPluginKeys(): Set<string> {
  const disabled = new Set<string>()
  try {
    const raw = readFileSync(join(homedir(), '.claude', 'settings.json'), 'utf8')
    const parsed: unknown = JSON.parse(raw)
    const ep = typeof parsed === 'object' && parsed !== null && 'enabledPlugins' in parsed
      ? parsed.enabledPlugins
      : undefined
    if (ep !== null && typeof ep === 'object') {
      for (const [key, val] of Object.entries(ep)) if (val === false) disabled.add(key)
    }
  } catch {
    // settings.json 缺失/坏 JSON/无 enabledPlugins → 不过滤（同老脚本优雅退化）
  }
  return disabled
}

function scanInstalledSkillNames(): Set<string> {
  const home = homedir()
  const names = new Set<string>()
  for (const n of safeReaddirDirs(join(home, '.claude', 'skills'))) names.add(n)
  for (const n of safeReaddirDirs(join(home, '.agents', 'skills'))) names.add(n)
  const cache = join(home, '.claude', 'plugins', 'cache')
  const disabledPlugins = readDisabledPluginKeys()
  for (const marketplace of safeReaddirDirs(cache)) {
    const mktDir = join(cache, marketplace)
    for (const plugin of safeReaddirDirs(mktDir)) {
      if (disabledPlugins.has(`${plugin}@${marketplace}`)) continue
      names.add(plugin)
      for (const skill of safeReaddirDirs(join(mktDir, plugin, 'skills'))) names.add(skill)
    }
  }
  return names
}

function scanCodexProjectSkillNames(cwd: string, root: string): Set<string> {
  const names = new Set<string>()
  for (const skillsRoot of [join(root, 'skills'), join(cwd, '.agents', 'skills')]) {
    for (const name of safeReaddirDirs(skillsRoot)) {
      try {
        if (statSync(join(skillsRoot, name, 'SKILL.md')).isFile()) names.add(name)
      } catch {
        // A dangling/unreadable link is not an installed Codex skill.
      }
    }
  }
  return names
}

function scanSkillDigests(skillsRoot: string): Map<string, string> {
  const digests = new Map<string, string>()
  for (const name of safeReaddirDirs(skillsRoot)) {
    try {
      const skillPath = join(skillsRoot, name, 'SKILL.md')
      if (!statSync(skillPath).isFile()) continue
      digests.set(name, createHash('sha256').update(readFileSync(skillPath)).digest('hex'))
    } catch {
      // Unreadable/dangling entries are not active Skills; missing coverage remains visible.
    }
  }
  return digests
}

function defaultTrustedCommand(
  command: 'bash' | 'git' | 'node' | 'codex' | 'claude',
  scope: RuntimeScopeSnapshot,
): TrustedExecutable | undefined {
  const candidate = resolveCommandOnPath(command, {
    pathValue: scope.env.PATH,
    platform: process.platform,
    requireAbsolutePathEntries: true,
  })
  if (candidate === undefined) return undefined
  return freezeTrustedExecutable(candidate)
}

export function makeDoctorProbes(
  runtimeScope: () => RuntimeScopeSnapshot,
  root: string,
  runtime: DoctorProbeRuntime = {},
): DoctorProbes {
  const resolveTrusted = runtime.resolveTrustedCommand ?? defaultTrustedCommand
  const trustedCommand = (name: 'bash' | 'git' | 'node' | 'codex' | 'claude'): TrustedExecutable | undefined =>
    resolveTrusted(name, runtimeScope())
  const runtimeInstallerScope = () => {
    const scope = runtimeScope()
    const trustedBash = trustedCommand('bash')
    if (trustedBash === undefined) throw new Error('可信 Bash 不可执行')
    return { homeDir: scope.homeDir, env: scope.env, trustedBashPath: trustedBash.executable }
  }
  const runVerifySkills = (): Promise<{ code: number; output: string }> => {
    const scope = runtimeScope()
    const bash = resolveTrusted('bash', scope)
    const node = resolveTrusted('node', scope)
    if (bash === undefined || node === undefined) {
      return Promise.resolve({ code: 1, output: '可信 Bash/Node 不可执行' })
    }
    const args = [join(root, 'tools', 'verify-skills.sh'), '--quiet', '--root', root, '--node', node.executable]
    // This is deliberately synchronous proof code immediately followed by the injected/real
    // exec call.  No await, mutation, or other child can occur in the proof-to-spawn window.
    try {
      if (!bash.verify() || !node.verify()) {
        return Promise.resolve({ code: 1, output: '可信 Bash/Node 身份已漂移' })
      }
    } catch {
      return Promise.resolve({ code: 1, output: '可信 Bash/Node 身份已漂移' })
    }
    if (runtime.run !== undefined) return runtime.run(bash.executable, args, { timeoutMs: 30_000 })
    return new Promise((resolve) => {
      execFile(
        bash.executable,
        args,
        { timeout: 30_000 },
        (err, stdout, stderr) => {
          const errCode = (err as { code?: unknown } | null)?.code
          const code = err ? (typeof errCode === 'number' ? errCode : 1) : 0
          resolve({ code, output: `${stdout ?? ''}${stderr ?? ''}` })
        },
      )
    })
  }

  return {
    nodeVersion: () => process.version,
    gitAvailable: () => {
      const git = trustedCommand('git')
      if (git === undefined) return Promise.resolve(false)
      return new Promise((resolve) => {
        execFile(git.executable, ['--version'], (err) => resolve(!err))
      })
    },
    pluginRoot: root,
    manifestError: () => {
      try {
        loadManifest(join(root, 'templates', 'manifest.yaml'))
        return null
      } catch (e) {
        return e instanceof Error ? e.message : String(e)
      }
    },
    fileExists: (p) => {
      try { return statSync(p).isFile() } catch { return false }
    },
    fileExecutable: (p) => {
      try { accessSync(p, fsConstants.X_OK); return true } catch { return false }
    },
    dirExists: (p) => {
      try { return statSync(p).isDirectory() } catch { return false }
    },
    env: (name) => process.env[name],
    statuslineConfigured: () => {
      try {
        return readFileSync(join(homedir(), '.claude', 'settings.json'), 'utf8').includes('statusline.sh')
      } catch {
        return false
      }
    },
    nativeRuntimeHost: async () => {
      const active = (await REAL_RUNTIME_INSTALLER.inspect(runtimeInstallerScope())).active?.source.host
      return active === 'codex' || active === 'claude' ? active : null
    },
    hostKind: () => detectHostEnvironment(process.env).kind,
    codexAuthStatus: () => probeCodexAuth(),
    runVerifySkills,
    productIdentity: createDoctorProductIdentityProbe(runtimeScope, REAL_RUNTIME_INSTALLER),
    tapStatus: () => {
      const s = tapStatus()
      return { intercepting: s.intercepting, captureEnabled: s.captureEnabled, message: s.message }
    },
    installedSkillNames: () => scanInstalledSkillNames(),
    codexProjectSkillNames: () => scanCodexProjectSkillNames(process.cwd(), root),
    hostPluginInventory: async () => {
      const active = (await REAL_RUNTIME_INSTALLER.inspect(runtimeInstallerScope())).active
      const host = active?.source.host
      if (host !== 'codex' && host !== 'claude') return { kind: 'static' as const }
      try {
        const executable = trustedCommand(host)
        if (executable === undefined) {
          return { kind: 'unavailable' as const, host, detail: '宿主不在可信绝对 PATH 项中' }
        }
        const stdout = execFileSync(executable.executable, ['plugin', 'list', '--json'], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: 5_000,
        })
        const inventory = parseHostPluginInventory(host, stdout)
        return inventory === null
          ? { kind: 'unavailable' as const, host, detail: '宿主返回畸形 JSON' }
          : { kind: 'native' as const, host, enabledIds: inventory.enabledIds, tenonLoadErrors: inventory.tenonLoadErrors }
      } catch (error) {
        return { kind: 'unavailable' as const, host, detail: error instanceof Error ? error.message : String(error) }
      }
    },
    codexSkillDiscovery: async () => {
      const active = (await REAL_RUNTIME_INSTALLER.inspect(runtimeInstallerScope())).active?.source.host
      const native = active === 'codex' || active === 'claude'
      return {
        ...(native ? { selectedRoot: root } : {}),
        projectRoot: join(process.cwd(), '.agents', 'skills'),
        selected: native ? scanSkillDigests(join(root, 'skills')) : new Map(),
        project: scanSkillDigests(join(process.cwd(), '.agents', 'skills')),
      }
    },
    manifestSkills: () => {
      try {
        const m = loadManifest(join(root, 'templates', 'manifest.yaml'))
        return { mandatory: m.mandatorySkills, recommended: m.recommendedSkills }
      } catch {
        return null
      }
    },
    afkReadiness: () => {
      const scope = runtimeScope()
      return probeAfkReadiness({
        image: readAutomationJson(process.cwd()).image ?? 'sandcastle:local',
        secretsEnv: readSecrets(scope.paths.secretsPath).keys,
        hostEnv: scope.env,
        defaultCodexHome: join(scope.homeDir, '.codex'),
      })
    },
    /**
     * 直接读 `<pluginRoot>/skills/<id>/SKILL.md`：宿主允不允许代模型调用这个技能，权威来源就是
     * 这份 frontmatter。不走 skills.lock.json——那是跨版本线格式，v0.1.0 的读取器 exact-keys，
     * 多一个字段就整条拒掉（真机 setup 已实测中招）。读不到字节就回 null（未知），不猜。
     */
    skillModelInvocable: (skillId: string) => {
      if (skillId.includes(':') || skillId.includes('/') || skillId === '' || skillId === '.' || skillId === '..') {
        return null
      }
      try {
        return skillTextModelInvocable(readFileSync(join(root, 'skills', skillId, 'SKILL.md'), 'utf8'))
      } catch {
        return null
      }
    },
    upstreamSkillView: () => {
      try {
        return readUpstreamSkillView(root, runtimeScope().paths.stateRoot)
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) }
      }
    },
  }
}
