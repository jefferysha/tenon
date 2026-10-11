import { useEffect, useState } from 'react'
import { fetchSkillsRegistry, type WbSkillEntry } from '../api/client'

/**
 * 技能候选池（GET /api/skills/registry），挂载即拉：芯片的「未装」徽章与添加候选都要知道哪些技能已安装。
 * fail-soft：失败就保持 null，添加入口禁用（不可判就不给写入口，不谎报）；失败不重试打转。
 */
export function useSkillRegistry(): WbSkillEntry[] | null {
  const [registry, setRegistry] = useState<WbSkillEntry[] | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    if (registry !== null || failed) return
    let cancelled = false
    fetchSkillsRegistry()
      .then((skills) => { if (!cancelled) setRegistry(skills) })
      .catch(() => { if (!cancelled) setFailed(true) })
    return () => { cancelled = true }
  }, [registry, failed])
  return registry
}
