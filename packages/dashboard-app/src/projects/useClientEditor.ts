import { useRef, useState } from 'react'
import type { InstructionHostRow, InstructionPreviewFile, InstructionState, InstructionTarget } from '../api/instructionsDecoders'
import { fileStatus, groupByProjectFile, type ClientGroup, type FileStatus } from './clientModel'
import { useEnabledClients } from './useEnabledClients'
import { useInstructionFiles, type InstructionFiles } from './useInstructionFiles'

export type Scope = 'project' | 'user'

type Drafts = Readonly<Record<string, string>>

/** Claude Code 的 CLAUDE.md 用 `@path` 引用其他文件：一行就让它读 AGENTS.md。 */
const AGENTS_REFERENCE = '@AGENTS.md\n'

const draftKey = (scope: Scope, id: string): string => `${scope}:${id}`

function hasDraft(drafts: Drafts, scope: Scope, state: InstructionState | null): boolean {
  return (state?.targets ?? []).some((target) => {
    const draft = drafts[draftKey(scope, target.id)]
    return draft !== undefined && draft !== target.text
  })
}

export interface ClientEditor {
  readonly loading: boolean
  /** 读取失败（项目级指令文件或启用的客户端）：词典键后缀；有它时列表显示错误与重试。 */
  readonly loadErrorKey: string | null
  /** 启用 / 停用客户端写入失败：词典键后缀。 */
  readonly clientsErrorKey: string | null
  /** 项目级数据面已就绪（state 非空）。 */
  readonly ready: boolean
  readonly hosts: readonly InstructionHostRow[]
  readonly enabled: readonly string[]
  readonly groups: readonly ClientGroup[]
  readonly group: ClientGroup | null
  /** 实际生效的作用域：所选组没有用户级文件时退回项目级。 */
  readonly scope: Scope
  /** 所选组里有用户级文件的客户端（按宿主表顺序）。 */
  readonly userReaders: readonly string[]
  /** 当前编辑的客户端：项目级 = 组的第一个；用户级 = 所选读者。 */
  readonly client: string | null
  readonly target: InstructionTarget | null
  readonly text: string
  readonly files: InstructionFiles
  projectTarget: (file: string) => InstructionTarget | null
  statusOf: (scope: Scope, target: InstructionTarget) => FileStatus
  select: (clientId: string) => void
  setScope: (scope: Scope) => void
  setText: (next: string) => void
  enable: (clientId: string) => void
  disable: (clientId: string) => void
  preview: () => Promise<readonly InstructionPreviewFile[] | null>
  apply: (files: readonly InstructionPreviewFile[]) => Promise<boolean>
  remove: () => Promise<boolean>
  reload: () => void
  /** 缺 CLAUDE.md 而 AGENTS.md 存在时：写一行 `@AGENTS.md` 创建它；其余情况为 null。 */
  readonly linkAgents: (() => Promise<boolean>) | null
  /** 读取失败后的重试：项目级、用户级与启用的客户端一起重读。 */
  retry: () => void
}

/**
 * 项目页的编辑状态：已启用客户端按项目级文件归组；每组可在 项目级 / 用户级 之间切换编辑对应文件。
 * 每个文件各自保留草稿（键 = 作用域 + 目标 id），切换客户端或作用域不丢正在写的内容。
 */
