/**
 * Durable execution runtime for the v2 orchestration aggregate.
 *
 * This module is deliberately an application adapter: every state mutation is
 * sent to the Kernel ledger, which performs CAS, `decideV2`, and `evolveV2`.
 * Executor/validator payloads stay at this boundary and are reduced to bounded
 * evidence before a complete/validation command is appended.
 */
import { randomUUID } from 'node:crypto'
import {
  type ArtifactCatalog,
  type BoardCommandV2,
  type BoardSnapshotV2,
  type CapabilityResolutionV2,
  type GateEvaluationV2,
  type OrchestrationLedger,
  type SkillResultV2,
  type SkillRunV2,
  type ValidationReportV2,
  type WorkItemV2,
} from '@tenon/kernel'
import {
  addMilliseconds,
  idValid,
  normalizeObservation,
  normalizePolicy,
  normalizeReport,
  redact,
  resultIdentity,
  resultFor,
  utc,
  type NormalizedPolicyV2,
  type RuntimeObservationV2,
  type RuntimePolicyV2,
} from './runtime-v2-boundary.js'
import {
  createFilesystemArtifactResolverV2,
  materializeRunInputsV2,
  rejectedInputManifest,
  emptyInputBundleV2,
  InputMaterializationErrorV2,
  type RuntimeArtifactResolverV2,
  type RuntimeInputBundleV2,
} from './input-materialization-v2.js'
import { bindingFor, chooseWave, pipelineDependencyStageIds, pipelineSkillFor, pipelineStageIdFor, resultInputRefs } from './runtime-v2-scheduler.js'
import { StageArtifactRuntime, type ArtifactServicePort } from '../artifact-runtime/stage-runtime.js'
import { openArtifactService } from '../artifacts/service.js'
import { consumeArtifactsV2 } from './artifact-consumption-v2.js'
import { persistRuntimeOutputV2 } from './runtime-output-persistence-v2.js'

export interface RuntimeExecutorInputV2 {
  readonly run_id: string
  readonly work_item_id: string
  readonly skill_id: string
  readonly skill_version: string
  readonly mcp_ids: readonly string[]
  readonly input_refs: readonly string[]
  readonly input_bundle: RuntimeInputBundleV2
  readonly signal: AbortSignal
  /** Stage-scoped observer/publisher. Skills may explicitly publish actual files. */
  readonly artifact_runtime?: StageArtifactRuntime
  /** Bounded metadata exposed before execution; file bodies remain on-demand. */
  readonly artifact_catalog?: ArtifactCatalog
}

/** Provider-neutral port. The returned value is untrusted and bounded here. */
export interface RuntimeExecutorV2 {
  execute(input: RuntimeExecutorInputV2): Promise<unknown>
}

export interface RuntimeValidatorInputV2 {
  readonly run_id: string
  readonly result_id: string
  readonly work_item_id: string
  readonly skill_id: string
  readonly skill_version: string
  readonly observation: RuntimeObservationV2
  readonly input_bundle: RuntimeInputBundleV2
}

/** A validator may return a V2 report or an equivalent plain JSON record. */
export interface RuntimeValidatorV2 {
  validate(input: RuntimeValidatorInputV2): Promise<unknown>
}

export type { RuntimeObservationV2, RuntimePolicyV2 }
export type { RuntimeArtifactV2 } from './runtime-v2-boundary.js'

export interface ExecutionRuntimeOptionsV2 {
  readonly change_dir: string
  readonly ledger: OrchestrationLedger
  readonly worker_id: string
  readonly executor: RuntimeExecutorV2
  readonly validator?: RuntimeValidatorV2
  readonly signal?: AbortSignal
  readonly clock?: () => string
  readonly id_factory?: (prefix: string) => string
  readonly retry?: RuntimePolicyV2
  readonly actor_id?: string
  /** Optional resolver for project/MCP artifact references. Files in change_dir are resolved by default. */
  readonly artifact_resolver?: RuntimeArtifactResolverV2
  /** Durable runtime artifact service. When omitted, one is opened in change_dir. */
  readonly artifact_service?: ArtifactServicePort
}

