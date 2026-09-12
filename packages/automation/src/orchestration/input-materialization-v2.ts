import { mkdir, readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'
import type { BoardSnapshotV2, SkillResultV2, SkillInputManifestV2, WorkItemV2 } from '@tenon/kernel'
import { digest } from './runtime-v2-boundary.js'
import { snapshotJsonBoundary, type JsonBoundaryValue } from './jsonBoundary.js'

const MAX_INPUT_BYTES = 1024 * 1024
const SAFE_REF = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,511}$/u

export interface RuntimeInputBundleItemV2 {
  readonly ref: string
  readonly digest: `sha256:${string}`
  readonly kind: 'result' | SkillResultV2['artifacts'][number]['kind']
  readonly byte_length: number
  readonly content: JsonBoundaryValue
  readonly source_result_id?: string
}

/** Content delivered to a Skill. It is intentionally not persisted in the ledger. */
export interface RuntimeInputBundleV2 {
  readonly schema_version: 'skill-input-bundle/v2'
  readonly bundle_id: string
  readonly run_id: string
  readonly work_item_id: string
  readonly items: readonly RuntimeInputBundleItemV2[]
  readonly bundle_digest: `sha256:${string}`
  readonly byte_length: number
}

export interface RuntimeArtifactResolverV2 {
  resolve(input: { readonly ref: string; readonly expected_digest: `sha256:${string}`; readonly signal: AbortSignal }): Promise<unknown>
}

export type InputMaterializationErrorCode =
  | 'missing-resolver'
  | 'artifact-unavailable'
  | 'artifact-digest-mismatch'
  | 'artifact-invalid'
  | 'bundle-too-large'

export class InputMaterializationErrorV2 extends Error {
  override readonly name = 'InputMaterializationErrorV2'

  constructor(readonly code: InputMaterializationErrorCode, message: string) { super(message) }
}

interface InputRefV2 {
  readonly ref: string
  readonly expected_digest: `sha256:${string}`
  readonly kind: RuntimeInputBundleItemV2['kind']
  readonly source_result_id?: string
  readonly content?: JsonBoundaryValue
}

function safeRef(value: string): boolean { return SAFE_REF.test(value) && !value.includes('..') }
function byteLength(value: string): number { return new TextEncoder().encode(value).byteLength }
function rawDigest(value: unknown): `sha256:${string}` | undefined {
  return typeof value === 'string' ? `sha256:${createHash('sha256').update(new TextEncoder().encode(value)).digest('hex')}` : undefined
}
function digestMatches(value: unknown, expected: `sha256:${string}`, normalized: `sha256:${string}`): boolean {
  return normalized === expected || rawDigest(value) === expected
}

function resultProjection(result: SkillResultV2): JsonBoundaryValue {
  return {
    result_id: result.result_id,
    run_id: result.run_id,
    status: result.status,
    contract_status: result.contract_status,
    ...(result.output_schema_id === undefined ? {} : { output_schema_id: result.output_schema_id }),
    ...(result.output_digest === undefined ? {} : { output_digest: result.output_digest }),
    ...(result.output_bytes === undefined ? {} : { output_bytes: result.output_bytes }),
    ...(result.summary === undefined ? {} : { summary: result.summary }),
    artifacts: result.artifacts.map((artifact) => ({
      id: artifact.id, kind: artifact.kind, ref: artifact.ref, digest: artifact.digest,
      ...(artifact.media_type === undefined ? {} : { media_type: artifact.media_type }),
      ...(artifact.byte_length === undefined ? {} : { byte_length: artifact.byte_length }),
    })),
    validation_refs: [...result.validation_refs],
    diagnostics: [...result.diagnostics],
  }
}

function pipelineDependencyItemIds(snapshot: BoardSnapshotV2, item: WorkItemV2): readonly string[] {
  const ids = new Set(item.depends_on)
  const pipeline = snapshot.pipeline
  const binding = snapshot.resolution?.bindings.find((candidate) => candidate.work_item_id === item.work_item_id)
  const stage = pipeline?.stages.find((candidate) => candidate.work_item_ids.includes(item.work_item_id))
  const skill = stage?.skills.find((candidate) => candidate.skill_id === binding?.skill_id && candidate.skill_version === binding?.skill_version)
  if (pipeline && stage) {
    for (const dependencyStageId of stage.depends_on) {
      const dependencyStage = pipeline.stages.find((candidate) => candidate.stage_id === dependencyStageId)
      for (const workItemId of dependencyStage?.work_item_ids ?? []) ids.add(workItemId)
    }
  }
  for (const dependency of skill?.depends_on ?? []) {
    const dependencySkill = pipeline?.stages.flatMap((candidate) => candidate.skills).find((candidate) => candidate.binding_id === dependency || candidate.skill_id === dependency || `skill:${candidate.skill_id}` === dependency)
    const dependencyStage = pipeline?.stages.find((candidate) => candidate.skills.some((candidateSkill) => candidateSkill.binding_id === dependencySkill?.binding_id))
    const dependencyItem = dependencyStage?.work_item_ids.find((workItemId) => {
      const candidateBinding = snapshot.resolution?.bindings.find((candidate) => candidate.work_item_id === workItemId)
      return candidateBinding?.skill_id === dependencySkill?.skill_id && candidateBinding?.skill_version === dependencySkill?.skill_version
    })
    if (dependencyItem !== undefined) ids.add(dependencyItem)
  }
  for (const ref of stage?.input_refs ?? []) if (ref.startsWith('result:')) ids.add(ref.slice('result:'.length))
  return Object.freeze([...ids])
}

