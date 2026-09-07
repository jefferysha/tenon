import { Check } from 'lucide-react'

export type StageState = 'done' | 'current' | 'pending'

export function StageNode({ state }: { state: StageState }): JSX.Element {
  if (state === 'done') {
    return (
      <span className="relative z-10 flex h-8 w-8 items-center justify-center rounded-full bg-(--accent) text-btn-fg shadow-sm">
        <Check className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
      </span>
    )
  }
  if (state === 'current') {
    return (
      <span className="relative z-10 flex h-8 w-8 items-center justify-center">
        <span className="absolute h-10 w-10 rounded-full bg-amber-t" aria-hidden="true" />
        <span className="relative flex h-8 w-8 items-center justify-center rounded-full border-2 border-amber-b bg-card">
          <span className="h-3 w-3 rounded-full bg-amber-d" aria-hidden="true" />
        </span>
      </span>
    )
  }
  return (
    <span className="relative z-10 flex h-8 w-8 items-center justify-center rounded-full border-2 border-border-2 bg-card">
      <span className="h-2 w-2 rounded-full bg-border-2" aria-hidden="true" />
    </span>
  )
}
