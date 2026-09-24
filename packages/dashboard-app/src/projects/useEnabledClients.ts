import { useCallback, useState } from 'react'
import type { InstructionHostRow, InstructionTarget } from '../api/instructionsDecoders'
import { derivedEnabled } from './clientModel'

const KEY_PREFIX = 'tenon-dashboard-clients:'

function readStored(root: string): string[] | null {
  try {
    const raw = localStorage.getItem(`${KEY_PREFIX}${root}`)
    if (raw === null) return null
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) && parsed.every((item) => typeof item === 'string') ? parsed : null
  } catch {
    return null
  }
}

function writeStored(root: string, ids: readonly string[]): void {
  try { localStorage.setItem(`${KEY_PREFIX}${root}`, JSON.stringify(ids)) } catch { /* 存不下就只在本次会话生效 */ }
}

export interface EnabledClients {
  readonly enabled: readonly string[]
  enable: (id: string) => void
  disable: (id: string) => void
}

/**
 * 项目启用了哪些客户端。启用 / 停用只记在本机浏览器（按项目根），不动任何文件；
 * 从没记过时按盘上已存在的项目级文件推导。
 */
export function useEnabledClients(
  root: string, hosts: readonly InstructionHostRow[], targets: readonly InstructionTarget[],
): EnabledClients {
  const [stored, setStored] = useState<{ root: string; ids: string[] | null }>(() => ({ root, ids: readStored(root) }))
  // 换项目时在渲染中同步换成新项目的记录，不先闪一帧上一个项目的客户端。
  const ids = stored.root === root ? stored.ids : readStored(root)
  if (stored.root !== root) setStored({ root, ids })
  const enabled = ids ?? derivedEnabled(hosts, targets)

  const save = useCallback((next: string[]): void => {
    setStored({ root, ids: next })
    writeStored(root, next)
  }, [root])

  return {
    enabled,
    enable: (id) => { if (!enabled.includes(id)) save([...enabled, id]) },
    disable: (id) => save(enabled.filter((candidate) => candidate !== id)),
  }
}
