import { useState, type MutableRefObject } from 'react'
import { isDefaultWorkflowName, isTemplateWorkflowName } from '@tenon/kernel/workflow/identifier'
import { deleteWorkflowDef } from '../api/client'
import type { WbWorkflowSource } from '../api/governanceTypes'
import { formatApiError } from '../api/transport'
import { readWorkflowDeleteResponse, splitWorkflowReferences } from './workbenchApiDecoders'
import type { EditorGenerations, WorkflowDeleteError } from './workflowEditorTypes'

type Locale = { t: (key: string, vars?: Record<string, string | number>) => string; lang: string }

export interface WorkflowDeleteContext {
  root: string
  wfName: string | null
  saving: boolean
  canWrite: boolean
  defaultSource: WbWorkflowSource
  generation: MutableRefObject<EditorGenerations>
  rootIdentity: MutableRefObject<string>
  localeRef: MutableRefObject<Locale>
  onDeleted: MutableRefObject<((name: string, restored: boolean) => void) | undefined>
  afterWrite: (root: string, name: string) => void
  setDefaultSource: (source: WbWorkflowSource) => void
  removeName: (name: string) => void
  switchTo: (name: string) => void
  reload: () => void
}

export interface WorkflowDelete {
  target: { root: string; name: string } | null
  busy: boolean
  error: WorkflowDeleteError | null
  open: () => void
  close: () => void
  confirm: () => Promise<void>
  /** root 切换：确认框与错误清空。 */
  reset: () => void
  clearError: () => void
}

/** 删除工作流；default 与模板是「恢复内建」（项目或全局覆盖存在时才可用）。被任务等引用时拒绝并逐个列出。 */
export function useWorkflowDelete(ctx: WorkflowDeleteContext): WorkflowDelete {
  const { root, wfName, saving, canWrite, defaultSource, generation, rootIdentity, localeRef } = ctx
  const [target, setTarget] = useState<{ root: string; name: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<WorkflowDeleteError | null>(null)

  function open(): void {
    if (saving || !wfName || !canWrite) return
    if (isDefaultWorkflowName(wfName) && defaultSource === 'builtin') return
    setError(null)
    setTarget({ root, name: wfName })
  }
  function close(): void {
    if (busy) return
    setTarget(null)
    setError(null)
  }
  async function confirm(): Promise<void> {
    const pending = target
    if (!pending || pending.root !== root || pending.name !== wfName || busy) { setTarget(null); return }
    const deleting = pending.name
    const targetRoot = pending.root
    const current = ++generation.current.delete
    const stillCurrent = (): boolean => current === generation.current.delete && rootIdentity.current === targetRoot
    setBusy(true)
    setError(null)
    try {
      const response = await deleteWorkflowDef(deleting, targetRoot)
      const outcome = await readWorkflowDeleteResponse(response)
      if (!stillCurrent()) return
      if (outcome.kind !== 'success') {
        const locale = localeRef.current
        const body = outcome.kind === 'error' ? outcome.body : null
        setError({
          summary: outcome.kind === 'invalid'
            ? locale.t('common.invalid_response')
            : body?.code === 'WORKFLOW_REFERENCED'
              ? locale.t('workbench.workflow_delete_referenced')
              : (locale.lang === 'zh' ? body?.error : undefined) ?? locale.t('workbench.workflow_delete_failed', { status: response.status }),
          ...splitWorkflowReferences(body?.references ?? []),
          blockers: body?.blockers ?? [],
        })
        return
      }
      ctx.afterWrite(targetRoot, deleting)
      setTarget(null)
      setError(null)
      ctx.onDeleted.current?.(deleting, isTemplateWorkflowName(deleting))
      if (isTemplateWorkflowName(deleting)) {
        if (isDefaultWorkflowName(deleting)) ctx.setDefaultSource('builtin')
        ctx.switchTo(deleting)
        // wfName 没变，定义 effect 不会自己重跑；推 nonce 把内建模板重新拉回来。
        ctx.reload()
        return
      }
      ctx.removeName(deleting)
      ctx.switchTo('default')
      ctx.reload()
    } catch (failure) {
      if (stillCurrent()) setError({ summary: formatApiError(failure, localeRef.current.t), tasks: [], references: [], blockers: [] })
    } finally {
      if (stillCurrent()) setBusy(false)
    }
  }

  return {
    target,
    busy,
    error,
    open,
    close,
    confirm,
    reset: () => { setTarget(null); setBusy(false); setError(null) },
    clearError: () => setError(null),
  }
}
