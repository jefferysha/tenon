import { useEffect, useState } from 'react'
import { Folder, Plus } from 'lucide-react'
import { useT } from '../i18n'
import type { TopBarProject } from '../shell/TopBar'
import { DetailEmpty, ListColumn, RailCard, RailColumn, ThreeColumns } from '../shell/ThreeColumns'
import { BUTTON_ICON } from '../shared/uiRecipes'
import { AddClientMenu, ClientList } from './ClientList'
import { ClientScopeControls } from './ClientScopeControls'
import { InstructionEditor } from './InstructionEditor'
import { NewProjectDialog } from './NewProjectDialog'
import { CODEX_MAX_BYTES, clientName, fileNameOf } from './clientModel'
import { shortPath } from '@/lib/utils'
import { useClientEditor } from './useClientEditor'

const RAIL_KEY = 'tenon-dashboard-rail:projects'

/** 项目：左列项目 + 新建项目 / 中列该项目已启用的客户端 / 右列所选客户端的 项目级 · 用户级 指令文件。 */
export function ProjectsView({
  projects, currentRoot, onSelectProject, onToast, newProjectOpen = false, onNewProjectOpenChange, snapshotRevision = '',
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
            <ul className="grid gap-1">
              {projects.map((candidate) => (
                <li key={candidate.root}>
                  <RailCard
                    mark={<Folder />}
                    name={candidate.name}
                    meta={shortPath(candidate.root)}
                    metaTitle={candidate.root}
                    metaMono
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
            title={t('projects.clients')}
            action={currentRoot !== '' && editor.ready ? (
              <AddClientMenu hosts={editor.hosts} enabled={editor.enabled} onEnable={editor.enable} />
            ) : undefined}
          >
            {editor.loading ? (
              <ul className="grid gap-2" role="status" aria-label={t('common.loading')} data-testid="proj-loading">
                {[0, 1, 2].map((index) => (
                  <li key={index} className="h-11 animate-pulse rounded-md bg-fill motion-reduce:animate-none" />
                ))}
              </ul>
            ) : (
              <ClientList
                groups={editor.groups}
                selectedFile={group?.file ?? null}
                statusOf={(file) => {
                  const projectTarget = editor.projectTarget(file)
                  return projectTarget === null ? null : editor.statusOf('project', projectTarget)
                }}
                onSelect={editor.select}
                onDisable={editor.disable}
              />
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
