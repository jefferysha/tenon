import { createDefaultArtifactCheckers, openArtifactService, type ArtifactService } from '../artifacts/service.js'
import { createCodexRuntimeExecutor, type CodexRuntimeExecutorOptions } from './codex-skill-executor-v2.js'
import { ExecutionRuntimeV2, type ExecutionRuntimeOptionsV2, type RuntimeValidatorV2 } from './runtime-v2.js'
import type { OrchestrationLedger } from '@tenon/kernel'

/** The single production assembly used by CLI, server and task-local runners. */
export interface ProductionRuntimeV2Options {
  readonly change_dir: string
  readonly ledger: OrchestrationLedger
  readonly worker_id: string
  readonly codex?: Omit<CodexRuntimeExecutorOptions, 'change_dir'>
  readonly validator?: RuntimeValidatorV2
  readonly artifact_service?: ArtifactService
  readonly runtime?: Omit<ExecutionRuntimeOptionsV2, 'change_dir' | 'ledger' | 'worker_id' | 'executor' | 'validator' | 'artifact_service'>
}

function defaultValidator(): RuntimeValidatorV2 {
  return {
    async validate(input) {
      const valid = input.observation.output_bytes > 0 && input.observation.output_digest.startsWith('sha256:')
      return {
        status: valid ? 'pass' : 'fail',
        validator_id: 'builtin-runtime-output',
        validator_version: '1',
        checks: [{ id: 'output-json-envelope', status: valid ? 'pass' : 'fail', message: valid ? 'bounded output persisted' : 'empty output' }],
        target_digests: [input.observation.output_digest],
        evidence_refs: input.observation.raw_output_ref === undefined ? [] : [input.observation.raw_output_ref],
      }
    },
  }
}

export async function createProductionExecutionRuntimeV2(options: ProductionRuntimeV2Options): Promise<ExecutionRuntimeV2> {
  const artifactService = options.artifact_service ?? await openArtifactService({
    rootDir: options.change_dir,
    scopeId: 'runtime-artifacts',
    checkers: createDefaultArtifactCheckers(),
  })
  const executor = createCodexRuntimeExecutor({ change_dir: options.change_dir, ...options.codex })
  return new ExecutionRuntimeV2({
    ...options.runtime,
    change_dir: options.change_dir,
    ledger: options.ledger,
    worker_id: options.worker_id,
    executor,
    validator: options.validator ?? defaultValidator(),
    artifact_service: artifactService,
  })
}
