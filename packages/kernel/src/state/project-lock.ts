/**
 * 项目级协调锁：`<repo>/.pipeline` 目录锁。
 *
 * 它串起「校验工作流 → 发布引用它的任务」与 server 的工作流删除 / 保存（后者在同一把锁内扫描引用该工作流的
 * 任务再动手）：建任务与改任务的 track / workflow 先拿它，工作流就不会在「已校验、未发布」的窗口里被删掉。
 * 锁序固定为 项目锁 → 任务锁；项目锁不可重入，回调里禁止再取同一把。
 *
 * 只加锁、不读任何配置。
 */
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { withLock } from './lock.js'

/** 项目协调锁所在目录（相对仓库根）。 */
export const PROJECT_LOCK_DIR = '.pipeline'

export async function withProjectCoordinationLock<T>(repoRoot: string, callback: () => Promise<T>): Promise<T> {
  const dir = path.join(repoRoot, PROJECT_LOCK_DIR)
  await mkdir(dir, { recursive: true })
  return withLock(dir, callback)
}
