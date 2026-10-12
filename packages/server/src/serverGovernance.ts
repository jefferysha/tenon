import { mkdirSync } from 'node:fs'
import type { ServerResponse } from 'node:http'
import { join, resolve as resolvePath } from 'node:path'
import {
  createEffectiveSkillResolver,
  type EffectiveSkillResolver,
  type ExtendedManifestData,
} from '@tenon/kernel'
import { cliExitHttpStatus, parsePipelineCliJson, type PipelineCliRunner } from './operations.js'
import { dedupeRoots } from './snapshot.js'
import {
  assertWorkflowRootAnchor,
  captureWorkflowRootAnchor,
  closeWorkflowRootAnchor,
  type WorkflowRootAnchor,
} from './workflows.js'
import { errMsg } from './serverSupport.js'
import { projectFileExists } from './projectCapabilities.js'

/** 工作流路由的存储锚：root 为空 = 全局存储（首次使用时建目录并捕获锚），否则 = 已注册项目。 */
export type WorkflowStoreCheck =
  | { ok: true; anchor: WorkflowRootAnchor; global: boolean }
  | { ok: false; code: 403 | 404; error: string }

export interface ServerGovernanceOptions {
  registry: () => string[]
  /** 全局工作流存储根（产品 configRoot/workflows）：目录形状同项目，`.pipeline/workflows/*.yaml`。 */
  globalWorkflowRoot: string
  sendJson: (res: ServerResponse, code: number, body: unknown) => void
  operationsAvailable: boolean
  operationRunner: PipelineCliRunner
}

export function createServerGovernance(options: ServerGovernanceOptions) {
  const { registry, globalWorkflowRoot, sendJson, operationsAvailable, operationRunner } = options

const fileExists = projectFileExists

// 信任锚单源：19 处「两侧规范化再比较」的唯一落点——注册表条目经 dedupeRoots 已 resolve
// （且过滤空条目，防 resolvePath('')=cwd 混入可信集），提交的 root 此处同样 resolvePath，
// 两侧规范化后再比对，防止「同一路径的非规范写法（如结尾多一个斜杠）」被误判为未注册。
// 纯读谓词：判定失败后的响应（404 + 各自 error 文案）仍由调用点自持——transition 端点的
// 文案与其余 18 处不同，收敛响应会破坏行为保持。
const isRegisteredRoot = (root: string): boolean =>
  dedupeRoots(registry()).includes(resolvePath(root))

async function executeOperation(
  res: ServerResponse,
  root: string,
  args: readonly string[],
): Promise<void> {
  if (!operationsAvailable) {
    return sendJson(res, 503, { ok: false, error: 'Operations 未接线：Tenon CLI bundle 不存在' })
  }
  if (!root || !isRegisteredRoot(root)) {
    return sendJson(res, 404, { ok: false, error: 'root 未在机器级项目注册表中' })
  }
  try {
    const result = await operationRunner(resolvePath(root), args)
    return sendJson(res, cliExitHttpStatus(result.exitCode), {
      ok: result.exitCode === 0,
      exit_code: result.exitCode,
      command: ['pipeline', ...args],
      result: parsePipelineCliJson(result.stdout),
      stdout: result.stdout.trimEnd(),
      stderr: result.stderr.trimEnd(),
    })
  } catch (error) {
    return sendJson(res, 500, { ok: false, error: errMsg(error) })
  }
}

// workflow CRUD 的注册根是能力锚，不是每请求可重新学习的 pathname。启动时先捕获当下已注册、
// 且确为非 symlink 目录的 inode。CLI `tenon init` 会直接原子更新同一机器级注册表，因而
// server 也允许一个*尚未有锚的、当前仍在可信注册表中的*根在首个 workflow 请求时作一次 TOFU
// 捕获；捕获成功后永不重建锚。这样既支持运行中 dashboard 发现 CLI 新建项目，也不会在已经
// 绑定的 root 被换位后把新 pathname 重新认作可信。
const workflowRootAnchors = new Map<string, WorkflowRootAnchor>()
try {
  for (const root of dedupeRoots(registry())) {
    try { workflowRootAnchors.set(root, captureWorkflowRootAnchor(root)) } catch { /* 陈旧/不安全条目隔离 */ }
  }
} catch {
  // 注册表读取本就具 best-effort 语义；读取失败时 workflow CRUD 没有锚，统一 fail-closed。
}

type WorkflowRootCheck =
  | { ok: true; anchor: WorkflowRootAnchor }
  | { ok: false; code: 403 | 404; error: string }

const workflowRootForRequest = (root: string): WorkflowRootCheck => {
  const normalized = resolvePath(root)
  if (!dedupeRoots(registry()).includes(normalized)) {
    const stale = workflowRootAnchors.get(normalized)
    if (stale) {
      closeWorkflowRootAnchor(stale)
      workflowRootAnchors.delete(normalized)
    }
    return { ok: false, code: 404, error: 'root 未在机器级项目注册表中' }
  }
  const anchor = workflowRootAnchors.get(normalized)
  if (!anchor) {
    try {
      const captured = captureWorkflowRootAnchor(normalized)
      workflowRootAnchors.set(normalized, captured)
      return { ok: true, anchor: captured }
    } catch (e) {
      return { ok: false, code: 403, error: errMsg(e) }
    }
  }
  try {
    assertWorkflowRootAnchor(anchor)
    return { ok: true, anchor }
  } catch (e) {
    return { ok: false, code: 403, error: errMsg(e) }
  }
}

let globalAnchor: WorkflowRootAnchor | null = null
const globalWorkflowStore = (): WorkflowStoreCheck => {
  try {
    if (globalAnchor === null) {
      mkdirSync(join(globalWorkflowRoot, '.pipeline', 'workflows'), { recursive: true })
      globalAnchor = captureWorkflowRootAnchor(globalWorkflowRoot)
    } else {
      assertWorkflowRootAnchor(globalAnchor)
    }
    return { ok: true, anchor: globalAnchor, global: true }
  } catch (e) {
    return { ok: false, code: 403, error: errMsg(e) }
  }
}
const workflowStoreForRequest = (root: string): WorkflowStoreCheck => {
  if (root === '') return globalWorkflowStore()
  const checked = workflowRootForRequest(root)
  return checked.ok ? { ok: true, anchor: checked.anchor, global: false } : checked
}


  /** 项目的技能解析器：loop 装配校验与快照 readiness 共用。技能只看工作流 YAML，不查轨道登记表也不叠加 manifest 矩阵。 */
  const rootSkillResolver = (_root: string, manifest: ExtendedManifestData): EffectiveSkillResolver =>
    createEffectiveSkillResolver(manifest)
  return {
    fileExists,
    isRegisteredRoot,
    executeOperation,
    workflowRootAnchors,
    workflowRootForRequest,
    workflowStoreForRequest,
    rootSkillResolver,
  }
}
