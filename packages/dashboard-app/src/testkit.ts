/** 测试工厂（非 *.test.*，不被收集）——构造 server 契约形状的 snapshot/change 供真组件测试喂数据。 */
import type {
  ChangeSnapshot, ProjectSnapshot, Snapshot, TransitionReadinessSnapshot, WorkflowRulesSnapshot,
} from './types'

export const DEFAULT_WORKFLOW_FINGERPRINT = '0'.repeat(64)
export const CUSTOM_WORKFLOW_FINGERPRINT = '1'.repeat(64)
export const DEFAULT_WORKFLOW_RULES: WorkflowRulesSnapshot = {
  executionModel: 'phase-manifest',
  steps: ['open', 'explore', 'spec', 'build', 'verify', 'ship', 'archive'],
  transitions: {
    open: [{ event: 'open-complete', to: 'explore' }],
    explore: [{ event: 'explore-complete', to: 'spec' }],
    spec: [{ event: 'spec-complete', to: 'build' }],
    build: [{ event: 'build-complete', to: 'verify' }, { event: 'requirements-changed', to: 'spec' }],
    verify: [{ event: 'verify-pass', to: 'ship' }, { event: 'verify-fail', to: 'build' }],
    ship: [{ event: 'ship-complete', to: 'archive' }],
    archive: [],
  },
  gateByStep: { open: null, explore: 'review', spec: 'review', build: null, verify: 'review', ship: null, archive: null },
  labelByStep: {
    open: '立项',
    explore: '调研',
    spec: '规格',
    build: '实现',
    verify: '验证',
    ship: '交付',
    archive: '归档',
  },
  outputsByStep: { open: [], explore: [], spec: [], build: [], verify: [], ship: [], archive: [] },
}
const ready: TransitionReadinessSnapshot = { ready: true, blockers: [] }
const missing = (field: string) => ({
  ready: false,
  blockers: [{ kind: 'guard-failed' as const, guardType: 'field-nonempty', field, actual: '' }],
})

function defaultWorkflowExecution(fields: ChangeSnapshot['fields'], track: string) {
  const value = (field: string): string => typeof fields[field] === 'string' ? fields[field] : ''
  const present = (field: string): boolean => value(field) !== '' && value(field) !== 'null'
  return {
    readinessByTransition: {
      open: { 'open-complete': ready },
      explore: { 'explore-complete': present('design_doc') ? ready : missing('design_doc') },
      spec: { 'spec-complete': track === 'pm' || track === 'free' || present('plan') ? ready : missing('plan') },
      build: {
        'build-complete': present('build_mode') && present('isolation')
          ? ready
          : missing(present('build_mode') ? 'isolation' : 'build_mode'),
        'requirements-changed': ready,
      },
      verify: {
        'verify-pass': present('verification_report') ? ready : missing('verification_report'),
        'verify-fail': ready,
      },
      ship: {
        'ship-complete': {
          ready: false,
          blockers: [{
            kind: 'guard-failed' as const,
            guardType: 'spec-migration-applied',
            actual: 'not-projected-in-test-fixture',
          }],
        },
      },
      archive: {},
    },
  }
}

export function makeChange(name: string, phase: string, over: Partial<ChangeSnapshot> = {}): ChangeSnapshot {
  const customWorkflow = typeof over.fields?.workflow === 'string' && over.fields.workflow !== ''
  const fields = over.fields ?? {}
  const track = over.track ?? 'backend'
  return {
    name,
    path: `/repo/openspec/changes/${name}`,
    phase,
    phase_status: 'in_progress',
    track,
    preset: 'full',
    archived: 'false',
    updated_at: '2026-07-07T00:00:00Z',
    fields,
    workflowPlanFingerprint: customWorkflow ? CUSTOM_WORKFLOW_FINGERPRINT : DEFAULT_WORKFLOW_FINGERPRINT,
    workflowRules: DEFAULT_WORKFLOW_RULES,
    workflowExecution: defaultWorkflowExecution(fields, track),
    owner: null,
    creator: null,
    ...over,
  }
}

export function makeProject(root: string, changes: ChangeSnapshot[], over: Partial<ProjectSnapshot> = {}): ProjectSnapshot {
  return { root, ok: true, changes, ...over }
}

export function makeSnapshot(projects: ProjectSnapshot[], over: Partial<Snapshot> = {}): Snapshot {
  const change_count = projects.reduce((n, p) => n + p.changes.length, 0)
  return {
    version: '0.1.0',
    generated_at: '2026-07-07T00:00:00Z',
    capabilities: { snapshot: true, health: true, stream: true, transition: true },
    project_count: projects.length,
    change_count,
    projects,
    ...over,
  }
}
