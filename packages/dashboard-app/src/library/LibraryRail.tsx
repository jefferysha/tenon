import { Bot, FileText, FlaskConical, Package } from 'lucide-react'
import { useT } from '../i18n'
import { RailCard, RailColumn } from '../shell/ThreeColumns'

export type LibrarySection = 'templates' | 'resources' | 'directions' | 'agents'

/** 库页左列：模板 / 资源目录 / 测试方向 / agent。各区共用同一条导轨，切换只换中列与右列。 */
export function LibraryRail({
  section, templates, resources, directions, agents, collapsed, onSection, onToggle,
}: {
  section: LibrarySection
  /** null = 还在读取：计数显示「–」，不显示假的 0。 */
  templates: number | null
  resources: number | null
  directions: number | null
  agents: number | null
  collapsed: boolean
  onSection: (next: LibrarySection) => void
  onToggle: () => void
}): JSX.Element {
  const { t } = useT()
  return (
    <RailColumn title={t('library.title')} collapsed={collapsed} onToggle={onToggle} testId="library-rail">
      <ul className="grid gap-1">
        <li>
          <RailCard
            mark={<FileText />}
            name={t('library.templates')}
            count={templates ?? '–'}
            selected={section === 'templates'}
            collapsed={collapsed}
            onClick={() => onSection('templates')}
            testId="lib-section-templates"
          />
        </li>
        <li>
          <RailCard
            mark={<Package />}
            name={t('resources.title')}
            count={resources ?? '–'}
            selected={section === 'resources'}
            collapsed={collapsed}
            onClick={() => onSection('resources')}
            testId="lib-section-resources"
          />
        </li>
        <li>
          <RailCard
            mark={<FlaskConical />}
            name={t('library.test_directions')}
            count={directions ?? '–'}
            selected={section === 'directions'}
            collapsed={collapsed}
            onClick={() => onSection('directions')}
            testId="lib-section-directions"
          />
        </li>
        <li>
          <RailCard
            mark={<Bot />}
            name={t('library.agents')}
            count={agents ?? '–'}
            selected={section === 'agents'}
            collapsed={collapsed}
            onClick={() => onSection('agents')}
            testId="lib-section-agents"
          />
        </li>
      </ul>
    </RailColumn>
  )
}
