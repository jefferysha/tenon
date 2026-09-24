/*
 * 共享样式配方。按钮与图标按钮点击区不小于 40px（min-h-10 / size-10）。
 * 禁用态换成 fill 底 + text-3 字，不靠整体透明度——透明度会把主按钮压到约 2.5:1，读不出字。
 * hover / active 只挂在 enabled: 上，禁用按钮悬停不再变色。
 */
export const PAGE_FRAME = 'mx-auto w-full max-w-[1088px]'
export const PANEL = 'rounded-lg border border-border bg-card shadow-sm'
export const PANEL_SOFT = 'rounded-lg border border-border bg-fill/45 shadow-sm'
export const CARD = 'rounded-md border border-border bg-card shadow-sm'
export const CARD_SOFT = 'rounded-md border border-border bg-fill/45 shadow-sm'
export const EMPTY_STATE = 'rounded-lg border border-dashed border-border bg-fill/45 px-6 py-10 text-center'
export const PILL = 'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-micro font-bold'
export const FIELD_LABEL = 'flex flex-col gap-1.5 text-caption font-semibold text-text-2'
export const FIELD_HELP = 'text-caption leading-5 text-text-3'
export const INPUT =
  'min-h-10 w-full rounded-md border border-border bg-bg px-3.5 py-2 text-base text-text outline-none transition-[border-color,box-shadow,background-color] placeholder:text-text-3 hover:border-border-2 focus-visible:border-(--accent) focus-visible:ring-2 focus-visible:ring-(--accent) focus-visible:ring-offset-2 focus-visible:ring-offset-bg focus-visible:outline-none aria-invalid:border-red aria-invalid:focus-visible:border-red aria-invalid:focus-visible:ring-red-t disabled:cursor-not-allowed disabled:opacity-60'
export const SELECT =
  'min-h-10 w-full appearance-none rounded-md border border-border bg-card px-3.5 py-2 pr-9 text-base text-text outline-none transition-[border-color,box-shadow,background-color] hover:border-border-2 focus-visible:border-(--accent) focus-visible:ring-2 focus-visible:ring-(--accent) focus-visible:ring-offset-2 focus-visible:ring-offset-bg focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60'
export const TEXTAREA = `${INPUT} min-h-28 resize-y leading-6`
export const BUTTON_SOLID =
  'inline-flex min-h-10 cursor-pointer items-center justify-center gap-2 whitespace-nowrap rounded-md bg-btn-bg px-4 py-2 text-caption font-bold text-btn-fg outline-none transition-[background-color,transform,box-shadow] duration-150 enabled:hover:bg-btn-hover enabled:hover:shadow-sm enabled:active:translate-y-px focus-visible:ring-2 focus-visible:ring-(--accent) focus-visible:ring-offset-2 focus-visible:ring-offset-card disabled:cursor-not-allowed disabled:bg-fill-2 disabled:text-text-3 motion-reduce:transform-none'
export const BUTTON_GHOST =
  'inline-flex min-h-10 cursor-pointer items-center justify-center gap-2 whitespace-nowrap rounded-md border border-border bg-card px-4 py-2 text-caption font-semibold text-text-2 outline-none transition-[background-color,border-color,color,box-shadow] duration-150 enabled:hover:border-border-2 enabled:hover:bg-fill enabled:hover:text-text focus-visible:ring-2 focus-visible:ring-(--accent) focus-visible:ring-offset-2 focus-visible:ring-offset-card disabled:cursor-not-allowed disabled:bg-fill disabled:text-text-3 motion-reduce:transition-none'
export const BUTTON_DANGER =
  'inline-flex min-h-10 cursor-pointer items-center justify-center gap-2 whitespace-nowrap rounded-md border border-red-b bg-card px-4 py-2 text-caption font-semibold text-red-d outline-none transition-[background-color,border-color,color,box-shadow] duration-150 enabled:hover:border-red enabled:hover:bg-red-t focus-visible:ring-2 focus-visible:ring-(--accent) focus-visible:ring-offset-2 focus-visible:ring-offset-card disabled:cursor-not-allowed disabled:border-border disabled:bg-fill disabled:text-text-3 motion-reduce:transition-none'
export const BUTTON_ICON =
  'grid size-10 place-items-center rounded-full text-text-3 transition-[background-color,color,transform] duration-150 enabled:hover:bg-fill enabled:hover:text-text focus-visible:ring-2 focus-visible:ring-(--accent) focus-visible:ring-offset-2 focus-visible:ring-offset-card disabled:cursor-not-allowed disabled:text-text-4'
export const BUTTON_SEGMENT =
  'inline-flex min-h-10 items-center justify-center gap-1.5 whitespace-nowrap rounded-md px-3 text-body font-semibold text-text-3 transition-colors hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--accent) focus-visible:ring-offset-2 focus-visible:ring-offset-bg'
