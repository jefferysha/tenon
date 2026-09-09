import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { I18nProvider, useT } from '../i18n'
import {
  DEFAULT_WORKFLOW_RULES,
  makeChange,
  makeProject,
  makeSnapshot,
} from '../testkit'
import type {
  Snapshot,
  WorkflowDecompositionPolicySnapshot,
  WorkflowPolicyRulesSnapshot,
} from '../types'
import { WorkflowPolicyRuntimeSummary } from './WorkflowPolicyRuntimeSummary'

const ROOT = '/tmp/proj-a'
const DECOMPOSITION: WorkflowDecompositionPolicySnapshot = {
  version: 'v1',
  mode: 'require-review',
  target: 'child-pipelines',
  strategy: 'depth-first',
  max_items: 8,
  max_depth: 3,
  auto_when: ['cross-component-boundary'],
  ask_when: ['missing-authorization'],
}
const INTERACTION = { version: 'v1' as const, mode: 'recommended-defaults' as const }

function makePolicy(over: Partial<WorkflowPolicyRulesSnapshot> = {}): WorkflowPolicyRulesSnapshot {
  return {
    schema: 'workflow-policy/v1',
    configured: {
      status: 'available',
      workflowFingerprint: 'a'.repeat(64),
      decomposition: DECOMPOSITION,
      interaction: INTERACTION,
    },
    frozen: {
      workflowFingerprint: 'b'.repeat(64),
      decomposition: DECOMPOSITION,
      interaction: INTERACTION,
      workflowCeiling: {
        status: 'valid',
        grants: ['suggest-decomposition', 'create-branch'],
      },
    },
    effective: {
      status: 'available',
      grants: ['suggest-decomposition', 'create-branch'],
      denials: [{
        action: 'merge-pull-request',
        layer: 'workflow',
        code: 'workflow-ceiling',
        remediation: 'Ask a human reviewer before merging the pull request.',
      }],
    },
    drift: {
      status: 'current',
      fingerprintChanged: false,
      policyChanged: false,
    },
    ...over,
  }
}

function makeRuntimeChange(
  name: string,
  policy: WorkflowPolicyRulesSnapshot | undefined,
  over: Partial<ReturnType<typeof makeChange>> = {},
) {
  const base = makeChange(name, 'build', {
    fields: { workflow: 'release-train' },
    workflowRules: { ...DEFAULT_WORKFLOW_RULES, ...(policy ? { policy } : {}) },
    ...over,
  })
  return base
}

function renderSummary(snapshot: Snapshot | null, workflowName: string | null = 'release-train', root = ROOT): void {
  render(
    <I18nProvider>
      <WorkflowPolicyRuntimeSummary root={root} workflowName={workflowName} snapshot={snapshot} />
    </I18nProvider>,
  )
}

