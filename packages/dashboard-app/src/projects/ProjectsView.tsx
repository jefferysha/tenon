import { useEffect, useMemo, useRef, useState } from 'react'
import { useT } from '../i18n'
import type { InstructionPreviewFile } from '../api/instructionsDecoders'
import { Icon } from '../shell/Icon'
import type { TopBarProject } from '../shell/TopBar'
import { DetailEmpty, ListColumn, RailCard, RailColumn, RailFootLink, ThreeColumns } from '../shell/ThreeColumns'
import { HostTargetList } from './HostTargetList'
import { InstructionEditor } from './InstructionEditor'
import { NewProjectDialog } from './NewProjectDialog'
import { firstLoadable, targetsForHosts } from './instructionModel'
import { useInstructionFiles } from './useInstructionFiles'

const RAIL_KEY = 'tenon-dashboard-rail:projects'
const DEFAULT_HOSTS = ['claude', 'codex']

/** 项目：左列用户级 + 各项目 + 新建项目 / 中列宿主与文件 / 右列指令文件编辑器。 */
export function ProjectsView({
  projects, currentRoot, onSelectProject, onToast, newProjectOpen = false, onNewProjectOpenChange,
}: {
  projects: readonly TopBarProject[]
  currentRoot: string
  onSelectProject: (root: string) => void
  onToast?: (message: string) => void
  /** 由零项目教学态的「新建项目」触发时为 true。 */
  newProjectOpen?: boolean
  onNewProjectOpenChange?: (open: boolean) => void
}): JSX.Element {
  const { t } = useT()
  const [railCollapsed, setRailCollapsed] = useState<boolean>(() => {
    try { return localStorage.getItem(RAIL_KEY) === '1' } catch { return false }
  })
  useEffect(() => {
    try { localStorage.setItem(RAIL_KEY, railCollapsed ? '1' : '0') } catch { /* ignore */ }
  }, [railCollapsed])

  const [localDialog, setLocalDialog] = useState(false)
  const dialogOpen = newProjectOpen || localDialog
  const closeDialog = (): void => {
    setLocalDialog(false)
    onNewProjectOpenChange?.(false)
  }

  const [text, setText] = useState('')
  const loadedRef = useRef('')
  const dirtyRef = useRef(false)
  dirtyRef.current = text !== loadedRef.current
  const files = useInstructionFiles(currentRoot, () => dirtyRef.current)
  const [selectedHosts, setSelectedHosts] = useState<ReadonlySet<string>>(() => new Set(DEFAULT_HOSTS))

  const hosts = files.state?.hosts ?? []
  const targets = files.state?.targets ?? []
  const targetIds = useMemo(() => targetsForHosts(hosts, selectedHosts), [hosts, selectedHosts])

  // 载入盘上的正文：只在没有草稿时跟随刷新，避免覆盖用户正在写的内容。
  useEffect(() => {
    if (files.state === null || dirtyRef.current) return
    const source = firstLoadable(files.state.targets, targetsForHosts(files.state.hosts, selectedHosts))
    const next = source?.text ?? ''
    loadedRef.current = next
    setText(next)
  }, [files.state, selectedHosts])

  const level = files.state?.level ?? (currentRoot === '' ? 'user' : 'project')
  const project = projects.find((candidate) => candidate.root === currentRoot)
  const title = currentRoot === '' ? t('projects.user_level') : project?.name ?? currentRoot

  const onApply = async (previewFiles: readonly InstructionPreviewFile[]): Promise<boolean> => {
    const applied = await files.apply(text, previewFiles.map((file) => ({ id: file.id, base_digest: file.base_digest })))
    if (applied === null) return false
    loadedRef.current = text
    onToast?.(t('common.done_applied'))
    return true
  }

  const onDelete = async (): Promise<void> => {
    const removed: string[] = []
    for (const id of targetIds) {
      const target = targets.find((candidate) => candidate.id === id)
      if (target === undefined || !target.exists) continue
      if (await files.remove(id, target.digest) !== null) removed.push(id)
    }
    if (removed.length > 0) onToast?.(t('common.done_deleted', { name: removed.join(', ') }))
  }

  return (
    <>
      <ThreeColumns
        testId="projects-view"
        railCollapsed={railCollapsed}
        rail={(
          <RailColumn
            title={t('projects.rail')}
            collapsed={railCollapsed}
            onToggle={() => setRailCollapsed((value) => !value)}
            testId="projects-rail"
            footer={(
              <RailFootLink
                icon={<Icon name="folder" size={14} />}
                label={t('projects.new_project')}
                collapsed={railCollapsed}
                onClick={() => setLocalDialog(true)}
                testId="proj-new"
              />
            )}
          >
            <ul className="grid gap-1">
              <li>
                <RailCard
                  mark="U"
                  name={t('projects.user_level')}
                  selected={currentRoot === ''}
                  collapsed={railCollapsed}
                  onClick={() => onSelectProject('')}
                  testId="proj-user"
                />
              </li>
              {projects.map((candidate) => (
                <li key={candidate.root}>
                  <RailCard
                    mark={(candidate.name[0] ?? '?').toUpperCase()}
                    name={candidate.name}
                    meta={candidate.root}
                    selected={candidate.root === currentRoot}
                    collapsed={railCollapsed}
                    onClick={() => onSelectProject(candidate.root)}
                    testId={`proj-root-${candidate.name}`}
                  />
                </li>
              ))}
            </ul>
          </RailColumn>
        )}
        list={(
          <ListColumn
            testId="projects-list"
            eyebrow={t('projects.rail')}
            title={t('projects.hosts')}
          >
            {files.loading ? (
              <p className="text-base text-text-2" data-testid="proj-loading">{t('projects.rail')}</p>
            ) : (
              <HostTargetList
                hosts={hosts}
                targets={targets}
                selected={selectedHosts}
                editorText={text}
                onToggle={(hostId) => setSelectedHosts((current) => {
                  const next = new Set(current)
                  if (next.has(hostId)) next.delete(hostId)
                  else next.add(hostId)
                  return next
                })}
                onLoad={(id) => {
                  const target = targets.find((candidate) => candidate.id === id)
                  if (target === undefined) return
                  loadedRef.current = target.text
                  setText(target.text)
                }}
              />
            )}
          </ListColumn>
        )}
        detail={files.state === null ? (
          <DetailEmpty title={t('projects.empty_detail')} desc={t('projects.rail')} testId="proj-detail-empty" />
        ) : (
          <InstructionEditor
            level={level}
            title={title}
            root={currentRoot}
            targets={targets}
            targetIds={targetIds}
            text={text}
            onText={setText}
            external={files.external}
            busy={files.busy}
            errorKey={files.errorKey}
            onPreview={() => files.preview(text, targetIds)}
            onApply={onApply}
            onDelete={onDelete}
            onReload={() => { void files.reload() }}
            onDismissExternal={files.dismissExternal}
          />
        )}
      />
      {dialogOpen && (
        <NewProjectDialog
          onClose={closeDialog}
          onCreated={(root) => {
            closeDialog()
            onSelectProject(root)
            onToast?.(t('projects.done_project_created', { name: root.split('/').filter(Boolean).pop() ?? root }))
          }}
        />
      )}
    </>
  )
}
