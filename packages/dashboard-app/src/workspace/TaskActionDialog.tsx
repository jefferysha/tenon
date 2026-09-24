import { useEffect, useId, useState } from 'react'
import { useT } from '../i18n'
import { ApiError, formatApiError } from '../api/transport'
import {
  archiveTask, deleteTask, fetchTaskLifecycle, TaskLifecycleRefusal,
  type TaskLifecycleAction, type TaskReason,
} from '../api/taskLifecycleClient'
import { takeOwner } from '../api/userClient'
import { Dialog } from '../shared/Dialog'
import { BUTTON_GHOST, BUTTON_SOLID, INPUT } from '../shared/uiRecipes'
import { cn } from '@/lib/utils'

export interface TaskActionDialogProps {
  root: string
  change: string
  /** take = 接手（负责人改为当前用户），只需确认，没有服务端原因。 */
  action: TaskLifecycleAction | 'take'
  onClose: () => void
  onDone: (message: string) => void
  /** 接手时服务端报缺用户身份（412）：交给外层打开身份对话框。 */
  onUserMissing?: () => void
}

type Load =
  | { kind: 'loading' }
  | { kind: 'ready'; blockers: readonly TaskReason[]; confirmations: readonly TaskReason[]; recoverable?: boolean | null }
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
export function TaskActionDialog({ root, change, action, onClose, onDone, onUserMissing }: TaskActionDialogProps): JSX.Element {
  const { t } = useT()
  const [load, setLoad] = useState<Load>({ kind: 'loading' })
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const [typed, setTyped] = useState('')
  const typedId = useId()

  useEffect(() => {
    if (action === 'take') {
      setLoad({ kind: 'ready', blockers: [], confirmations: [] })
      return
    }
    const controller = new AbortController()
    setLoad({ kind: 'loading' })
    fetchTaskLifecycle(root, change, action, controller.signal)
      .then((view) => setLoad({
        kind: 'ready', blockers: view.blockers, confirmations: view.confirmations,
        ...(view.recoverable === undefined ? {} : { recoverable: view.recoverable }),
      }))
      .catch((error: unknown) => {
        if (controller.signal.aborted) return
        setLoad({ kind: 'error', text: formatApiError(error, t, { exposeServerDetail: true }) })
      })
    return () => controller.abort()
  }, [root, change, action, t])

  const reasons = load.kind === 'ready' ? [...load.blockers, ...load.confirmations] : []
  // 删除一个 git 找不回的目录（或探测失败）= 不可恢复：危险色说明 + 输入任务名才能确认。
  const unrecoverable = action === 'delete' && load.kind === 'ready' && load.recoverable !== true
  const blocked = load.kind !== 'ready' || load.blockers.length > 0 || (unrecoverable && typed !== change)
  const danger = action === 'delete'

  async function apply(): Promise<void> {
    if (load.kind !== 'ready') return
    const acknowledged = load.confirmations.map((reason) => reason.code)
    setBusy(true)
    setFailure(null)
    try {
      if (action === 'take') {
        await takeOwner(root, change)
        onDone(t('workspace.take_done'))
        onClose()
        return
      }
      if (action === 'delete') await deleteTask({ root, change, acknowledged })
      else await archiveTask({ root, change, acknowledged })
      onDone(t(action === 'delete' ? 'workspace.done_deleted' : 'workspace.done_archived', { name: change }))
      onClose()
    } catch (error) {
      if (action === 'take' && error instanceof ApiError && error.status === 412 && onUserMissing !== undefined) {
        onClose()
        onUserMissing()
        return
      }
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
      title={t(`workspace.dialog_${action}_title`, { name: change })}
      onClose={onClose}
      testid="task-action-dialog"
      role="alertdialog"
      actions={(
        <>
          <button
            type="button"
            className={BUTTON_GHOST}
            data-testid="task-action-cancel"
            disabled={busy}
            onClick={onClose}
          >
            {t('workspace.cancel')}
          </button>
          <button
            type="button"
            className={danger ? cn(BUTTON_SOLID, 'bg-red-d text-solid-fg enabled:hover:bg-red') : BUTTON_SOLID}
            data-testid="task-action-confirm"
            disabled={blocked || busy}
            onClick={() => { void apply() }}
          >
            {t(action === 'take' ? 'workspace.take_owner' : `workspace.${action}`)}
          </button>
        </>
      )}
    >
      {unrecoverable ? (
        <p className="mb-3 text-body font-semibold text-red-d" role="alert" data-testid="task-action-unrecoverable">
          {t('workspace.dialog_delete_unrecoverable')}
        </p>
      ) : (
        <p className="mb-3 text-body text-text-2" data-testid="task-action-effect">
          {t(`workspace.dialog_${action}_effect`)}
        </p>
      )}
      {unrecoverable && (
        <label className="mb-3 grid gap-1.5 text-caption font-semibold text-text-2" htmlFor={typedId}>
          <span className="whitespace-nowrap">{t('workspace.dialog_delete_type_name', { name: change })}</span>
          <input
            id={typedId}
            className={INPUT}
            value={typed}
            autoComplete="off"
            spellCheck={false}
            data-testid="task-action-type-name"
            onChange={(event) => setTyped(event.target.value)}
          />
        </label>
      )}
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
