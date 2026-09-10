import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import {
  compileEffectiveWorkflowPlan,
  compileWorkflow,
  effectiveWorkflowPlanFromSnapshot,
  loadTrackRegistry,
  loadManifest,
  loadWorkflow,
  resolveStep,
  resolveWorkflowName,
  type FieldName,
  type EffectiveWorkflowPlan,
  type PipelineState,
  type StateStore,
  type StepIR,
  type TrackValidationContext,
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

function defaultTrackValidationContext(repoRoot: string, manifestRoot?: string): TrackValidationContext {
  const skillProfiles = new Set(['pm', 'frontend', 'backend', 'free'])
  if (manifestRoot !== undefined) {
    const manifestPath = join(manifestRoot, 'templates', 'manifest.yaml')
    try {
      const manifest = loadManifest(manifestPath)
      for (const table of [manifest.mandatorySkills, manifest.recommendedSkills]) {
        for (const row of Object.values(table)) {
          for (const profile of Object.keys(row)) {
            if (profile !== '_all') skillProfiles.add(profile)
          }
        }
      }
    } catch (error) {
      // Missing plugin manifests are valid in lightweight/test harnesses. Existing files are
      // authoritative, however: a malformed manifest must fail closed instead of allowing a
      // track registry to be captured against a different skill vocabulary.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  return {
    // validateTrackRegistry treats the packaged default workflow as an intrinsic kernel value;
    // this adapter only resolves project-defined workflow files for the remaining identifiers.
    workflowExists: (id) => {
      try { return loadWorkflow(repoRoot, id) !== null } catch { return false }
    },
    // Built-in profile keys cover the no-manifest test harness and normal bundled registry.
    skillProfiles,
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
  registryRevision: string
}> {
  const manifestInput = await readOptionalFile(join(manifestRoot, 'templates', 'manifest.yaml'))
  const registry = loadTrackRegistry(repoRoot, defaultTrackValidationContext(repoRoot, manifestRoot))
  const track = trackId === '' ? undefined : registry.byId.get(trackId)
  if (trackId !== '' && track === undefined) {
    throw new Error(`未注册的 track '${trackId}'（default execution coordinate 无法冻结 capability）`)
  }
  // A persisted WorkflowRun snapshot is authoritative for AFK coordinates. Only legacy states
  // without a snapshot fall back to the current default declaration; never rebuild a frozen phase
  // capability from a later default template when a snapshot is present.
  const plan = frozenWorkflowSnapshot === undefined
    ? compileEffectiveWorkflowPlan('default', loadWorkflow(repoRoot, 'default') ?? undefined, track)
    : effectiveWorkflowPlanFromSnapshot(frozenWorkflowSnapshot, track)
  return { capability: plan.capabilities.skills, manifestInput, registryRevision: registry.revision }
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
    const { capability, manifestInput, registryRevision } = await defaultCapabilitySnapshot(
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
        capability, manifestInput, registryRevision,
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
  const step = resolveStep(compileWorkflow(definition), stepId)
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
