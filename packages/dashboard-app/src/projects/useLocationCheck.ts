import { useEffect, useState } from 'react'
import { instructionErrorKey } from '../api/instructionErrorKey'
import { planProjectCreate } from '../api/instructionsClient'
import { PROJECT_INSTRUCTION_FILES, type ProjectCreatePlan } from '../api/instructionsDecoders'
import { projectInput, type LocationInput } from './newProjectModel'

export interface LocationCheck {
  status: 'idle' | 'checking' | 'ok' | 'error'
  plan: ProjectCreatePlan | null
  errorKey: string | null
}

const IDLE: LocationCheck = { status: 'idle', plan: null, errorKey: null }
export const LOCATION_CHECK_DELAY_MS = 200

/**
 * 位置即时校验：位置一变就（短暂防抖后）dry run 目录本身——存在、是目录、是否 git 仓库、是否已登记；
 * 已有目录还带上三个指令文件，看哪些已存在。旧请求的结果一律丢弃；revision 变化时强制重查（执行失败退回位置时用）。
 */
export function useLocationCheck(location: LocationInput, ready: boolean, revision = 0): LocationCheck {
  const [check, setCheck] = useState<LocationCheck>(IDLE)
  const { mode, path, parent, name, gitInit } = location
  useEffect(() => {
    if (!ready) {
      setCheck(IDLE)
      return undefined
    }
    let live = true
    setCheck({ status: 'checking', plan: null, errorKey: null })
    const timer = setTimeout(() => {
      const probe = mode === 'existing' ? { text: '', targets: [...PROJECT_INSTRUCTION_FILES], base_digests: {} } : null
      planProjectCreate(projectInput({ mode, path, parent, name, gitInit }, [], probe))
        .then((plan) => { if (live) setCheck({ status: 'ok', plan, errorKey: null }) })
        .catch((error: unknown) => { if (live) setCheck({ status: 'error', plan: null, errorKey: instructionErrorKey(error) }) })
    }, LOCATION_CHECK_DELAY_MS)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [mode, path, parent, name, gitInit, ready, revision])
  return check
}
