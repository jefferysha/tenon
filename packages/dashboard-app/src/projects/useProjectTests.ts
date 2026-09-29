import { useMemo, useState } from 'react'
import { fetchWorkflow } from '../api/governanceClient'
import type { WbWorkflowDef } from '../api/governanceTypes'
import { fetchTestCatalog } from '../api/testSystemClient'
import type { TestCatalogResponse } from '../api/testSystemTypes'
import { useRemote, type Remote } from '../tests/useRemote'

export interface ProjectTests {
  readonly catalog: Remote<TestCatalogResponse>
  readonly reload: () => void
  /** 覆盖率门槛来自 default 工作流的策略；取不到就是 null（不挡页面）。 */
  readonly workflow: WbWorkflowDef | null
  readonly selectedId: string | null
  readonly select: (id: string) => void
}

/**
 * 项目页「测试」视图的数据：项目测试目录（含已知失败与各套件最近结果）+ default 工作流（只为覆盖率门槛）。
 * 只在「测试」分段打开时读；快照版本变化时重读；选中项不在列表里时落到第一个套件（右列不留空）。
 */
export function useProjectTests(root: string, revision: string, enabled: boolean): ProjectTests {
  const active = enabled && root !== ''
  const { state: catalog, reload } = useRemote((signal) => fetchTestCatalog(root, signal), [root, revision], active)
  const { state: workflow } = useRemote((): Promise<WbWorkflowDef> => fetchWorkflow('default', root), [root], active)
  const [picked, setPicked] = useState<string | null>(null)
  const suites = catalog.status === 'ready' && catalog.data.catalog.state === 'ok' ? catalog.data.catalog.suites : []
  const selectedId = useMemo(
    () => (suites.some((suite) => suite.id === picked) ? picked : suites[0]?.id ?? null),
    [suites, picked],
  )
  return {
    catalog,
    reload,
    workflow: workflow.status === 'ready' ? workflow.data : null,
    selectedId,
    select: setPicked,
  }
}
