import { useCallback, useEffect, useRef, useState } from 'react'
import { instructionErrorKey } from '../api/instructionErrorKey'
import {
  applyInstructions, deleteInstruction, fetchInstructions, previewInstructions,
} from '../api/instructionsClient'
import type { AppliedFile, InstructionPreviewFile, InstructionState } from '../api/instructionsDecoders'
import { isAbortError } from '../api/transport'

export interface InstructionFiles {
  readonly loading: boolean
  readonly state: InstructionState | null
  /** 词典键后缀（`projects.errors.<key>`）；null = 无错误。 */
  readonly errorKey: string | null
  /** 磁盘上的某个目标文件已被外部修改，且编辑器有未保存内容。 */
  readonly external: boolean
  readonly busy: boolean
  reload: () => Promise<void>
  dismissExternal: () => void
  preview: (text: string, targets: readonly string[]) => Promise<readonly InstructionPreviewFile[] | null>
  apply: (text: string, files: readonly { id: string; base_digest: string }[]) => Promise<readonly AppliedFile[] | null>
  remove: (target: string, digest: string) => Promise<'removed' | 'managed-kept' | null>
}

const digestsOf = (state: InstructionState | null): Record<string, string> =>
  Object.fromEntries((state?.targets ?? []).map((target) => [target.id, target.digest]))

/**
 * 指令文件数据面：root 变化时读当前级别的全部目标文件；之后只在快照变化（`revision`）或窗口重新聚焦时复查，
 * 应用 / 删除后自己重读。没有定时轮询：停在页面上什么都没变时不发任何请求。
 * 磁盘变了而编辑器干净 → 静默刷新；编辑器有草稿 → 只亮「外部修改」，不覆盖用户正在写的内容。
 */
export function useInstructionFiles(root: string, isDirty: () => boolean, revision = ''): InstructionFiles {
  const [loading, setLoading] = useState(true)
  const [state, setState] = useState<InstructionState | null>(null)
  const [errorKey, setErrorKey] = useState<string | null>(null)
  const [external, setExternal] = useState(false)
  const [busy, setBusy] = useState(false)
  const dirtyRef = useRef(isDirty)
  dirtyRef.current = isDirty
  const digestsRef = useRef<Record<string, string>>({})

  const load = useCallback(async (signal?: AbortSignal): Promise<void> => {
    try {
      const next = await fetchInstructions(root, signal)
      setState(next)
      digestsRef.current = digestsOf(next)
      setExternal(false)
      setErrorKey(null)
    } catch (error) {
      if (!isAbortError(error)) setErrorKey(instructionErrorKey(error))
    }
  }, [root])

  const reload = useCallback(async (): Promise<void> => {
    setLoading(true)
    await load()
    setLoading(false)
  }, [load])

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setExternal(false)
    void load(controller.signal).finally(() => setLoading(false))
    return () => controller.abort()
  }, [load])

  // 复查只比对摘要：干净就静默换成盘上的内容，有草稿就亮提示交给用户决定。
  const check = useCallback(async (): Promise<void> => {
    if (document.visibilityState !== 'visible') return
    try {
      const next = await fetchInstructions(root)
      const changed = next.targets.some((target) => digestsRef.current[target.id] !== target.digest)
      if (!changed) return
      if (dirtyRef.current()) {
        setExternal(true)
        return
      }
      setState(next)
      digestsRef.current = digestsOf(next)
    } catch {
      // 复查失败不打扰用户：下一次快照变化、聚焦或手动重新载入会重试。
    }
  }, [root])

  useEffect(() => {
    const onFocus = (): void => { void check() }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [check])

  // 只在 revision 真的变了才复查；root 变化由上面的首读负责，这里不重复发请求。
  const seenRevision = useRef(revision)
  useEffect(() => {
    if (seenRevision.current === revision) return
    seenRevision.current = revision
    void check()
  }, [revision, check])

  const run = useCallback(async <T>(action: () => Promise<T>): Promise<T | null> => {
    setBusy(true)
    setErrorKey(null)
    try {
      return await action()
    } catch (error) {
      setErrorKey(instructionErrorKey(error))
      if (error instanceof Error && instructionErrorKey(error) === 'instruction_file_changed') setExternal(true)
      return null
    } finally {
      setBusy(false)
    }
  }, [])

  const preview = useCallback((text: string, targets: readonly string[]) =>
    run(() => previewInstructions(root, text, targets)), [root, run])

  const apply = useCallback(async (text: string, files: readonly { id: string; base_digest: string }[]) => {
    const applied = await run(() => applyInstructions(root, text, files))
    if (applied !== null) await load()
    return applied
  }, [load, root, run])

  const remove = useCallback(async (target: string, digest: string) => {
    const result = await run(() => deleteInstruction(root, target, digest))
    if (result !== null) await load()
    return result
  }, [load, root, run])

  return {
    loading, state, errorKey, external, busy, reload,
    dismissExternal: useCallback(() => setExternal(false), []),
    preview, apply, remove,
  }
}
