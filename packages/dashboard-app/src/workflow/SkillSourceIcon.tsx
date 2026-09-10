import { Cpu, Package, Store, User } from 'lucide-react'
import type { WbSkillEntry } from '../api/governanceTypes'
import { useT } from '../i18n'

const ICONS = {
  'local-plugin': Package,
  'external-marketplace': Store,
  builtin: Cpu,
  user: User,
} as const

/** 技能来源图标：本地插件 / 市场 / 内建 / 用户；悬停显示文字。 */
export function SkillSourceIcon({ source, className = 'size-3.5' }: { source: WbSkillEntry['source']; className?: string }): JSX.Element {
  const { t } = useT()
  const Icon = ICONS[source]
  const label = t(`workflow.skill_source_${source}`)
  return (
    <span className="inline-flex flex-none items-center text-text-3" role="img" aria-label={label} title={label} data-testid={`skill-source-${source}`}>
      <Icon className={className} aria-hidden="true" />
    </span>
  )
}
