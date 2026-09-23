/**
 * 骨架占位符判定：`document scaffold` 铺出来、作者还没替换的行。
 *
 * 真机验收（D7）：`scaffold` 之后立刻 `document record` 登记 proposal / design / tasks 全部成功，
 * 文档里仍满是 `[待填写]`——台账把一份空骨架当成了证据。登记闸据本模块拒绝它们。
 *
 * 判定只认模板渲染器自己写出的记号（DOCUMENT_PENDING_WORD / DOCUMENT_PROMPT_TAG / 各模板目录里的
 * 提示词），不猜「看起来像草稿」的文字：
 *   · `[待填写]` / `[pending]` 以及目录提示词里的 `[待填写:open]` 这类带阶段的记号；
 *   · 任务骨架行 `- [ ] 待填写`、场景骨架行 `- **WHEN** 待填写`、标题尾 `: 待填写`；
 *   · tasks.md 各阶段的提示任务（`- [ ] 将本阶段目标拆成可验证任务。`，勾上也仍是提示词）。
 */
import {
  DOCUMENT_LOCALES, DOCUMENT_LOCALE_CATALOGS, type DocumentLocale,
} from './document-presentation-registry.js'
import { DOCUMENT_PENDING_WORD, DOCUMENT_PROMPT_TAG } from './document-template-renderer.js'

export interface DocumentPlaceholder {
  /** 1 起的行号。 */
  readonly line: number
  readonly text: string
}

function escape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function localePatterns(locale: DocumentLocale): readonly RegExp[] {
  const pending = escape(DOCUMENT_PENDING_WORD[locale])
  const tag = DOCUMENT_PROMPT_TAG[locale]
  // `[待填写]` → 也认 `[待填写:open]`：目录提示词在同一个方括号记号后面带阶段名。
  const tagWord = escape(tag.slice(1, -1))
  const taskPrompt = escape(DOCUMENT_LOCALE_CATALOGS[locale]['workflow-tasks'].taskPrompt)
  return [
    new RegExp(`\\[${tagWord}(?::[A-Za-z0-9_-]+)?\\]`, 'u'),
    new RegExp(`^\\s*- \\[ \\] ${pending}\\s*$`, 'u'),
    new RegExp(`^\\s*- \\*\\*(?:WHEN|THEN)\\*\\* ${pending}\\s*$`, 'u'),
    new RegExp(`^#{1,6} .*: ${pending}\\s*$`, 'u'),
    new RegExp(`^\\s*- \\[[ xX]\\] ${taskPrompt}(?: \\([A-Za-z0-9_-]+\\))?\\s*$`, 'u'),
  ]
}

const PATTERNS: readonly RegExp[] = DOCUMENT_LOCALES.flatMap((locale) => localePatterns(locale))

/** 文档里仍未替换的骨架占位行（按出现顺序）；空 = 没有占位符。 */
export function findDocumentPlaceholders(content: string): readonly DocumentPlaceholder[] {
  const found: DocumentPlaceholder[] = []
  const lines = content.split('\n')
  for (const [index, text] of lines.entries()) {
    if (PATTERNS.some((pattern) => pattern.test(text))) found.push({ line: index + 1, text: text.trim() })
  }
  return found
}
