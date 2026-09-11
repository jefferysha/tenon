import { FolderKanban, Settings } from 'lucide-react'
import { useT } from '../i18n'
import { RailCard, RailColumn, RailFootLink } from '../shell/ThreeColumns'
import type { TopBarProject } from '../shell/TopBar'

export interface ProjectRailProps {
  projects: readonly TopBarProject[]
  currentRoot: string
  collapsed: boolean
  onToggle: () => void
  onSelect: (root: string) => void
}

/** 工作台左列：项目选择。「所有项目」= 取消选择、中列聚合全部项目；「设置」= 打开顶部条的设置面板。 */
export function ProjectRail({ projects, currentRoot, collapsed, onToggle, onSelect }: ProjectRailProps): JSX.Element {
  const { t } = useT()
  return (
    <RailColumn
      title={t('shell.project_rail_title')}
      collapsed={collapsed}
      onToggle={onToggle}
      testId="project-rail"
      footer={(
        <>
          <RailFootLink
            icon={<FolderKanban />}
            label={t('shell.all_projects')}
            collapsed={collapsed}
            current={currentRoot === ''}
            testId="project-rail-all"
            onClick={() => onSelect('')}
          />
          <RailFootLink
            icon={<Settings />}
            label={t('common.settings')}
            collapsed={collapsed}
            testId="project-rail-settings"
            onClick={() => document.querySelector<HTMLElement>('[data-testid="nav-settings"]')?.click()}
          />
        </>
      )}
    >
      {projects.length === 0 ? (
        <p className="px-2 text-caption text-text-3" role="status">{t('shell.no_projects')}</p>
      ) : (
        <ul className="grid gap-1">
          {projects.map((project) => (
            <li key={project.root}>
              <RailCard
                mark={project.name.slice(0, 1).toUpperCase()}
                name={project.name}
                meta={project.ok ? project.root.split('/').filter(Boolean).slice(-2).join('/') : t('shell.project_unreachable')}
                selected={project.root === currentRoot}
                collapsed={collapsed}
                tag={project.ok ? undefined : <span className="rounded-full bg-red-t px-1.5 text-micro font-medium text-red-d">{t('shell.project_unreachable')}</span>}
                testId={`project-rail-item-${project.name}`}
                onClick={() => onSelect(project.root)}
              />
            </li>
          ))}
        </ul>
      )}
    </RailColumn>
  )
}
