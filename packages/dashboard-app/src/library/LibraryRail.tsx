import { useT } from '../i18n'
import { RailCard, RailColumn } from '../shell/ThreeColumns'

export type LibrarySection = 'templates' | 'resources' | 'directions'

/** 库页左列：模板 / 资源目录 / 测试方向。三个区共用同一条导轨，切换只换中列与右列。 */
export function LibraryRail({
  section, templates, directions, collapsed, onSection, onToggle,
}: {
  section: LibrarySection
  templates: number
  directions: number
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
            mark="T"
            name={t('library.templates')}
            count={templates}
            selected={section === 'templates'}
            collapsed={collapsed}
            onClick={() => onSection('templates')}
            testId="lib-section-templates"
          />
        </li>
        <li>
          <RailCard
            mark="R"
            name={t('resources.title')}
            selected={section === 'resources'}
            collapsed={collapsed}
            onClick={() => onSection('resources')}
            testId="lib-section-resources"
          />
        </li>
        <li>
          <RailCard
            mark="D"
            name={t('library.test_directions')}
            count={directions}
            selected={section === 'directions'}
            collapsed={collapsed}
            onClick={() => onSection('directions')}
            testId="lib-section-directions"
          />
        </li>
      </ul>
    </RailColumn>
  )
}
