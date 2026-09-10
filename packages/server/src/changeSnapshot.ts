import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  realpathSync,
} from 'node:fs'
import { isAbsolute, join, posix, relative, sep } from 'node:path'
import {
  decodeUtf8Text,
  LedgerContextBundleError,
  isCanonicalTaskPlanTasksMarkdown,
  projectPipelineTodo,
  readPipelineStateFromSync,
  type PipelineState,
} from '@tenon/kernel'
import {
  documentEvidence,
  documentTodoItems,
  readTerminalActivity,
  type SnapshotDeps,
} from './snapshot.js'
import type { ChangeSnapshot } from './types.js'
import { projectWorkflowDefinitionStatus } from './workflowDefinitionStatus.js'
import { projectReviewHandshake } from './reviewHandshake.js'
import { resolveSnapshotTrack } from './skillRuns.js'
import { readWorkflowSnapshotAuthority } from './workflowSnapshotAuthority.js'
import {
  resolveSnapshotEffectivePlan,
  resolveConfiguredWorkflowPolicySafely,
  snapshotTodoStages,
  snapshotWorkflowExecution,
  snapshotWorkflowRules,
  type WorkflowSnapshotCapabilityDeps,
} from './workflowSnapshot.js'
import {
  assertChangePathAnchor,
  captureChangePathAnchor,
  ContextBundlePathError,
  type ChangePathAnchor,
} from './contextBundlePreviewSupport.js'
import {
  assertWorkflowRootAnchor,
  captureWorkflowRootAnchor,
  closeWorkflowRootAnchor,
  readWorkflowForApi,
  WorkflowNotFoundError,
  WorkflowPathError,
  WorkflowReadError,
  type WorkflowRootAnchor,
} from './workflows.js'
import {
  ContextBundleTrustedFileError,
  readBounded,
  readTrustedFile,
} from './contextBundleTrustedReader.js'
import {
  hasCurrentCanonicalTaskPlanProjection,
  MAX_LEGACY_TASKS_MARKDOWN_BYTES,
  MAX_TASKS_MARKDOWN_BYTES,
} from './snapshotTasks.js'
import {
  assertWorkflowRootMutationVersion,
  captureWorkflowRootMutationVersion,
  sameIdentity,
  traversableDirectoryFdPath,
  type WorkflowRootMutationVersion,
} from './workflowRootAnchor.js'
import {
  captureStableFileVersion,
  matchesStableFileVersion,
} from './stableFileMetadata.js'
export { MAX_TASKS_MARKDOWN_BYTES } from './snapshotTasks.js'
export interface AnchoredChangeState {
  readonly changeDir: string
  readonly state: PipelineState
  readonly changeAnchor: ChangePathAnchor
}

function missing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && Reflect.get(error, 'code') === 'ENOENT'
}

function isInside(base: string, candidate: string): boolean {
  const fromBase = relative(base, candidate)
  return fromBase === ''
    || (fromBase !== '..' && !fromBase.startsWith(`..${sep}`) && !isAbsolute(fromBase))
}
type TasksFdReader = (fd: number, maxBytes: number) => string

function readBoundedTasksSource(fd: number, maxBytes: number): string {
  const bytes = readBounded(fd, maxBytes)
  if (bytes.byteLength > maxBytes) {
    throw new Error(`Change tasks 超过 ${maxBytes} bytes 上限`)
  }
  return decodeUtf8Text(bytes, 'Change tasks snapshot')
}

/** @internal Exported only so the race regression can prove no bytes are read before anchor checks. */
interface AnchoredTasksProjection {
  readonly source: string
  readonly trustedCanonicalProjection: boolean
}