export interface RuntimeRecoveryV2 {
  readonly report: Awaited<ReturnType<OrchestrationLedger['recover']>>['report']
  readonly recovered: boolean
  readonly expired_runs: readonly string[]
}

export interface ExecutionRuntimeResultV2 {
  readonly ok: boolean
  readonly snapshot: BoardSnapshotV2
  readonly recovery: RuntimeRecoveryV2
  readonly attempts: number
  readonly diagnostics: readonly string[]
}

export class ExecutionRuntimeErrorV2 extends Error {
  readonly code: 'ledger-unavailable' | 'command-rejected' | 'runtime-invalid' | 'round-budget-exceeded'

  constructor(code: ExecutionRuntimeErrorV2['code'], message: string) {
    super(message)
    this.name = 'ExecutionRuntimeErrorV2'
    this.code = code
  }
}

interface SettledRunV2 {
  readonly run: SkillRunV2
  readonly item: WorkItemV2
  readonly result: SkillResultV2
  readonly report?: ValidationReportV2
  readonly retryable: boolean
  readonly blocking: boolean
}

export class ExecutionRuntimeV2 {
  private readonly options: ExecutionRuntimeOptionsV2
  private readonly policy: NormalizedPolicyV2
  private readonly clock: () => string
  private readonly idFactory: (prefix: string) => string
  private readonly controllers = new Map<string, AbortController>()
  private readonly inputBundles = new Map<string, RuntimeInputBundleV2>()
  private readonly artifactResolver: RuntimeArtifactResolverV2
  private stopping = false
  private attempts = 0
  private readonly diagnostics: string[] = []

  constructor(options: ExecutionRuntimeOptionsV2) {
    if (!options.change_dir || !idValid(options.worker_id)) throw new ExecutionRuntimeErrorV2('runtime-invalid', 'worker_id/change_dir is invalid')
    this.options = options
    this.policy = normalizePolicy(options.retry)
    this.clock = options.clock ?? (() => new Date().toISOString())
    this.idFactory = options.id_factory ?? ((prefix) => `${prefix}:${randomUUID()}`)
    this.artifactResolver = options.artifact_resolver ?? createFilesystemArtifactResolverV2(options.change_dir)
  }

  async run(): Promise<ExecutionRuntimeResultV2> {
    let snapshot = await this.snapshot()
    const recovery = await this.recoverExpired(snapshot)
    snapshot = recovery.snapshot
    for (let round = 0; round < this.policy.max_rounds; round += 1) {
      if (this.stopping || this.options.signal?.aborted === true) {
        snapshot = await this.cancelIfNeeded(snapshot, this.stopping ? 'runtime-shutdown' : 'execution-aborted')
        return this.result(snapshot, recovery)
      }
      snapshot = await this.evaluateCompletionGate(snapshot)
      if (snapshot.status === 'completed') return this.result(snapshot, recovery)
      if (snapshot.status === 'paused' || snapshot.status === 'waiting-input' || snapshot.status === 'blocked' || snapshot.status === 'cancelled') return this.result(snapshot, recovery)
      snapshot = await this.enqueueReady(snapshot)
      const wave = chooseWave(snapshot, this.policy)
      if (wave.length === 0) return this.result(await this.evaluateCompletionGate(snapshot), recovery)
      const prepared = await this.claimAndBegin(snapshot, wave)
      snapshot = prepared.snapshot
      const settled = await Promise.allSettled(prepared.runs.map((run) => this.executeOne(run)))
      if (Boolean(this.options.signal?.aborted) || this.stopping) {
        snapshot = await this.cancelIfNeeded(snapshot, this.stopping ? 'runtime-shutdown' : 'execution-aborted')
        return this.result(snapshot, recovery)
      }
      const outcomes: SettledRunV2[] = settled.map((entry, index) => {
        const preparedRun = prepared.runs[index]
        if (preparedRun === undefined) throw new ExecutionRuntimeErrorV2('runtime-invalid', 'prepared run identity was lost')
        return entry.status === 'fulfilled' ? entry.value : {
          run: preparedRun.run, item: preparedRun.item,
          result: resultFor(preparedRun.run, undefined, undefined, utc(this.clock), 'executor-failed'),
          retryable: true, blocking: true,
        }
      }).sort((left, right) => Number(left.blocking) - Number(right.blocking))
      for (const outcome of outcomes) {
        snapshot = await this.settle(snapshot, outcome)
      }
      if (Boolean(this.options.signal?.aborted) || this.stopping) {
        snapshot = await this.cancelIfNeeded(snapshot, this.stopping ? 'runtime-shutdown' : 'execution-aborted')
        return this.result(snapshot, recovery)
      }
      let retried = false
      for (const outcome of outcomes) {
        const item = snapshot.work_items.find((candidate) => candidate.work_item_id === outcome.item.work_item_id)
        if (item?.status === 'failed' && outcome.retryable && this.policy.auto_retry && item.attempt_count + 1 < this.policy.max_attempts) {
          snapshot = await this.append(snapshot, 'retry-work-item', { work_item_id: item.work_item_id, attempt_id: this.id('attempt'), run_id: this.id('run') }, `retry:${item.work_item_id}:${item.attempt_count + 1}`)
          retried = true
        }
      }
      if (snapshot.status === 'failed' && !retried) return this.result(snapshot, recovery)
    }
    this.diagnostics.push('round-budget-exceeded')
    throw new ExecutionRuntimeErrorV2('round-budget-exceeded', 'execution exceeded bounded round budget')
  }

