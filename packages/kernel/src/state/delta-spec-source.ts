/**
 * 一份 change 的 delta spec 从哪里来——全仓库只有这一个答案。
 *
 * 两种任务来源不同，但「这份 change 有哪些 delta spec」必须只有一个口径，否则彩排 / 应用 / 回执 / ship 出口
 * 的 spec-migration-applied 守卫会各算各的（观察模式的任务曾因此既无法应用规格、守卫又当作不需要而放行）：
 *   · 带文档账本的任务（升级前创建，契约模式）：取账本里 kind=delta-spec 的记录，行为与从前一致；
 *   · 没有账本的任务（观察模式）：扫描任务目录 `specs/` 下所有名为 spec.md 的普通文件。
 *
 * 返回值是仓库相对路径（`openspec/changes/<change>/specs/<capability...>/spec.md`），与账本记录同形。
 *
 * 扫描是安全边界：任务目录里的内容由 agent 写出，不可信。所以遍历有界（深度与条目数超限即报错，
 * 不静默截断——截断会让一份 delta spec 悄悄从「已应用」的判定里消失）；只认普通文件；一遇符号链接就整体拒绝，
 * 不跟随也不忽略（忽略等于让链接背后的 delta spec 逃过守卫，跟随等于让任务目录之外的文件被当作本任务的规格）。
 * 遍历只走 readdir 给出的真实目录项、从不拼接 `..`，路径因此不可能越出任务目录。
 */
import { lstat, opendir } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { readDocumentLedger } from './document-ledger.js'

/** 每份 delta spec 的文件名（OpenSpec 约定：`specs/<capability>/spec.md`）。 */
const DELTA_SPEC_FILE = 'spec.md'
/** `specs/` 之下最多允许的目录层数（capability 允许多级，但不会深到离谱）。 */
export const DELTA_SPEC_SCAN_MAX_DEPTH = 6
/** 一次扫描最多检视的目录项数（含目录与非 spec.md 的文件）。 */
export const DELTA_SPEC_SCAN_MAX_ENTRIES = 512

/** delta spec 来源不可信或不可读（符号链接、超出界限、`specs` 不是目录）。调用方按「证据不可用」处理。 */
export class DeltaSpecSourceError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DeltaSpecSourceError'
  }
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined
  const code = Reflect.get(error, 'code')
  return typeof code === 'string' ? code : undefined
}

async function scanDeltaSpecs(changeDir: string): Promise<readonly string[]> {
  const specsDir = join(changeDir, 'specs')
  const prefix = `openspec/changes/${basename(changeDir)}/specs`
  try {
    const info = await lstat(specsDir)
    if (info.isSymbolicLink()) throw new DeltaSpecSourceError(`${prefix} 是符号链接，拒绝跟随`)
    if (!info.isDirectory()) throw new DeltaSpecSourceError(`${prefix} 不是目录`)
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return []
    throw error
  }

  const found: string[] = []
  let inspected = 0
  const walk = async (dir: string, rel: string, depth: number): Promise<void> => {
    for await (const entry of await opendir(dir)) {
      inspected += 1
      if (inspected > DELTA_SPEC_SCAN_MAX_ENTRIES) {
        throw new DeltaSpecSourceError(`${prefix} 下的条目超过 ${DELTA_SPEC_SCAN_MAX_ENTRIES} 个上限`)
      }
      const entryRel = `${rel}/${entry.name}`
      if (entry.isSymbolicLink()) throw new DeltaSpecSourceError(`${entryRel} 是符号链接，拒绝跟随`)
      if (entry.isDirectory()) {
        if (depth + 1 > DELTA_SPEC_SCAN_MAX_DEPTH) {
          throw new DeltaSpecSourceError(`${entryRel} 的目录深度超过 ${DELTA_SPEC_SCAN_MAX_DEPTH} 层上限`)
        }
        await walk(join(dir, entry.name), entryRel, depth + 1)
      } else if (entry.isFile() && entry.name === DELTA_SPEC_FILE) {
        found.push(entryRel)
      }
    }
  }
  await walk(specsDir, prefix, 0)
  return found.sort()
}

/**
 * 这份 change 的 delta spec 路径（仓库相对）。没有 = 本 change 不产出规格增量，「应用规格」对它不适用
 * （返回空数组，由调用方决定 not-required 还是别的口径）。
 *
 * 账本不可读 / 来源不可信时抛错（`DocumentLedgerError` / `DeltaSpecSourceError`），调用方按证据不可用处理，
 * 不回退到另一种来源——换一种来源再试，等于让坏账本把「有 delta」悄悄变成「没有 delta」。
 */
export async function changeDeltaSpecPaths(changeDir: string): Promise<readonly string[]> {
  const ledger = await readDocumentLedger(changeDir)
  if (ledger !== undefined) {
    return ledger.records.filter((record) => record.kind === 'delta-spec').map((record) => record.path)
  }
  return scanDeltaSpecs(changeDir)
}