describe('WorkflowPolicyRuntimeSummary', () => {
  it('selects only the exact root/workflow active change and breaks newest ties by name', () => {
    const snapshot = makeSnapshot([
      makeProject('/tmp/other-root', [makeRuntimeChange('cross-root-newer', makePolicy(), { updated_at: '2026-08-08T12:00:00Z' })]),
      makeProject(ROOT, [
        makeRuntimeChange('archived-newer', makePolicy(), { archived: 'true', updated_at: '2026-08-08T11:00:00Z' }),
        makeRuntimeChange('wrong-workflow', makePolicy(), { fields: { workflow: 'other-workflow' }, updated_at: '2026-08-08T10:00:00Z' }),
        makeRuntimeChange('zeta-tie', makePolicy(), { updated_at: '2026-08-08T09:00:00Z' }),
        makeRuntimeChange('alpha-tie', makePolicy(), { updated_at: '2026-08-08T09:00:00Z' }),
        makeRuntimeChange('older', makePolicy(), { updated_at: '2026-08-07T09:00:00Z' }),
      ]),
    ])

    renderSummary(snapshot)

    expect(screen.getByTestId('workflow-policy-runtime-source-change')).toHaveTextContent('alpha-tie')
    expect(screen.getByTestId('workflow-policy-runtime-summary')).not.toHaveTextContent('cross-root-newer')
    expect(screen.getByTestId('workflow-policy-runtime-summary')).not.toHaveTextContent('archived-newer')
    expect(screen.getByTestId('workflow-policy-runtime-summary')).not.toHaveTextContent('wrong-workflow')
  })

  it('renders available current policy details, full fingerprints, modes, grants, and denials', () => {
    const configured = {
      status: 'available' as const,
      workflowFingerprint: 'a'.repeat(64),
      decomposition: { ...DECOMPOSITION, mode: 'suggest' as const },
      interaction: { ...INTERACTION, mode: 'interactive' as const },
    }
    renderSummary(makeSnapshot([makeProject(ROOT, [makeRuntimeChange('runtime-current', makePolicy({ configured }))])] ))

    const summary = screen.getByTestId('workflow-policy-runtime-summary')
    expect(screen.getByTestId('workflow-policy-runtime-configured-status')).toHaveTextContent('可用')
    expect(screen.getByTestId('workflow-policy-runtime-configured-fingerprint')).toHaveTextContent('a'.repeat(64))
    expect(screen.getByTestId('workflow-policy-runtime-configured-decomposition')).toHaveTextContent('仅建议')
    expect(screen.getByTestId('workflow-policy-runtime-configured-decomposition')).toHaveTextContent('(suggest)')
    expect(screen.getByTestId('workflow-policy-runtime-configured-interaction')).toHaveTextContent('逐项互动')
    expect(screen.getByTestId('workflow-policy-runtime-configured-interaction')).toHaveTextContent('(interactive)')
    expect(screen.getByTestId('workflow-policy-runtime-frozen-fingerprint')).toHaveTextContent('b'.repeat(64))
    expect(screen.getByTestId('workflow-policy-runtime-drift-status')).toHaveTextContent('当前')
    expect(screen.getByTestId('workflow-policy-runtime-drift-fingerprint')).toHaveTextContent('否')
    expect(screen.getByTestId('workflow-policy-runtime-drift-policy')).toHaveTextContent('否')
    expect(summary).toHaveTextContent('执行前必须复核')
    expect(summary).toHaveTextContent('推荐默认值')
    expect(within(screen.getByTestId('workflow-policy-runtime-frozen-ceiling')).getByText('suggest-decomposition')).toBeInTheDocument()
    expect(within(screen.getByTestId('workflow-policy-runtime-frozen-ceiling')).getByText('create-branch')).toBeInTheDocument()
    expect(within(screen.getByTestId('workflow-policy-runtime-grants')).getByText('suggest-decomposition')).toBeInTheDocument()
    expect(within(screen.getByTestId('workflow-policy-runtime-denials')).getByText('merge-pull-request')).toBeInTheDocument()
    expect(summary).toHaveTextContent('workflow-ceiling')
    expect(summary).toHaveTextContent('Ask a human reviewer before merging the pull request.')
  })

  it('renders an explicit empty state for the frozen workflow ceiling', () => {
    const base = makePolicy()
    renderSummary(makeSnapshot([makeProject(ROOT, [makeRuntimeChange('runtime-empty-ceiling', makePolicy({
      frozen: {
        ...base.frozen,
        workflowCeiling: { status: 'valid', grants: [] },
      },
    }))])] ))

    expect(screen.getByTestId('workflow-policy-runtime-frozen-ceiling-empty')).toHaveTextContent('冻结权限上限未授予任何动作')
    expect(within(screen.getByTestId('workflow-policy-runtime-frozen-ceiling')).queryByText('suggest-decomposition')).toBeNull()
  })

  it('never labels changed drift as current and preserves both change flags', () => {
    renderSummary(makeSnapshot([makeProject(ROOT, [makeRuntimeChange('runtime-changed', makePolicy({
      drift: { status: 'changed', fingerprintChanged: true, policyChanged: false },
    }))])] ))

    expect(screen.getByTestId('workflow-policy-runtime-drift-status')).toHaveTextContent('已变化')
    expect(screen.getByTestId('workflow-policy-runtime-drift-fingerprint')).toHaveTextContent('是')
    expect(screen.getByTestId('workflow-policy-runtime-drift-policy')).toHaveTextContent('否')
    expect(screen.getByTestId('workflow-policy-runtime-drift-status')).not.toHaveTextContent('当前')
  })

  it.each(['missing', 'invalid', 'unavailable'] as const)('renders configured %s without a configured fingerprint', (status) => {
    renderSummary(makeSnapshot([makeProject(ROOT, [makeRuntimeChange('runtime-configured-state', makePolicy({
      configured: { status },
    }))])] ))

    expect(screen.getByTestId('workflow-policy-runtime-configured-status')).toHaveTextContent(status === 'missing' ? '缺失' : status === 'invalid' ? '无效' : '不可用')
    expect(screen.queryByTestId('workflow-policy-runtime-configured-fingerprint')).toBeNull()
  })

  it('renders policy absent as an explicit rolling-runtime state', () => {
    renderSummary(makeSnapshot([makeProject(ROOT, [makeRuntimeChange('runtime-old-server', undefined)])]))

    expect(screen.getByTestId('workflow-policy-runtime-state')).toHaveTextContent('当前运行时未提供 Workflow 策略快照')
    expect(screen.getByTestId('workflow-policy-runtime-source-change')).toHaveTextContent('runtime-old-server')
  })

  it('renders effective authority unavailable with the exact stable reason', () => {
    renderSummary(makeSnapshot([makeProject(ROOT, [makeRuntimeChange('runtime-no-authority', makePolicy({
      effective: { status: 'unavailable', reason: 'authority-input-unavailable' },
    }))])] ))

    expect(screen.getByTestId('workflow-policy-runtime-effective-state')).toHaveTextContent('不可用')
    expect(screen.getByTestId('workflow-policy-runtime-effective-reason')).toHaveTextContent('authority-input-unavailable')
    expect(screen.getByTestId('workflow-policy-runtime-effective-reason')).toHaveTextContent('授权输入不可用，无法确认有效权限。')
    expect(screen.queryByTestId('workflow-policy-runtime-grants')).toBeNull()
  })

  it('renders honest empty states for missing workflow, snapshot, and active matching Change', () => {
    renderSummary(null, null)
    expect(screen.getByTestId('workflow-policy-runtime-state')).toHaveTextContent('尚未选择 Workflow')

    cleanup()
    renderSummary(null, 'release-train')
    expect(screen.getByTestId('workflow-policy-runtime-state')).toHaveTextContent('当前没有可用的运行时快照')

    cleanup()
    renderSummary(makeSnapshot([makeProject(ROOT, [makeRuntimeChange('archived-only', makePolicy(), { archived: 'true' })])]))
    expect(screen.getByTestId('workflow-policy-runtime-state')).toHaveTextContent('没有匹配的活跃 Change')
  })

  it('keeps all explanatory copy localized in both zh and en', () => {
    function LanguageToggle(): JSX.Element {
      const { setLang } = useT()
      return <><button type="button" onClick={() => setLang('en')}>en</button><button type="button" onClick={() => setLang('zh')}>zh</button></>
    }
    const snapshot = makeSnapshot([makeProject(ROOT, [makeRuntimeChange('runtime-i18n', makePolicy())])])
    render(
      <I18nProvider>
        <LanguageToggle />
        <WorkflowPolicyRuntimeSummary root={ROOT} workflowName="release-train" snapshot={snapshot} />
      </I18nProvider>,
    )

    fireEvent.click(screen.getByRole('button', { name: 'en' }))
    expect(screen.getByTestId('workflow-policy-runtime-summary')).toHaveTextContent('Policy in effect at runtime')
    expect(screen.getByTestId('workflow-policy-runtime-drift-status')).toHaveTextContent('Current')
    expect(screen.getByTestId('workflow-policy-runtime-summary')).toHaveTextContent('Action:')
    expect(screen.getByTestId('workflow-policy-runtime-summary')).not.toHaveTextContent('：')
    fireEvent.click(screen.getByRole('button', { name: 'zh' }))
    expect(screen.getByTestId('workflow-policy-runtime-summary')).toHaveTextContent('策略运行时生效情况')
  })

  it('keeps full fingerprints keyboard-readable and does not expose editing controls', () => {
    renderSummary(makeSnapshot([makeProject(ROOT, [makeRuntimeChange('runtime-readonly', makePolicy())])]))

    const configuredFingerprint = screen.getByTestId('workflow-policy-runtime-configured-fingerprint')
    const frozenFingerprint = screen.getByTestId('workflow-policy-runtime-frozen-fingerprint')
    expect(configuredFingerprint).toHaveAttribute('tabindex', '0')
    expect(frozenFingerprint).toHaveAttribute('tabindex', '0')
    expect(configuredFingerprint).toHaveClass('select-text')
    expect(frozenFingerprint).toHaveClass('select-text')
    expect(screen.queryByRole('button', { name: /保存|Save/ })).toBeNull()
    expect(screen.queryByRole('textbox')).toBeNull()
  })
})