  async shutdown(): Promise<ExecutionRuntimeResultV2> {
    this.stopping = true
    for (const controller of this.controllers.values()) controller.abort()
    return this.run()
  }

  async cancel(reason = 'operator-request'): Promise<BoardSnapshotV2> {
    this.stopping = true
    for (const controller of this.controllers.values()) controller.abort()
    return this.cancelIfNeeded(await this.snapshot(), reason)
  }

  private id(prefix: string): string {
    const value = this.idFactory(prefix)
    if (!idValid(value)) throw new ExecutionRuntimeErrorV2('runtime-invalid', 'id_factory returned an unsafe id')
    return value
  }

  private async snapshot(): Promise<BoardSnapshotV2> {
    let snapshot: BoardSnapshotV2 | undefined
    try { snapshot = await this.options.ledger.readSnapshot(this.options.change_dir) } catch (error) { throw error }
    if (snapshot === undefined) throw new ExecutionRuntimeErrorV2('ledger-unavailable', 'orchestration ledger is not initialized')
    return snapshot
  }

  private async recoverExpired(snapshot: BoardSnapshotV2): Promise<RuntimeRecoveryV2 & { readonly snapshot: BoardSnapshotV2 }> {
    const now = utc(this.clock)
    const recovery = await this.options.ledger.recover(this.options.change_dir, now)
    let next = recovery.snapshot ?? snapshot
    const expired = recovery.report.lease_decisions.filter((entry) => entry.decision === 'expired-awaiting-scheduler').map((entry) => entry.run_id)
    for (const runId of expired) {
      const run = next.runs.find((candidate) => candidate.run_id === runId)
      if (run === undefined || (run.status !== 'claimed' && run.status !== 'running') || run.lease === undefined) continue
      const result: SkillResultV2 = resultFor(run, undefined, undefined, now, 'lease-expired-recovery')
      next = await this.append(next, 'complete-run', { run_id: run.run_id, result }, `recover:${run.run_id}`)
      const item = next.work_items.find((candidate) => candidate.work_item_id === run.work_item_id)
      if (item?.status === 'failed' && this.policy.auto_retry && item.attempt_count + 1 < this.policy.max_attempts) {
        next = await this.append(next, 'retry-work-item', { work_item_id: item.work_item_id, attempt_id: this.id('attempt'), run_id: this.id('run') }, `recover-retry:${run.run_id}`)
      }
    }
    return { snapshot: next, report: recovery.report, recovered: recovery.snapshot !== undefined, expired_runs: expired }
  }

  private async enqueueReady(snapshot: BoardSnapshotV2): Promise<BoardSnapshotV2> {
    let next = snapshot
    for (const item of snapshot.work_items.filter((candidate) => candidate.status === 'ready')) {
      next = await this.append(next, 'enqueue-work-item', { work_item_id: item.work_item_id }, `enqueue:${item.work_item_id}`)
    }
    return next
  }

