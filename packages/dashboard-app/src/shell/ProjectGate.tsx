import { FolderKanban } from 'lucide-react'
import { useT } from '../i18n'
import type { ProjectSnapshot } from '../types'
import { isProjectNavigable } from '../state/projectSelectionModel'

export interface ProjectGateProps {
  projects: readonly ProjectSnapshot[]
  onSelectProject: (root: string) => void
}

/**
 * 需要项目语境的页面（工作流 / 自动化）在无选择时的门：就地列出可读项目，选一个即留在当前页。
 * 不自动选中——静默替用户挑项目会把失效深链改写到别的项目上。
 */
export function ProjectGate({ projects, onSelectProject }: ProjectGateProps): JSX.Element {
  const { t } = useT()
  const selectable = projects.filter(isProjectNavigable)
  return (
    <section
      className="mx-auto mt-10 flex w-full max-w-[620px] flex-col items-start rounded-lg border border-border bg-card p-6 max-[900px]:mt-6 max-[900px]:p-5"
      data-testid="project-required"
      aria-labelledby="project-required-title"
    >
      <div className="mb-4 grid size-10 place-items-center rounded-md bg-accent-t text-accent-d" aria-hidden="true">
        <FolderKanban className="size-5" strokeWidth={1.75} />
      </div>
      <h1 id="project-required-title" className="text-title font-bold text-text">{t('shell.project_gate_title')}</h1>
      <p className="mt-2 text-base text-text-2">{t('shell.project_gate_desc')}</p>
      {selectable.length > 0 && (
        <ul className="mt-4 grid w-full gap-1.5" data-testid="project-required-list">
          {selectable.map((project) => {
            const name = project.repository?.label ?? project.root.split('/').filter(Boolean).pop() ?? project.root
            return (
              <li key={project.root}>
                <button
                  type="button"
                  className="flex w-full items-center justify-between gap-3 rounded-md border border-border bg-card px-3.5 py-3 text-left hover:border-accent-b hover:bg-accent-t"
                  data-testid={`project-required-pick-${name}`}
                  title={project.root}
                  onClick={() => onSelectProject(project.root)}
                >
                  <span className="min-w-0 truncate text-base font-semibold text-text">{name}</span>
                  <span className="font-mono text-caption text-text-3">{project.changes.length}</span>
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
