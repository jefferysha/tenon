import { useState } from 'react'
import { Folder, MoreHorizontal } from 'lucide-react'
import { useT } from '../i18n'
import { unregisterProject } from '../api/client'
import type { TopBarProject } from '../shell/TopBar'
import { RailCard } from '../shell/ThreeColumns'
import { Dialog } from '../shared/Dialog'
import { BUTTON_DANGER, BUTTON_GHOST } from '../shared/uiRecipes'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { shortPath } from '@/lib/utils'

/**
 * 左列项目：每行悬停 / 聚焦时右侧出现 ⋯（注销…）。注销只把项目移出本机注册表，不删文件；
 * 确认对话框写明这一点。折叠态不给菜单（只剩图标）。
 */
export function ProjectRailList({ projects, currentRoot, collapsed, canWrite, onSelect, onUnregistered, onToast }: {
  projects: readonly TopBarProject[]
  currentRoot: string
  collapsed: boolean
  canWrite: boolean
  onSelect: (root: string) => void
  onUnregistered: (root: string) => void
  onToast?: (message: string) => void
}): JSX.Element {
  const { t } = useT()
  const [pending, setPending] = useState<TopBarProject | null>(null)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)

  const confirm = async (project: TopBarProject): Promise<void> => {
    setBusy(true)
    setFailed(false)
    try {
      await unregisterProject(project.root)
      setPending(null)
      onUnregistered(project.root)
      onToast?.(t('nav.unregister_ok'))
    } catch {
      setFailed(true)
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <ul className="grid gap-1">
        {projects.map((candidate) => (
          <li key={candidate.root} className="group relative">
            <RailCard
              mark={<Folder />}
              name={candidate.name}
              meta={shortPath(candidate.root)}
              metaTitle={candidate.root}
              metaMono
              selected={candidate.root === currentRoot}
              collapsed={collapsed}
              onClick={() => onSelect(candidate.root)}
              testId={`proj-root-${candidate.name}`}
            />
            {!collapsed && canWrite && (
              <DropdownMenu>
                <DropdownMenuTrigger
                  className="absolute top-1/2 right-1 grid size-8 -translate-y-1/2 place-items-center rounded-sm text-text-3 opacity-0 outline-none transition-opacity duration-(--dur-fast) ease-(--ease-out) group-hover:opacity-100 hover:bg-fill-2 hover:text-text focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-(--accent) aria-expanded:opacity-100 max-[1360px]:hidden max-[900px]:grid"
                  aria-label={t('nav.project_unregister_aria', { name: candidate.name })}
                  title={t('projects.more')}
                  data-testid={`proj-root-${candidate.name}-more`}
                >
                  <MoreHorizontal className="size-4" aria-hidden="true" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="min-w-40">
                  <DropdownMenuItem
                    className="min-h-10 text-body text-red-d focus:text-red-d"
                    data-testid={`proj-root-${candidate.name}-unregister`}
                    onSelect={() => { setFailed(false); setPending(candidate) }}
                  >
                    {t('nav.project_unregister')}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </li>
        ))}
      </ul>
      {pending !== null && (
        <Dialog
          title={t('nav.unregister_title', { name: pending.name })}
          onClose={() => setPending(null)}
          testid="proj-unregister-dialog"
          role="alertdialog"
          actions={(
            <>
              <button type="button" className={BUTTON_GHOST} data-testid="proj-unregister-cancel" onClick={() => setPending(null)}>
                {t('nav.unregister_cancel')}
              </button>
              <button
                type="button"
                className={BUTTON_DANGER}
                disabled={busy}
                data-testid="proj-unregister-confirm"
                onClick={() => { void confirm(pending) }}
              >
                {t('nav.unregister_confirm')}
              </button>
            </>
          )}
        >
          <div className="grid gap-2">
            <p className="text-body text-text-2">{t('nav.unregister_desc', { name: pending.name })}</p>
            <p className="truncate whitespace-nowrap font-mono text-caption text-text-3" title={pending.root}>{pending.root}</p>
            {failed && <p className="text-body font-semibold text-red-d" role="alert" data-testid="proj-unregister-error">{t('projects.errors.unknown')}</p>}
          </div>
        </Dialog>
      )}
    </>
  )
}
