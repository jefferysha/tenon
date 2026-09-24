import { useRef, useState, type ReactNode, type RefObject } from 'react'
import { Monitor, Moon, Settings, Sun, X } from 'lucide-react'
import { useT } from '../i18n'
import type { Lang } from '../i18n/translations'
import { handleRadioKey } from '../shared/radioKeyboard'
import { SEGMENT_SLIDE_S, SEGMENT_THUMB_CLS, useSlidingIndicator } from '../shared/useSlidingIndicator'
import type { ThemePreference } from './views'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'

/** 分段项：选中只换字色与字重，白色滑块由组内共享指示块提供。 */
const SEGMENT_CLS =
  'inline-flex min-h-10 flex-1 items-center justify-center gap-1.5 whitespace-nowrap rounded-sm px-2 text-caption font-semibold text-text-2 outline-none transition-colors duration-(--dur-fast) ease-(--ease-out) hover:text-text focus-visible:ring-2 focus-visible:ring-(--accent) aria-checked:text-text motion-reduce:transition-none'
const THEMES: readonly { value: ThemePreference; icon: typeof Monitor; key: string }[] = [
  { value: 'system', icon: Monitor, key: 'common.theme_system' },
  { value: 'light', icon: Sun, key: 'common.theme_light' },
  { value: 'dark', icon: Moon, key: 'common.theme_dark' },
]
const LANGS: readonly { value: Lang; key: string }[] = [
  { value: 'zh', key: 'common.switch_to_chinese' },
  { value: 'en', key: 'common.switch_to_english' },
]

/**
 * 顶栏设置：齿轮按钮 + Radix Popover（主题 / 语言两行分段控件）。弹层顶边对齐顶栏下沿：
 * 打开时量出触发钮底边到顶栏底边的距离作为 sideOffset。
 * testid：nav-settings / nav-settings-panel / theme-toggle / theme-option-<pref> / lang-toggle / lang-option-<lang>。
 */
export function TopBarSettings({ lang, onLang, theme, onTheme, barRef }: {
  lang: Lang
  onLang: (lang: Lang) => void
  theme: ThemePreference
  onTheme: (theme: ThemePreference) => void
  /** 顶栏本身：用来把弹层顶边对齐到它的下沿。 */
  barRef: RefObject<HTMLElement>
}): JSX.Element {
  const { t } = useT()
  const [open, setOpen] = useState(false)
  const [offset, setOffset] = useState(8)
  const triggerRef = useRef<HTMLButtonElement>(null)

  const onOpenChange = (next: boolean): void => {
    if (next) {
      const bar = barRef.current?.getBoundingClientRect()
      const trigger = triggerRef.current?.getBoundingClientRect()
      if (bar !== undefined && trigger !== undefined && bar.bottom > trigger.bottom) setOffset(Math.round(bar.bottom - trigger.bottom))
    }
    setOpen(next)
  }

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <button
          ref={triggerRef}
          type="button"
          className="grid size-10 place-items-center rounded-sm border border-border bg-card text-text-2 outline-none hover:text-text focus-visible:ring-2 focus-visible:ring-(--accent)"
          aria-label={t('common.settings')}
          data-testid="nav-settings"
        >
          <Settings className="size-4" aria-hidden="true" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={offset}
        aria-label={t('common.settings')}
        className="w-[320px] rounded-md border-0 bg-surface-raised p-3.5 shadow-(--shadow-2)"
        data-side-offset={offset}
        data-testid="nav-settings-panel"
      >
        <div className="mb-3 flex items-center justify-between gap-3 border-b border-border pb-3">
          <h2 className="text-base font-semibold text-text">{t('common.settings')}</h2>
          <button
            type="button"
            className="grid size-10 place-items-center rounded-sm text-text-3 outline-none hover:bg-fill hover:text-text focus-visible:ring-2 focus-visible:ring-(--accent)"
            aria-label={t('common.dialog_close')}
            onClick={() => setOpen(false)}
          >
            <X className="size-3.5" aria-hidden="true" />
          </button>
        </div>
        <div className="grid gap-3">
          <SegmentRow label={t('common.theme_toggle')} testId="theme-toggle">
            {THEMES.map((option, index) => {
              const Icon = option.icon
              return (
                <button
                  key={option.value}
                  type="button"
                  role="radio"
                  aria-checked={theme === option.value}
                  tabIndex={theme === option.value ? 0 : -1}
                  className={SEGMENT_CLS}
                  data-testid={`theme-option-${option.value}`}
                  onClick={() => onTheme(option.value)}
                  onKeyDown={(event) => handleRadioKey(event, index, THEMES.length, (next) => onTheme(THEMES[next]?.value ?? option.value))}
                >
                  <Icon className="size-4" aria-hidden="true" />
                  {t(option.key)}
                </button>
              )
            })}
          </SegmentRow>
          <SegmentRow label={t('common.language')} testId="lang-toggle">
            {LANGS.map((option, index) => (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={lang === option.value}
                tabIndex={lang === option.value ? 0 : -1}
                lang={option.value === 'zh' ? 'zh-CN' : 'en'}
                className={SEGMENT_CLS}
                data-testid={`lang-option-${option.value}`}
                onClick={() => onLang(option.value)}
                onKeyDown={(event) => handleRadioKey(event, index, LANGS.length, (next) => onLang(LANGS[next]?.value ?? option.value))}
              >
                {t(option.key)}
              </button>
            ))}
          </SegmentRow>
        </div>
      </PopoverContent>
    </Popover>
  )
}

/** 设置面板的一行：左侧名词标签 + 右侧分段控件（radiogroup，fill 轨道 + 白色滑块，滑块切换时滑动 180ms）。 */
function SegmentRow({ label, testId, children }: { label: string; testId: string; children: ReactNode }): JSX.Element {
  const { containerRef, indicatorRef } = useSlidingIndicator<HTMLDivElement>({ duration: SEGMENT_SLIDE_S })
  return (
    <div className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-3">
      <span className="whitespace-nowrap text-caption font-semibold text-text-2" aria-hidden="true">{label}</span>
      <div ref={containerRef} className="relative isolate flex gap-0.5 rounded-md bg-fill p-0.5" role="radiogroup" aria-label={label} data-testid={testId}>
        {children}
        <span ref={indicatorRef} className={SEGMENT_THUMB_CLS} aria-hidden="true" data-testid={`${testId}-indicator`} />
      </div>
    </div>
  )
}