export async function readAnchoredTasksProjection(
  changeAnchor: ChangePathAnchor,
  readSource: TasksFdReader = readBoundedTasksSource,
  authorizeCanonicalProjection?: (
    source: string,
    anchoredChangeDir: string,
  ) => boolean | Promise<boolean>,
  rootAnchor?: WorkflowRootAnchor,
): Promise<AnchoredTasksProjection | undefined> {
  let rootVersion: WorkflowRootMutationVersion | undefined
  const assertTrustContext = (): void => {
    if (rootAnchor === undefined) return
    try {
      rootVersion ??= captureWorkflowRootMutationVersion(rootAnchor)
      assertWorkflowRootMutationVersion(rootAnchor, rootVersion)
    } catch (cause) {
      throw new ContextBundlePathError(403, 'Change tasks registered root changed during read', cause)
    }
  }
  assertTrustContext()
  const lexicalTarget = join(changeAnchor.changeDir, 'tasks.md')
  const changeIdentity = changeAnchor.chain.at(-1)
  if (changeIdentity === undefined) {
    throw new ContextBundlePathError(403, 'Change tasks directory identity is missing')
  }
  assertChangePathAnchor(changeAnchor)
  let changeFd: number
  try {
    changeFd = openSync(
      changeAnchor.changeDir,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    )
  } catch (cause) {
    throw new ContextBundlePathError(403, 'Change tasks directory cannot be anchored', cause)
  }
  const openedChange = fstatSync(changeFd)
  const anchoredChangeDir = traversableDirectoryFdPath(changeFd, changeIdentity)
    ?? changeAnchor.changeDir
  if (!openedChange.isDirectory() || !sameIdentity(openedChange, changeIdentity)) {
    closeSync(changeFd)
    throw new ContextBundlePathError(403, 'Change tasks directory identity changed while anchoring')
  }
  assertTrustContext()
  const target = join(anchoredChangeDir, 'tasks.md')
  let fd: number
  try {
    fd = openSync(
      target,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    )
  } catch (error) {
    if (missing(error)) {
      closeSync(changeFd)
      return undefined
    }
    closeSync(changeFd)
    throw new ContextBundlePathError(403, 'Change tasks 路径不可信', error)
  }
  try {
    const opened = fstatSync(fd)
    if (!opened.isFile()) {
      throw new ContextBundlePathError(403, 'Change tasks 必须是普通文件')
    }
    const openedVersion = captureStableFileVersion(fstatSync(fd, { bigint: true }))
    const assertOpenedTargetStillAnchored = (): void => {
      let current
      let realPath: string
      try {
        assertChangePathAnchor(changeAnchor)
        current = lstatSync(lexicalTarget, { bigint: true })
        realPath = realpathSync(lexicalTarget)
      } catch (error) {
        if (error instanceof ContextBundlePathError) throw error
        throw new ContextBundlePathError(403, 'Change tasks 路径在读取期间变化', error)
      }
      if (
        current.isSymbolicLink()
        || !current.isFile()
        || !matchesStableFileVersion(current, openedVersion)
        || !isInside(changeAnchor.realPath, realPath)
      ) {
        throw new ContextBundlePathError(403, 'Change tasks 路径在读取期间变化')
      }
    }
    const assertOpenedFdStillStable = (): void => {
      if (!matchesStableFileVersion(fstatSync(fd, { bigint: true }), openedVersion)) {
        throw new ContextBundlePathError(403, 'Change tasks 路径在读取期间变化')
      }
    }
    // open(2) follows parent components even with O_NOFOLLOW. Validate that the opened inode is
    // still reached through the captured Change before reading any project-controlled bytes.
    assertOpenedTargetStillAnchored()
    assertOpenedFdStillStable()
    if (opened.size > MAX_TASKS_MARKDOWN_BYTES) {
      throw new Error(`Change tasks 超过 ${MAX_TASKS_MARKDOWN_BYTES} bytes 上限`)
    }
    const source = readSource(fd, MAX_TASKS_MARKDOWN_BYTES)
    assertTrustContext()
    const trustedCanonicalProjection = isCanonicalTaskPlanTasksMarkdown(source)
      && authorizeCanonicalProjection !== undefined
      && await authorizeCanonicalProjection(source, anchoredChangeDir)
    assertTrustContext()
    if (opened.size > MAX_LEGACY_TASKS_MARKDOWN_BYTES && !trustedCanonicalProjection) {
      throw new Error(`Legacy Change tasks 超过 ${MAX_LEGACY_TASKS_MARKDOWN_BYTES} bytes 上限`)
    }
    assertOpenedFdStillStable()
    assertOpenedTargetStillAnchored()
    assertTrustContext()
    return { source, trustedCanonicalProjection }
  } finally {
    closeSync(fd)
    closeSync(changeFd)
  }
}

