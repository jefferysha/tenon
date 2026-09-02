import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { useT } from '../i18n'
import { TaskDetail, type TaskDetailSurface } from '../shared/TaskDetail'
import { VerificationEvidenceComposer } from '../verification/VerificationEvidenceComposer'
import { TaskPlanEvidenceSection } from './TaskPlanEvidenceSection'
import { fieldStr, type FlatRow } from './progressViewModel'
import { ContextBundlePreview } from './ContextBundlePreview'
import { ReviewHandshakeStatus } from './ReviewHandshakeStatus'
import { RunLogPane } from './RunLogPane'

export interface ProgressDrawerProps {
  row: FlatRow
  drawerRef: RefObject<HTMLElement>
  scrimRef: RefObject<HTMLDivElement>
  badge: ReactNode
  actions?: ReactNode
  onClose: () => void
  onToast?: (message: string) => void
}

export function ProgressDrawer({
  row,
  drawerRef,
  scrimRef,
  badge,
  actions,
  onClose,
  onToast,
}: ProgressDrawerProps): JSX.Element {
  const { lang, t } = useT()
  const [surface, setSurface] = useState<Exclude<TaskDetailSurface, 'all'>>('summary')
  const rowIdentity = `${row.row.root}\u0000${row.row.change.name}`
  const rowIdentityRef = useRef(rowIdentity)
  useEffect(() => {
    if (rowIdentityRef.current === rowIdentity) return
    rowIdentityRef.current = rowIdentity
    setSurface('summary')
  }, [rowIdentity])
  const tabs: Array<{ id: Exclude<TaskDetailSurface, 'all'>; label: string }> = [
    { id: 'summary', label: t('navigation.sheet_summary') },
    { id: 'outputs', label: t('navigation.sheet_outputs') },
    { id: 'terminal', label: t('navigation.sheet_terminal') },
    { id: 'history', label: t('navigation.sheet_history') },
  ]
  return (
    <>
      <div className="fixed inset-0 z-40 bg-scrim" data-testid="prg9-scrim" ref={scrimRef} onClick={onClose} />
      <aside
        className="fixed top-0 right-0 bottom-0 z-50 flex w-[560px] max-w-[94vw] flex-col border-l border-border-2 bg-card shadow-lg"
        data-anim="prg-drawer"
        role="dialog"
        aria-modal="true"
        aria-label={row.row.change.name}
        data-testid="prg9-drawer"
        ref={drawerRef}
      >
        <div
          className="min-h-0 flex-1 overflow-y-auto p-4"
          role="tabpanel"
          id="progress-sheet-panel"
          aria-labelledby={`progress-sheet-tab-${surface}`}
          data-testid="progress-sheet-panel"
        >
          <TaskDetail
            root={row.row.root}
            change={row.row.change}
            rules={row.rules}
            badge={badge}
            actions={actions}
            evidenceExtra={<TaskPlanEvidenceSection root={row.row.root} change={row.row.change.name} />}
            curStageExtra={(
              <>
                <ReviewHandshakeStatus change={row.row.change} />
                <ContextBundlePreview
                  key={`${row.row.root}\u0000${row.row.change.name}\u0000${row.row.change.phase}`}
                  root={row.row.root}
                  change={row.row.change.name}
                  currentPhase={row.row.change.phase}
                />
              </>
            )}
            collapseTechnical
            documentsExtra={row.row.change.phase === 'verify'
              ? (
                  <VerificationEvidenceComposer
                    locale={lang === 'zh' ? 'zh-CN' : 'en'}
                    onToast={onToast}
                    root={row.row.root}
                  />
                )
              : undefined}
            onClose={onClose}
            onToast={onToast}
            surface={surface}
          />
          {surface === 'terminal' && (
            <p className="prg-terminal-boundary" data-testid="progress-terminal-boundary">{t('navigation.terminal_boundary')}</p>
          )}
          {surface === 'terminal' && row.row.state === 'running' && fieldStr(row.row.change, 'automation') === 'running' && (
            <RunLogPane root={row.row.root} change={row.row.change} />
          )}
        </div>
        <div className="prg-sheet-tabs border-b border-border px-4 pt-3" role="tablist" aria-label={t('progress.title')}>
          {tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={surface === tab.id}
              aria-controls="progress-sheet-panel"
              id={`progress-sheet-tab-${tab.id}`}
              data-testid={`progress-sheet-tab-${tab.id}`}
              className="prg-sheet-tab"
              onClick={() => setSurface(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </aside>
    </>
  )
}
