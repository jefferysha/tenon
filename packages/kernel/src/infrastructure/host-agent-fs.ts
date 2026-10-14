/**
 * 宿主 agent 文件的落盘原语（内部件，不对外导出）：用户级安装（host-agent-install）与旧项目级文件清理
 * （host-agent-files）共用同一份原子写与「只看目标文件本身」的探查，两处的符号链接与崩溃残留规则不会各走各的。
 */
import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/** 目标文件本身的状态：不存在 / 符号链接（不跟随、不读） / 普通文件及其内容。 */
export type FileTarget = { readonly kind: 'missing' } | { readonly kind: 'link' } | { readonly kind: 'file'; readonly text: string }

export const isNotFound = (error: unknown): boolean => error instanceof Error && 'code' in error && error.code === 'ENOENT'

/**
 * tmp + rename 原子写，缺的父目录一并建出。临时文件名唯一且用 wx 创建：不会写穿事先摆好的同名链接，
 * 崩溃残留也不会挡住下次写入；失败时清掉临时文件再原样抛出。
 */
export async function writeAtomic(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.tmp.${process.pid}.${randomUUID()}`
  try {
    await writeFile(tmp, content, { encoding: 'utf8', flag: 'wx' })
    await rename(tmp, path)
  } catch (error) {
    await unlink(tmp).catch(() => {})
    throw error
  }
}

/** 只用 lstat 看目标文件本身：符号链接不跟随、不读内容；除「不存在」外的读写错误向上抛。 */
export async function inspectFile(path: string): Promise<FileTarget> {
  let info
  try {
    info = await lstat(path)
  } catch (error) {
    if (isNotFound(error)) return { kind: 'missing' }
    throw error
  }
  if (info.isSymbolicLink()) return { kind: 'link' }
  return { kind: 'file', text: await readFile(path, 'utf8') }
}