export function useClientEditor(root: string, revision: string): ClientEditor {
  const [drafts, setDrafts] = useState<Drafts>({})
  const draftsRef = useRef(drafts)
  draftsRef.current = drafts
  const projectStateRef = useRef<InstructionState | null>(null)
  const userStateRef = useRef<InstructionState | null>(null)
  const active = root !== ''
  const project = useInstructionFiles(root, () => hasDraft(draftsRef.current, 'project', projectStateRef.current), revision, active)
  const user = useInstructionFiles('', () => hasDraft(draftsRef.current, 'user', userStateRef.current), revision, active)
  projectStateRef.current = project.state
  userStateRef.current = user.state

  // 换项目：项目级草稿属于上一个项目，清掉；用户级文件与项目无关，草稿保留。
  const [draftRoot, setDraftRoot] = useState(root)
  if (draftRoot !== root) {
    setDraftRoot(root)
    setDrafts((current) => Object.fromEntries(Object.entries(current).filter(([key]) => key.startsWith('user:'))))
  }

  const hosts = project.state?.hosts ?? []
  const projectTargets = project.state?.targets ?? []
  const clients = useEnabledClients(root, revision)
  const groups = groupByProjectFile(hosts, projectTargets, clients.enabled)

  const [selected, setSelected] = useState<string | null>(null)
  const [wantedScope, setScope] = useState<Scope>('project')
  const group = groups.find((candidate) => selected !== null && candidate.clients.includes(selected)) ?? groups[0] ?? null
  const userHosts = user.state?.hosts ?? []
  const userReaders = (group?.clients ?? []).filter((id) => (userHosts.find((host) => host.id === id)?.target ?? null) !== null)
  const reader = selected !== null && userReaders.includes(selected) ? selected : userReaders[0] ?? null
  const scope: Scope = wantedScope === 'user' && reader !== null ? 'user' : 'project'

  const files = scope === 'project' ? project : user
  const targetId = scope === 'project' ? group?.file ?? null : reader
  const target = targetId === null ? null : files.state?.targets.find((candidate) => candidate.id === targetId) ?? null
  const key = target === null ? null : draftKey(scope, target.id)
  const text = key === null ? '' : drafts[key] ?? target?.text ?? ''

  const agents = projectTargets.find((candidate) => candidate.id === 'AGENTS.md')
  const canLink = scope === 'project' && target !== null && target.id === 'CLAUDE.md' && !target.exists && target.error === null
    && agents !== undefined && agents.exists

  const dropDraft = (): void => {
    if (key === null) return
    setDrafts((current) => Object.fromEntries(Object.entries(current).filter(([candidate]) => candidate !== key)))
  }

  return {
    loading: project.loading || clients.loading,
    loadErrorKey: project.state === null ? project.errorKey : clients.loading ? null : clients.loadErrorKey,
    clientsErrorKey: clients.errorKey,
    ready: project.state !== null,
    hosts,
    enabled: clients.enabled,
    groups,
    group,
    scope,
    userReaders,
    client: scope === 'user' ? reader : group?.clients[0] ?? null,
    target,
    text,
    files,
    projectTarget: (file) => projectTargets.find((candidate) => candidate.id === file) ?? null,
    statusOf: (of, candidate) => fileStatus(candidate, drafts[draftKey(of, candidate.id)] ?? candidate.text),
    select: setSelected,
    setScope,
    setText: (next) => { if (key !== null) setDrafts((current) => ({ ...current, [key]: next })) },
    enable: (id) => {
      clients.enable(id)
      setSelected(id)
    },
    disable: clients.disable,
    preview: async () => (target === null ? null : files.preview(text, [target.id])),
    apply: async (previewFiles) => {
      const applied = await files.apply(text, previewFiles.map((file) => ({ id: file.id, base_digest: file.base_digest })))
      if (applied === null) return false
      dropDraft()
      return true
    },
    remove: async () => {
      if (target === null || !target.exists) return false
      const removed = await files.remove(target.id, target.digest)
      if (removed === null) return false
      dropDraft()
      return true
    },
    linkAgents: !canLink || target === null ? null : async () => {
      const applied = await project.apply(AGENTS_REFERENCE, [{ id: target.id, base_digest: target.digest }])
      if (applied === null) return false
      dropDraft()
      return true
    },
    retry: () => {
      void project.reload()
      void user.reload()
      clients.reload()
    },
    reload: () => {
      dropDraft()
      files.dismissExternal()
      void files.reload()
    },
  }
}
