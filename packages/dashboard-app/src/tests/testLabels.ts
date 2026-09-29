/**
 * 阻塞码 / 提示码的短标签取自 kernel（与 `tenon status` 同源），按当前语言选中文或英文；
 * 不认识的码原样显示，不猜测。前端不另存一份文案。
 */
import { TEST_BLOCKER_CODES, TEST_BLOCKER_LABELS, TEST_NOTICE_CODES, TEST_NOTICE_LABELS } from '@tenon/kernel/test-system/blockers'
import type { Lang } from '../i18n/translations'

export function blockerLabel(code: string, lang: Lang): string {
  const known = TEST_BLOCKER_CODES.find((item) => item === code)
  return known === undefined ? code : TEST_BLOCKER_LABELS[known][lang]
}

export function noticeLabel(code: string, lang: Lang): string {
  const known = TEST_NOTICE_CODES.find((item) => item === code)
  return known === undefined ? code : TEST_NOTICE_LABELS[known][lang]
}