function dependencyResults(snapshot: BoardSnapshotV2, item: WorkItemV2): readonly SkillResultV2[] {
  return pipelineDependencyItemIds(snapshot, item).flatMap((dependency) => {
    const dependencyItem = snapshot.work_items.find((candidate) => candidate.work_item_id === dependency)
    const run = dependencyItem?.active_run_id === undefined
      ? snapshot.runs.filter((candidate) => candidate.work_item_id === dependency && candidate.status === 'completed').at(-1)
      : snapshot.runs.find((candidate) => candidate.run_id === dependencyItem.active_run_id)
    return run?.result_id === undefined ? [] : snapshot.results.filter((result) => result.result_id === run.result_id)
  })
}

function inputRefs(snapshot: BoardSnapshotV2, item: WorkItemV2): readonly InputRefV2[] {
  const refs: InputRefV2[] = []
  for (const result of dependencyResults(snapshot, item)) {
    const projection = resultProjection(result)
    refs.push({ ref: `skill-result:${result.result_id}`, expected_digest: digest(projection), kind: 'result', source_result_id: result.result_id, content: projection })
    if (result.raw_output !== undefined) refs.push({ ref: result.raw_output.ref, expected_digest: result.raw_output.digest, kind: 'json', source_result_id: result.result_id })
    for (const artifact of result.artifacts) refs.push({ ref: artifact.ref, expected_digest: artifact.digest, kind: artifact.kind, source_result_id: result.result_id })
  }
  return Object.freeze(refs.filter((entry, index, all) => all.findIndex((candidate) => candidate.ref === entry.ref) === index))
}

export function emptyInputBundleV2(runId: string, workItemId: string): RuntimeInputBundleV2 {
  return Object.freeze({ schema_version: 'skill-input-bundle/v2', bundle_id: `bundle:${runId}`, run_id: runId, work_item_id: workItemId, items: [], bundle_digest: digest([]), byte_length: 0 })
}

export function rejectedInputManifest(runId: string, workItemId: string, refs: readonly string[], reason: string, now: string): SkillInputManifestV2 {
  return Object.freeze({ schema_version: 'skill-input-manifest/v2', manifest_id: `input:${runId}`, run_id: runId, work_item_id: workItemId, input_refs: Object.freeze([...refs]), artifact_digests: [], bundle_digest: digest(refs), byte_length: 0, delivery: 'rejected', rejection_reason: reason.slice(0, 160), created_at: now })
}

export function createFilesystemArtifactResolverV2(changeDir: string): RuntimeArtifactResolverV2 {
  const root = path.resolve(changeDir)
  return {
    async resolve({ ref, signal }) {
      if (signal.aborted) throw new InputMaterializationErrorV2('artifact-unavailable', 'input resolution was aborted')
      let target: string
      const artifactMatch = /^artifact:\/\/([A-Za-z0-9][A-Za-z0-9._:-]{0,159})\/output\.json$/u.exec(ref)
      if (artifactMatch?.[1] !== undefined) target = path.join(root, '.tenon-artifacts', artifactMatch[1], 'output.json')
      else if (ref.startsWith('artifact://') || ref.startsWith('http://') || ref.startsWith('https://') || ref.startsWith('mcp://')) throw new InputMaterializationErrorV2('missing-resolver', `no resolver is registered for ${ref}`)
      else {
        if (!safeRef(ref)) throw new InputMaterializationErrorV2('artifact-invalid', `unsafe input reference ${ref}`)
        target = path.resolve(root, ref)
        if (target !== root && !target.startsWith(`${root}${path.sep}`)) throw new InputMaterializationErrorV2('artifact-invalid', `input reference escapes change directory: ${ref}`)
      }
      try {
        const value = await readFile(target, 'utf8')
        if (byteLength(value) > MAX_INPUT_BYTES) throw new InputMaterializationErrorV2('bundle-too-large', `input ${ref} exceeds ${MAX_INPUT_BYTES} bytes`)
        try { return JSON.parse(value) as unknown } catch { return value }
      } catch (error) {
        if (error instanceof InputMaterializationErrorV2) throw error
        throw new InputMaterializationErrorV2('artifact-unavailable', `input ${ref} is unavailable`)
      }
    },
  }
}

