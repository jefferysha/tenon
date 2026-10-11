import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import {
  compileEffectiveWorkflowPlan,
  compileWorkflow,
  effectiveWorkflowPlanFromSnapshot,
  loadWorkflow,
  resolveStep,
  resolveWorkflowName,
  selectTrackBranch,
  type FieldName,
  type EffectiveWorkflowPlan,
  type PipelineState,
  type StateStore,
  type StepIR,
  type WorkflowPlanSnapshot,
} from '@tenon/kernel'
import type {
  CapturedExecutionCoordinate,
  ExecutionContext,
  ExecutionCoordinatePort,
} from '@tenon/automation'
import { join } from 'node:path'
import { changeDir } from './paths.js'

function scalarField(state: PipelineState, field: FieldName): string {
  const value = state.fields[field]
  return Array.isArray(value) ? value.join(',') : (value ?? '')
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

/** Missing custom workflow files mean no declared skills; malformed definitions still fail loudly. */
function emptyDeclaredStep(stepId: string): StepIR {
  return {
    id: stepId,
    label: '',
    gate: null,
    skills: [],
    inputs: [],
    outputs: [],
    guards: [],
    artifacts: [],
    transitions: [],
  }
}

interface CoordinateSnapshot {
  readonly resolution: CapturedExecutionCoordinate['resolution']
  readonly workflow: string
  readonly track: string
  readonly workflowRunId?: string
  readonly digestInput: string
}

async function readOptionalFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

async function defaultCapabilitySnapshot(
  repoRoot: string,
  trackId: string,
  manifestRoot: string,
  frozenWorkflowSnapshot?: WorkflowPlanSnapshot,
): Promise<{
  capability: EffectiveWorkflowPlan['capabilities']['skills']
  manifestInput: string | null
}> {
  const manifestInput = await readOptionalFile(join(manifestRoot, 'templates', 'manifest.yaml'))
  // A persisted WorkflowRun snapshot is authoritative for AFK coordinates. Only legacy states
  // without a snapshot fall back to the current default declaration; never rebuild a frozen phase
  // capability from a later default template when a snapshot is present. 分支按任务记着的轨道选，不查登记表。
  const plan = frozenWorkflowSnapshot === undefined
    ? compileEffectiveWorkflowPlan('default', loadWorkflow(repoRoot, 'default') ?? undefined, { track: trackId })
    : effectiveWorkflowPlanFromSnapshot(frozenWorkflowSnapshot, trackId)
  return { capability: plan.capabilities.skills, manifestInput }
}

/** Shared coordinate read keeps capture and TOCTOU recheck on one canonical digest contract. */
async function readCoordinateSnapshot(
  store: StateStore,
  repoRoot: string,
  dir: string,
  manifestRoot: string,
): Promise<CoordinateSnapshot> {
  const state = await store.read(dir)
  const workflowName = resolveWorkflowName(state)
  const stepId = scalarField(state, 'phase')
  const track = scalarField(state, 'track')
  const automation = scalarField(state, 'automation')
  const runId = state.runMetadata?.runId ?? ''
  if (workflowName === 'default') {
    const { capability, manifestInput } = await defaultCapabilitySnapshot(
      repoRoot,
      track,
      manifestRoot,
      state.runMetadata?.workflowPlanSnapshot,
    )
    return {
      resolution: { kind: 'default', stepId, capability },
      workflow: workflowName,
      track,
      workflowRunId: runId || undefined,
      digestInput: JSON.stringify({
        workflowName, stepId, track, automation, runId,
        capability, manifestInput,
      }),
    }
  }
  const definition = loadWorkflow(repoRoot, workflowName)
  if (definition === null) {
    return {
      resolution: { kind: 'custom', step: emptyDeclaredStep(stepId) },
      workflow: workflowName,
      track,
      workflowRunId: runId || undefined,
      digestInput: JSON.stringify({ workflowName, stepId, track, automation, runId, def: null }),
    }
  }
  // 步骤在任务所属轨道的分支里（有 tracks: 的工作流顶层没有 steps）；平铺工作流就是它自己的 steps。
  const step = resolveStep(compileWorkflow(selectTrackBranch(definition, track)), stepId)
  if (step === null) {
    throw new Error(
      `custom workflow '${workflowName}' 未声明 step '${stepId}'（workflow 文件存在但 step 不在图里，数据完整性问题）`,
    )
  }
  return {
    resolution: { kind: 'custom', step },
    workflow: workflowName,
    track,
    workflowRunId: runId || undefined,
    digestInput: JSON.stringify({ workflowName, stepId, track, automation, runId, def: definition }),
  }
}

export interface ExecutionCoordinatePortDeps {
  readonly store: StateStore
  readonly repoRoot: string
  /** Optional plugin root containing the canonical manifest used by the resolver. */
  readonly manifestRoot?: string
}

/**
 * Captures the immutable workflow coordinate under the Change lock, then exposes
 * a separate digest read for the admission TOCTOU check.
 */
export function createExecutionCoordinatePort(
  deps: ExecutionCoordinatePortDeps,
): ExecutionCoordinatePort {
  const { store, repoRoot } = deps
  const manifestRoot = deps.manifestRoot ?? repoRoot
  return {
    async capture(ctx: ExecutionContext): Promise<CapturedExecutionCoordinate> {
      const dir = changeDir(repoRoot, ctx.change)
      return store.withLock(dir, async () => {
        const snapshot = await readCoordinateSnapshot(store, repoRoot, dir, manifestRoot)
        return {
          resolution: snapshot.resolution,
          workflow: snapshot.workflow,
          track: snapshot.track,
          workflowRunId: snapshot.workflowRunId,
          inputsDigest: sha256Hex(snapshot.digestInput),
        }
      })
    },
    async readCurrentInputsDigest(ctx: ExecutionContext): Promise<string> {
      const dir = changeDir(repoRoot, ctx.change)
      const snapshot = await readCoordinateSnapshot(store, repoRoot, dir, manifestRoot)
      return sha256Hex(snapshot.digestInput)
    },
  }
}
