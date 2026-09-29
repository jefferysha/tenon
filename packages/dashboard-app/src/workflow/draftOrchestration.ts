/**
 * 工作流页画的是编辑中的草稿：编排直接调 kernel 的 orchestrate（与服务端 buildOrchestration 同一个实现），
 * 只有 manifest 叠加层（机器级技能矩阵）要问服务端。叠加层只取决于工作流、轨道与机器 manifest，与草稿内容
 * 无关，按 (root, 工作流, 轨道) 缓存一份。
 */
import { useEffect, useMemo, useState } from 'react'
import { orchestrate, type WorkflowOrchestration } from '@tenon/kernel/workflow/orchestration'
import type { WbEffectiveIo, WbWorkflowDef } from '../api/governanceTypes'
import { fetchWorkflowOrchestration } from '../api/workflowOrchestrationClient'

export type ManifestOverlay = Readonly<Record<string, readonly string[]>>

const NO_OVERLAY: ManifestOverlay = {}
const cache = new Map<string, Promise<ManifestOverlay>>()

function overlayFor(root: string, name: string, track: string): Promise<ManifestOverlay> {
  const key = `${root}\n${name}\n${track}`
  const hit = cache.get(key)
  if (hit !== undefined) return hit
  const request = fetchWorkflowOrchestration(name, root, track === '' ? null : track)
    .then((body) => body.overlay)
    .catch((error: unknown) => {
      cache.delete(key)
      throw error
    })
  cache.set(key, request)
  return request
}

/** 读不到叠加层（服务端旧版本、网络错误）时按「没有叠加」画：声明的技能照样按 runner 顺序排。 */
export function useManifestOverlay(root: string, name: string | null, track: string): ManifestOverlay {
  const [state, setState] = useState<{ key: string; overlay: ManifestOverlay }>({ key: '', overlay: NO_OVERLAY })
  const key = name === null ? '' : `${root}\n${name}\n${track}`
  useEffect(() => {
    if (name === null) return
    let cancelled = false
    overlayFor(root, name, track)
      .then((overlay) => { if (!cancelled) setState({ key: `${root}\n${name}\n${track}`, overlay }) })
      .catch(() => undefined)
    return () => { cancelled = true }
  }, [root, name, track])
  return state.key === key ? state.overlay : NO_OVERLAY
}

export function draftOrchestration(def: WbWorkflowDef, io: WbEffectiveIo | undefined, overlay: ManifestOverlay): WorkflowOrchestration {
  return orchestrate({ steps: def.steps, ...(io === undefined ? {} : { io }), overlay })
}

export function useDraftOrchestration(def: WbWorkflowDef | null, io: WbEffectiveIo | undefined, overlay: ManifestOverlay = NO_OVERLAY): WorkflowOrchestration | null {
  return useMemo(() => def === null ? null : draftOrchestration(def, io, overlay), [def, io, overlay])
}
