/**
 * 机器画像：OS + 架构 + CPU 型号 + 核数 + 内存档位 + 运行时主版本 + 目录 `profiles_env` 的取值 → 短哈希，
 * 附可读名（如 `darwin-arm64-m3max-node22-1a2b3c4d`）。基准基线按画像存放，不同画像互不比较：
 * 换机器只会得到「没有同画像基线」的提示，而不是一次假退化。
 *
 * `machineProfile` 是纯函数（输入显式给出，便于测试与跨宿主复算）；`readMachineProfileInput` 读本机。
 */
import { arch, cpus, platform, totalmem } from 'node:os'
import { sha256Hex } from '../sha256.js'
import { canonicalJson } from './canonical.js'
import { MACHINE_PROFILE_ID_RE } from './paths.js'

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
  readonly facts: {
    readonly platform: string
    readonly arch: string
    readonly cpu: string
    readonly cores: number
    readonly memory_gib: number
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

export function machineProfile(input: MachineProfileInput): MachineProfile {
  const runtimeMajor = /^v?(\d+)/.exec(input.runtimeVersion)?.[1] ?? '0'
  const facts = {
    platform: slug(input.platform, 16),
    arch: slug(input.arch, 16),
    cpu: slug(input.cpuModel, 24),
    cores: Math.max(1, Math.trunc(input.cores)),
    memory_gib: memoryTierGiB(input.memoryBytes),
    runtime: `node${runtimeMajor}`,
  }
  const env = Object.fromEntries(Object.keys(input.env).sort().map((name) => [name, input.env[name] ?? null]))
  const hash = sha256Hex(canonicalJson({ facts, env })).slice(0, 8)
  const label = `${facts.platform}-${facts.arch}-${facts.cpu}-${facts.runtime}`
  const id = `${label}-${hash}`.slice(0, 96)
  if (!MACHINE_PROFILE_ID_RE.test(id)) throw new Error(`machineProfile: 画像 id 非法 ${id}`)
  return { id, label, facts }
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
