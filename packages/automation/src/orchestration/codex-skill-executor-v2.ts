import { redact } from './runtime-v2-boundary.js'
import type { RuntimeExecutorInputV2, RuntimeExecutorV2 } from './runtime-v2.js'
import type { ExecFn } from '../runner/exec.js'
import { nodeExec } from '../runner/exec.js'
import path from 'node:path'

export interface CodexSkillExecutorV2Options {
  readonly change_dir: string
  readonly codex_executable?: string
  readonly exec?: ExecFn
  readonly max_output_chars?: number
  readonly sandbox?: 'workspace-write' | 'read-only' | 'danger-full-access'
  readonly prompt?: (input: RuntimeExecutorInputV2) => string
}

const DEFAULT_MAX_OUTPUT_CHARS = 256 * 1024
const SAFE_LOCAL_REF = /^[A-Za-z0-9][A-Za-z0-9._/@:-]{0,511}$/u
const MAX_MANAGED_TOOL_OBSERVATIONS = 128
const MAX_EVENT_TYPES = 32
const MAX_EVENT_SAMPLES = 8
const MAX_EVENT_SAMPLE_CHARS = 180

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function unwrap(text: string): string {
  const tagged = /<output>\s*([\s\S]*?)\s*<\/output>/u.exec(text)?.[1] ?? text
  const fenced = tagged.trim().match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/u)
  return (fenced?.[1] ?? tagged).trim()
}

/** Extract the latest assistant envelope from Codex JSONL without trusting usage events as output. */
export function parseCodexSkillOutput(jsonl: string): { readonly value: unknown; readonly diagnostics: readonly string[] } {
  const candidates: string[] = []
  const diagnostics: string[] = []
  for (const [index, line] of jsonl.split(/\r?\n/u).entries()) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    let event: unknown
    try { event = JSON.parse(trimmed) } catch { diagnostics.push(`codex-jsonl-invalid:${index + 1}`); continue }
    const record = asRecord(event)
    if (record === undefined) continue
    const item = asRecord(record.item)
    const values = [record.output, record.text, record.message, item?.output, item?.text, item?.message, item?.content]
    for (const value of values) {
      if (typeof value === 'string' && value.trim().length > 0) candidates.push(value)
      else if (Array.isArray(value)) {
        for (const part of value) {
          const partRecord = asRecord(part)
          if (typeof partRecord?.text === 'string') candidates.push(partRecord.text)
        }
      }
    }
  }
  const last = candidates.at(-1)
  if (last === undefined) return { value: { output: null }, diagnostics: [...diagnostics, 'codex-output-missing'] }
  try { return { value: JSON.parse(unwrap(last)), diagnostics } } catch { return { value: last, diagnostics: [...diagnostics, 'codex-output-not-json'] } }
}

function toolCompletionKind(event: unknown): string | undefined {
  const record = asRecord(event)
  if (record === undefined) return undefined
  const type = typeof record.type === 'string' ? record.type : ''
  if (type === 'tool.completed' || type === 'command.completed' || type === 'shell.completed' || type === 'write.completed') return type
  if (type !== 'item.completed') return undefined
  const item = asRecord(record.item)
  const itemType = typeof item?.type === 'string' ? item.type : ''
  // Codex has used these exact item names. Do not use a substring match here:
  // `tool_result`, `command_preview`, and future item types are not proof that a
  // managed tool completed and must fall back to the stage-end reconcile.
  return new Set(['command_execution', 'command', 'shell_command', 'shell', 'file_change', 'write', 'file_write', 'tool_call', 'tool_use', 'mcp_tool_call']).has(itemType)
    ? itemType
    : undefined
}

function stringsAtKnownKeys(value: unknown, output: string[], depth = 0): void {
  if (depth > 4 || value === null || value === undefined) return
  if (Array.isArray(value)) {
    for (const child of value) stringsAtKnownKeys(child, output, depth + 1)
    return
  }
  const record = asRecord(value)
  if (record === undefined) return
  const keys = ['path', 'file_path', 'relative_path', 'output_path', 'target_path', 'source_path']
  for (const key of keys) if (typeof record[key] === 'string') output.push(record[key] as string)
  for (const key of ['item', 'changes', 'files', 'paths', 'result', 'output', 'arguments', 'input', 'parameters', 'tool', 'data']) {
    if (record[key] === undefined) continue
    if ((key === 'files' || key === 'paths') && Array.isArray(record[key])) {
      for (const child of record[key] as unknown[]) if (typeof child === 'string') output.push(child)
    } else stringsAtKnownKeys(record[key], output, depth + 1)
  }
}

