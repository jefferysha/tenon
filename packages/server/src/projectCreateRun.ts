/**
 * 新建项目的执行阶段，拆成可报告的步骤：directory → git → skeleton → file:<name>（逐个文件）→ clients → register。
 *
 * 每步先报 running，成功报 done，失败报 failed（带错误原文）后停止；后续步骤保持未开始。
 * 新建目录：任一步失败都删掉本次创建的目录（按 inode 核对），因此整体重试是安全的。
 * 已有目录：指令文件逐个写入，失败时已写入的文件保留；重试前重新 dry run 拿到新摘要即可（内容相同 = 不变）。
 */
import { lstatSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { readProjectRegistry } from '@tenon/kernel'
import { applyInstructions, type InstructionResult } from './instructionFiles.js'
import { trustedFsFailure, writeTrustedFile } from './instructionTrustedFs.js'
import { writeProjectClients } from './projectClients.js'
import { effectiveText, previewProjectFile, type InstructionsRequest } from './projectInstructionText.js'
import type { ProjectCreateDeps, ProjectCreatePlan } from './projectCreate.js'
import { registerProjectAnchored } from './projects.js'
import { withTrustedDirectoryChain } from './workflowTrustedFs.js'
import {
  captureWorkflowRootAnchor, closeWorkflowRootAnchor, lstatIfExists, sameIdentity, type WorkflowRootAnchor,
} from './workflowRootAnchor.js'

export type CreateStepState = 'running' | 'done' | 'failed'
export interface CreateStepEvent { readonly id: string; readonly state: CreateStepState; readonly error?: string; readonly code?: string }
export type CreateStepReporter = (event: CreateStepEvent) => void

type EmptyPlan = Extract<ProjectCreatePlan, { mode: 'empty' }>
type ExistingPlan = Extract<ProjectCreatePlan, { mode: 'existing' }>

/** 旧的 JSON 端点在 500 里带的 step 名（兼容面）。 */
const LEGACY_STEP: Readonly<Record<string, string>> = { git: 'git-init', skeleton: 'directories', clients: 'clients', register: 'register' }
const legacyStep = (id: string): string => LEGACY_STEP[id] ?? (id.startsWith('file:') ? 'instructions' : id)

const ERROR_MAX = 600

const fail = (status: number, code: string, error: string, extra: Record<string, unknown> = {}): InstructionResult =>
  ({ status, body: { ok: false, code, error, ...extra } })

class StepFailure extends Error {
  constructor(
    readonly step: string, message: string, readonly code: string | undefined,
    readonly result: InstructionResult | null = null, readonly original: unknown = null,
  ) {
    super(message)
  }
}

function bodyText(result: InstructionResult): { error: string; code: string | undefined } {
  const body = typeof result.body === 'object' && result.body !== null ? result.body : {}
  const error = Reflect.get(body, 'error')
  const code = Reflect.get(body, 'code')
  return { error: typeof error === 'string' ? error : `HTTP ${result.status}`, code: typeof code === 'string' ? code : undefined }
}

const hasClients = (plan: ProjectCreatePlan): boolean => plan.clients !== undefined && plan.clients !== null

async function recordClients(plan: ProjectCreatePlan, anchor: WorkflowRootAnchor, report: CreateStepReporter): Promise<void> {
  const clients = plan.clients
  if (clients === undefined || clients === null) return
  await runStep('clients', report, () => {
    const written = writeProjectClients(anchor, clients)
    if (!written.ok) throw new StepFailure('clients', written.error, written.code)
  })
}

/** 本次计划会执行的步骤 id（进度视图的行）。 */
export function createStepIds(plan: ProjectCreatePlan): string[] {
  const files = [...(plan.instructions?.targets ?? []).map((id) => `file:${id}`), ...(hasClients(plan) ? ['clients'] : [])]
  if (plan.mode === 'existing') return [...(needsGitInit(plan) ? ['git'] : []), ...files, 'register']
  return ['directory', 'git', ...(plan.directories.length > 0 ? ['skeleton'] : []), ...files, 'register']
}

async function runStep<T>(id: string, report: CreateStepReporter, work: () => T | Promise<T>): Promise<T> {
  report({ id, state: 'running' })
  try {
    const value = await work()
    report({ id, state: 'done' })
    return value
  } catch (error) {
    const failure = error instanceof StepFailure
      ? error
      : new StepFailure(id, error instanceof Error ? error.message : String(error), undefined, null, error)
    report({ id, state: 'failed', error: failure.message.slice(0, ERROR_MAX), ...(failure.code === undefined ? {} : { code: failure.code }) })
    throw failure
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

/** 按实际正文（引用 / 追加 / 替换）写一个文件；baseDigest 不符时由 applyInstructions 以 409 拒绝。 */
function writeFile(anchor: WorkflowRootAnchor, request: InstructionsRequest, id: string, baseDigest: string): unknown {
  const preview = previewProjectFile(anchor, request, id)
  const planned = Reflect.get(Object(preview.body), 'files')
  const current = Array.isArray(planned) ? Reflect.get(Object(planned[0]), 'current') : null
  const text = preview.status === 200 ? effectiveText(request, id, typeof current === 'string' ? current : null) : request.text
  const applied = applyInstructions({ level: 'project', anchor }, text, [{ id, base_digest: baseDigest }])
  if (applied.status !== 200) {
    const { error, code } = bodyText(applied)
    throw new StepFailure(`file:${id}`, error, code, applied)
  }
  const files = Reflect.get(Object(applied.body), 'files')
  return Array.isArray(files) ? files[0] : undefined
}

const needsGitInit = (plan: ProjectCreatePlan): boolean =>
  plan.mode === 'existing' && plan.gitInit === true && lstatIfExists(join(plan.root, '.git')) === undefined

async function gitInit(plan: ProjectCreatePlan, deps: ProjectCreateDeps, report: CreateStepReporter): Promise<void> {
  await runStep('git', report, async () => {
    const git = await deps.runGit(['init'], plan.root)
    if (git.code !== 0) {
      throw new StepFailure('git', `git init: ${git.stderr.trim() || `exit ${git.code}`}`, undefined,
        fail(500, 'project-create-failed', '新建项目失败', { step: 'git-init' }))
    }
  })
}

export async function executeEmpty(plan: EmptyPlan, deps: ProjectCreateDeps, report: CreateStepReporter): Promise<InstructionResult> {
  report({ id: 'directory', state: 'running' })
  try {
    mkdirSync(plan.root)
  } catch (error) {
    const exists = error instanceof Error && Reflect.get(error, 'code') === 'EEXIST'
    const result = exists ? fail(409, 'project-path-exists', '目录已存在') : trustedFsFailure(error)
    report({ id: 'directory', state: 'failed', ...bodyText(result) })
    return result
  }
  report({ id: 'directory', state: 'done' })
  const anchor = captureWorkflowRootAnchor(plan.root)
  try {
    await gitInit(plan, deps, report)
    if (plan.directories.length > 0) {
      await runStep('skeleton', report, () => {
        for (const directory of plan.directories) {
          const name = directory.slice(0, -1)
          withTrustedDirectoryChain(anchor, [name], true, () => { throw new Error(`${directory}: mkdir`) }, () => undefined)
          const keep = writeTrustedFile(anchor, [name], '.gitkeep', '', 'absent', 1)
          if (!keep.ok) throw new Error(`${directory}.gitkeep: write`)
        }
      })
    }
    const files: unknown[] = []
    const instructions = plan.instructions
    for (const id of instructions?.targets ?? []) {
      if (instructions) files.push(await runStep(`file:${id}`, report, () => writeFile(anchor, instructions, id, 'absent')))
    }
    await recordClients(plan, anchor, report)
    await runStep('register', report, async () => {
      const registration = await registerProjectAnchored(deps.paths, deps.workflowRootAnchors, plan.root)
      if (!registration.ok) throw new Error(registration.error)
    })
    return { status: 200, body: { ok: true, root: plan.root, git: 'init', registration: 'add', directories: plan.directories, files } }
  } catch (error) {
    removeCreated(plan.root, anchor)
    const step = error instanceof StepFailure ? legacyStep(error.step) : 'unknown'
    return fail(500, 'project-create-failed', '新建项目失败', { step })
  } finally {
    closeWorkflowRootAnchor(anchor)
  }
}

export async function executeExisting(plan: ExistingPlan, deps: ProjectCreateDeps, report: CreateStepReporter): Promise<InstructionResult> {
  const files: unknown[] = []
  try {
    const initialized = needsGitInit(plan)
    if (initialized) await gitInit(plan, deps, report)
    const instructions = plan.instructions
    if (instructions || hasClients(plan)) {
      const anchor = captureWorkflowRootAnchor(plan.root)
      try {
        for (const id of instructions?.targets ?? []) {
          if (instructions) files.push(await runStep(`file:${id}`, report, () => writeFile(anchor, instructions, id, instructions.baseDigests[id] ?? 'absent')))
        }
        await recordClients(plan, anchor, report)
      } finally {
        closeWorkflowRootAnchor(anchor)
      }
    }
    const git = initialized ? 'init' : lstatIfExists(join(plan.root, '.git')) ? 'existing' : 'none'
    const registration = await runStep('register', report, async () => {
      if (readProjectRegistry(deps.paths.registryPath).includes(plan.root)) return 'already' as const
      const added = await registerProjectAnchored(deps.paths, deps.workflowRootAnchors, plan.root)
      if (!added.ok) throw new StepFailure('register', added.error, 'registration-failed', fail(added.code, 'registration-failed', added.error))
      return 'add' as const
    })
    return { status: 200, body: { ok: true, root: plan.root, git, registration, directories: [], files } }
  } catch (error) {
    if (error instanceof StepFailure && error.result !== null) return error.result
    throw error instanceof StepFailure && error.original !== null ? error.original : error
  }
}
