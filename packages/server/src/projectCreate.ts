/**
 * 新建项目：选已有目录，或在父目录下新建空目录并 `git init`；随后按选择写入项目级指令文件、骨架目录，登记为项目。
 *
 * - dry_run：只校验与计算计划（文件新建 / 修改 / 不变的 current 与 next），不产生任何副作用。
 * - 新建目录：全部校验（含 `git --version`）先于任何写入；mkdir 之后任一步失败都删掉本次创建的目录（按 inode 核对）。
 * - 已有目录：从不 `git init`、从不建骨架目录；指令文件按 dry run 拿到的摘要写入；已登记的项目不报错。
 */
import { execFile } from 'node:child_process'
import { lstatSync, mkdirSync, rmSync } from 'node:fs'
import { isAbsolute, join, resolve as resolvePath } from 'node:path'
import {
  PROJECT_INSTRUCTION_FILES, containsManagedMarker, mergeManagedBlocks, readProjectRegistry,
  type ProjectInstructionFile, type RecordActor,
} from '@tenon/kernel'
import { IDENTITY_REQUIRED, recordInstructionAudit } from './instructionAudit.js'
import { INSTRUCTION_TEXT_MAX_BYTES, applyInstructions, previewInstructionApply, type InstructionResult } from './instructionFiles.js'
import { trustedFsFailure, writeTrustedFile } from './instructionTrustedFs.js'
import { registerProjectAnchored } from './projects.js'
import type { ServerPaths } from './types.js'
import { withTrustedDirectoryChain } from './workflowTrustedFs.js'
import {
  captureWorkflowRootAnchor, closeWorkflowRootAnchor, lstatIfExists, sameIdentity, type WorkflowRootAnchor,
} from './workflowRootAnchor.js'

export type GitRunner = (args: readonly string[], cwd: string) => Promise<{ code: number; stderr: string }>

export interface ProjectCreateDeps {
  readonly paths: Pick<ServerPaths, 'registryPath' | 'configRoot'>
  readonly workflowRootAnchors: Map<string, WorkflowRootAnchor>
  readonly runGit: GitRunner
  /** 新建项目的作者；null = 本机没有声明身份，执行阶段拒绝（dry run 不需要）。 */
  readonly actor: RecordActor | null
}

interface InstructionsRequest { readonly text: string; readonly targets: readonly ProjectInstructionFile[]; readonly baseDigests: Readonly<Record<string, string>> }

export type ProjectCreatePlan =
  | { readonly mode: 'empty'; readonly root: string; readonly parent: string; readonly directories: readonly string[]; readonly instructions: InstructionsRequest | null; readonly dryRun: boolean }
  | { readonly mode: 'existing'; readonly root: string; readonly instructions: InstructionsRequest | null; readonly dryRun: boolean }

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
  return { text: body.text, targets, baseDigests: Object.fromEntries(Object.entries(digests).map(([key, item]) => [key, String(item)])) }
}

/** 解码与静态校验；不访问文件系统。 */
export function decodeProjectCreate(body: unknown): ProjectCreatePlan | InstructionResult {
  const request = record(body)
  const allowed = ['mode', 'parent', 'name', 'path', 'directories', 'instructions', 'dry_run']
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
  const dryRun = request.dry_run === true
  if (request.mode === 'empty') {
    if (!absolutePath(request.parent) || typeof request.name !== 'string' || !NAME.test(request.name)) return fail(400, 'invalid-path', '父目录必须是绝对路径，名称只能含字母、数字、. _ -')
    const parent = resolvePath(request.parent)
    return { mode: 'empty', parent, root: join(parent, request.name), directories: directories.map(String), instructions, dryRun }
  }
  if (request.mode === 'existing') {
    if (!absolutePath(request.path)) return fail(400, 'invalid-path', '路径必须是绝对路径')
    if (directories.length > 0) return fail(400, 'invalid', '已有目录不创建骨架目录')
    return { mode: 'existing', root: resolvePath(request.path), instructions, dryRun }
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
          id, path: join(plan.root, id), base_digest: 'absent', current: null, next: mergeManagedBlocks(plan.instructions?.text ?? '', []),
        })),
      },
    }
  }
  const problem = directoryProblem(plan.root, fail(404, 'path-missing', '路径不存在'))
  if (problem) return problem
  let files: unknown[] = []
  if (plan.instructions) {
    const anchor = captureWorkflowRootAnchor(plan.root)
    try {
      const preview = previewInstructionApply({ level: 'project', anchor }, plan.instructions.text, plan.instructions.targets)
      if (preview.status !== 200) return preview
      files = (preview.body as { files: unknown[] }).files
    } finally {
      closeWorkflowRootAnchor(anchor)
    }
  }
  return {
    status: 200,
    body: {
      ok: true, root: plan.root, git: lstatIfExists(join(plan.root, '.git')) ? 'existing' : 'none',
      registration: registered(deps, plan.root) ? 'already' : 'add', directories: [], files,
    },
  }
}

