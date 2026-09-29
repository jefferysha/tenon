import { Bot, FileText, FlaskConical, Package } from 'lucide-react'
import { useT } from '../i18n'
import { RailCard, RailColumn } from '../shell/ThreeColumns'

export type LibrarySection = 'templates' | 'resources' | 'test-templates' | 'agents'

/** 库页左列：模板 / 资源目录 / 测试模板 / agent。各区共用同一条导轨，切换只换中列与右列。 */
export function LibraryRail({
  section, templates, resources, testTemplates, agents, collapsed, onSection, onToggle,
}: {
  section: LibrarySection
  /** null = 还在读取：计数显示「–」，不显示假的 0。 */
  templates: number | null
  resources: number | null
  testTemplates: number | null
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
            name={t('library.test_templates')}
            count={testTemplates ?? '–'}
            selected={section === 'test-templates'}
            collapsed={collapsed}
            onClick={() => onSection('test-templates')}
            testId="lib-section-test-templates"
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
