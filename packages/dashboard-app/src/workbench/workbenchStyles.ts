export {
  BUTTON_DANGER as BTN_DANGER,
  BUTTON_GHOST as BTN_GHOST,
  BUTTON_SOLID as BTN_SOLID,
  CARD as SIDE_CARD,
  FIELD_HELP as NOTE,
  INPUT as FIELD_INPUT,
  PILL,
} from '../shared/uiRecipes'

export const ERR_NOTE = 'p-5 text-body text-red'
export const SIDE_HEAD = 'flex items-center gap-2 border-b border-border px-3.5 py-3 text-text-3'
export const SIDE_HEAD_B = 'text-body font-bold text-text'
export const SIDE_BODY = 'px-3.5 pt-0.5 pb-1'
export const SIDE_ROW = 'flex items-center gap-2 py-2 text-caption text-text-2'
export const SIDE_ROW_LABEL = 'min-w-0 flex-1 truncate font-[550]'
export const SIDE_ROW_VALUE = 'flex-none font-mono text-base font-[750] text-accent-d'

/**
 * 触控命中区（PRD「触控目标满足可用尺寸」）：
 * · MOBILE_TAP：控件本身可以长高时，直接把窄屏最小高度抬到 44px（触控下限）。
 * · MOBILE_HIT：开关、图标按钮这类**视觉尺寸不能变**的小控件，用透明伪元素把命中盒撑到
 *   44×44——伪元素参与命中测试，视觉密度不变。只在所在行本身高度富余时用它，
 *   否则外扩的命中盒会盖住上下相邻控件。
 * 只在 `mobile`（≤720px）生效：桌面指针精度足够，放大反而拉散既有密度。
 */
export const MOBILE_TAP = 'mobile:min-h-11'
export const MOBILE_HIT =
  "relative mobile:before:absolute mobile:before:top-1/2 mobile:before:left-1/2 mobile:before:size-11 mobile:before:-translate-x-1/2 mobile:before:-translate-y-1/2 mobile:before:content-['']"
