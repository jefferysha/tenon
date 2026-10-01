/**
 * 机器画像：基准基线按画像存放，不同画像互不比较——换机器只会得到「没有同画像基线」的提示，而不是一次假退化。
 * 两种口径，由目录顶层的 `profile:` 选（缺省 `fine`）：
 *   · `fine`：OS + 架构 + CPU 型号 + 核数 + 内存档位 + 运行时主版本 + 目录 `profiles_env` 的取值 → 短哈希，
 *     附可读名（如 `darwin-arm64-m3max-node22-8510794d`）。适合固定的开发机。
 *   · `coarse`：OS + 架构 + 核数 + 运行时主版本 + `profiles_env` 的取值（如 `linux-x64-4c-node22-1a2b3c4d`）。
 *     CPU 型号与内存档位不参与：托管 CI 的同规格运行器会落在不同代的 CPU 上，细口径下每换一代 CPU 就得到一个新画像，
 *     已提交的基线永远对不上；粗口径让同规格运行器共用一份基线，代价是 CPU 代差会带进噪声（由基准的波动提示兜底）。
 *     口径写进哈希，粗细两种画像即使事实相同也不会撞 id。
 *
 * `machineProfile` 是纯函数（输入显式给出，便于测试与跨宿主复算）；`readMachineProfileInput` 读本机。
 */
import { arch, cpus, platform, totalmem } from 'node:os'
import { sha256Hex } from '../sha256.js'
import { canonicalJson } from './canonical.js'
import { MACHINE_PROFILE_ID_RE } from './paths.js'

export const MACHINE_PROFILE_MODES = ['fine', 'coarse'] as const
export type MachineProfileMode = (typeof MACHINE_PROFILE_MODES)[number]

export function isMachineProfileMode(value: unknown): value is MachineProfileMode {
  return typeof value === 'string' && (MACHINE_PROFILE_MODES as readonly string[]).includes(value)
}

export interface MachineProfileInput {
  readonly platform: string
  readonly arch: string
  readonly cpuModel: string
  readonly cores: number
  readonly memoryBytes: number
  /** 如 `v22.10.0`；只取主版本参与画像（补丁版本不改变性能口径）。 */
  readonly runtimeVersion: string
  /** profiles_env 声明的变量 → 当前值（未设置为 undefined）。只进哈希，不进可读名。 */
  readonly env: Readonly<Record<string, string | undefined>>
}

export interface MachineProfile {
  readonly id: string
  readonly label: string
  readonly mode: MachineProfileMode
  readonly facts: {
    readonly platform: string
    readonly arch: string
    /** 粗口径不记 CPU 型号。 */
    readonly cpu?: string
    readonly cores: number
    /** 粗口径不记内存档位。 */
    readonly memory_gib?: number
    readonly runtime: string
  }
}

function slug(value: string, max: number): string {
  const cleaned = value.toLowerCase()
    .replace(/\((?:r|tm)\)/g, '')
    .replace(/\b(?:apple|intel|amd|core|cpu|processor|with|radeon|graphics)\b/g, '')
    .replace(/@.*$/, '')
    .replace(/[^a-z0-9]+/g, '')
  return cleaned.slice(0, max) || 'unknown'
}

/** 内存档位：向下取到 2 的幂 GiB，避免同一台机器因可用内存波动得到不同画像。 */
export function memoryTierGiB(bytes: number): number {
  const gib = Math.max(1, Math.floor(bytes / 1024 ** 3))
  return 2 ** Math.floor(Math.log2(gib))
}

export function machineProfile(input: MachineProfileInput, mode: MachineProfileMode = 'fine'): MachineProfile {
  const runtimeMajor = /^v?(\d+)/.exec(input.runtimeVersion)?.[1] ?? '0'
  const base = {
    platform: slug(input.platform, 16),
    arch: slug(input.arch, 16),
    cores: Math.max(1, Math.trunc(input.cores)),
    runtime: `node${runtimeMajor}`,
  }
  const env = Object.fromEntries(Object.keys(input.env).sort().map((name) => [name, input.env[name] ?? null]))
  if (mode === 'coarse') {
    const hash = sha256Hex(canonicalJson({ mode, facts: base, env })).slice(0, 8)
    const label = `${base.platform}-${base.arch}-${base.cores}c-${base.runtime}`
    return finish(label, hash, mode, base)
  }
  const facts = { ...base, cpu: slug(input.cpuModel, 24), memory_gib: memoryTierGiB(input.memoryBytes) }
  // 细口径的哈希输入保持原样（不带 mode）：已提交的细口径基线文件名不能因为新增口径而变。
  const hash = sha256Hex(canonicalJson({ facts, env })).slice(0, 8)
  return finish(`${facts.platform}-${facts.arch}-${facts.cpu}-${facts.runtime}`, hash, mode, facts)
}

function finish(label: string, hash: string, mode: MachineProfileMode, facts: MachineProfile['facts']): MachineProfile {
  const id = `${label}-${hash}`.slice(0, 96)
  if (!MACHINE_PROFILE_ID_RE.test(id)) throw new Error(`machineProfile: 画像 id 非法 ${id}`)
  return { id, label, mode, facts }
}

/** 读取本机事实；profilesEnv 的取值由调用方经 config 层读出后传入（kernel 不直接读 process.env）。 */
export function readMachineProfileInput(runtimeVersion: string, env: Readonly<Record<string, string | undefined>>): MachineProfileInput {
  const list = cpus()
  return {
    platform: platform(),
    arch: arch(),
    cpuModel: list[0]?.model ?? 'unknown',
    cores: list.length,
    memoryBytes: totalmem(),
    runtimeVersion,
    env,
  }
}
