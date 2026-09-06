export const PAGE_FRAME = 'mx-auto w-full max-w-[1088px]'
export const PANEL = 'rounded-[22px] border border-border bg-card shadow-sm'
export const PANEL_SOFT = 'rounded-[22px] border border-border bg-fill/45 shadow-sm'
export const CARD = 'rounded-xl border border-border bg-card shadow-sm'
export const CARD_SOFT = 'rounded-xl border border-border bg-fill/45 shadow-sm'
export const EMPTY_STATE = 'rounded-2xl border border-dashed border-border bg-fill/45 px-6 py-10 text-center'
export const PILL = 'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-bold'
export const FIELD_LABEL = 'flex flex-col gap-1.5 text-xs font-semibold text-text-2'
export const FIELD_HELP = 'text-xs leading-5 text-text-3'
export const INPUT =
  'min-h-10 w-full rounded-xl border border-border bg-bg px-3.5 py-2 text-sm text-text outline-none transition-[border-color,box-shadow,background-color] placeholder:text-text-3 hover:border-border-2 focus-visible:border-(--accent) focus-visible:ring-2 focus-visible:ring-(--accent) focus-visible:ring-offset-2 focus-visible:ring-offset-bg focus-visible:outline-none aria-invalid:border-red aria-invalid:focus-visible:border-red aria-invalid:focus-visible:ring-red-t disabled:cursor-not-allowed disabled:opacity-60'
export const SELECT =
  'min-h-10 w-full appearance-none rounded-xl border border-border bg-card px-3.5 py-2 pr-9 text-sm text-text outline-none transition-[border-color,box-shadow,background-color] hover:border-border-2 focus-visible:border-(--accent) focus-visible:ring-2 focus-visible:ring-(--accent) focus-visible:ring-offset-2 focus-visible:ring-offset-bg focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60'
export const TEXTAREA = `${INPUT} min-h-28 resize-y leading-6`
export const BUTTON_SOLID =
  'inline-flex min-h-10 cursor-pointer items-center justify-center gap-2 whitespace-nowrap rounded-xl bg-btn-bg px-4 py-2 text-[12.5px] font-bold text-btn-fg outline-none transition-[background-color,transform,box-shadow] duration-150 hover:bg-btn-hover hover:shadow-sm active:translate-y-px focus-visible:ring-2 focus-visible:ring-(--accent) focus-visible:ring-offset-2 focus-visible:ring-offset-card disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transform-none'
export const BUTTON_GHOST =
  'inline-flex min-h-10 cursor-pointer items-center justify-center gap-2 whitespace-nowrap rounded-xl border border-border bg-card px-4 py-2 text-[12.5px] font-semibold text-text-2 outline-none transition-[background-color,border-color,color,box-shadow] duration-150 hover:border-border-2 hover:bg-fill hover:text-text focus-visible:ring-2 focus-visible:ring-(--accent) focus-visible:ring-offset-2 focus-visible:ring-offset-card disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none'
export const BUTTON_DANGER =
  'inline-flex min-h-10 cursor-pointer items-center justify-center gap-2 whitespace-nowrap rounded-xl border border-red-b bg-card px-4 py-2 text-[12.5px] font-semibold text-red-d outline-none transition-[background-color,border-color,color,box-shadow] duration-150 hover:border-red hover:bg-red-t focus-visible:ring-2 focus-visible:ring-(--accent) focus-visible:ring-offset-2 focus-visible:ring-offset-card disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none'
export const BUTTON_ICON =
  'grid size-10 place-items-center rounded-full text-text-3 transition-[background-color,color,transform] duration-150 hover:bg-fill hover:text-text focus-visible:ring-2 focus-visible:ring-(--accent) focus-visible:ring-offset-2 focus-visible:ring-offset-card disabled:cursor-not-allowed disabled:opacity-50'
export const BUTTON_SEGMENT =
  'inline-flex min-h-9 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg px-3 text-[13px] font-semibold text-text-3 transition-colors hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--accent) focus-visible:ring-offset-2 focus-visible:ring-offset-bg'