function removeCreated(root: string, anchor: WorkflowRootAnchor): void {
  try {
    const current = lstatSync(root)
    if (current.isDirectory() && !current.isSymbolicLink() && sameIdentity(current, anchor)) rmSync(root, { recursive: true, force: true })
  } catch {
    // 目录已被换位或删除时不动它，宁可遗留也不删错。
  }
}

async function executeEmpty(plan: Extract<ProjectCreatePlan, { mode: 'empty' }>, deps: ProjectCreateDeps): Promise<InstructionResult> {
  try {
    mkdirSync(plan.root)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return fail(409, 'project-path-exists', '目录已存在')
    return trustedFsFailure(error)
  }
  const anchor = captureWorkflowRootAnchor(plan.root)
  let step = 'git-init'
  try {
    if ((await deps.runGit(['init'], plan.root)).code !== 0) throw new Error('git init 失败')
    step = 'directories'
    for (const directory of plan.directories) {
      const name = directory.slice(0, -1)
      withTrustedDirectoryChain(anchor, [name], true, () => { throw new Error('目录创建失败') }, () => undefined)
      const keep = writeTrustedFile(anchor, [name], '.gitkeep', '', 'absent', 1)
      if (!keep.ok) throw new Error('.gitkeep 写入失败')
    }
    let files: unknown[] = []
    if (plan.instructions) {
      step = 'instructions'
      const applied = applyInstructions({ level: 'project', anchor }, plan.instructions.text, plan.instructions.targets.map((id) => ({ id, base_digest: 'absent' })))
      if (applied.status !== 200) throw new Error('指令文件写入失败')
      files = (applied.body as { files: unknown[] }).files
    }
    step = 'register'
    const registration = await registerProjectAnchored(deps.paths, deps.workflowRootAnchors, plan.root)
    if (!registration.ok) throw new Error(registration.error)
    return { status: 200, body: { ok: true, root: plan.root, git: 'init', registration: 'add', directories: plan.directories, files } }
  } catch {
    removeCreated(plan.root, anchor)
    return fail(500, 'project-create-failed', '新建项目失败', { step })
  } finally {
    closeWorkflowRootAnchor(anchor)
  }
}

async function executeExisting(plan: Extract<ProjectCreatePlan, { mode: 'existing' }>, deps: ProjectCreateDeps): Promise<InstructionResult> {
  let files: unknown[] = []
  if (plan.instructions) {
    const instructions = plan.instructions
    const anchor = captureWorkflowRootAnchor(plan.root)
    try {
      const applied = applyInstructions({ level: 'project', anchor }, instructions.text,
        instructions.targets.map((id) => ({ id, base_digest: instructions.baseDigests[id] ?? 'absent' })))
      if (applied.status !== 200) return applied
      files = (applied.body as { files: unknown[] }).files
    } finally {
      closeWorkflowRootAnchor(anchor)
    }
  }
  const git = lstatIfExists(join(plan.root, '.git')) ? 'existing' : 'none'
  if (registered(deps, plan.root)) {
    return { status: 200, body: { ok: true, root: plan.root, git, registration: 'already', directories: [], files } }
  }
  const registration = await registerProjectAnchored(deps.paths, deps.workflowRootAnchors, plan.root)
  if (!registration.ok) return fail(registration.code, 'registration-failed', registration.error)
  return { status: 200, body: { ok: true, root: plan.root, git, registration: 'add', directories: [], files } }
}

/** POST /api/projects/create：解码 → 校验 / dry run → 执行。执行记作者，dry run 不需要身份也不记。 */
export async function handleProjectCreate(body: unknown, deps: ProjectCreateDeps): Promise<InstructionResult> {
  const plan = decodeProjectCreate(body)
  if ('status' in plan) return plan
  try {
    const checked = await planProjectCreate(plan, deps)
    if (checked.status !== 200 || plan.dryRun) return checked
    const actor = deps.actor
    if (actor === null) return IDENTITY_REQUIRED
    const created = plan.mode === 'empty' ? await executeEmpty(plan, deps) : await executeExisting(plan, deps)
    // 项目根是目录，没有文件摘要可比，前后都记 absent。
    if (created.status === 200) {
      recordInstructionAudit(deps.paths.configRoot, {
        actor, action: 'project-create', target: plan.root, digest_before: 'absent', digest_after: 'absent',
      })
    }
    return created
  } catch (error) {
    return trustedFsFailure(error)
  }
}