  private async claimAndBegin(snapshot: BoardSnapshotV2, items: readonly WorkItemV2[]): Promise<{ readonly snapshot: BoardSnapshotV2; readonly runs: readonly { readonly run: SkillRunV2; readonly item: WorkItemV2 }[] }> {
    let next = snapshot
    const runs: { readonly run: SkillRunV2; readonly item: WorkItemV2 }[] = []
    for (const item of items) {
      if (item.status !== 'queued') continue
      const binding = bindingFor(next, item)
      if (binding === undefined) {
        this.diagnostics.push(`binding-missing:${item.work_item_id}`)
        continue
      }
      const priorQueued = next.runs.find((candidate) => candidate.run_id === item.active_run_id && candidate.status === 'queued')
      const runBase: SkillRunV2 = priorQueued ?? {
        schema_version: 'skill-run/v2', record_id: `run:${this.id('run')}`, project_id: next.project_id, change_id: next.change_id,
        revision: next.revision, correlation_id: next.correlation_id, actor: { kind: 'worker', id: this.options.worker_id }, created_at: utc(this.clock),
        run_id: this.id('run'), attempt_id: this.id('attempt'), attempt: item.attempt_count + 1, work_item_id: item.work_item_id,
        skill_id: binding.skill_id, skill_version: binding.skill_version, mcp_ids: binding.mcp_ids, status: 'queued',
        input_refs: resultInputRefs(next, item),
      }
      let run = runBase
      let preparedBundle: RuntimeInputBundleV2 | undefined
      try {
        const prepared = await materializeRunInputsV2({ snapshot: next, item, run_id: run.run_id, signal: this.options.signal ?? new AbortController().signal, resolver: this.artifactResolver, max_bytes: Math.min(this.policy.max_output_bytes * 4, 4 * 1024 * 1024), now: utc(this.clock) })
        preparedBundle = prepared.bundle
        run = { ...run, input_refs: prepared.manifest.input_refs, input_manifest: prepared.manifest }
      } catch (error) {
        const reason = error instanceof InputMaterializationErrorV2 ? error.code : 'artifact-unavailable'
        this.diagnostics.push(`input-materialization:${reason}`)
        run = { ...run, input_manifest: rejectedInputManifest(run.run_id, run.work_item_id, run.input_refs, reason, utc(this.clock)) }
      }
      const lease = { lease_id: this.id('lease'), owner_id: this.options.worker_id, acquired_at: utc(this.clock), heartbeat_at: utc(this.clock), expires_at: addMilliseconds(utc(this.clock), this.policy.lease_duration_ms), generation: 1, status: 'active' as const }
      next = await this.append(next, 'claim-run', { run, lease }, `claim:${item.work_item_id}:${run.attempt}`)
      const claimed = next.runs.find((candidate) => candidate.run_id === run.run_id)
      if (claimed === undefined || claimed.lease === undefined) throw new ExecutionRuntimeErrorV2('command-rejected', `claim did not persist run ${run.run_id}`)
      next = await this.append(next, 'begin-run', { run_id: run.run_id, lease_id: claimed.lease.lease_id, owner_id: claimed.lease.owner_id, generation: claimed.lease.generation }, `begin:${run.run_id}`)
      const begun = next.runs.find((candidate) => candidate.run_id === run.run_id)
      if (begun === undefined) throw new ExecutionRuntimeErrorV2('command-rejected', `begin did not persist run ${run.run_id}`)
      this.attempts += 1
      if (preparedBundle !== undefined) this.inputBundles.set(run.run_id, preparedBundle)
      runs.push({ run: begun, item })
    }
    return { snapshot: next, runs }
  }

