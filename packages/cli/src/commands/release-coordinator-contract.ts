import type {
  ManagedReleaseOperation,
  ManagedStableReleaseTarget,
  RuntimeInstallerScope,
} from '../runtime/installer.js'
import type { NativeRuntimeHost, RuntimeActivation, RuntimeDevSource } from '../runtime/types.js'

export type ManagedReleaseFailureState = 'unchanged' | 'restored' | 'indeterminate'

export type ManagedReleaseOutcome =
  | {
      readonly ok: true
      readonly state: 'ready'
      readonly activation: RuntimeActivation
      readonly stableTarget?: ManagedStableReleaseTarget
    }
  | {
      readonly ok: true
      readonly state: 'current'
      readonly stableTarget?: ManagedStableReleaseTarget
    }
  | {
      readonly ok: false
      readonly state: ManagedReleaseFailureState
      readonly detail: string
    }

export interface ManagedHostPreparationContext {
  readonly transactionId: string
  /** Freeze latest once, or revalidate and reuse the target already owned by this journal. */
  resolveStableTarget(
    resolveLatest: () => Promise<ManagedStableReleaseTarget>,
    proveFrozen: (target: ManagedStableReleaseTarget) => void | Promise<void>,
  ): Promise<ManagedStableReleaseTarget>
  /**
   * Executes one retry-safe host command under a durable before/after checkpoint. A completed
   * step returns its persisted result on recovery instead of replaying earlier host mutations.
   */
  runStep(
    id: string,
    step: import('../runtime/managed-host-reconciliation.js').ManagedHostStepExecution,
  ): Promise<string>
}

export interface ManagedReleaseRequest {
  readonly operation: ManagedReleaseOperation
  readonly source: NativeRuntimeHost | 'adapter'
  readonly runtime: RuntimeInstallerScope
  readonly openBrowser: boolean
  /** Frozen release version which must match the candidate before selection changes. */
  readonly expectedPluginVersion?: string
  /** Native update recovery requires a persisted stable target in every post-prepare phase. */
  readonly requiresStableTarget?: boolean
  /**
   * tenon setup --from-source 在事务开始前冻结的源码身份；与 requiresStableTarget 互斥。
   * activate 把它写进 release manifest，assertManagedActivationIdentity 在激活后逐字段比对。
   */
  readonly devSource?: RuntimeDevSource
  /** Resolve the successor release before retiring a legacy transaction that had no frozen target. */
  readonly resolveStableTargetBeforeRecovery?: () =>
    | ManagedStableReleaseTarget
    | Promise<ManagedStableReleaseTarget>
  readonly proveFrozenTarget?: (
    target: ManagedStableReleaseTarget,
  ) => void | Promise<void>
  /** Optional isolated Dashboard port; absence preserves the production default. */
  readonly dashboardPort?: number
  /**
   * Runs under the same cross-process lock as activation and Dashboard commit.
   * Native hosts perform marketplace mutation and authoritative inventory resolution here.
   */
  readonly prepareCandidate: (host: ManagedHostPreparationContext) =>
    | { readonly candidateRoot: string; readonly evidence?: string; readonly openBrowser?: boolean }
    | { readonly candidateRoot: string; readonly evidence?: string; readonly openBrowser?: boolean; readonly currentActivation: RuntimeActivation; readonly currentDashboardExact?: true }
    | { readonly alreadyCurrent: true }
    | Promise<
        | { readonly candidateRoot: string; readonly evidence?: string; readonly openBrowser?: boolean }
        | { readonly candidateRoot: string; readonly evidence?: string; readonly openBrowser?: boolean; readonly currentActivation: RuntimeActivation; readonly currentDashboardExact?: true }
        | { readonly alreadyCurrent: true }
      >
  /**
   * Re-proves a persisted candidate against the current host immediately before activation.
   * Recovery must never trust candidate-resolved inventory evidence after another process could
   * have changed the marketplace ref, checkout, plugin root, or payload.
   */
  readonly revalidateCandidate?: (
    candidate: { readonly candidateRoot: string; readonly evidence?: string },
    context: {
      readonly transactionId: string
      readonly stableTarget?: ManagedStableReleaseTarget
    },
  ) => void | Promise<void>
  /** Dashboard ready 后才提交与 activation 绑定的外部证据。抛错会回滚 runtime 与 Dashboard。 */
  readonly commitReadyEvidence?: (
    activation: RuntimeActivation,
    candidate: { readonly candidateRoot: string; readonly evidence?: string },
    transactionId: string,
    context: {
      readonly stableTarget?: ManagedStableReleaseTarget
    },
  ) => void | Promise<void>
}