function normalizeScopedPath(candidate: string, changeDir: string): string | undefined {
  const normalizedCandidate = candidate.trim().replaceAll('\\', path.sep)
  if (normalizedCandidate.length === 0 || normalizedCandidate.includes('\u0000') || normalizedCandidate.includes('://') || /^[A-Za-z]:\//u.test(normalizedCandidate)) return undefined
  const root = path.resolve(changeDir)
  const absolute = path.resolve(root, normalizedCandidate)
  const relative = path.relative(root, absolute)
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return undefined
  const segments = relative.split(path.sep)
  if (segments.some((segment) => segment === '.git' || segment === '.pipeline-artifacts' || segment === '.tenon-artifacts' || segment === '.orchestration-v2')) return undefined
  return relative
}

interface CodexToolCompletion {
  readonly kind: string
  readonly paths: readonly string[]
  readonly rejectedPathCount: number
  readonly toolCallId?: string
}

/** Decode only known Codex completion envelopes. Exported for fixture-based tests. */
export function decodeCodexToolCompletion(event: unknown, changeDir: string): CodexToolCompletion | undefined {
  const kind = toolCompletionKind(event)
  if (kind === undefined) return undefined
  const record = asRecord(event)
  const item = asRecord(record?.item)
  const candidates: string[] = []
  stringsAtKnownKeys(record, candidates)
  const paths: string[] = []
  let rejectedPathCount = 0
  for (const candidate of candidates) {
    const normalized = normalizeScopedPath(candidate, changeDir)
    if (normalized === undefined) rejectedPathCount += 1
    else if (!paths.includes(normalized)) paths.push(normalized)
  }
  const toolCallId = [record?.tool_call_id, record?.call_id, record?.id, item?.tool_call_id, item?.call_id, item?.id]
    .find((value): value is string => typeof value === 'string' && value.length > 0)
  return { kind, paths, rejectedPathCount, ...(toolCallId === undefined ? {} : { toolCallId }) }
}

function promptFor(input: RuntimeExecutorInputV2): string {
  const catalog = input.artifact_catalog === undefined ? { entries: [] } : {
    revision: input.artifact_catalog.revision,
    digest: input.artifact_catalog.digest,
    entries: input.artifact_catalog.entries.map((entry) => ({ artifactId: entry.artifactId, version: entry.version, source: entry.source, contentUri: entry.contentUri, contentDigest: entry.contentDigest, size: entry.size, mediaType: entry.mediaType, disposition: entry.disposition, quality: entry.quality, availableFromStage: entry.availableFromStage, consumed: entry.consumed, affected: entry.affected })),
  }
  return [
    `Execute skill ${input.skill_id}@${input.skill_version}.`,
    'You may use the provided workspace and input references. Do not invent artifact success: files are accepted only when they exist and are observed by the host.',
    'At the end emit one JSON object inside <output>...</output>. Its optional keys are output, artifacts (array of {ref,kind}), consumed (array of a path string or {ref,version,representation,max_bytes}), summary, diagnostics.',
    `Context JSON: ${JSON.stringify({ run_id: input.run_id, work_item_id: input.work_item_id, input_refs: input.input_refs, input_bundle: input.input_bundle, artifact_catalog: catalog })}`,
  ].join('\n')
}

/** Production Codex subprocess adapter. The host owns observation, output bounds and receipts. */
export function createCodexSkillExecutorV2(options: CodexSkillExecutorV2Options): RuntimeExecutorV2 {
  const exec = options.exec ?? nodeExec
  const maxOutputChars = options.max_output_chars ?? DEFAULT_MAX_OUTPUT_CHARS
  const sandbox = options.sandbox ?? 'workspace-write'
  return {
    async execute(input) {
      const prompt = options.prompt?.(input) ?? promptFor(input)
      const reconciles: Promise<unknown>[] = []
      const managedObservations: Promise<unknown>[] = []
      const eventTypeCounts = new Map<string, number>()
      const eventSamples: string[] = []
      const pathDiagnostics: string[] = []
      let managedToolCompletionCount = 0
      let managedPathCount = 0
      let managedObservationLimitHit = false
      const result = await exec(options.codex_executable ?? 'codex', ['exec', '--json', '-C', options.change_dir, '--sandbox', sandbox, '--ephemeral', '--skip-git-repo-check', prompt], {
        cwd: options.change_dir,
        maxTailChars: maxOutputChars,
        onLine: (line) => {
          try {
            const event = JSON.parse(line) as unknown
            const completion = decodeCodexToolCompletion(event, options.change_dir)
            const type = completion?.kind ?? (typeof asRecord(event)?.type === 'string' ? asRecord(event)?.type as string : undefined)
            if (type !== undefined) {
              if (eventTypeCounts.size < MAX_EVENT_TYPES || eventTypeCounts.has(type)) eventTypeCounts.set(type, (eventTypeCounts.get(type) ?? 0) + 1)
              if (eventSamples.length < MAX_EVENT_SAMPLES && completion !== undefined) {
                eventSamples.push(`${completion.kind}:${completion.paths.join(',') || 'path-unresolved'}`.slice(0, MAX_EVENT_SAMPLE_CHARS))
              }
            }
            if (completion !== undefined) {
              managedToolCompletionCount += 1
              managedPathCount += completion.paths.length
              if (completion.paths.length === 0 && pathDiagnostics.length < MAX_EVENT_SAMPLES) pathDiagnostics.push(`codex-managed-path-unresolved:${completion.kind}`)
              if (completion.rejectedPathCount > 0 && pathDiagnostics.length < MAX_EVENT_SAMPLES) pathDiagnostics.push(`codex-managed-path-rejected:${completion.kind}:${completion.rejectedPathCount}`)
              if (completion.rejectedPathCount > 0 && eventSamples.length < MAX_EVENT_SAMPLES) eventSamples.push(`${completion.kind}:path-rejected=${completion.rejectedPathCount}`.slice(0, MAX_EVENT_SAMPLE_CHARS))
              if (input.artifact_runtime !== undefined) {
                for (const relativePath of completion.paths) {
                  if (managedObservations.length >= MAX_MANAGED_TOOL_OBSERVATIONS) {
                    managedObservationLimitHit = true
                    break
                  }
                  managedObservations.push(input.artifact_runtime.observePath(relativePath, { source: 'managed-tool', ...(completion.toolCallId === undefined ? {} : { toolCallId: completion.toolCallId }) }))
                }
                // A recognized tool completion without a safe path is not a managed
                // observation. Reconcile is deliberately tagged by StageRuntime as
                // `reconcile`, preserving the durable fallback without over-claiming.
                if (completion.paths.length === 0) reconciles.push(input.artifact_runtime.reconcile())
              }
            }
          } catch { /* parser reports malformed JSON after the child exits */ }
        },
      })
      const parsed = parseCodexSkillOutput(result.stdout)
      const [reconciliationResults, observationResults] = await Promise.all([
        Promise.allSettled(reconciles), Promise.allSettled(managedObservations),
      ])
      const reconcileDiagnostics = reconciliationResults.flatMap((entry) => entry.status === 'rejected' ? [`artifact-reconcile-failed:${redact(entry.reason instanceof Error ? entry.reason.message : 'unknown', 180)}`] : [])
      const observationDiagnostics = observationResults.flatMap((entry) => entry.status === 'rejected' ? [`artifact-managed-observe-failed:${redact(entry.reason instanceof Error ? entry.reason.message : 'unknown', 180)}`] : [])
      if (result.exitCode !== 0) throw new Error(`codex skill execution failed (${result.exitCode}): ${redact(result.stderr, 512)}`)
      const candidate = asRecord(parsed.value)
      const streamDiagnostics = [
        ...parsed.diagnostics,
        ...reconcileDiagnostics,
        ...observationDiagnostics,
        ...pathDiagnostics,
        ...(managedToolCompletionCount > 0 ? [`codex-managed-tool-completions:${managedToolCompletionCount}`] : []),
        ...(managedPathCount > 0 ? [`codex-managed-tool-paths:${managedPathCount}`] : []),
        ...(managedObservations.length > 0 ? [`codex-managed-observations:${observationResults.filter((entry) => entry.status === 'fulfilled').length}`] : []),
        ...(managedObservationLimitHit ? ['codex-managed-observations-truncated'] : []),
        ...(eventTypeCounts.size > 0 ? [`codex-event-types:${[...eventTypeCounts.entries()].map(([type, count]) => `${type}=${count}`).join(',').slice(0, 512)}`] : []),
        ...(eventSamples.length > 0 ? [`codex-event-samples:${eventSamples.slice(0, MAX_EVENT_SAMPLES).join('|').slice(0, 1024)}`] : []),
        ...(result.stderr.length > 0 ? [`codex-stderr:${redact(result.stderr, 256)}`] : []),
      ]
      const diagnostics = streamDiagnostics
      let observedArtifacts: unknown[] | undefined
      if (candidate !== undefined && Array.isArray(candidate.artifacts) && input.artifact_runtime !== undefined) {
        observedArtifacts = []
        for (const artifact of candidate.artifacts) {
          const ref = asRecord(artifact)?.ref
          if (typeof ref !== 'string' || !SAFE_LOCAL_REF.test(ref) || ref.includes('..') || ref.includes('://')) continue
          try {
            const published = await input.artifact_runtime.publish(ref, 'deliverable')
            observedArtifacts.push({ id: published.artifactId, kind: published.kind, ref, digest: `sha256:${published.contentDigest}`, media_type: published.mediaType, byte_length: published.size })
          } catch (error) { diagnostics.push(`artifact-publish-failed:${redact(error instanceof Error ? error.message : 'unknown', 180)}`) }
        }
      }
      if (candidate === undefined) return { output: parsed.value, artifacts: [], diagnostics }
      return { ...candidate, ...(observedArtifacts === undefined ? {} : { artifacts: observedArtifacts }), diagnostics: [...(Array.isArray(candidate.diagnostics) ? candidate.diagnostics.filter((entry): entry is string => typeof entry === 'string').slice(0, 32) : []), ...diagnostics].slice(0, 64) }
    },
  }
}

/** Stable production wiring name used by host assemblers. */
export const createCodexRuntimeExecutor = createCodexSkillExecutorV2
export type CodexRuntimeExecutorOptions = CodexSkillExecutorV2Options