  private async executeOne(prepared: { readonly run: SkillRunV2; readonly item: WorkItemV2 }): Promise<SettledRunV2> {
    const { run, item } = prepared
    const runSnapshot = await this.snapshot()
    const binding = bindingFor(runSnapshot, item)
    if (binding === undefined) throw new ExecutionRuntimeErrorV2('runtime-invalid', `binding missing for ${item.work_item_id}`)
    const controller = new AbortController()
    this.controllers.set(run.run_id, controller)
    const external = this.options.signal
    const abortExternal = () => controller.abort()
    if (external?.aborted === true) controller.abort()
    external?.addEventListener('abort', abortExternal, { once: true })
    let heartbeatTimer: ReturnType<typeof setInterval> | undefined
    let heartbeatBusy = false
    const heartbeat = async () => {
      if (heartbeatBusy || controller.signal.aborted) return
      heartbeatBusy = true
      try {
        const latest = await this.snapshot()
        const current = latest.runs.find((candidate) => candidate.run_id === run.run_id)
        if (current?.lease === undefined || (current.status !== 'running' && current.status !== 'claimed') || current.lease.owner_id !== this.options.worker_id) return
        const now = utc(this.clock)
        await this.append(latest, 'heartbeat-run', { run_id: run.run_id, lease_id: current.lease.lease_id, owner_id: current.lease.owner_id, generation: current.lease.generation + 1, heartbeat_at: now, expires_at: addMilliseconds(now, this.policy.lease_duration_ms) }, `heartbeat:${run.run_id}:${current.lease.generation + 1}`)
      } catch (error) {
        this.diagnostics.push(`heartbeat-failed:${error instanceof Error ? redact(error.message) : 'unknown'}`)
      } finally { heartbeatBusy = false }
    }
    heartbeatTimer = setInterval(() => { void heartbeat() }, this.policy.heartbeat_interval_ms)
    let observation: RuntimeObservationV2 | undefined
    let report: ValidationReportV2 | undefined
    let issue: string | undefined
    let retryable = false
    const inputBundle = this.inputBundles.get(run.run_id) ?? emptyInputBundleV2(run.run_id, item.work_item_id)
    let artifactRuntime: StageArtifactRuntime | undefined
    let artifactCatalog: ArtifactCatalog | undefined
    let artifactService: ArtifactServicePort | undefined = this.options.artifact_service
    if (artifactService === undefined) {
      try { artifactService = await openArtifactService({ rootDir: this.options.change_dir, scopeId: 'runtime-artifacts' }) } catch (error) { this.diagnostics.push(`artifact-service-open-failed:${error instanceof Error ? redact(error.message) : 'unknown'}`) }
    }
    if (artifactService !== undefined) {
      try {
        artifactRuntime = await StageArtifactRuntime.open({
          service: artifactService,
          rootDir: this.options.change_dir,
          workflowRunId: run.run_id,
          // Artifact lineage uses the stable pipeline stage namespace. The
          // work_item_id remains the ledger identity passed to the executor.
          stageId: pipelineStageIdFor(runSnapshot, item),
          stageAttemptId: run.attempt_id,
          dependencyStages: pipelineDependencyStageIds(runSnapshot, item),
          skillId: binding.skill_id,
          actorId: this.options.actor_id ?? this.options.worker_id,
        })
        const catalog = artifactRuntime.catalog.bind(artifactRuntime)
        try { artifactCatalog = await catalog({ includeCandidates: false, includeHistory: false, maxEntries: 100 }) } catch (error) { this.diagnostics.push(`artifact-catalog-open-failed:${error instanceof Error ? redact(error.message) : 'unknown'}`) }
      } catch (error) {
        this.diagnostics.push(`artifact-runtime-open-failed:${error instanceof Error ? redact(error.message) : 'unknown'}`)
      }
    }
    try {
      let raw: unknown
      if (run.input_manifest?.delivery === 'rejected') {
        issue = 'input-materialization-failed'
        retryable = true
      } else {
        try {
          raw = await this.options.executor.execute({ run_id: run.run_id, work_item_id: item.work_item_id, skill_id: binding.skill_id, skill_version: binding.skill_version, mcp_ids: binding.mcp_ids, input_refs: run.input_refs, input_bundle: inputBundle, signal: controller.signal, ...(artifactRuntime === undefined ? {} : { artifact_runtime: artifactRuntime }), ...(artifactCatalog === undefined ? {} : { artifact_catalog: artifactCatalog }) })
        } catch (error) {
          issue = controller.signal.aborted && this.options.signal?.aborted !== true ? 'executor-aborted' : 'executor-failed'
          retryable = issue === 'executor-failed'
          if (error instanceof Error) this.diagnostics.push(`executor:${redact(error.message)}`)
        }
      }
      if (issue === undefined) {
        const normalized = normalizeObservation(raw, this.policy)
        if (!normalized.ok) issue = normalized.code
        else {
          try {
            let preparedObservation = normalized.observation
            if (artifactRuntime !== undefined && artifactService !== undefined && normalized.observation.consumed !== undefined && normalized.observation.consumed.length > 0) {
              const consumeDiagnostics = await consumeArtifactsV2(artifactService, artifactRuntime, run.attempt_id, normalized.observation.consumed)
              if (consumeDiagnostics.length > 0) preparedObservation = { ...preparedObservation, diagnostics: Object.freeze([...preparedObservation.diagnostics, ...consumeDiagnostics].slice(0, 64)) }
            }
            const outputRef = await persistRuntimeOutputV2(this.options.change_dir, run, preparedObservation)
            observation = {
              ...preparedObservation,
              raw_output_ref: outputRef.ref,
              artifacts: Object.freeze([
                ...preparedObservation.artifacts,
                { id: `output:${run.run_id}`, kind: 'json' as const, ref: outputRef.ref, digest: outputRef.digest, media_type: 'application/json', byte_length: outputRef.byte_length },
              ]),
            }
          } catch (error) {
            issue = 'output-persist-failed'
            retryable = true
            if (error instanceof Error) this.diagnostics.push(`output-persist:${redact(error.message)}`)
          }
          if (issue === undefined && this.options.validator !== undefined) {
            try {
              if (observation === undefined) throw new Error('observation unavailable after output persistence')
              const rawReport = await this.options.validator.validate({ run_id: run.run_id, result_id: resultIdentity(run.run_id), work_item_id: item.work_item_id, skill_id: binding.skill_id, skill_version: binding.skill_version, observation, input_bundle: inputBundle })
              const normalizedReport = normalizeReport(rawReport, { result_id: resultIdentity(run.run_id), work_item_id: item.work_item_id }, utc(this.clock))
              if (!normalizedReport.ok) issue = normalizedReport.code
              else report = { ...normalizedReport.report, project_id: run.project_id, change_id: run.change_id, correlation_id: run.correlation_id, actor: { kind: 'system', id: 'validator' } }
            } catch (error) {
              issue = 'validator-failed'
              if (error instanceof Error) this.diagnostics.push(`validator:${redact(error.message)}`)
            }
          }
        }
      }
    } finally {
      if (heartbeatTimer !== undefined) clearInterval(heartbeatTimer)
      external?.removeEventListener('abort', abortExternal)
      this.controllers.delete(run.run_id)
    }
    if (artifactRuntime !== undefined) {
      try {
        await artifactRuntime.end(issue === undefined ? 'completed' : (controller.signal.aborted ? 'cancelled' : 'failed'))
      } catch (error) {
        this.diagnostics.push(`artifact-runtime-reconcile-failed:${error instanceof Error ? redact(error.message) : 'unknown'}`)
      }
    }
    if (issue === 'executor-failed' || issue === 'observation-invalid' || issue?.startsWith('json-') === true) retryable = true
    const result = resultFor(run, observation, report, utc(this.clock), issue, pipelineSkillFor(await this.snapshot(), item)?.output_schema_id)
    const blocking = result.contract_status !== 'validated' || report?.status !== 'pass' || report.checks.some((check) => check.status !== 'pass') || issue !== undefined
    return { run, item, result, ...(report === undefined ? {} : { report }), retryable, blocking }
  }

