import { useT } from '../i18n'
import { Drawer } from '../shared/Drawer'
import type { SuiteVerdict, TestPolicyView } from '../api/testSystemTypes'

/** 要打开的一次套件运行：记录所属用户、运行 id 与套件 id。 */
export interface SuiteRunTarget {
  readonly user: string
  readonly runId: string
  readonly suite: string
}

export interface SuiteRunDrawerProps {
  root: string
  change: string
  target: SuiteRunTarget | null
  /** 该套件在所选阶段的判定（过期原因、基准对比）；缺省 = 只看记录本身。 */
  verdict?: SuiteVerdict
  /** 所选阶段的策略（覆盖率门槛）。 */
  policy?: TestPolicyView | null
  onClose: () => void
}

/** 套件运行详情抽屉：命令与退出码、失败用例、产物、覆盖率、基准、日志。 */
export function SuiteRunDrawer({ target, verdict, onClose }: SuiteRunDrawerProps): JSX.Element | null {
  const { t } = useT()
  if (target === null) return null
  const name = verdict?.label ?? target.suite
  return (
    <Drawer open onClose={onClose} testId="suite-run-drawer" ariaLabel={name} title={<span className="truncate">{name}</span>}>
      <p className="text-body text-text-3">{t('tests.word.suite')}</p>
    </Drawer>
  )
}
