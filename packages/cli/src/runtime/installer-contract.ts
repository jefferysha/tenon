import type { RuntimePathInput } from './paths.js'
import type {
  RuntimeActivation,
  RuntimeDevSource,
  RuntimeInspection,
  RuntimeLauncherSnapshot,
  RuntimeReleaseSource,
  RuntimeStableReleaseTarget,
  RuntimeSelection,
  TrustedExecutableProof,
} from './types.js'

export interface RuntimeActivationCheckpoint {
  readonly selection: RuntimeSelection
  readonly launchers: RuntimeLauncherSnapshot
}

export interface ManagedRuntimeTransaction {
  checkpointActivation(): Promise<RuntimeActivationCheckpoint>
  activate(
    candidateRoot: string,
    host: RuntimeReleaseSource['host'],
    expectedPluginVersion?: string,
    stableTarget?: RuntimeStableReleaseTarget,
    devSource?: RuntimeDevSource,
  ): Promise<RuntimeActivation>
  recoverActivation(
    checkpoint: RuntimeActivationCheckpoint,
    host: RuntimeReleaseSource['host'],
  ): Promise<{ readonly state: 'not-started' } | { readonly state: 'activated'; readonly activation: RuntimeActivation }>
  revertActivation(activation: RuntimeActivation): Promise<void>
  proveActivation(activation: RuntimeActivation): Promise<boolean>
  readonly journal: ManagedReleaseJournal
}

export interface ManagedHostStepJournalRecord {
  readonly id: string
  readonly state: 'started' | 'completed'
  /** Canonical host-owned inventory captured and committed before the mutation. */
  readonly before?: string
  /** Canonical postcondition which must be proven from a fresh host observation. */
  readonly desired?: string
  readonly replayPolicy?: 'observe-before-replay-v1'
  /** Fresh canonical observation which proved the completed checkpoint. */
  readonly observedAfter?: string
  /** Bounded diagnostic output only; never treated as proof that the mutation committed. */
  readonly result?: string
}

export interface ManagedDashboardIdentity {
  readonly version: 1
  readonly serverVersion: string
  readonly port: number
  readonly pid: number
  readonly releaseId: string
  readonly stateScopeId: string
  /** Absent only for an ordinary `tenon dashboard` process. */
  readonly transactionId?: string
}

export interface ManagedDashboardJournalRecord extends ManagedDashboardIdentity {
  readonly owner: 'transaction' | 'preexisting'
}

export type ManagedStableReleaseTarget = RuntimeStableReleaseTarget
export type ManagedReleaseOperation = 'setup' | 'update' | 'adapter'
export type ManagedReleaseJournalPhase =
  | 'preparing-host'
  | 'candidate-resolved'
  | 'activating-runtime'
  | 'runtime-activated'
  | 'starting-dashboard'
  | 'dashboard-ready'
  | 'stopping-candidate'
  | 'reverting-activation'
  | 'restoring-previous'
  | 'previous-restored'
  | 'evidence-committed'

export interface ManagedReleaseJournalRecord {
  readonly version: 1
  readonly transactionId: string
  readonly operation: ManagedReleaseOperation
  readonly source: RuntimeReleaseSource['host']
  readonly phase: ManagedReleaseJournalPhase
  readonly startedAt: string
  readonly updatedAt: string
  /** Concrete port frozen when the transaction is created and reused for every recovery. */
  readonly dashboardPort?: number
  /** Stable target frozen before the first host mutation and reused by every recovery. */
  readonly stableTarget?: ManagedStableReleaseTarget
  readonly candidateRoot?: string
  /** Candidate-specific browser policy persisted for recovery (for example first setup only). */
  readonly candidateOpenBrowser?: boolean
  /** Host inventory snapshot or another small serializable input for the final receipt. */
  readonly evidence?: string
  readonly hostSteps?: readonly ManagedHostStepJournalRecord[]
  readonly activationCheckpoint?: RuntimeActivationCheckpoint
  readonly activation?: RuntimeActivation
  /** Exact service observed before activation. */
  readonly dashboardBefore?: ManagedDashboardIdentity
  /** Durable proof that the pre-activation Dashboard probe observed an empty port. */
  readonly dashboardBeforeAbsent?: true
  /** Durable permission to retire only the exact frozen wrong-version Dashboard before retry. */
  readonly dashboardBeforeRetiring?: true
  readonly dashboard?: ManagedDashboardJournalRecord
  /** Bounded failure detail carried through crash-safe compensation. */
  readonly compensationReason?: string
  /** Exact previous Dashboard identity restored under this transaction's restore identity. */
  readonly dashboardRestored?: ManagedDashboardIdentity
}

export interface ManagedReleaseJournal {
  create(
    operation: ManagedReleaseOperation,
    source: RuntimeReleaseSource['host'],
    now: string,
  ): ManagedReleaseJournalRecord
  read(): Promise<ManagedReleaseJournalRecord | null>
  write(record: ManagedReleaseJournalRecord): Promise<void>
  clear(expectedTransactionId: string): Promise<void>
}

export interface RuntimeInstallerScope {
  readonly homeDir: string
  readonly env: NonNullable<RuntimePathInput['env']>
  readonly platform?: NodeJS.Platform
  /** Absolute Bash executable frozen by native setup/update before any host mutation. */
  readonly trustedBashPath?: string
  /** Synchronous physical identity proof replayed immediately before every Bash spawn. */
  readonly verifyTrustedBash?: () => void
  readonly trustedNodePath?: string
  readonly trustedNodeProof?: TrustedExecutableProof
  readonly verifyTrustedNode?: () => void
}

export interface RuntimeInstaller {
  /** Read-only WAL probe used before network resolution; it must not create runtime roots. */
  peekManagedJournal?(scope: RuntimeInstallerScope): Promise<ManagedReleaseJournalRecord | null>
  withManagedTransaction<T>(
    scope: RuntimeInstallerScope,
    operation: (transaction: ManagedRuntimeTransaction) => Promise<T>,
  ): Promise<T>
  inspect(scope: RuntimeInstallerScope): Promise<RuntimeInspection>
  rollback(scope: RuntimeInstallerScope): Promise<RuntimeActivation>
  recordUpdateFailure?(scope: RuntimeInstallerScope, detail: string): Promise<void>
}

export class ManagedRuntimeIndeterminateError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'ManagedRuntimeIndeterminateError'
  }
}
