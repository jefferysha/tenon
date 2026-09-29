import type { WbTrackBranch, WbWorkflowDef } from '../api/governanceTypes'
import { cloneDocumentContract } from './documentContractEdits'
import { cloneSteps } from './workbenchClone'

// ── 分支：有 tracks → 每条 track 一个分支（steps ⊕ tracks，顶层 steps 为空）；无 tracks → 单条 pipeline（id ''）──

export const BASE_BRANCH = ''

function trackEntries(def: WbWorkflowDef | null): Array<[string, WbTrackBranch]> {
  return Object.entries(def?.tracks ?? {})
}

/** 分支列表：有 tracks 时按声明序列出每条 track（名称 = label ?? id）；否则只有单条 pipeline。 */
export function branchesOf(def: WbWorkflowDef | null): Array<{ id: string; label: string | null }> {
  const tracks = trackEntries(def)
  if (tracks.length === 0) return [{ id: BASE_BRANCH, label: null }]
  return tracks.map(([id, branch]) => ({ id, label: branch.label ?? id }))
}

/** 有效分支 id：请求的分支不存在时退到第一条 track（无 tracks → ''）。 */
export function resolveBranch(def: WbWorkflowDef | null, branch: string): string {
  const tracks = trackEntries(def)
  if (tracks.length === 0) return BASE_BRANCH
  const first = tracks[0]
  return def?.tracks?.[branch] !== undefined ? branch : first?.[0] ?? BASE_BRANCH
}

/** 分支视图：把所选分支的 steps、文档契约与物化 IO 提升成一个「单条 pipeline」定义，供编辑器所有读路径使用。 */
export function selectBranchDef(def: WbWorkflowDef, branch: string): WbWorkflowDef {
  const { tracks: _tracks, branches, effectiveIo, documentContract, ...rest } = def
  const id = resolveBranch(def, branch)
  const track = id === BASE_BRANCH ? undefined : def.tracks?.[id]
  const io = branches?.[id === BASE_BRANCH ? '_base' : id]?.effectiveIo ?? (id === BASE_BRANCH ? effectiveIo : undefined)
  const contract = track === undefined ? documentContract : track.documentContract
  return {
    ...rest,
    ...(io === undefined ? {} : { effectiveIo: io }),
    ...(contract === undefined ? {} : { documentContract: contract }),
    steps: track === undefined ? def.steps : track.steps,
  }
}

/** 把分支视图上的编辑写回完整定义：steps 与文档契约回到对应分支，其余工作流级字段照抄更新后的值。 */
export function writeBranchDef(def: WbWorkflowDef, branch: string, updated: WbWorkflowDef): WbWorkflowDef {
  const { steps, tracks: _tracks, effectiveIo: _io, branches: _branches, documentContract, ...rest } = updated
  const contract = documentContract === undefined ? {} : { documentContract }
  const id = resolveBranch(def, branch)
  if (id === BASE_BRANCH) {
    const { documentContract: _previous, ...base } = { ...def, ...rest }
    return { ...base, ...contract, steps }
  }
  const existing = def.tracks?.[id]
  if (existing === undefined) return def
  const { documentContract: _previousBranch, ...branchRest } = existing
  return { ...def, ...rest, steps: def.steps, tracks: { ...def.tracks, [id]: { ...branchRest, ...contract, steps } } }
}

/**
 * 新建轨道分支 = 复制 `from` 分支的 steps（深拷贝）。工作流原本没有 tracks 时，它的单条 pipeline 搬进第一条
 * track（id `main`），顶层 steps 清空（steps ⊕ tracks）。
 */
export function addTrackBranch(def: WbWorkflowDef, id: string, label: string, from: string = BASE_BRANCH): WbWorkflowDef {
  const source = selectBranchDef(def, from)
  const branch: WbTrackBranch = {
    ...(label === '' ? {} : { label }),
    ...(source.documentContract === undefined ? {} : { documentContract: cloneDocumentContract(source.documentContract) }),
    steps: cloneSteps(source.steps),
  }
  if (trackEntries(def).length === 0) {
    const { documentContract: topContract, ...single } = def
    if (def.steps.length === 0) return { ...single, steps: [], tracks: { [id]: branch } }
    const firstId = id === 'main' ? 'base' : 'main'
    const first: WbTrackBranch = { ...(topContract === undefined ? {} : { documentContract: cloneDocumentContract(topContract) }), steps: cloneSteps(def.steps) }
    return { ...single, steps: [], tracks: { [firstId]: first, [id]: branch } }
  }
  return { ...def, tracks: { ...(def.tracks ?? {}), [id]: branch } }
}

/** 删除轨道分支；删到最后一条时它的 steps 与文档契约回到顶层，工作流重新成为单条 pipeline。 */
export function removeTrackBranch(def: WbWorkflowDef, id: string): WbWorkflowDef {
  const { [id]: removed, ...rest } = def.tracks ?? {}
  if (removed === undefined) return def
  const { tracks: _tracks, ...withoutTracks } = def
  if (Object.keys(rest).length === 0) {
    return { ...withoutTracks, ...(removed.documentContract === undefined ? {} : { documentContract: removed.documentContract }), steps: removed.steps }
  }
  return { ...def, tracks: rest }
}

