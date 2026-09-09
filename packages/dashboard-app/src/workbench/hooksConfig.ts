import { useEffect, useRef, useState } from 'react'
import {
  fetchHooksConfig,
  postHookToggle,
  postPromptRoutingBypass,
  type WbHookMeta,
} from '../api/client'
import { useT } from '../i18n'
import { ApiError, formatApiError } from '../api/transport'

/**
 * 工作台 Hook 配置的**数据层**（原 HookTimeline.tsx 的呈现组件已删除，见下）。
 *
 * 数据面消费 T5（决议#2）：GET /api/hooks 给 8 hook 元数据 + 阶段×hook 禁用矩阵
 * （只存禁用项，缺键=启用，fail-open）；POST /api/hooks 按**当前选中阶段**写回单键。
 * 时机归类以 server HOOK_METAS（= hooks/hooks.json plugin 注册）为准，前端不凭名字猜。
 *
 * 状态托管在 useHooksConfig（WorkbenchView 持有）而非呈现组件：阶段卡 hooksCount 真数与
 * 摘要卡「钩子」行都要吃同一份矩阵，数据必须住在共同祖先。
 *
 * 三档呈现（决议#2）现在**只有一个实现**：TimelineHookRows.tsx（经 ExecutionTimelineComposer
 * 挂载）。历史上另有 HookTimeline 与 OrchestrationHookBody/OrchestrationBoard 两套并行渲染，
 * 三套语义已分叉且后两套从未被挂载（测试仍在守护用户看不到的组件），已于本轮删除——
 * 新增 hook 呈现改动只改 TimelineHookRows，不要再复制第二套。
 *   · configurable=true（session-start/breadcrumb/router/skill-tracker）：开关可点，
 *     乐观更新（点击即翻，POST 失败回滚 + 错误提示）；
 *   · 强制常开（gate/interactive-skill-gate，见 LOCKED_IDS）：「强制常开」badge + 不给开关——
 *     交互门/安全门关掉 = 整个 gate 语义失效，server 写端点也会 400；
 *   · 暂不可配（confirm-clear/decision-recorder）：卡灰显 +「暂不可配」badge——sh 侧
 *     未接线，开放开关就是「设置不起效」，违反交付门槛②。
 * 后两档实际都在跑，故状态标签恒显「已启用」，不拿矩阵残留键谎报「已停用」。
 *
 * 注意：hooks.json 是 per-root 运行时配置、不属于 workflow def 草稿——default workflow
 * 只读态下本区照常可切（不走保存钮，写回即时生效），与 StepEditor 的 readonly 无关。
 */

/**
 * 强制常开（决议#2）：configurable:false 里的「安全门/交互门」子集；其余 false 项 = 暂不可配。
 * v6 计划 T11：export 供 WorkbenchView 的流程带门徽章 popover 复用同一对 id（静态兜底展示,
 * 不依赖本文件内部状态）——TimelineHookRows 与流程带门徽章消费同一个常量,不重复定义。
 */
export const LOCKED_IDS: ReadonlySet<string> = new Set(['gate', 'interactive-skill-gate'])

export interface HooksConfigState {
  /** null = 加载中或加载失败（loadError 区分）——消费方此时隐藏计数（诚实占位，不谎报）。 */
  hooks: WbHookMeta[] | null
  matrix: Record<string, false>
  loadError: string | null
  toggleError: string | null
  promptSkipKeyword: string | null
  promptSkipBusy: boolean
  promptSkipError: string | null
  /** Prompt routing editor reports its unsaved effective keyword into Workbench's aggregate guard. */
  onPromptSkipDirtyChange?: (dirty: boolean) => void
  /** 在途写回的 `<hook>.<阶段>` 键：对应开关禁用，防同键乱序竞态。 */
  busyKeys: ReadonlySet<string>
  toggle: (hook: string, phase: string, enabled: boolean) => void
  savePromptSkipKeyword: (keyword: string) => Promise<boolean>
  /** 某阶段的启用 hook 数（含强制常开——它们真的在跑）；数据未就绪 → undefined。 */
  enabledCount: (phase: string) => number | undefined
}

/**
 * /api/hooks 的读写状态托管（WorkbenchView 调用，传给 TimelineHookRows/阶段卡/摘要三个消费方）。
 * toggle 乐观更新：先翻本地矩阵再 POST，失败按原值回滚 + toggleError 提示（验收②）。
 *
 * T17：可选 onError——宿主（App 经 WorkbenchView）传入时，写回失败的提示改走它（接全局
 * showFlash），不再落 toggleError 行内 alert（两处同时报同一件事是重复）；缺省行为与 T15 一致。
 */
