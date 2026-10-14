import { useMemo, useState } from 'react'
import { fetchTestCatalog } from '../api/testSystemClient'
import type { TestCatalogResponse } from '../api/testSystemTypes'
import { useRemote, type Remote } from '../tests/useRemote'

export interface ProjectTests {
  readonly catalog: Remote<TestCatalogResponse>
  readonly reload: () => void
  readonly selectedId: string | null
  readonly select: (id: string) => void
}

/**
 * 项目页「测试」视图的数据：项目测试目录（含档位定义、已知失败与各套件最近结果）。
 * 只在「测试」分段打开时读；快照版本变化时重读；选中项不在列表里时落到第一个套件（右列不留空）。
 */
export function useProjectTests(root: string, revision: string, enabled: boolean): ProjectTests {
  const active = enabled && root !== ''
  const { state: catalog, reload } = useRemote((signal) => fetchTestCatalog(root, signal), [root, revision], active)
  const [picked, setPicked] = useState<string | null>(null)
  const suites = catalog.status === 'ready' && catalog.data.catalog.state === 'ok' ? catalog.data.catalog.suites : []
  const selectedId = useMemo(
    () => (suites.some((suite) => suite.id === picked) ? picked : suites[0]?.id ?? null),
    [suites, picked],
  )
  return { catalog, reload, selectedId, select: setPicked }
}
