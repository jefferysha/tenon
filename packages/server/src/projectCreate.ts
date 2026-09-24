/**
 * 新建项目：选已有目录，或在父目录下新建空目录并 `git init`；随后按选择写入项目级指令文件、骨架目录，登记为项目。
 *
 * - dry_run：只校验与计算计划（文件新建 / 修改 / 不变的 current 与 next），不产生任何副作用。
 * - 新建目录：全部校验（含 `git --version`）先于任何写入；mkdir 之后任一步失败都删掉本次创建的目录（按 inode 核对）。
 * - 已有目录：从不 `git init`、从不建骨架目录；指令文件按 dry run 拿到的摘要写入；已登记的项目不报错。
 */
import { execFile } from 'node:child_process'
import { isAbsolute, join, resolve as resolvePath } from 'node:path'
import {
  PROJECT_INSTRUCTION_FILES, containsManagedMarker, mergeManagedBlocks, readProjectRegistry,
  type ProjectInstructionFile, type RecordActor,
} from '@tenon/kernel'
import { IDENTITY_REQUIRED, recordInstructionAudit } from './instructionAudit.js'
import { INSTRUCTION_TEXT_MAX_BYTES, type InstructionResult } from './instructionFiles.js'
import { trustedFsFailure } from './instructionTrustedFs.js'
import { normalizeProjectClients } from './projectClients.js'
import { executeEmpty, executeExisting, type CreateStepReporter } from './projectCreateRun.js'
import { REFERENCE_FILES, effectiveText, previewProjectFiles, type InstructionsRequest } from './projectInstructionText.js'
import type { ServerPaths } from './types.js'
import {
  captureWorkflowRootAnchor, closeWorkflowRootAnchor, lstatIfExists, type WorkflowRootAnchor,
} from './workflowRootAnchor.js'

export type GitRunner = (args: readonly string[], cwd: string) => Promise<{ code: number; stderr: string }>

export interface ProjectCreateDeps {
  readonly paths: Pick<ServerPaths, 'registryPath' | 'configRoot'>
  readonly workflowRootAnchors: Map<string, WorkflowRootAnchor>
  readonly runGit: GitRunner
  /** 新建项目的作者；null = 本机没有声明身份，执行阶段拒绝（dry run 不需要）。 */
  readonly actor: RecordActor | null
}


/**
 * clients：要记入 `.tenon/clients.json` 的客户端（已去重排序）；null = 请求没带，不写。
 * gitInit：已有目录还不是 git 仓库时是否 `git init`（缺省不做）。
 */
export type ProjectCreatePlan =
  | {
    readonly mode: 'empty'; readonly root: string; readonly parent: string; readonly directories: readonly string[]
    readonly instructions: InstructionsRequest | null; readonly clients?: readonly string[] | null; readonly dryRun: boolean
  }
  | {
    readonly mode: 'existing'; readonly root: string; readonly instructions: InstructionsRequest | null
    readonly clients?: readonly string[] | null; readonly gitInit?: boolean; readonly dryRun: boolean
  }

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/
const DIRECTORY = /^[a-z0-9._-]+\/$/

const fail = (status: number, code: string, error: string, extra: Record<string, unknown> = {}): InstructionResult =>
  ({ status, body: { ok: false, code, error, ...extra } })

export const runGitCommand: GitRunner = (args, cwd) => new Promise((resolve) => {
  execFile('git', [...args], { cwd, timeout: 10_000 }, (error, _stdout, stderr) => {
    const exit = error === null ? 0 : typeof error.code === 'number' ? error.code : 1
    resolve({ code: exit, stderr: String(stderr ?? '') })
  })
})

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : null
}

const absolutePath = (value: unknown): value is string => typeof value === 'string' && isAbsolute(value) && !value.includes('\0')

