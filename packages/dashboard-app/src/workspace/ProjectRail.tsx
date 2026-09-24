import { Folder, FolderX, Layers } from 'lucide-react'
import { useT } from '../i18n'
import { RailCard, RailColumn } from '../shell/ThreeColumns'
import type { TopBarProject } from '../shell/TopBar'
import { shortPath } from '@/lib/utils'

export interface ProjectRailProps {
  projects: readonly TopBarProject[]
  currentRoot: string
  collapsed: boolean
  onToggle: () => void
  onSelect: (root: string) => void
}

/**
 * 工作台左列：「所有项目」（聚合）+ 各项目。≤900px 整列隐藏，改由顶部条的项目切换器选择——
 * 堆叠布局下这一列只会变成一团芯片。
 */
export function ProjectRail({ projects, currentRoot, collapsed, onToggle, onSelect }: ProjectRailProps): JSX.Element {
  const { t } = useT()
  return (
    <div className="contents max-[900px]:hidden" data-testid="project-rail-wrap">
      <RailColumn
        title={t('shell.project_rail_title')}
        collapsed={collapsed}
        onToggle={onToggle}
        testId="project-rail"
        lead={(
          <RailCard
            mark={<Layers />}
            name={t('shell.all_projects')}
            selected={currentRoot === ''}
            collapsed={collapsed}
            testId="project-rail-all"
            onClick={() => onSelect('')}
          />
        )}
      >
        <ul className="grid gap-1">
          {projects.map((project) => (
            <li key={project.root}>
              <RailCard
                mark={project.ok ? <Folder /> : <FolderX />}
                name={project.name}
                // 不可读只说一次：图标 + 副行，不再加徽标。
                meta={project.ok ? shortPath(project.root) : t('shell.project_unreachable')}
                metaTitle={project.root}
                metaMono={project.ok}
                selected={project.root === currentRoot}
                collapsed={collapsed}
                danger={!project.ok}
                testId={`project-rail-item-${project.name}`}
                onClick={() => onSelect(project.root)}
              />
            </li>
          ))}
        </ul>
        {projects.length === 0 && <p className="mt-2 px-2 text-caption text-text-3" role="status">{t('shell.no_projects')}</p>}
      </RailColumn>
    </div>
  )
}