export function useHooksConfig(
  root: string,
  onError?: (msg: string) => void,
  onPromptSkipDirtyChange?: (dirty: boolean) => void,
): HooksConfigState {
  const { t, lang } = useT()
  const tRef = useRef(t)
  tRef.current = t
  const langRef = useRef(lang)
  langRef.current = lang
  const [hooks, setHooks] = useState<WbHookMeta[] | null>(null)
  const [matrix, setMatrix] = useState<Record<string, false>>({})
  const [loadFailed, setLoadFailed] = useState(false)
  const [toggleError, setToggleError] = useState<string | null>(null)
  const [promptSkipKeyword, setPromptSkipKeyword] = useState<string | null>(null)
  const [promptSkipBusy, setPromptSkipBusy] = useState(false)
  const [promptSkipFailed, setPromptSkipFailed] = useState(false)
  const promptSkipGeneration = useRef(0)
  const toggleSequence = useRef(0)
  const toggleTokens = useRef(new Map<string, number>())
  const rootIdentity = useRef(root)
  rootIdentity.current = root
  const [busyKeys, setBusyKeys] = useState<ReadonlySet<string>>(new Set())

  useEffect(() => {
    let cancelled = false
    promptSkipGeneration.current += 1
    toggleTokens.current.clear()
    setHooks(null)
    setMatrix({})
    setLoadFailed(false)
    setToggleError(null)
    setPromptSkipKeyword(null)
    setPromptSkipBusy(false)
    setPromptSkipFailed(false)
    setBusyKeys(new Set())
    fetchHooksConfig(root)
      .then((body) => {
        if (cancelled) return
        setHooks(body.hooks)
        setMatrix(body.matrix)
        setPromptSkipKeyword(body.promptSkipKeyword)
      })
      .catch(() => {
        // 加载失败不挡工作台其余区块：计数回落 '—' 占位、时序线区行内报错。
        if (cancelled) return
        setLoadFailed(true)
      })
    return () => {
      cancelled = true
      promptSkipGeneration.current += 1
      toggleTokens.current.clear()
    }
  }, [root])

  useEffect(() => {
    setToggleError(null)
  }, [lang])

  // 故意不 useCallback：闭包要读最新 busyKeys 守卫（WorkbenchView 脏守卫四件套的同一条
  // React 记忆化纪律——冻结的快照会放行同键并发写）。
  function toggle(hook: string, phase: string, enabled: boolean): void {
    const key = `${hook}.${phase}`
    if (busyKeys.has(key)) return
    const targetRoot = root
    const token = ++toggleSequence.current
    toggleTokens.current.set(key, token)
    setToggleError(null)
    // 乐观更新：矩阵只存禁用项——开=删键、关=写键（与 server writeHookToggle 同语义）。
    setMatrix((prev) => {
      const next = { ...prev }
      if (enabled) delete next[key]
      else next[key] = false
      return next
    })
    setBusyKeys((prev) => new Set(prev).add(key))
    postHookToggle({ root: targetRoot, hook, phase, enabled })
      .catch((err: unknown) => {
        if (rootIdentity.current !== targetRoot || toggleTokens.current.get(key) !== token) return
        // 失败回滚到点击前的值（本键在途期间被 busy 守卫锁住，不会有交叉写覆盖）。
        setMatrix((prev) => {
          const next = { ...prev }
          if (enabled) next[key] = false
          else delete next[key]
          return next
        })
        // 409 = 别处已改过这份 hooks.json：本地已按上面的回滚回到权威值，提示要说清「未写入 +
        // 显示的已是最新」，不能混进「网络错误请重试」那一类。
        const conflict = err instanceof ApiError && err.status === 409
        const msg = conflict
          ? tRef.current('workbench.save_conflict')
          : tRef.current('workbench.hk_toggle_error', {
            msg: formatApiError(err, tRef.current, { exposeServerDetail: langRef.current === 'zh' }),
          })
        if (onError) onError(msg)
        else setToggleError(msg)
      })
      .finally(() => {
        if (rootIdentity.current !== targetRoot || toggleTokens.current.get(key) !== token) return
        toggleTokens.current.delete(key)
        setBusyKeys((prev) => {
          const next = new Set(prev)
          next.delete(key)
          return next
        })
      })
  }

  async function savePromptSkipKeyword(keyword: string): Promise<boolean> {
    if (promptSkipBusy) return false
    const targetRoot = root
    const generation = ++promptSkipGeneration.current
    setPromptSkipBusy(true)
    setPromptSkipFailed(false)
    try {
      const saved = await postPromptRoutingBypass(targetRoot, keyword)
      if (generation !== promptSkipGeneration.current || rootIdentity.current !== targetRoot) return false
      setPromptSkipKeyword(saved)
      return true
    } catch {
      if (generation !== promptSkipGeneration.current || rootIdentity.current !== targetRoot) return false
      setPromptSkipFailed(true)
      return false
    } finally {
      if (generation === promptSkipGeneration.current && rootIdentity.current === targetRoot) setPromptSkipBusy(false)
    }
  }

  function enabledCount(phase: string): number | undefined {
    if (hooks === null) return undefined
    return hooks.filter((h) => !(`${h.id}.${phase}` in matrix)).length
  }

  return {
    hooks,
    matrix,
    loadError: loadFailed ? t('workbench.hk_load_error') : null,
    toggleError,
    promptSkipKeyword,
    promptSkipBusy,
    promptSkipError: promptSkipFailed ? t('workbench.hk_bypass_save_error') : null,
    onPromptSkipDirtyChange,
    busyKeys,
    toggle,
    savePromptSkipKeyword,
    enabledCount,
  }
}