function decodeInstructions(value: unknown): InstructionsRequest | null | 'invalid' {
  if (value === null || value === undefined) return null
  const body = record(value)
  if (!body || typeof body.text !== 'string' || !Array.isArray(body.targets)) return 'invalid'
  const targets = body.targets.filter((item): item is ProjectInstructionFile =>
    typeof item === 'string' && (PROJECT_INSTRUCTION_FILES as readonly string[]).includes(item))
  if (targets.length === 0 || targets.length !== body.targets.length || new Set(targets).size !== targets.length) return 'invalid'
  const digests = record(body.base_digests ?? {})
  if (!digests || !Object.values(digests).every((item) => typeof item === 'string')) return 'invalid'
  const references = subset(body.references, targets, REFERENCE_FILES)
  const append = subset(body.append, targets, targets)
  if (references === null || append === null) return 'invalid'
  return {
    text: body.text, targets, references, append,
    baseDigests: Object.fromEntries(Object.entries(digests).map(([key, item]) => [key, String(item)])),
  }
}

/** 可选的文件子集：缺省为空；必须是 targets 与 allowed 的交集里不重复的项。 */
function subset(value: unknown, targets: readonly string[], allowed: readonly string[]): string[] | null {
  if (value === undefined) return []
  if (!Array.isArray(value) || new Set(value).size !== value.length) return null
  return value.every((item) => typeof item === 'string' && targets.includes(item) && allowed.includes(item)) ? value.map(String) : null
}

/** 解码与静态校验；不访问文件系统。 */
export function decodeProjectCreate(body: unknown): ProjectCreatePlan | InstructionResult {
  const request = record(body)
  const allowed = ['mode', 'parent', 'name', 'path', 'directories', 'instructions', 'clients', 'git_init', 'dry_run']
  if (!request || Object.keys(request).some((key) => !allowed.includes(key))) return fail(400, 'invalid', '请求体不合法')
  const directories = request.directories ?? []
  if (!Array.isArray(directories) || directories.length > 8 || !directories.every((item) => typeof item === 'string' && DIRECTORY.test(item) && item !== './' && item !== '../')
    || new Set(directories).size !== directories.length) {
    return fail(400, 'invalid', 'directories 必须是不超过 8 个单层目录名（以 / 结尾）')
  }
  const instructions = decodeInstructions(request.instructions)
  if (instructions === 'invalid') return fail(400, 'invalid', 'instructions 不合法')
  if (instructions && containsManagedMarker(instructions.text)) return fail(400, 'managed-marker-in-text', '正文不能包含 Tenon 受管块标记行')
  if (instructions && Buffer.byteLength(instructions.text, 'utf8') > INSTRUCTION_TEXT_MAX_BYTES) return fail(413, 'too-large', '指令文件过大')
  const clients = request.clients === undefined || request.clients === null ? null : normalizeProjectClients(request.clients)
  if (clients === null && request.clients !== undefined && request.clients !== null) return fail(400, 'invalid', 'clients 只能是已知客户端 id')
  const dryRun = request.dry_run === true
  if (request.mode === 'empty') {
    if (!absolutePath(request.parent) || typeof request.name !== 'string' || !NAME.test(request.name)) return fail(400, 'invalid-path', '父目录必须是绝对路径，名称只能含字母、数字、. _ -')
    const parent = resolvePath(request.parent)
    return { mode: 'empty', parent, root: join(parent, request.name), directories: directories.map(String), instructions, clients, dryRun }
  }
  if (request.mode === 'existing') {
    if (!absolutePath(request.path)) return fail(400, 'invalid-path', '路径必须是绝对路径')
    if (directories.length > 0) return fail(400, 'invalid', '已有目录不创建骨架目录')
    if (request.git_init !== undefined && typeof request.git_init !== 'boolean') return fail(400, 'invalid', 'git_init 必须是布尔值')
    return { mode: 'existing', root: resolvePath(request.path), instructions, clients, gitInit: request.git_init === true, dryRun }
  }
  return fail(400, 'invalid', 'mode 必须是 empty 或 existing')
}

function directoryProblem(path: string, missing: InstructionResult): InstructionResult | null {
  const entry = lstatIfExists(path)
  if (!entry) return missing
  if (entry.isSymbolicLink()) return fail(400, 'path-unsafe', '路径不能是符号链接')
  if (!entry.isDirectory()) return fail(400, 'not-directory', '路径不是目录')
  return null
}

const registered = (deps: ProjectCreateDeps, root: string): boolean => readProjectRegistry(deps.paths.registryPath).includes(root)