export async function materializeRunInputsV2(input: {
  readonly snapshot: BoardSnapshotV2
  readonly item: WorkItemV2
  readonly run_id: string
  readonly signal: AbortSignal
  readonly resolver?: RuntimeArtifactResolverV2
  readonly max_bytes?: number
  readonly now: string
}): Promise<{ readonly bundle: RuntimeInputBundleV2; readonly manifest: SkillInputManifestV2 }> {
  const refs = inputRefs(input.snapshot, input.item)
  if (refs.length === 0) {
    const bundle = emptyInputBundleV2(input.run_id, input.item.work_item_id)
    return { bundle, manifest: Object.freeze({ schema_version: 'skill-input-manifest/v2', manifest_id: `input:${input.run_id}`, run_id: input.run_id, work_item_id: input.item.work_item_id, input_refs: [], artifact_digests: [], bundle_digest: bundle.bundle_digest, byte_length: 0, delivery: 'not-required', created_at: input.now }) }
  }
  const resolver = input.resolver
  const maxBytes = input.max_bytes ?? MAX_INPUT_BYTES
  if (!resolver) throw new InputMaterializationErrorV2('missing-resolver', 'input references require an artifact resolver')
  const items: RuntimeInputBundleItemV2[] = []
  let total = 0
  for (const entry of refs) {
      if (entry.content !== undefined) {
      const snap = snapshotJsonBoundary(entry.content, { maxBytes, maxDepth: 40, maxNodes: 8_192 })
      const actual = digest(snap.value)
      if (!digestMatches(snap.value, entry.expected_digest, actual)) throw new InputMaterializationErrorV2('artifact-digest-mismatch', `input digest mismatch for ${entry.ref}`)
        total += snap.bytes
        if (total > maxBytes) throw new InputMaterializationErrorV2('bundle-too-large', `input bundle exceeds ${maxBytes} bytes`)
      items.push({ ref: entry.ref, digest: entry.expected_digest, kind: entry.kind, byte_length: snap.bytes, content: snap.value, ...(entry.source_result_id === undefined ? {} : { source_result_id: entry.source_result_id }) })
      continue
    }
    let raw: unknown
    try { raw = await resolver.resolve({ ref: entry.ref, expected_digest: entry.expected_digest, signal: input.signal }) } catch (error) {
      if (error instanceof InputMaterializationErrorV2) throw error
      throw new InputMaterializationErrorV2('artifact-unavailable', `input ${entry.ref} could not be resolved`)
    }
    const snap = snapshotJsonBoundary(raw, { maxBytes, maxDepth: 40, maxNodes: 8_192 })
    const actual = digest(snap.value)
    if (!digestMatches(snap.value, entry.expected_digest, actual)) throw new InputMaterializationErrorV2('artifact-digest-mismatch', `input digest mismatch for ${entry.ref}`)
    total += snap.bytes
    if (total > maxBytes) throw new InputMaterializationErrorV2('bundle-too-large', `input bundle exceeds ${maxBytes} bytes`)
    items.push({ ref: entry.ref, digest: entry.expected_digest, kind: entry.kind, byte_length: snap.bytes, content: snap.value, ...(entry.source_result_id === undefined ? {} : { source_result_id: entry.source_result_id }) })
  }
  const bundleDigest = digest(items.map((entry) => ({ ref: entry.ref, digest: entry.digest, kind: entry.kind, byte_length: entry.byte_length, content_digest: digest(entry.content) })))
  const bundle = Object.freeze({ schema_version: 'skill-input-bundle/v2' as const, bundle_id: `bundle:${input.run_id}`, run_id: input.run_id, work_item_id: input.item.work_item_id, items: Object.freeze(items), bundle_digest: bundleDigest, byte_length: total })
  const manifest = Object.freeze({ schema_version: 'skill-input-manifest/v2' as const, manifest_id: `input:${input.run_id}`, run_id: input.run_id, work_item_id: input.item.work_item_id, input_refs: Object.freeze(refs.map((entry) => entry.ref)), artifact_digests: Object.freeze(refs.map((entry) => entry.expected_digest)), bundle_digest: bundle.bundle_digest, byte_length: bundle.byte_length, delivery: 'injected' as const, created_at: input.now })
  return { bundle, manifest }
}
