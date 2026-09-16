import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  CODEX_TRIAGE_MODEL_ALLOWLIST,
  DEFAULT_CODEX_TRIAGE_MODEL,
  TriageOrchestrationError,
  createCodexTriageProvider,
  createGitCommitsConnector,
  createLoopRunTerminalsConnector,
  createTriageCheckpointStore,
  createWorkflowRunCreateIfAbsentRepository,
  createWorkflowRunMaterializer,
  codexOnlyProcessEnv,
  nodeCodexTriageExec,
  runTriage,
  type CodexTriageExecFn,
  type CodexTriageModel,
  type ProductionTriageProvider,
  type RunTriageResult,
} from '@tenon/automation'
import type {
  ObserveAction,
  StateStore,
  TriageRoute,
  WorkflowRunRepository,
} from '@tenon/kernel'
import { loadEffectiveWorkflowPlan } from '@tenon/kernel'
import { errMsg, type CliDeps } from '../deps.js'

export type TriageSourceKind = 'git-commits' | 'loop-run-terminals'
const TRIAGE_SOURCE_KINDS: readonly TriageSourceKind[] = ['git-commits', 'loop-run-terminals']

const isTriageSourceKind = (value: string): value is TriageSourceKind =>
  (TRIAGE_SOURCE_KINDS as readonly string[]).includes(value)

export interface TriageCmdOpts {
  readonly provider?: string
  readonly model?: string
  readonly pageSize?: string
  readonly maxPages?: string
  readonly maxHighCandidates?: string
  readonly json?: boolean
}

export interface TriageCommandRequest {
  readonly source: TriageSourceKind
  readonly provider: 'codex'
  readonly model: CodexTriageModel
  readonly pageSize: number
  readonly maxPages: number
  readonly maxHighCandidates: number
}

export interface TriageCommandRuntime {
  run(request: TriageCommandRequest): Promise<RunTriageResult>
}

export type TriageTerminationSignal = 'SIGINT' | 'SIGTERM'

export class TriageCommandInterruptedError extends Error {
  override readonly name = 'TriageCommandInterruptedError'
  readonly exitCode: 130 | 143

  constructor(readonly signal: TriageTerminationSignal) {
    super(`triage interrupted by ${signal}`)
    this.exitCode = signal === 'SIGINT' ? 130 : 143
  }
}

export interface TriageProcessSignals {
  once(signal: TriageTerminationSignal, listener: () => void): void
  off(signal: TriageTerminationSignal, listener: () => void): void
}

const REAL_PROCESS_SIGNALS: TriageProcessSignals = {
  once(signal, listener) { process.once(signal, listener) },
  off(signal, listener) { process.off(signal, listener) },
}

async function withTerminationSignal<T>(
  configuredSignal: AbortSignal | undefined,
  processSignals: TriageProcessSignals,
  work: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  if (configuredSignal !== undefined) return work(configuredSignal)
  const controller = new AbortController()
  const interrupt = (signal: TriageTerminationSignal): void => {
    if (!controller.signal.aborted) controller.abort(new TriageCommandInterruptedError(signal))
  }
  const onSigint = (): void => interrupt('SIGINT')
  const onSigterm = (): void => interrupt('SIGTERM')
  processSignals.once('SIGINT', onSigint)
  processSignals.once('SIGTERM', onSigterm)
  try {
    const value = await work(controller.signal)
    if (controller.signal.reason instanceof TriageCommandInterruptedError) {
      throw controller.signal.reason
    }
    return value
  } catch (error) {
    if (controller.signal.reason instanceof TriageCommandInterruptedError) {
      throw controller.signal.reason
    }
    throw error
  } finally {
    processSignals.off('SIGINT', onSigint)
    processSignals.off('SIGTERM', onSigterm)
  }
}

export interface CreateProductionTriageRuntimeOptions {
  readonly repoRoot: string
  readonly store: StateStore
  readonly runRepository: Pick<WorkflowRunRepository, 'initChange'>
  readonly clock: () => string
  /** Declared identity that creates triaged Changes; throws the setup hint when missing. */
  readonly creator: () => import('@tenon/kernel').RecordActor
  readonly providerFactory?: (model: CodexTriageModel) => ProductionTriageProvider
  /** Hermetic test seam. Production omits it and receives a process-lifetime signal per invocation. */
  readonly signal?: AbortSignal
  readonly processSignals?: TriageProcessSignals
}

