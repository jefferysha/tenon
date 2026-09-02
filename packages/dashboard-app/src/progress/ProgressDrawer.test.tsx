import { createRef, type ReactNode } from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '../i18n'
import { DEFAULT_WORKFLOW_RULES, makeChange } from '../testkit'
import { toFlatRow } from './progressViewModel'
import { ProgressDrawer } from './ProgressDrawer'

vi.mock('../shared/TaskDetail', () => ({
  TaskDetail: ({
    surface,
    curStageExtra,
    documentsExtra,
  }: {
    surface?: string
    curStageExtra?: ReactNode
    documentsExtra?: ReactNode
  }) => (
    <>
      <section data-testid={`task-detail-surface-${surface ?? 'all'}`}>
        {surface === 'outputs' && <>
          <section data-testid="current-stage-extra">{curStageExtra}</section>
          <section data-testid="documents-extra">{documentsExtra}</section>
        </>}
      </section>
    </>
  ),
}))

vi.mock('./ContextBundlePreview', () => ({
  ContextBundlePreview: () => <div data-testid="context-bundle-preview" />,
}))

vi.mock('../verification/VerificationEvidenceComposer', () => ({
  VerificationEvidenceComposer: () => <div data-testid="verification-evidence-composer" />,
}))

function renderDrawer(phase: string): void {
  const change = makeChange('integration-demo', phase)
  const row = toFlatRow(
    { root: '/repo', change, state: 'agent' },
    DEFAULT_WORKFLOW_RULES,
    'default',
  )

  render(
    <I18nProvider>
      <ProgressDrawer
        row={row}
        drawerRef={createRef<HTMLElement>()}
        scrimRef={createRef<HTMLDivElement>()}
        badge={null}
        onClose={vi.fn()}
      />
    </I18nProvider>,
  )
}

describe('ProgressDrawer integration surfaces', () => {
  it('opens on a compact overview and defers heavy evidence until Outputs', async () => {
    renderDrawer('verify')

    expect(screen.getByTestId('progress-sheet-tab-summary')).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByTestId('task-detail-surface-summary')).toBeInTheDocument()
    expect(screen.queryByTestId('context-bundle-preview')).not.toBeInTheDocument()
    expect(screen.queryByTestId('verification-evidence-composer')).not.toBeInTheDocument()

    screen.getByTestId('progress-sheet-tab-outputs').click()
    await waitFor(() => expect(screen.getByTestId('progress-sheet-tab-outputs')).toHaveAttribute('aria-selected', 'true'))
    expect(screen.getByTestId('current-stage-extra')).toContainElement(screen.getByTestId('context-bundle-preview'))
    expect(screen.getByTestId('documents-extra')).toContainElement(screen.getByTestId('verification-evidence-composer'))
  })

  it('keeps the evidence composer scoped to Verify Outputs and explains the terminal boundary', async () => {
    renderDrawer('build')

    screen.getByTestId('progress-sheet-tab-outputs').click()
    await waitFor(() => expect(screen.getByTestId('context-bundle-preview')).toBeInTheDocument())
    expect(screen.queryByTestId('verification-evidence-composer')).not.toBeInTheDocument()
    screen.getByTestId('progress-sheet-tab-terminal').click()
    await waitFor(() => expect(screen.getByTestId('progress-terminal-boundary')).toBeInTheDocument())
    expect(screen.getByTestId('progress-terminal-boundary')).toBeInTheDocument()
    expect(screen.queryByTestId('task-detail-surface-outputs')).not.toBeInTheDocument()
  })
})
