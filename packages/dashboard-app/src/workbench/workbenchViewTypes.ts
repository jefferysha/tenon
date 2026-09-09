import type { Snapshot } from '../types'

export interface WorkbenchViewProps {
  root: string
  snapshot?: Snapshot | null
  /** App shell consumes one aggregate bit; domain children keep ownership of their own draft comparisons. */
  onDirtyChange?: (dirty: boolean) => void
}
