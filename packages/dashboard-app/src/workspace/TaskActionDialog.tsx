import { useEffect, useState } from 'react'
import { useT } from '../i18n'
import { formatApiError } from '../api/transport'
import {
  archiveTask, deleteTask, fetchTaskLifecycle, TaskLifecycleRefusal,
  type TaskLifecycleAction, type TaskReason,
} from '../api/taskLifecycleClient'
import { Dialog } from '../shared/Dialog'
import { cn } from '@/lib/utils'

export interface TaskActionDialogProps {
  root: string
  change: string
  action: TaskLifecycleAction
  onClose: () => void
  onDone: (message: string) => void
}

type Load =
  | { kind: 'loading' }
  | { kind: 'ready'; blockers: readonly TaskReason[]; confirmations: readonly TaskReason[] }
  | { kind: 'error'; text: string }

function reasonText(reason: TaskReason, t: (key: string) => string): string {
  const label = t(`workspace.reason_${reason.code.replace(/-/gu, '_')}`)
  return reason.detail === undefined ? label : `${label} ${reason.detail}`
}

/**
 * 删除 / 归档 confirmation. The reasons always come from the server; the confirm button echoes back exactly
 * the codes shown here, and the server re-checks them under the lock — a 409 refreshes this list instead of
 * acting on a stale one. A blocker cannot be acknowledged at all.
 */
export function TaskActionDialog({ root, change, action, onClose, onDone }: TaskActionDialogProps): JSX.Element {
  const { t } = useT()
  const [load, setLoad] = useState<Load>({ kind: 'loading' })
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    setLoad({ kind: 'loading' })
    fetchTaskLifecycle(root, change, action, controller.signal)
      .then((view) => setLoad({ kind: 'ready', blockers: view.blockers, confirmations: view.confirmations }))
      .catch((error: unknown) => {
        if (controller.signal.aborted) return
        setLoad({ kind: 'error', text: formatApiError(error, t, { exposeServerDetail: true }) })
      })
    return () => controller.abort()
  }, [root, change, action, t])

  const reasons = load.kind === 'ready' ? [...load.blockers, ...load.confirmations] : []
  const blocked = load.kind !== 'ready' || load.blockers.length > 0

  async function apply(): Promise<void> {
    if (load.kind !== 'ready') return
    const acknowledged = load.confirmations.map((reason) => reason.code)
    setBusy(true)
    setFailure(null)
    try {
      if (action === 'delete') await deleteTask({ root, change, acknowledged })
      else await archiveTask({ root, change, acknowledged })
      onDone(t(action === 'delete' ? 'workspace.done_deleted' : 'workspace.done_archived', { name: change }))
      onClose()
    } catch (error) {
      // A refusal carries the reasons the server just re-checked; show those instead of the stale list.
      if (error instanceof TaskLifecycleRefusal) {
        const fresh = error.code === 'task-blocked'
          ? { kind: 'ready' as const, blockers: error.reasons, confirmations: [] }
          : { kind: 'ready' as const, blockers: [], confirmations: error.reasons }
        setLoad(fresh)
      }
      setFailure(formatApiError(error, t, { exposeServerDetail: true }))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      title={t(action === 'delete' ? 'workspace.dialog_delete_title' : 'workspace.dialog_archive_title', { name: change })}
      onClose={onClose}
      testid="task-action-dialog"
      closeLabel={t('workspace.cancel')}
      closeDisabled={busy}
      actions={(
        <>
          <button
            type="button"
            className="min-h-10 rounded-md border border-border bg-card px-4 text-base font-semibold text-text hover:border-text-3 disabled:opacity-60"
            data-testid="task-action-cancel"
            disabled={busy}
            onClick={onClose}
          >
            {t('workspace.cancel')}
          </button>
          <button
            type="button"
            className={cn(
              'min-h-10 rounded-md px-4 text-base font-semibold text-white disabled:opacity-60',
              action === 'delete' ? 'bg-red-d hover:opacity-90' : 'bg-(--accent) hover:opacity-90',
            )}
            data-testid="task-action-confirm"
            disabled={blocked || busy}
            onClick={() => { void apply() }}
          >
            {t(action === 'delete' ? 'workspace.delete' : 'workspace.archive')}
          </button>
        </>
      )}
    >
      <p className="mb-3 text-body text-text-2" data-testid="task-action-effect">
        {t(action === 'delete' ? 'workspace.dialog_delete_effect' : 'workspace.dialog_archive_effect')}
      </p>
      {load.kind === 'error' && (
        <p className="text-body text-red-d" role="alert" data-testid="task-action-error">{load.text}</p>
      )}
      {reasons.length > 0 && (
        <ul className="grid gap-1.5" data-testid="task-action-reasons">
          {reasons.map((reason) => (
            <li
              key={reason.code}
              className={cn(
                'whitespace-nowrap rounded-sm px-2 py-1 text-body',
                load.kind === 'ready' && load.blockers.includes(reason) ? 'bg-red-t text-red-d' : 'bg-fill text-text-2',
              )}
              data-testid={`task-action-reason-${reason.code}`}
            >
              {reasonText(reason, t)}
            </li>
          ))}
        </ul>
      )}
      {failure !== null && (
        <p className="mt-3 text-body text-red-d" role="alert" data-testid="task-action-failure">{failure}</p>
      )}
    </Dialog>
  )
}
