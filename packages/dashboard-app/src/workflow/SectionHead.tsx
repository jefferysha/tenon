/** 右栏段头一行：标题 · 计数 · 动作。 */
export function SectionHead({ title, count, action }: { title: string; count?: number; action?: JSX.Element }): JSX.Element {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <h2 className="whitespace-nowrap text-title font-semibold text-text">
        {title}
        {count !== undefined && <span className="ml-2 font-mono text-caption font-normal text-text-3">{count}</span>}
      </h2>
      {action}
    </div>
  )
}

export const HEAD_ACTION = 'inline-flex items-center gap-1.5 whitespace-nowrap text-body text-text-2 outline-none hover:text-text focus-visible:ring-2 focus-visible:ring-(--accent)'
