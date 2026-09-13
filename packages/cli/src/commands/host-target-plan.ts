import type { CliDeps } from '../deps.js'
import {
  nativeHostConvergenceSequence,
  type NativeHostUpdateStepId,
} from './native-host-convergence-sequence.js'
import {
  TENON_HOSTS,
  TENON_RELEASE_VERSION,
  hostFlag,
  isNativePipelineHost,
  nativeUpdatePlan,
  type HostCommandPlanItem,
  type NativePipelineHost,
  type PipelineHost,
} from './plugin-host.js'

export const HOST_TARGET_PLAN_SCHEMA_VERSION = 'host-target-plan/v1' as const

export type HostTargetOperation = 'setup' | 'update'
export type HostTargetCapability =
  | 'native-marketplace'
  | 'project-adapter'
  | 'managed-runtime'
  | 'bundled-skills'
  | 'automatic-update'

export interface HostTarget {
  readonly id: PipelineHost
  readonly kind: 'native' | 'adapter'
  readonly cli_flag: `--${PipelineHost}`
  readonly target_scope: 'user' | 'project'
  readonly supported_operations: readonly ['setup', 'update']
  readonly capabilities: readonly HostTargetCapability[]
}

export interface HostTargetCatalog {
  readonly schema_version: typeof HOST_TARGET_PLAN_SCHEMA_VERSION
  readonly targets: readonly HostTarget[]
}

export interface HostPlanCommand {
  readonly executable: string
  readonly args: readonly string[]
  readonly display: string
}

export interface HostTargetPlanStep {
  readonly id: string
  readonly label: string
  readonly command: HostPlanCommand | null
  /**
   * Present only when execution depends on host state this read-only plan never observed; absence
   * means the step runs on every execution of the previewed command.
   */
  readonly condition?: string
}

export interface HostTargetPlan {
  readonly schema_version: typeof HOST_TARGET_PLAN_SCHEMA_VERSION
  readonly side_effects: 'none'
  readonly host: HostTarget
  readonly operation: HostTargetOperation
  readonly command: HostPlanCommand
  readonly steps: readonly HostTargetPlanStep[]
  readonly notices: readonly string[]
}

export interface HostTargetPlanOpts {
  readonly host?: string
  readonly operation?: string
  readonly json?: boolean
}

const PRODUCT_STEPS = [
  { id: 'managed-runtime', label: 'host-plan.step.managed-runtime', command: null },
  { id: 'dashboard-readiness', label: 'host-plan.step.dashboard-readiness', command: null },
  { id: 'bundled-skills', label: 'host-plan.step.bundled-skills', command: null },
  { id: 'runtime-readiness', label: 'host-plan.step.runtime-readiness', command: null },
] as const satisfies readonly HostTargetPlanStep[]

const SETUP_RELEASE_TARGET_STEP = {
  id: 'stable-release-target',
  label: 'host-plan.step.stable-release-target',
  command: null,
} as const satisfies HostTargetPlanStep

const UPDATE_RELEASE_RESOLVER_STEP = {
  id: 'stable-release-resolve',
  label: 'host-plan.step.stable-release-resolve',
  command: null,
} as const satisfies HostTargetPlanStep

const CANDIDATE_VALIDATION_STEP = {
  id: 'candidate-validation',
  label: 'host-plan.step.candidate-validation',
  command: null,
} as const satisfies HostTargetPlanStep

const CODEX_AUTH_STATUS_STEP = {
  id: 'codex-auth-status',
  label: 'host-plan.step.codex-auth-status',
  command: {
    executable: 'codex',
    args: ['login', 'status'],
    display: 'codex login status',
  },
} as const satisfies HostTargetPlanStep

/**
 * Published step ids for the shared convergence sequence.  The sequence itself is derived by
 * `nativeHostConvergenceSequence`, so a new or reordered host command reaches the preview through
 * this map instead of a second hand-maintained list; only the wire name of the final inventory step
 * differs, because `host-target-plan/v1` already publishes it as `plugin-inventory`.
 */
const PUBLISHED_STEP_IDS: Record<NativeHostUpdateStepId, string> = {
  'plugin-remove': 'plugin-remove',
  'marketplace-remove': 'marketplace-remove',
  'marketplace-register': 'marketplace-register',
  'plugin-install': 'plugin-install',
  'inventory-after': 'plugin-inventory',
}

function command(executable: string, args: readonly string[]): HostPlanCommand {
  return {
    executable,
    args: [...args],
    display: [executable, ...args].join(' '),
  }
}

function targetFor(host: PipelineHost): HostTarget {
  if (isNativePipelineHost(host)) {
    return {
      id: host,
      kind: 'native',
      cli_flag: hostFlag(host),
      target_scope: 'user',
      supported_operations: ['setup', 'update'],
      capabilities: [
        'native-marketplace',
        'managed-runtime',
        'bundled-skills',
        'automatic-update',
      ],
    }
  }
  return {
    id: host,
    kind: 'adapter',
    cli_flag: hostFlag(host),
    target_scope: 'project',
    supported_operations: ['setup', 'update'],
    capabilities: ['project-adapter', 'managed-runtime', 'bundled-skills'],
  }
}

export function createHostTargetCatalog(): HostTargetCatalog {
  return {
    schema_version: HOST_TARGET_PLAN_SCHEMA_VERSION,
    targets: TENON_HOSTS.map(targetFor),
  }
}