  private async settle(snapshot: BoardSnapshotV2, outcome: SettledRunV2): Promise<BoardSnapshotV2> {
    const current = snapshot.runs.find((candidate) => candidate.run_id === outcome.run.run_id)
    if (current === undefined || current.status !== 'running') return snapshot
    let next = await this.append(snapshot, 'complete-run', { run_id: outcome.run.run_id, result: outcome.result }, `complete:${outcome.run.run_id}`)
    if (outcome.report !== undefined && outcome.result.contract_status === 'validated') {
      const report = { ...outcome.report, revision: next.revision }
      next = await this.append(next, 'record-validation', { report }, `validate:${outcome.run.run_id}`)
    }
    return next
  }

  private async cancelIfNeeded(snapshot: BoardSnapshotV2, reason: string): Promise<BoardSnapshotV2> {
    if (snapshot.status === 'cancelled' || snapshot.status === 'completed') return snapshot
    try { return await this.append(snapshot, 'cancel-change', { reason }, `cancel:${reason}`) } catch (error) {
      if (error instanceof ExecutionRuntimeErrorV2 && error.code === 'command-rejected') {
        const latest = await this.snapshot()
        if (latest.status === 'cancelled') return latest
      }
      throw error
    }
  }

  private async evaluateCompletionGate(snapshot: BoardSnapshotV2): Promise<BoardSnapshotV2> {
    if (snapshot.work_items.length === 0 || !snapshot.work_items.every((item) => item.status === 'completed')) return snapshot
    if (snapshot.gates.some((gate) => gate.kind === 'verification' && (gate.status === 'passed' || gate.status === 'waived'))) return snapshot
    const evidence = [...snapshot.results.flatMap((result) => result.artifacts.map((artifact) => artifact.ref)), ...snapshot.validations.flatMap((report) => report.evidence_refs)]
    const gate: GateEvaluationV2 = {
      schema_version: 'gate-evaluation/v2', record_id: `gate:${snapshot.change_id}:verification`, project_id: snapshot.project_id,
      change_id: snapshot.change_id, revision: snapshot.revision, correlation_id: snapshot.correlation_id,
      actor: { kind: 'worker', id: this.options.worker_id }, created_at: utc(this.clock), gate_id: `gate:${snapshot.change_id}:verification`,
      kind: 'verification', status: 'passed', required_evidence_refs: [...new Set(evidence)], decision_revision: snapshot.revision,
      rationale: 'all work items completed with passing validation evidence',
    }
    return this.append(snapshot, 'evaluate-gate', { gate }, 'gate:verification')
  }

