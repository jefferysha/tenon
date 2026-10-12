import { useCallback, useEffect, useLayoutEffect, useState } from 'react'

export type WorkbenchDirtySource = 'loop' | 'automation' | 'secrets'

export function useWorkbenchDirtyState(input: {
  localDirty: boolean
  onDirtyChange?: (dirty: boolean) => void
}): {
  dirty: boolean
  setSourceDirty: (source: WorkbenchDirtySource, dirty: boolean) => void
} {
  const [sources, setSources] = useState<Record<WorkbenchDirtySource, boolean>>({
    loop: false,
    automation: false,
    secrets: false,
  })
  const dirty = input.localDirty || Object.values(sources).some(Boolean)
  const setSourceDirty = useCallback((source: WorkbenchDirtySource, value: boolean) => {
    setSources((current) => current[source] === value ? current : { ...current, [source]: value })
  }, [])

  useLayoutEffect(() => {
    input.onDirtyChange?.(dirty)
  }, [dirty, input.onDirtyChange])
  useEffect(() => () => {
    input.onDirtyChange?.(false)
  }, [input.onDirtyChange])

  return { dirty, setSourceDirty }
}
