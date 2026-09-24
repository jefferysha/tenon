import type { ReactNode } from 'react'
import { Folder, FolderX, Layers } from 'lucide-react'
import { useT } from '../i18n'
import { RailColumn } from '../shell/ThreeColumns'
import type { TopBarProject } from '../shell/TopBar'
import { cn, shortPath } from '@/lib/utils'

export interface ProjectRailProps {
  projects: readonly TopBarProject[]
  currentRoot: string
  collapsed: boolean
  onToggle: () => void
  onSelect: (root: string) => void
}

/**
 * 左列一项：语义图标 + 名称 + 路径（与项目页同一 shortPath，完整路径放 title）。
 * RailCard 的 mark 只收字母，这里要图标，所以单独画；样式与 RailCard 对齐。
 */
function ProjectRailItem({ icon, name, meta, title, selected, collapsed, danger, testId, onClick }: {
  icon: ReactNode
  name: string
  meta?: string
  title: string
  selected: boolean
  collapsed: boolean
  danger?: boolean
  testId: string
  onClick: () => void
}): JSX.Element {
  return (
    <button
      type="button"
      className={cn(
        'grid min-h-10 w-full items-center gap-3 rounded-md border border-transparent text-left outline-none transition-colors hover:bg-fill focus-visible:ring-2 focus-visible:ring-(--accent) aria-[current=true]:border-accent-b aria-[current=true]:bg-accent-t motion-reduce:transition-none',
        collapsed ? 'grid-cols-1 justify-items-center p-2' : 'grid-cols-[auto_minmax(0,1fr)] px-3 py-2.5 max-[1279px]:grid-cols-1 max-[1279px]:justify-items-center max-[1279px]:p-2',
      )}
      aria-current={selected ? 'true' : undefined}
      aria-label={collapsed ? name : undefined}
      title={title}
      data-testid={testId}
      onClick={onClick}
    >
      <span
        className={cn('grid size-8 place-items-center rounded-sm border border-border bg-card [&_svg]:size-4', selected ? 'border-accent-b text-(--accent)' : danger ? 'text-red-d' : 'text-text-2')}
        aria-hidden="true"
      >
        {icon}
      </span>
      {!collapsed && (
        <span className="min-w-0 max-[1279px]:hidden">
          <span className={cn('block truncate text-base font-semibold', selected ? 'text-(--accent)' : 'text-text')}>{name}</span>
          {meta !== undefined && <span className={cn('block truncate font-mono text-caption', danger ? 'text-red-d' : 'text-text-2')}>{meta}</span>}
        </span>
      )}
    </button>
  )
}

/**
 * 工作台左列：「所有项目」（聚合）+ 各项目。≤900px 整列隐藏，改由顶部条的项目切换器选择——
 * 堆叠布局下这一列只会变成一团芯片。
 */
export function ProjectRail({ projects, currentRoot, collapsed, onToggle, onSelect }: ProjectRailProps): JSX.Element {
  const { t } = useT()
  // 壳层组的 RailColumn 新增 lead 插槽（列表前）；合并后把它作为 lead 传入，这里先放在列表之前。
  const lead = (
    <div className="mb-1">
      <ProjectRailItem
        icon={<Layers />}
        name={t('shell.all_projects')}
        title={t('shell.all_projects')}
        selected={currentRoot === ''}
        collapsed={collapsed}
        testId="project-rail-all"
        onClick={() => onSelect('')}
      />
    </div>
  )
  return (
    <div className="contents max-[900px]:hidden" data-testid="project-rail-wrap">
      <RailColumn
        title={t('shell.project_rail_title')}
        collapsed={collapsed}
        onToggle={onToggle}
        testId="project-rail"
      >
        {lead}
        <ul className="grid gap-1">
          {projects.map((project) => (
            <li key={project.root}>
              <ProjectRailItem
                icon={project.ok ? <Folder /> : <FolderX />}
                name={project.name}
                // 不可读只说一次：图标 + 副行，不再加徽标。
                meta={project.ok ? shortPath(project.root) : t('shell.project_unreachable')}
                title={project.root}
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