  private async append(snapshot: BoardSnapshotV2, type: BoardCommandV2['type'], payload: Record<string, unknown>, key: string): Promise<BoardSnapshotV2> {
    const commandId = this.id(`command:${key}`)
    const idempotencyKey = this.id(`idem:${key}`)
    let expected = snapshot
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const command: BoardCommandV2 = {
        schema_version: 'board-command/v2', command_id: commandId, idempotency_key: idempotencyKey,
        expected_revision: expected.revision, actor: { kind: 'worker', id: this.options.actor_id ?? this.options.worker_id }, issued_at: utc(this.clock),
        correlation_id: expected.correlation_id, ...(expected.event_head_id === undefined ? {} : { causation_id: expected.event_head_id }), change_id: expected.change_id,
        type, ...payload,
      } as BoardCommandV2
      const result = await this.options.ledger.append(this.options.change_dir, command)
      if (result.kind === 'committed' || result.kind === 'replayed') return result.snapshot
      if (result.rejection.code !== 'revision-conflict') throw new ExecutionRuntimeErrorV2('command-rejected', `${type}: ${redact(result.rejection.message)}`)
      expected = await this.snapshot()
    }
    throw new ExecutionRuntimeErrorV2('command-rejected', `${type}: revision conflict retry budget exhausted`)
  }

  private result(snapshot: BoardSnapshotV2, recovery: RuntimeRecoveryV2 & { readonly snapshot: BoardSnapshotV2 }): ExecutionRuntimeResultV2 {
    return { ok: true, snapshot, recovery: { report: recovery.report, recovered: recovery.recovered, expired_runs: recovery.expired_runs }, attempts: this.attempts, diagnostics: Object.freeze([...this.diagnostics]) }
  }
}

export function createExecutionRuntimeV2(options: ExecutionRuntimeOptionsV2): ExecutionRuntimeV2 {
  return new ExecutionRuntimeV2(options)
}

export type { NormalizedPolicyV2 }
