import { useEffect, useState } from 'react'
import { Check, Copy } from 'lucide-react'
import { useT } from '../i18n'
import { COPIED_MS } from '../shared/CommandLine'

/**
 * 表格单元里的可复制命令：等宽单行、永不折行、过长截断（全文在 title），行尾一个复制图标。
 * 与 CommandLine 的区别是没有底色块——表里一行一条命令，不该堆成一列色块。
 */
export function FixCommand({ command, testId }: { command: string; testId: string }): JSX.Element {
  const { t } = useT()
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = window.setTimeout(() => setCopied(false), COPIED_MS)
    return () => window.clearTimeout(timer)
  }, [copied])
  const label = copied ? t('tests.copied') : t('tests.copy')
  return (
    <span className="flex min-w-0 items-center gap-1" data-testid={testId}>
      <code className="min-w-0 truncate whitespace-nowrap font-mono text-caption text-text-2" title={command} data-testid={`${testId}-text`}>{command}</code>
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
    </span>
  )
}
