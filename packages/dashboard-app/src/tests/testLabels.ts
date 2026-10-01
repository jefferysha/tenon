/**
 * 阻塞码 / 提示码的短标签取自 kernel（与 `tenon status` 同源），按当前语言选中文或英文；
 * 不认识的码原样显示，不猜测。前端不另存一份文案。
 */
import { TEST_BLOCKER_CODES, TEST_BLOCKER_LABELS, TEST_NOTICE_CODES, TEST_NOTICE_LABELS } from '@tenon/kernel/test-system/blockers'
import { INTEGRITY_SIGNAL_CODES, INTEGRITY_SIGNAL_LABELS } from '@tenon/kernel/test-system/integrity-labels'
import { RUN_SCOPES, TEST_KINDS } from '@tenon/kernel/test-system/vocabulary'
import type { Lang } from '../i18n/translations'

type Translate = (key: string) => string

export function blockerLabel(code: string, lang: Lang): string {
  const known = TEST_BLOCKER_CODES.find((item) => item === code)
  return known === undefined ? code : TEST_BLOCKER_LABELS[known][lang]
}

export function noticeLabel(code: string, lang: Lang): string {
  const known = TEST_NOTICE_CODES.find((item) => item === code)
  return known === undefined ? code : TEST_NOTICE_LABELS[known][lang]
}

/** 测试完整性信号的短标签（kernel 与 `tenon test integrity` 同源）；不认识的码原样显示。 */
export function integrityLabel(code: string, lang: Lang): string {
  const known = INTEGRITY_SIGNAL_CODES.find((item) => item === code)
  return known === undefined ? code : INTEGRITY_SIGNAL_LABELS[known][lang]
}

/** 失败 / 提示原因码的短标签：先按阻塞码，再按提示码；都不认识就原样（不猜）。完整说明由调用方放进 Tooltip。 */
export function reasonLabel(code: string, lang: Lang): string {
  const blocker = TEST_BLOCKER_CODES.find((item) => item === code)
  if (blocker !== undefined) return TEST_BLOCKER_LABELS[blocker][lang]
  return noticeLabel(code, lang)
}

/** 种类的界面词（单测 / Unit …）；不在闭集里的原样显示。标识本身放 Tooltip（KindLabel）。 */
export function kindLabel(kind: string, t: Translate): string {
  return TEST_KINDS.some((item) => item === kind) ? t(`tests.kind.${kind}`) : kind
}

/** 运行范围的界面词（全量 / 变更 / 文件 / 筛选 / 已知失败）；不认识的原样。 */
export function scopeLabel(scope: string, t: Translate): string {
  return RUN_SCOPES.some((item) => item === scope) ? t(`tests.scope.${scope}`) : scope
}
