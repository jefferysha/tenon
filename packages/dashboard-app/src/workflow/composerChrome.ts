import { cn } from '@/lib/utils'
import { LIST_SELECTED } from '../shared/uiRecipes'

/**
 * 技能 / agent 编辑浮层共用的外观：三栏（候选 · 画布 · 预览）合成一个表面，栏间只用发丝线分隔；
 * 候选行常驻名称 + 来源图标，拖拽柄与「+」在悬停或键盘聚焦到该行时才显出（触屏常显）。
 */
export const COMPOSER_SURFACE = 'grid h-full min-h-0 divide-x divide-border overflow-hidden rounded-lg border border-border bg-card max-[900px]:divide-x-0 max-[900px]:divide-y'
export const COMPOSER_PALETTE = 'flex min-h-0 flex-col gap-2 p-2'
export const COMPOSER_CANVAS = 'min-h-0 rounded-none border-0'
export const COMPOSER_DETAIL = 'flex min-h-0 flex-col overflow-hidden p-4 max-[1100px]:hidden'
export const COMPOSER_SEARCH = 'flex h-9 flex-none items-center gap-2 rounded-sm border border-border bg-card px-2 text-text-3 focus-within:border-accent-b'
/** 悬停 / 聚焦该行才出现；不改布局（只改透明度），不会让名称跳动。 */
export const ROW_REVEAL = 'opacity-0 transition-opacity duration-(--dur-fast) group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100 motion-reduce:transition-none'
export const ROW_ADD = cn('grid size-10 flex-none place-items-center rounded-sm text-text-3 outline-none enabled:hover:bg-fill enabled:hover:text-text focus-visible:ring-2 focus-visible:ring-(--accent) disabled:invisible', ROW_REVEAL)

export function paletteRowClass(active: boolean, placed: boolean): string {
  return cn(
    'group flex min-w-0 items-center gap-1 rounded-md pl-1 transition-colors duration-(--dur-fast)',
    active ? LIST_SELECTED : 'hover:bg-fill',
    placed ? 'opacity-45' : 'cursor-grab active:cursor-grabbing',
  )
}

export function paletteNameClass(active: boolean): string {
  return cn('min-w-0 flex-1 truncate whitespace-nowrap font-mono text-body', active ? 'font-semibold text-text' : 'text-text')
}
