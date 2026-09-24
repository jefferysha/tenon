import { useEffect, useState } from 'react'
import { Plus } from 'lucide-react'
import { useT } from '../i18n'
import type { TopBarProject } from '../shell/TopBar'
import { DetailEmpty, ListColumn, RailColumn, ThreeColumns } from '../shell/ThreeColumns'
import { getToken } from '../api/transport'
import { BUTTON_GHOST, BUTTON_ICON } from '../shared/uiRecipes'
import { AddClientMenu, ClientList } from './ClientList'
import { Hinted, InlineError } from './projectBits'
import { ClientScopeControls } from './ClientScopeControls'
import { InstructionEditor } from './InstructionEditor'
import { NewProjectDialog } from './NewProjectDialog'
import { ProjectRailList } from './ProjectRailList'
import { CODEX_MAX_BYTES, clientName, fileNameOf } from './clientModel'
import { useClientEditor } from './useClientEditor'

const RAIL_KEY = 'tenon-dashboard-rail:projects'

/** 项目：左列项目 + 新建项目 / 中列该项目已启用的客户端 / 右列所选客户端的 项目级 · 用户级 指令文件。 */
export function ProjectsView({
  projects, currentRoot, onSelectProject, onToast, newProjectOpen = false, onNewProjectOpenChange, snapshotRevision = '', onOpenProject,
}: {
  projects: readonly TopBarProject[]
  currentRoot: string
  /** 快照的版本标记（generated_at）：变化时复查一次指令文件，不变就不请求。 */
  snapshotRevision?: string
  onSelectProject: (root: string) => void
  onToast?: (message: string) => void
  /** 由零项目教学态的「新建项目」触发时为 true。 */
  newProjectOpen?: boolean
  onNewProjectOpenChange?: (open: boolean) => void
  /** 新建向导完成或打开已登记目录后切到该项目的工作台；缺省只选中项目。 */
  onOpenProject?: (root: string) => void
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

  // 项目页总有一个项目：没选时打开列表第一个，不留空白页。
  const firstRoot = projects[0]?.root
  useEffect(() => {
    if (currentRoot === '' && firstRoot !== undefined) onSelectProject(firstRoot)
  }, [currentRoot, firstRoot, onSelectProject])

  const editor = useClientEditor(currentRoot, snapshotRevision)
  const { target, group, client } = editor

  const onApply = async (...args: Parameters<typeof editor.apply>): Promise<boolean> => {
    const applied = await editor.apply(...args)
    if (applied) onToast?.(t('common.done_applied'))
    return applied
  }

  const onDelete = async (): Promise<void> => {
    const name = target === null ? '' : fileNameOf(target)
    if (await editor.remove()) onToast?.(t('common.done_deleted', { name }))
  }

  const onLinkAgents = async (): Promise<void> => {
    if (await editor.linkAgents?.()) onToast?.(t('common.done_applied'))
  }

  const canWrite = getToken() !== ''
  const readers = editor.scope === 'user' ? [client ?? ''] : group?.clients ?? []

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
            headerAction={(
              <button
                type="button"
                className={BUTTON_ICON}
                aria-label={t('projects.new_project')}
                title={t('projects.new_project')}
                data-testid="proj-new"
                onClick={() => setLocalDialog(true)}
              >
                <Plus className="size-4" aria-hidden="true" />
              </button>
            )}
          >
            <ProjectRailList
              projects={projects}
              currentRoot={currentRoot}
              collapsed={railCollapsed}
              canWrite={canWrite}
              onSelect={onSelectProject}
              onUnregistered={(root) => { if (root === currentRoot) onSelectProject('') }}
              onToast={onToast}
            />
          </RailColumn>
        )}
        list={(
          <ListColumn
            testId="projects-list"
            title={t('projects.clients')}
            action={currentRoot !== '' && editor.ready && editor.loadErrorKey === null ? (
              <AddClientMenu hosts={editor.hosts} enabled={editor.enabled} disabled={!canWrite} onEnable={editor.enable} />
            ) : undefined}
          >
            {editor.loadErrorKey !== null ? (
              <InlineError errorKey={editor.loadErrorKey} onRetry={editor.retry} testId="proj-load-error" />
            ) : editor.loading ? (
              <ul className="grid gap-2" role="status" aria-label={t('common.loading')} data-testid="proj-loading">
                {[0, 1, 2].map((index) => (
                  <li key={index} className="h-11 animate-pulse rounded-md bg-fill motion-reduce:animate-none" />
                ))}
              </ul>
            ) : (
              <>
                {editor.clientsErrorKey !== null && <InlineError errorKey={editor.clientsErrorKey} testId="proj-clients-error" />}
                <ClientList
                  groups={editor.groups}
                  selectedFile={group?.file ?? null}
                  statusOf={(file) => {
                    const projectTarget = editor.projectTarget(file)
                    return projectTarget === null ? null : editor.statusOf('project', projectTarget)
                  }}
                  canWrite={canWrite}
                  onSelect={editor.select}
                  onDisable={editor.disable}
                />
              </>
            )}
          </ListColumn>
        )}
        detail={target === null || client === null ? (
          // 详情空态不写字，只留空白；可访问名称仍说明要选什么。
          <DetailEmpty label={t(currentRoot === '' ? 'projects.empty_detail' : 'projects.add_client')} testId="proj-detail-empty" />
        ) : (
          <InstructionEditor
            key={`${editor.scope}:${target.id}`}
            title={clientName(client)}
            target={target}
            root={editor.scope === 'project' ? currentRoot : ''}
            controls={(
              <ClientScopeControls
                scope={editor.scope}
                onScope={editor.setScope}
                userReaders={editor.userReaders}
                reader={editor.scope === 'user' ? client : null}
                onReader={editor.select}
                levels={editor.hosts.find((host) => host.id === client)?.levels ?? null}
              />
            )}
            status={editor.statusOf(editor.scope, target)}
            tooLarge={readers.includes('codex') && target.bytes > CODEX_MAX_BYTES}
            text={editor.text}
            onText={editor.setText}
            external={editor.files.external}
            busy={editor.files.busy}
            errorKey={editor.files.errorKey}
            onPreview={editor.preview}
            onApply={onApply}
            onDelete={onDelete}
            onReload={editor.reload}
            extraAction={editor.linkAgents === null ? undefined : (
              <Hinted hint={t('projects.link_agents_hint')} asChild>
                <button
                  type="button"
                  className={BUTTON_GHOST}
                  disabled={!canWrite || editor.files.busy}
                  data-testid="proj-link-agents"
                  onClick={() => { void onLinkAgents() }}
                >
                  {t('projects.link_agents')}
                </button>
              </Hinted>
            )}
          />
        )}
      />
      {dialogOpen && (
        <NewProjectDialog
          onClose={closeDialog}
          onCreated={(root) => {
            closeDialog()
            ;(onOpenProject ?? onSelectProject)(root)
            onToast?.(t('projects.done_project_created', { name: root.split('/').filter(Boolean).pop() ?? root }))
          }}
          onOpen={(root) => {
            closeDialog()
            ;(onOpenProject ?? onSelectProject)(root)
          }}
        />
      )}
    </>
  )
}
