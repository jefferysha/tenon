import type { StageArtifactRuntime, ArtifactServicePort } from '../artifact-runtime/stage-runtime.js'
import type { RuntimeConsumedV2 } from './runtime-v2-boundary.js'
import { redact } from './runtime-v2-boundary.js'

/** Resolve bounded executor declarations to exact versions and emit receipts. */
export async function consumeArtifactsV2(
  service: ArtifactServicePort,
  runtime: StageArtifactRuntime | undefined,
  stageAttemptId: string,
  declarations: readonly RuntimeConsumedV2[],
): Promise<readonly string[]> {
  if (runtime !== undefined) {
    const diagnostics: string[] = []
    for (const declaration of declarations.slice(0, 128)) {
      try {
        const options = { representation: declaration.representation ?? 'content' as const, ...(declaration.max_bytes === undefined ? {} : { maxBytes: declaration.max_bytes }) }
        if (declaration.artifact_id !== undefined && declaration.version !== undefined) await runtime.read(declaration.artifact_id, declaration.version, options)
        else await runtime.consume(declaration.ref, declaration.version, options)
      } catch (error) {
        diagnostics.push(`artifact-consume-failed:${redact(error instanceof Error ? error.message : 'unknown', 180)}`)
      }
    }
    return diagnostics.slice(0, 32)
  }
  if (service.read === undefined || service.catalog === undefined) return ['artifact-consume-unavailable']
  let catalog: Awaited<ReturnType<NonNullable<ArtifactServicePort['catalog']>>> | undefined
  const diagnostics: string[] = []
  let remainingBytes = 4 * 1024 * 1024
  for (const declaration of declarations.slice(0, 128)) {
    try {
      if (remainingBytes <= 0) throw new Error('artifact consumption byte budget exhausted')
      catalog ??= await service.catalog(stageAttemptId, { includeCandidates: true, includeHistory: true, maxEntries: 256 })
      const match = catalog.entries.filter((entry) =>
        (entry.source?.path === declaration.ref || entry.contentUri === declaration.ref) &&
        (declaration.artifact_id === undefined || entry.artifactId === declaration.artifact_id) &&
        (declaration.version === undefined || entry.version === declaration.version),
      ).at(-1)
      if (match === undefined) throw new Error(`artifact reference not found: ${declaration.ref}`)
      const inspected = await service.read(stageAttemptId, match.artifactId, match.version, {
        representation: declaration.representation ?? 'content',
        consumer: 'execution',
        maxBytes: Math.min(declaration.max_bytes ?? 256 * 1024, remainingBytes),
      })
      remainingBytes -= inspected.bytes?.byteLength ?? 0
    } catch (error) {
      diagnostics.push(`artifact-consume-failed:${redact(error instanceof Error ? error.message : 'unknown', 180)}`)
    }
  }
  return diagnostics.slice(0, 32)
}