/**
 * Generating a plan never reads host state, so the registration is `unknown`: removals stay visible
 * as conditional steps rather than being promised.  Setup drops `plugin-remove` entirely on a host
 * without a registered tenon plugin, and the managed runner proves-and-skips a marketplace removal
 * whose absence already holds, so promising either here would describe an execution that will not
 * happen.
 */
function hostCommandSteps(
  plan: readonly HostCommandPlanItem[],
): readonly HostTargetPlanStep[] {
  return nativeHostConvergenceSequence(plan, { plugin: 'unknown' }).map((step) => {
    const id = PUBLISHED_STEP_IDS[step.id]
    return {
      id,
      label: `host-plan.step.${id}`,
      command: command(step.item.cmd, step.item.args),
      ...(step.conditional ? { condition: `host-plan.condition.${id}` } : {}),
    }
  })
}

function nativeSteps(
  host: NativePipelineHost,
  operation: HostTargetOperation,
  plan: readonly HostCommandPlanItem[],
): readonly HostTargetPlanStep[] {
  return [
    operation === 'setup' ? SETUP_RELEASE_TARGET_STEP : UPDATE_RELEASE_RESOLVER_STEP,
    ...hostCommandSteps(plan),
    CANDIDATE_VALIDATION_STEP,
    PRODUCT_STEPS[0],
    PRODUCT_STEPS[1],
    ...(host === 'codex' ? [CODEX_AUTH_STATUS_STEP] : []),
    ...(operation === 'setup' ? PRODUCT_STEPS.slice(2) : []),
  ]
}

function adapterSteps(
  operation: HostTargetOperation,
  manualCommand: HostPlanCommand,
): readonly HostTargetPlanStep[] {
  const deploymentSteps: readonly HostTargetPlanStep[] = [
    { id: 'package-assets', label: 'host-plan.step.package-assets', command: null },
    PRODUCT_STEPS[0],
    PRODUCT_STEPS[1],
    { id: 'adapter-deploy', label: 'host-plan.step.adapter-deploy', command: manualCommand },
  ]
  return operation === 'setup'
    ? [...deploymentSteps, ...PRODUCT_STEPS.slice(2)]
    : deploymentSteps
}

export function createHostTargetPlan(
  host: PipelineHost,
  operation: HostTargetOperation,
): HostTargetPlan {
  const target = targetFor(host)
  const args = isNativePipelineHost(host)
    ? [operation, hostFlag(host)]
    : [operation, hostFlag(host), '--target', '.']
  const manualCommand = command('tenon', args)
  const steps = isNativePipelineHost(host)
    ? nativeSteps(
        host,
        operation,
        operation === 'setup'
          ? nativeUpdatePlan(host, {
              version: TENON_RELEASE_VERSION,
              tag: `v${TENON_RELEASE_VERSION}`,
              commit: '0'.repeat(40),
            })
          : nativeUpdatePlan(
              host,
              { version: '<latest-stable>', tag: '<latest-stable>', commit: '0'.repeat(40) },
            ),
      )
    : adapterSteps(operation, manualCommand)
  return {
    schema_version: HOST_TARGET_PLAN_SCHEMA_VERSION,
    side_effects: 'none',
    host: target,
    operation,
    command: manualCommand,
    steps,
    notices: [
      'host-plan.notice.read-only-generation',
      'host-plan.notice.manual-command-has-effects',
      'host-plan.notice.dashboard-readiness',
      ...(operation === 'setup'
        ? [
            'host-plan.notice.first-setup-browser',
            ...(isNativePipelineHost(host)
              ? ['host-plan.notice.setup-rebind-conditional']
              : []),
          ]
        : []),
      ...(isNativePipelineHost(host) && operation === 'update'
        ? ['host-plan.notice.update-target-frozen-at-execution']
        : []),
      ...(host === 'codex' ? ['host-plan.notice.codex-auth-guidance'] : []),
      ...(isNativePipelineHost(host) ? [] : ['host-plan.notice.current-project-target']),
    ],
  }
}

function isPipelineHost(value: string): value is PipelineHost {
  return (TENON_HOSTS as readonly string[]).includes(value)
}

function isHostTargetOperation(value: string): value is HostTargetOperation {
  return value === 'setup' || value === 'update'
}

/** Render a deterministic DTO only; this command never enters setup/update or reads process state. */
export function cmdHostTargetPlan(
  deps: Pick<CliDeps, 'io'>,
  opts: HostTargetPlanOpts,
): number {
  if (opts.json !== true) {
    deps.io.err('ERROR: host-target-plan 是机器可读只读契约，必须指定 --json。')
    return 1
  }
  if (opts.host === undefined && opts.operation === undefined) {
    deps.io.out(JSON.stringify(createHostTargetCatalog()))
    return 0
  }
  if (opts.host === undefined || opts.operation === undefined) {
    deps.io.err('ERROR: 单目标计划必须同时指定 --host 与 --operation。')
    return 1
  }
  if (!isPipelineHost(opts.host)) {
    deps.io.err(`ERROR: 未知宿主；仅支持 ${TENON_HOSTS.join(', ')}。`)
    return 1
  }
  if (!isHostTargetOperation(opts.operation)) {
    deps.io.err('ERROR: 未知操作；仅支持 setup, update。')
    return 1
  }
  deps.io.out(JSON.stringify(createHostTargetPlan(opts.host, opts.operation)))
  return 0
}
