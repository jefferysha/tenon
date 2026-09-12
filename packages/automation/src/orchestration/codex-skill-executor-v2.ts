import { redact } from './runtime-v2-boundary.js'
import type { RuntimeExecutorInputV2, RuntimeExecutorV2 } from './runtime-v2.js'
import type { ExecFn } from '../runner/exec.js'
import { nodeExec } from '../runner/exec.js'

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

function toolPath(event: unknown): { readonly path: string; readonly toolCallId?: string } | undefined {
  const record = asRecord(event)
  const item = asRecord(record?.item)
  const candidate = [record?.path, record?.file_path, item?.path, item?.file_path].find((value): value is string => typeof value === 'string')
  if (candidate === undefined) return undefined
  const id = [record?.id, record?.call_id, item?.id].find((value): value is string => typeof value === 'string')
  return { path: candidate, ...(id === undefined ? {} : { toolCallId: id }) }
}

function isToolCompletion(event: unknown): boolean {
  const record = asRecord(event)
  if (record === undefined) return false
  const type = typeof record.type === 'string' ? record.type : ''
  if (type === 'tool.completed' || type === 'command.completed' || type === 'shell.completed' || type === 'write.completed') return true
  if (type !== 'item.completed') return false
  const item = asRecord(record.item)
  const itemType = typeof item?.type === 'string' ? item.type : ''
  return itemType.includes('command') || itemType.includes('shell') || itemType.includes('write') || itemType.includes('tool')
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
      const events: string[] = []
      const reconciles: Promise<unknown>[] = []
      const result = await exec(options.codex_executable ?? 'codex', ['exec', '--json', '-C', options.change_dir, '--sandbox', sandbox, '--ephemeral', '--skip-git-repo-check', prompt], {
        cwd: options.change_dir,
        maxTailChars: maxOutputChars,
        onLine: (line) => {
          events.push(line)
          try {
            const event = JSON.parse(line) as unknown
            if (isToolCompletion(event) && input.artifact_runtime !== undefined) {
              const pathInfo = toolPath(event)
              if (pathInfo !== undefined) reconciles.push(input.artifact_runtime.observePath(pathInfo.path, { source: 'managed-tool', ...(pathInfo.toolCallId === undefined ? {} : { toolCallId: pathInfo.toolCallId }) }))
              else reconciles.push(input.artifact_runtime.reconcile())
            }
          } catch { /* parser reports malformed JSON after the child exits */ }
        },
      })
      const parsed = parseCodexSkillOutput(result.stdout)
      const reconciliationResults = await Promise.allSettled(reconciles)
      const reconcileDiagnostics = reconciliationResults.flatMap((entry) => entry.status === 'rejected' ? [`artifact-reconcile-failed:${redact(entry.reason instanceof Error ? entry.reason.message : 'unknown', 180)}`] : [])
      if (result.exitCode !== 0) throw new Error(`codex skill execution failed (${result.exitCode}): ${redact(result.stderr, 512)}`)
      const candidate = asRecord(parsed.value)
      const diagnostics = [...parsed.diagnostics, ...reconcileDiagnostics, ...(result.stderr.length > 0 ? [`codex-stderr:${redact(result.stderr, 256)}`] : [])]
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