export interface CreateCodexFirstTriageProviderOptions {
  readonly model: CodexTriageModel
  readonly exec?: CodexTriageExecFn
  readonly homeDir?: () => string
  readonly env?: Readonly<NodeJS.ProcessEnv>
}

/** Codex owns authentication; missing CODEX_HOME resolves to the normal ~/.codex identity. */
export function createCodexFirstTriageProvider(
  options: CreateCodexFirstTriageProviderOptions,
): ProductionTriageProvider {
  const execute = options.exec ?? nodeCodexTriageExec
  const hostEnv = options.env ?? process.env
  const configuredHome = hostEnv.CODEX_HOME?.trim()
  const codexHome = configuredHome === undefined || configuredHome === ''
    ? join((options.homeDir ?? homedir)(), '.codex')
    : configuredHome
  return createCodexTriageProvider({
    model: options.model,
    exec: (file, args, execOptions) => execute(file, args, {
      ...execOptions,
      env: codexOnlyProcessEnv(execOptions.env, {
        CODEX_HOME: codexHome,
      }),
    }),
  })
}

const GIT_SOURCE_ID = 'repo-head'
const LOOP_SOURCE_ID = 'loop-ledger'
const DEFAULT_ROUTES: readonly TriageRoute[] = Object.freeze([Object.freeze({
  routeId: 'default-fix',
  description: 'Create a default backend fix workflow run for an actionable observation',
  resolved: Object.freeze({ workflowId: 'default', initialStep: 'open' }),
})])

/** Production composition: trusted source config/routes/init policy stay outside provider output. */
export function createProductionTriageRuntime(
  options: CreateProductionTriageRuntimeOptions,
): TriageCommandRuntime {
  const checkpointStore = createTriageCheckpointStore({ repoRoot: options.repoRoot })
  const createRepository = createWorkflowRunCreateIfAbsentRepository({
    repoRoot: options.repoRoot,
    store: options.store,
    runRepository: options.runRepository,
    resolveWorkflowPlan: (request) => loadEffectiveWorkflowPlan(
      options.repoRoot,
      request.workflowId,
    ),
    resolveInit: () => ({
      track: 'backend',
      reviewSeed: 'pending',
      preset: 'full',
      creator: options.creator(),
      clock: options.clock,
    }),
  })
  const materializer = createWorkflowRunMaterializer({ repository: createRepository })
  const gitConnector = createGitCommitsConnector({
    sources: {
      [GIT_SOURCE_ID]: { repoRoot: options.repoRoot, ref: 'HEAD' },
    },
  })
  const loopConnector = createLoopRunTerminalsConnector({ repoRoot: options.repoRoot })
  const providerFactory = options.providerFactory
    ?? ((model: CodexTriageModel) => createCodexFirstTriageProvider({ model }))
  const processSignals = options.processSignals ?? REAL_PROCESS_SIGNALS

  return {
    async run(request) {
      const action: ObserveAction = request.source === 'git-commits'
        ? { schemaVersion: 1, kind: 'git-commits', sourceId: GIT_SOURCE_ID }
        : { schemaVersion: 1, kind: 'loop-run-terminals', sourceId: LOOP_SOURCE_ID }
      const connector = request.source === 'git-commits' ? gitConnector : loopConnector
      return withTerminationSignal(options.signal, processSignals, (signal) => runTriage({
        action,
        connector,
        provider: providerFactory(request.model),
        materializer,
        checkpointStore,
        routes: DEFAULT_ROUTES,
        pageSize: request.pageSize,
        maxPages: request.maxPages,
        maxHighCandidates: request.maxHighCandidates,
        signal,
      }))
    },
  }
}

class TriageCommandUsageError extends Error {
  override readonly name = 'TriageCommandUsageError'
}

function integerOption(
  value: string | undefined,
  fallback: number,
  flag: string,
  minimum: number,
): number {
  const raw = value ?? String(fallback)
  if (!/^(?:0|[1-9]\d*)$/.test(raw)) {
    throw new TriageCommandUsageError(`${flag} 必须是大于等于 ${minimum} 的十进制安全整数`)
  }
  const parsed = Number(raw)
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    throw new TriageCommandUsageError(`${flag} 必须是大于等于 ${minimum} 的十进制安全整数`)
  }
  return parsed
}