/** @internal Exported only so existing callers can consume the bounded source without trust metadata. */
export async function readAnchoredTasksMarkdown(
  changeAnchor: ChangePathAnchor,
  readSource: TasksFdReader = readBoundedTasksSource,
  authorizeCanonicalProjection?: (
    source: string,
    anchoredChangeDir: string,
  ) => boolean | Promise<boolean>,
  rootAnchor?: WorkflowRootAnchor,
): Promise<string | undefined> {
  return (await readAnchoredTasksProjection(
    changeAnchor,
    readSource,
    authorizeCanonicalProjection,
    rootAnchor,
  ))?.source
}

export async function readAnchoredChangeState(
  root: WorkflowRootAnchor,
  changeName: string,
): Promise<AnchoredChangeState | null> {
  assertWorkflowRootAnchor(root)
  let changeAnchor: ChangePathAnchor
  try {
    changeAnchor = captureChangePathAnchor(root, changeName)
  } catch (error) {
    if (error instanceof ContextBundlePathError && error.status === 400) return null
    throw error
  }
  const prefix = posix.join('openspec', 'changes', changeName)
  const changeIdentity = changeAnchor.chain.at(-1)
  if (changeIdentity === undefined) {
    throw new ContextBundlePathError(403, 'canonical Change 路径身份缺失')
  }
  const readText = (relativePath: string): string | undefined => {
    try {
      return readTrustedFile(
        root,
        posix.join(prefix, relativePath.replaceAll(sep, '/')),
        2 * 1024 * 1024,
        undefined,
        changeIdentity,
      ).text
    } catch (error) {
      if (error instanceof LedgerContextBundleError
        && error.code === 'CONTEXT_BUNDLE_DOCUMENT_MISSING') return undefined
      if (error instanceof ContextBundleTrustedFileError) {
        throw new ContextBundlePathError(
          403,
          'canonical Change 状态路径不可信（须为非 symlink 普通文件）',
          error,
        )
      }
      throw error
    }
  }
  const state = readPipelineStateFromSync(readText, 'canonical Change state')
  if (state === undefined) return null
  assertWorkflowRootAnchor(root)
  assertChangePathAnchor(changeAnchor)
  return { changeDir: changeAnchor.changeDir, state, changeAnchor }
}

function stringField(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value.join(',') : value ?? ''
}

/**
 * Project exactly one Change without enumerating sibling roots/Changes and without inspecting or
 * repairing the YAML projection. This is the bounded read path for scope-specific GET endpoints.
 */
