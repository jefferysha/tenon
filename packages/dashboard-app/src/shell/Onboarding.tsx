import { useT } from '../i18n'
import { BUTTON_SOLID } from '../shared/uiRecipes'
import { Icon } from './Icon'

export interface OnboardingProps {
  kind: 'no-project'
  /** 打开「新建项目」：选已有目录接入，或新建空目录。 */
  onNewProject?: () => void
}

const EMPTY_CLS = 'mx-auto my-[8vh] rounded-md border border-border bg-card px-8 py-8 text-center'
const EMPTY_MARK_CLS = 'mx-auto mb-3.5 grid h-[42px] w-[42px] place-items-center rounded-md bg-ink text-ink-fg'
const EMPTY_TITLE_CLS = 'mb-2 text-title font-bold text-text'
const EMPTY_DESC_CLS = 'mb-4 text-caption leading-[1.7] text-text-3'

/**
 * 零项目状态：Dashboard 自己就能建项目（选已有目录或建新目录并 git init），所以这里只给一个动作，
 * 不再教用户回终端敲命令。
 */
export function Onboarding({ onNewProject }: OnboardingProps): JSX.Element {
  const { t } = useT()
  return (
    <div className={`${EMPTY_CLS} max-w-[620px]`} data-testid="onboard-no-project">
      <div className={EMPTY_MARK_CLS} aria-hidden="true"><Icon name="folder" size={20} /></div>
      <h1 className={EMPTY_TITLE_CLS}>{t('onboard.no_project_title')}</h1>
      <p className={EMPTY_DESC_CLS}>{t('onboard.no_project_desc')}</p>
      <button type="button" className={BUTTON_SOLID} data-testid="onboard-new-project" onClick={() => onNewProject?.()}>
        {t('projects.new_project')}
      </button>
    </div>
  )
}
