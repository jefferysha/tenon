/**
 * 工程用的 vitest 主版本：discover 要据此选 `vitest bench` 的调用（vitest 5 重写了 bench，删掉了 `--outputJson`，
 * 同一条命令在 ≤4 与 ≥5 上一个能跑一个直接退出 1）。
 *
 * 取证顺序：先看实际装了什么（从工程目录向上到仓库根，逐层找 `node_modules/vitest/package.json`，与 Node 的解析顺序一致，
 * monorepo 里提升到根的依赖也能读到），再看 package.json 声明的范围（同样从近到远）。装的版本永远压过声明——
 * `^4.1` 声明下装了 5 也按 5 算。两处都读不出主版本时返回 undefined，调用方必须按「不确定」处理，不能默认某个版本。
 */
import { resolve } from 'node:path'
import { isRecord } from './parsers/json.js'
import { readSmallText, type ProjectDir } from './discover-support.js'

export interface VitestVersion {
  readonly major: number
  /** 主版本的来源：实际安装的版本，还是 package.json 声明的范围。 */
  readonly source: 'installed' | 'declared'
  /** 读到的原文：安装的版本号（如 5.0.3）或声明的范围（如 ^5.0.3），给人读的提示用。 */
  readonly raw: string
}

const DECLARED_FIELDS: readonly string[] = ['devDependencies', 'dependencies', 'optionalDependencies', 'peerDependencies']
// 一个版本或一个简单范围：`5`、`5.0`、`^5.0.3`、`~4.1.0`、`=3.2.7`、`v5`、`5.x`、`5.*`、`^5.0.0-beta.7`。
const SIMPLE_RANGE = /^[\^~=]?\s*v?(\d+)(?:\.(?:\d+|[xX*])){0,2}(?:-[0-9A-Za-z.-]+)?$/u
const INSTALLED_VERSION = /^v?(\d+)\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]+)?$/u
const NPM_ALIAS = /^npm:vitest@/u

/** 安装的版本号 → 主版本；不是 `x.y.z` 形态返回 undefined。 */
export function majorOfInstalledVersion(version: string): number | undefined {
  const major = INSTALLED_VERSION.exec(version.trim())?.[1]
  return major === undefined ? undefined : Number(major)
}

/**
 * package.json 声明的范围 → 主版本。只认能唯一定出主版本的写法（简单版本 / `^` / `~` / `x` 通配，以及 `||` 连起来的
 * 全部同一主版本）；`>=5`、`>=3 <6`、`*`、`latest`、`next`、`workspace:*`、`catalog:`、git / 文件地址都返回 undefined——
 * 它们可能落在任何主版本上，猜了就是猜错的 bench 命令。
 */
export function majorOfDeclaredRange(range: string): number | undefined {
  const alternatives = range.trim().replace(NPM_ALIAS, '').split('||').map((part) => part.trim())
  const majors = alternatives.map((part) => SIMPLE_RANGE.exec(part)?.[1])
  if (majors.some((major) => major === undefined)) return undefined
  const distinct = new Set(majors)
  return distinct.size === 1 ? Number(majors[0]) : undefined
}

/** 从工程目录向上到仓库根（含）的目录，近的在前。 */
function ancestorsToRoot(dir: ProjectDir): string[] {
  const depth = dir.rel === '.' ? 0 : dir.rel.split('/').length
  const levels: string[] = []
  for (let up = 0; up <= depth; up++) levels.push(resolve(dir.abs, ...Array<string>(up).fill('..')))
  return levels
}

async function readJsonRecord(path: string): Promise<Readonly<Record<string, unknown>> | undefined> {
  const text = await readSmallText(path)
  if (text === undefined) return undefined
  try {
    const parsed: unknown = JSON.parse(text)
    return isRecord(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

export async function detectVitestVersion(dir: ProjectDir): Promise<VitestVersion | undefined> {
  const levels = ancestorsToRoot(dir)
  for (const level of levels) {
    const installed = await readJsonRecord(resolve(level, 'node_modules', 'vitest', 'package.json'))
    if (installed === undefined || installed.name !== 'vitest' || typeof installed.version !== 'string') continue
    const major = majorOfInstalledVersion(installed.version)
    if (major !== undefined) return { major, source: 'installed', raw: installed.version }
  }
  for (const level of levels) {
    const manifest = await readJsonRecord(resolve(level, 'package.json'))
    if (manifest === undefined) continue
    for (const field of DECLARED_FIELDS) {
      const section = manifest[field]
      const range = isRecord(section) ? section.vitest : undefined
      if (typeof range !== 'string') continue
      const major = majorOfDeclaredRange(range)
      // 最近的一处声明说了算：它写的是别的写法（latest 等）就不再往上找更远的声明凑一个版本。
      return major === undefined ? undefined : { major, source: 'declared', raw: range }
    }
  }
  return undefined
}
