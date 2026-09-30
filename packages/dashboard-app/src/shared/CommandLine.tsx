import { useEffect, useState } from 'react'
import { Check, Copy } from 'lucide-react'
import { useT } from '../i18n'

/** 复制成功后勾号停留的时长。 */
export const COPIED_MS = 1200

/**
 * 单行命令块：中性等宽底、永不折行（过长横向滚动）+ 行尾复制按钮，复制成功后短暂变勾。
 * 复制按钮视觉 32px，伪元素向外扩 4px，点击区 40px。truncate = 过长截断（全文进 title），用于窄列：
 * true 从尾部省略；'start' 从头部省略——命令的关键部分在末尾（`cd <路径> && tenon status <change>`）时用它。 */
export function CommandLine({ command, testId, truncate = false }: { command: string; testId: string; truncate?: boolean | 'start' }): JSX.Element {
  const { t } = useT()
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = window.setTimeout(() => setCopied(false), COPIED_MS)
    return () => window.clearTimeout(timer)
  }, [copied])
  const label = copied ? t('workspace.copied') : t('workspace.copy_command')
  return (
    <div className="flex min-w-0 items-center gap-1 rounded-sm bg-(--code-bg) pl-3" data-testid={testId}>
      <code
        // 头部省略：rtl 令省略号落在左侧，bdi 保持命令自身从左到右（标点不被 rtl 重排）。
        className={`min-w-0 flex-1 py-2 font-mono text-body whitespace-nowrap text-text ${truncate ? 'truncate' : 'overflow-x-auto'}${truncate === 'start' ? ' text-left [direction:rtl]' : ''}`}
        title={truncate ? command : undefined}
        data-truncate={truncate === 'start' ? 'start' : undefined}
        data-testid={`${testId}-text`}
      >
        {truncate === 'start' ? <bdi dir="ltr">{command}</bdi> : command}
      </code>
      <button
        type="button"
        className="relative grid size-8 flex-none place-items-center rounded-sm text-text-3 outline-none after:absolute after:-inset-1 after:content-[''] hover:bg-fill-2 hover:text-text focus-visible:ring-2 focus-visible:ring-(--accent)"
        aria-label={label}
        title={label}
        data-copied={copied}
        data-testid={`${testId}-copy`}
        onClick={() => { void navigator.clipboard?.writeText(command).then(() => setCopied(true), () => undefined) }}
      >
        {copied ? <Check className="size-4 text-(--accent)" aria-hidden="true" /> : <Copy className="size-4" aria-hidden="true" />}
      </button>
    </div>
  )
}
