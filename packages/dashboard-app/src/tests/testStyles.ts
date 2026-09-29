/** 测试视图共用的表格与徽标样式类：表头一行灰字、行间一条细线、单元格永不折行。 */

/** 计数徽标（「3」「+2」）：fill 底、等宽数字，唯一允许的药丸形。 */
export const COUNT_BADGE = 'inline-grid h-5 min-w-5 place-items-center rounded-sm bg-fill px-1.5 text-micro font-semibold tabular-nums text-text-2'

export const TABLE_HEAD = 'border-b border-border px-1 pb-1.5 text-caption text-text-3'
export const TABLE_ROW = 'min-h-10 border-b border-border px-1 py-1 text-body last:border-0'

/** 一行的网格外壳：列宽由调用方给，所有格子不折行。 */
export function gridRow(columns: string): string {
  return `grid ${columns} items-center gap-3 whitespace-nowrap`
}

/** 危险色文字 + 红点用的类：越界的数值、失败的行。 */
export const DANGER_TEXT = 'text-red-d'
