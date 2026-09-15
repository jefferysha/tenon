/**
 * Tenon 配置域项目注册表写模块（G18，spec §3.1）—— projects.json 的
 * add/remove。读沿用 registry.ts::readRegistry（容错语义不变），写走 kernel
 * writeProjectRegistry 原子原语（tmp+rename，崩溃不留半截 JSON——v5 T2 偏离登记的 backlog
 * 收口）。序列化格式逐字节不变：JSON 数组 + 2 空格缩进 + 尾换行，保持人工可编辑。
 *
 * 鉴权语境：POST /api/projects 与 POST /api/projects/create 是全仓仅有的**豁免第四层信任锚**的写端点——
 * 它们的职责就是把 root 放进注册表，"root 必须已注册"在这里逻辑不成立；作为补偿，本模块
 * 强制 root 真实存在且为目录（404），并做两侧规范化判重（409）。
 */
import { lstatSync, statSync } from 'node:fs'
import { resolve as resolvePath } from 'node:path'
import { registerProjectRoot, unregisterProjectRoot } from '@tenon/kernel'
import type { ServerPaths } from './types.js'
import {
  assertWorkflowRootAnchor, captureWorkflowRootAnchor, closeWorkflowRootAnchor, type WorkflowRootAnchor,
} from './workflowRootAnchor.js'

export type ProjectWriteResult =
  | { ok: true; root: string }
  | { ok: false; code: 400 | 404 | 409; error: string }

export async function addProjectToRegistry(registryPath: string, rawRoot: unknown): Promise<ProjectWriteResult> {
  if (typeof rawRoot !== 'string' || !rawRoot) {
    return { ok: false, code: 400, error: 'root 须为非空字符串' }
  }
  let isDir: boolean
  try {
    isDir = statSync(rawRoot).isDirectory()
  } catch {
    return { ok: false, code: 404, error: `路径不存在：${rawRoot}` }
  }
  if (!isDir) {
    return { ok: false, code: 404, error: `路径不是目录：${rawRoot}` }
  }
  const normalized = resolvePath(rawRoot)
  if (!await registerProjectRoot(registryPath, normalized)) {
    return { ok: false, code: 409, error: `项目已注册：${normalized}` }
  }
  return { ok: true, root: normalized }
}

export type ProjectRemoveResult =
  | { ok: true }
  | { ok: false; code: 400 | 404; error: string }

export async function removeProjectFromRegistry(registryPath: string, rawRoot: unknown): Promise<ProjectRemoveResult> {
  if (typeof rawRoot !== 'string' || !rawRoot) {
    return { ok: false, code: 400, error: '缺 root 查询参数' }
  }
  const normalized = resolvePath(rawRoot)
  if (!await unregisterProjectRoot(registryPath, normalized)) {
    return { ok: false, code: 404, error: `项目未注册：${normalized}` }
  }
  return { ok: true }
}

export type AnchoredRegistration =
  | { ok: true; root: string; added: true }
  | { ok: false; code: 400 | 404 | 409; error: string }

/**
 * 注册项目并建立 inode 锚（POST /api/projects 与新建项目共用）：先捕获锚，再写注册表，
 * 写入后复核锚仍指向同一目录；任何一步失败都撤销注册，不留只有注册没有锚的项目。
 */
export async function registerProjectAnchored(
  paths: Pick<ServerPaths, 'registryPath'>,
  anchors: Map<string, WorkflowRootAnchor>,
  rawRoot: unknown,
): Promise<AnchoredRegistration> {
  let pendingAnchor: WorkflowRootAnchor | undefined
  if (typeof rawRoot === 'string' && rawRoot) {
    try {
      pendingAnchor = captureWorkflowRootAnchor(rawRoot)
    } catch {
      // stat 历来跟随 symlink；workflow 能力锚必须更严：最终词法段本身若是
      // symlink，不能先把它写进注册表再在业务请求上学习其目标 inode。
      try {
        if (lstatSync(resolvePath(rawRoot)).isSymbolicLink()) {
          return { ok: false, code: 400, error: `registered root 不得是 symlink：${resolvePath(rawRoot)}` }
        }
      } catch {
        // 不存在/不可访问/非目录继续交给 addProjectToRegistry，以保持既有 404 文案与状态码。
      }
    }
  }
  const result = await addProjectToRegistry(paths.registryPath, rawRoot)
  if (!result.ok) {
    if (pendingAnchor) closeWorkflowRootAnchor(pendingAnchor)
    return result
  }
  if (!pendingAnchor || pendingAnchor.path !== result.root) {
    if (pendingAnchor) closeWorkflowRootAnchor(pendingAnchor)
    await removeProjectFromRegistry(paths.registryPath, result.root).catch(() => undefined)
    return { ok: false, code: 400, error: 'registered root 在注册期间未能建立稳定 inode 锚' }
  }
  try {
    assertWorkflowRootAnchor(pendingAnchor)
  } catch (error) {
    closeWorkflowRootAnchor(pendingAnchor)
    await removeProjectFromRegistry(paths.registryPath, result.root).catch(() => undefined)
    return { ok: false, code: 400, error: error instanceof Error ? error.message : String(error) }
  }
  const previous = anchors.get(result.root)
  if (previous) closeWorkflowRootAnchor(previous)
  anchors.set(result.root, pendingAnchor)
  return { ok: true, root: result.root, added: true }
}
