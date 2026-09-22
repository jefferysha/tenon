/**
 * 转换编排读 state 字段值的唯一口径：列表按逗号连接、缺省空串（对齐老仓 cmd_get 的 fstr）。
 *
 * 独立成模块只为一件事：default 轨规划器（transition-plan-default.ts）与编排层
 * （transition-application.ts）读同一份，而不是各自留一份三行副本。零 import，物理上无环。
 */
export function fieldStr(v: string | string[] | undefined): string {
  return Array.isArray(v) ? v.join(',') : (v ?? '')
}