/** 校验计划并返回 dry run 结果；新建目录时同时确认 git 可用。 */
export async function planProjectCreate(plan: ProjectCreatePlan, deps: ProjectCreateDeps): Promise<InstructionResult> {
  if (plan.mode === 'empty') {
    const parentProblem = directoryProblem(plan.parent, fail(404, 'parent-missing', '父目录不存在'))
    if (parentProblem) return parentProblem.body && (parentProblem.body as { code: string }).code === 'not-directory'
      ? fail(400, 'parent-not-directory', '父目录不是目录') : parentProblem
    if (lstatIfExists(plan.root)) return fail(409, 'project-path-exists', '目录已存在')
    if ((await deps.runGit(['--version'], plan.parent)).code !== 0) return fail(422, 'git-unavailable', '无法运行 git')
    return {
      status: 200,
      body: {
        ok: true, root: plan.root, git: 'init', registration: registered(deps, plan.root) ? 'already' : 'add',
        directories: plan.directories.map((path) => ({ path, exists: false })),
        files: (plan.instructions?.targets ?? []).map((id) => ({
          id, path: join(plan.root, id), base_digest: 'absent', current: null,
          next: plan.instructions ? mergeManagedBlocks(effectiveText(plan.instructions, id, null), []) : '',
        })),
      },
    }
  }
  const problem = directoryProblem(plan.root, fail(404, 'path-missing', '路径不存在'))
  if (problem) return problem
  const hasGit = lstatIfExists(join(plan.root, '.git')) !== undefined
  if (!hasGit && plan.gitInit === true && (await deps.runGit(['--version'], plan.root)).code !== 0) return fail(422, 'git-unavailable', '无法运行 git')
  let files: unknown[] = []
  if (plan.instructions) {
    const anchor = captureWorkflowRootAnchor(plan.root)
    try {
      const preview = previewProjectFiles(anchor, plan.instructions)
      if (preview.status !== 200) return preview
      files = (preview.body as { files: unknown[] }).files
    } finally {
      closeWorkflowRootAnchor(anchor)
    }
  }
  return {
    status: 200,
    body: {
      ok: true, root: plan.root, git: hasGit ? 'existing' : plan.gitInit === true ? 'init' : 'none',
      registration: registered(deps, plan.root) ? 'already' : 'add', directories: [], files,
    },
  }
}

/** 解码 + 校验；执行（非 dry run）还要求本机有声明身份。返回计划 = 可以执行；返回结果 = 直接响应。 */
export async function prepareProjectCreate(body: unknown, deps: ProjectCreateDeps): Promise<{ plan: ProjectCreatePlan } | InstructionResult> {
  const plan = decodeProjectCreate(body)
  if ('status' in plan) return plan
  try {
    const checked = await planProjectCreate(plan, deps)
    if (checked.status !== 200 || plan.dryRun) return checked
    if (deps.actor === null) return IDENTITY_REQUIRED
    return { plan }
  } catch (error) {
    return trustedFsFailure(error)
  }
}

/** 按步骤执行已校验的计划；成功后记一行审计。 */
export async function runProjectCreate(
  plan: ProjectCreatePlan, deps: ProjectCreateDeps, report: CreateStepReporter = () => undefined,
): Promise<InstructionResult> {
  try {
    const created = plan.mode === 'empty' ? await executeEmpty(plan, deps, report) : await executeExisting(plan, deps, report)
    // 项目根是目录，没有文件摘要可比，前后都记 absent。
    if (created.status === 200 && deps.actor !== null) {
      recordInstructionAudit(deps.paths.configRoot, {
        actor: deps.actor, action: 'project-create', target: plan.root, digest_before: 'absent', digest_after: 'absent',
      })
    }
    return created
  } catch (error) {
    return trustedFsFailure(error)
  }
}

/** POST /api/projects/create：解码 → 校验 / dry run → 执行。执行记作者，dry run 不需要身份也不记。 */
export async function handleProjectCreate(body: unknown, deps: ProjectCreateDeps): Promise<InstructionResult> {
  const prepared = await prepareProjectCreate(body, deps)
  return 'plan' in prepared ? runProjectCreate(prepared.plan, deps) : prepared
}