function jsonResult(request: TriageCommandRequest, result: RunTriageResult): object {
  const runs = result.materializations.map(({ request: create, outcome }) => ({
    status: outcome.status,
    changeName: create.changeName,
    runId: outcome.run.id,
    workflowId: outcome.run.workflowId,
    currentStep: outcome.run.currentStep,
  }))
  return {
    schemaVersion: 1,
    command: 'triage',
    source: request.source,
    provider: request.provider,
    model: request.model,
    pagesProcessed: result.pagesProcessed,
    observationsProcessed: result.observationsProcessed,
    workflowRuns: {
      total: runs.length,
      created: runs.filter((run) => run.status === 'created').length,
      existing: runs.filter((run) => run.status === 'existing').length,
      runs,
    },
    checkpoint: {
      sourceId: result.checkpoint.sourceId,
      actionKind: result.checkpoint.actionKind,
      commit: result.checkpointCommit,
      hasMore: result.hasMore,
      limitReached: result.limitReached,
    },
  }
}

export async function cmdTriage(
  deps: CliDeps,
  source: string,
  options: TriageCmdOpts,
  runtime?: TriageCommandRuntime,
): Promise<number> {
  const provider = options.provider ?? 'codex'
  if (provider !== 'codex') {
    deps.io.err(`ERROR: triage provider '${provider}' 不受支持；生产仅支持 codex`)
    return 1
  }
  if (!isTriageSourceKind(source)) {
    deps.io.err(
      `ERROR: triage source '${source}' 不受支持；允许 ${TRIAGE_SOURCE_KINDS.join(' | ')}`,
    )
    return 1
  }
  const model = options.model ?? DEFAULT_CODEX_TRIAGE_MODEL
  if (!(CODEX_TRIAGE_MODEL_ALLOWLIST as readonly string[]).includes(model)) {
    deps.io.err(
      `ERROR: triage model '${model}' 不在 host allowlist（${CODEX_TRIAGE_MODEL_ALLOWLIST.join(' | ')}）`,
    )
    return 1
  }
  if (runtime === undefined) {
    deps.io.err('ERROR: triage production runtime 未装配')
    return 1
  }
  let request: TriageCommandRequest
  try {
    request = {
      source,
      provider,
      model: model as CodexTriageModel,
      pageSize: integerOption(options.pageSize, 20, '--page-size', 1),
      maxPages: integerOption(options.maxPages, 4, '--max-pages', 1),
      maxHighCandidates: integerOption(
        options.maxHighCandidates,
        10,
        '--max-high-candidates',
        0,
      ),
    }
  } catch (error) {
    if (!(error instanceof TriageCommandUsageError)) throw error
    deps.io.err(`ERROR: ${error.message}`)
    return 1
  }
  let result: RunTriageResult
  try {
    result = await runtime.run(request)
  } catch (error) {
    if (error instanceof TriageCommandInterruptedError) {
      deps.io.err(`ERROR: ${error.message}`)
      return error.exitCode
    }
    if (error instanceof TriageOrchestrationError) {
      const progress = error.progress
      const issues = error.issues.length === 0 ? '' : `; issues=${error.issues.join(' | ')}`
      deps.io.err(
        `ERROR: triage ${error.reason}: ${error.message} `
        + `(pages_committed=${progress.pagesCommitted}, `
        + `observations_committed=${progress.observationsCommitted}, `
        + `checkpoint_commit=${progress.checkpointCommit}, retryable=${progress.retryable})${issues}`,
      )
    } else {
      deps.io.err(`ERROR: triage failed: ${errMsg(error)}`)
    }
    return 1
  }
  if (options.json) {
    deps.io.out(JSON.stringify(jsonResult(request, result)))
  } else {
    const created = result.materializations.filter(
      (materialization) => materialization.outcome.status === 'created',
    ).length
    const existing = result.materializations.length - created
    deps.io.out(`TRIAGE source=${request.source} provider=${request.provider} model=${request.model}`)
    deps.io.out(
      `pages=${result.pagesProcessed} observations=${result.observationsProcessed} `
      + `workflow_runs=${result.materializations.length} created=${created} existing=${existing}`,
    )
    deps.io.out(
      `checkpoint=${result.checkpointCommit} has_more=${result.hasMore} `
      + `limit_reached=${result.limitReached}`,
    )
    if (result.limitReached) {
      deps.io.out('RESUME: source 仍有数据；原命令重跑将从 durable checkpoint 幂等续跑')
    }
  }
  return 0
}