export async function readChangeSnapshot(
  deps: SnapshotDeps,
  root: string | WorkflowRootAnchor,
  changeName: string,
  nowMs = deps.now?.() ?? Date.now(),
): Promise<ChangeSnapshot | null> {
  const ownedAnchor: WorkflowRootAnchor | undefined = typeof root === 'string'
    ? captureWorkflowRootAnchor(root)
    : undefined
  const anchor: WorkflowRootAnchor = typeof root === 'string' ? ownedAnchor as WorkflowRootAnchor : root
  try {
    const anchored = await readAnchoredChangeState(anchor, changeName)
    if (anchored === null) return null
    const { changeDir, state } = anchored
    const rootPath = anchor.path
    const fields = state.fields
    const phase = stringField(fields.phase)
    const workflowName = stringField(fields.workflow) || 'default'
    const frozenPlan = state.runMetadata?.workflowPlanSnapshot
    const definitionWorkflow = frozenPlan?.workflowId ?? workflowName
    const configuredPolicy = resolveConfiguredWorkflowPolicySafely(
      definitionWorkflow,
      (name) => {
        try {
          return readWorkflowForApi(anchor, name)
        } catch (error) {
          if (error instanceof WorkflowNotFoundError) return null
          throw error
        }
      },
      (error) => error instanceof WorkflowPathError || error instanceof WorkflowReadError,
    )
    const workflowDefinition = projectWorkflowDefinitionStatus(
      definitionWorkflow,
      frozenPlan?.workflowFingerprint ?? null,
      configuredPolicy.status === 'available'
        ? { kind: 'current', fingerprint: configuredPolicy.workflowFingerprint }
        : { kind: configuredPolicy.status === 'unavailable' ? 'invalid' : configuredPolicy.status },
    )
    const trackId = Array.isArray(state.fields.track) ? state.fields.track.join(',') : (state.fields.track ?? '')
    const plan = resolveSnapshotEffectivePlan(rootPath, workflowName, {
      documentProfile: state.runMetadata?.documentProfile,
      documentGovernanceFingerprint: state.runMetadata?.documentGovernanceFingerprint,
      workflowPlanFingerprint: state.runMetadata?.workflowPlanFingerprint,
      workflowPlanSnapshot: state.runMetadata?.workflowPlanSnapshot,
    }, (name) => {
      try {
        return readWorkflowForApi(anchor, name)
      } catch (error) {
        if (error instanceof WorkflowNotFoundError) return null
        throw error
      }
    }, resolveSnapshotTrack(rootPath, trackId, workflowName))
    const { gitHeadSha, workspaceFingerprint } = deps
    const capabilityDeps: WorkflowSnapshotCapabilityDeps = {
      ...(deps.fileExists === undefined ? {} : { fileExists: deps.fileExists }),
      ...(gitHeadSha === undefined ? {} : { gitHeadSha: () => gitHeadSha(rootPath) }),
      ...(workspaceFingerprint === undefined
        ? {}
        : { workspaceFingerprint: () => workspaceFingerprint(rootPath, changeName) }),
      ...(deps.assessBuildRevision === undefined ? {} : { assessBuildRevision: deps.assessBuildRevision }),
    }
    const [documents, terminalActivity, tasksProjection, workflowExecution, authority] = await Promise.all([
      documentEvidence(rootPath, changeDir, plan, phase),
      readTerminalActivity(changeDir, changeName, nowMs),
      readAnchoredTasksProjection(
        anchored.changeAnchor,
        undefined,
        (source, anchoredChangeDir) => hasCurrentCanonicalTaskPlanProjection(
          anchoredChangeDir,
          source,
        ),
        anchor,
      ),
      snapshotWorkflowExecution(plan, state, rootPath, changeDir, changeName, capabilityDeps),
      readWorkflowSnapshotAuthority(changeDir, state, plan),
    ])
    assertWorkflowRootAnchor(anchor)
    assertChangePathAnchor(anchored.changeAnchor)
    const todo = projectPipelineTodo({
      phase,
      tasksMarkdown: tasksProjection?.source,
      trustedCanonicalProjection: tasksProjection?.trustedCanonicalProjection,
      stages: snapshotTodoStages(plan, phase),
      additionalItemsByStage: documentTodoItems(plan, documents),
    })
    return {
      name: changeName,
      path: changeDir,
      phase,
      phase_status: stringField(fields.phase_status),
      track: stringField(fields.track),
      preset: stringField(fields.preset),
      archived: stringField(fields.archived),
      updated_at: stringField(fields.updated_at),
      fields,
      workflowPlanFingerprint: plan.workflowFingerprint,
      workflowDefinition,
      workflowRules: snapshotWorkflowRules(plan, configuredPolicy, authority),
      workflowExecution,
      reviewHandshake: projectReviewHandshake(state, plan, phase),
      todo,
      documents,
      ...(terminalActivity === undefined ? {} : { terminalActivity }),
    }
  } finally {
    if (ownedAnchor !== undefined) closeWorkflowRootAnchor(ownedAnchor)
  }
}
