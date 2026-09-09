import { useEffect, useRef, useState } from 'react'
import { fetchSkillsRegistry, postMandatorySkills, type WbSkillEntry, type WbTrackDefinition } from '../api/client'
import { formatApiError } from '../api/transport'
import { useT } from '../i18n'
import {
  clearMandatoryConfig,
  loadMandatoryConfig,
  mergeMandatoryConfigCell,
  peekMandatoryConfig,
  type MandatoryConfig,
  type MatrixTrack,
} from './mandatoryConfig'
import { decodeMandatorySkillWriteSuccess } from './mandatorySkillWriteResponse'

interface MandatorySkillsPostError {
  readonly error: string | null
}

function decodeMandatorySkillsPostError(value: unknown): MandatorySkillsPostError | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const body = value as Record<string, unknown>
  if (body.ok !== false) return null
  if (body.error === undefined) return { error: null }
  return typeof body.error === 'string' ? { error: body.error } : null
}

// ══════════════════════════════════════════════════════════════════════════
// B2：useMandatorySkills —— 矩阵状态（宿主 WorkbenchView 持有，7 列共用一份）
// ══════════════════════════════════════════════════════════════════════════

export interface MandatoryState {
  root: string
  revision: string
  /** null = 加载中。 */
  table: Record<string, string[]> | null
  /** false = /api/config/effective registry 不可用；不退回静态轨道。 */
  capable: boolean
  tracks: readonly WbTrackDefinition[]
  matrixTracks: readonly WbTrackDefinition[]
  /** Server 显式授予的 profile 写能力；空数组即全只读，前端不猜固定三轨。 */
  writableProfiles: readonly string[]
  configError: string | null
  track: MatrixTrack | null
  setTrack: (t: MatrixTrack) => void
  /** Legacy single-cell projection for hand-written fixtures. Production consumers use savingKeys. */
  savingKey: string | null
  /** 当前 root 全部在途写回的 `phase.track` 键；不同 cell 可并发且各自保持禁用。 */
  savingKeys?: readonly string[]
  saveError: string | null
  /** 当前 root 按 `phase.track` 隔离的 mutation 错误。 */
  saveErrors?: Readonly<Record<string, string>>
  /**
   * 出错那次写回的 `phase.track` 键（契约 §3-B2 之外的附加项，故为可选）。
   * 理由：saveError 是矩阵级单值，7 列共用一份 state——不标记归属的话，build 列存失败会让
   * 7 列同时挂同一条红字。缺省（undefined）时 LaneMandatorySkills 退回「哪列都显示」的
   * 保守行为，手搓 MandatoryState 的调用点不必提供本字段。
   */
  saveErrorKey?: string | null
  /** 写回 POST /api/config/mandatory-skills（等响应、非乐观；失败只报错不回滚）。 */
  setSkills: (phase: string, skills: string[]) => void
  /** 候选池（GET /api/skills/registry）；null = 未就绪 → 添加入口禁用。 */
  registry: WbSkillEntry[] | null
  /** Track mutation 成功后的 authoritative config 重拉。 */
  reloadConfig: () => Promise<void>
}

export interface MandatoryCellView {
  key: string
  skills: string[]
  source: 'explicit' | 'profile-inherited' | 'all-inherited' | 'missing'
  profile: string
  editable: boolean
}

/** track policy profile → manifest key 的唯一前端投影；selector、lane 与 legacy SkillChain 共用。 */
export function resolveMandatoryCell(
  table: Record<string, string[]>,
  track: WbTrackDefinition,
  phase: string,
  writableProfiles: readonly string[],
): MandatoryCellView {
  const profile = track.policyProfile.skills.profile
  const profileKey = `${phase}.${profile}`
  const explicit = table[profileKey]
  if (explicit !== undefined) {
    return {
      key: profileKey,
      skills: explicit,
      source: profile === track.id ? 'explicit' : 'profile-inherited',
      profile,
      editable: profile === track.id && writableProfiles.includes(profile),
    }
  }
  const allKey = `${phase}._all`
  const all = table[allKey]
  if (all !== undefined) {
    return { key: allKey, skills: all, source: 'all-inherited', profile: '_all', editable: false }
  }
  return { key: profileKey, skills: [], source: 'missing', profile, editable: false }
}

export function useMandatorySkills(root: string): MandatoryState {
  const { t, lang } = useT()
  const [requestedTrack, setRequestedTrack] = useState<MatrixTrack | null>(null)
  const [cfg, setCfg] = useState<MandatoryConfig | null>(() => peekMandatoryConfig(root))
  const [registry, setRegistry] = useState<WbSkillEntry[] | null>(null)
  const [regFailed, setRegFailed] = useState(false)
  const [saveErrors, setSaveErrors] = useState<Record<string, string>>({})
  const [savingKeys, setSavingKeys] = useState<string[]>([])
  useEffect(() => {
    setSaveErrors({})
  }, [lang])
  // 保存操作同时绑定发起时的 root 与 cell。只记 cell 会让 root A 的晚到响应覆盖已经切到
  // root B 的同名格子；token 则避免旧操作的 finally 清掉较新的在途状态。
  const rootRef = useRef(root)
  const localeRef = useRef({ t, lang })
  const reloadRootRef = useRef(root)
  const reloadRootEpochRef = useRef(0)
  const reloadRequestRef = useRef(0)
  const configEffectRootRef = useRef(root)
  if (reloadRootRef.current !== root) {
    reloadRootRef.current = root
    reloadRootEpochRef.current += 1
    reloadRequestRef.current += 1
  }
  const renderRootEpoch = reloadRootEpochRef.current
  rootRef.current = root
  localeRef.current = { t, lang }
  const savingOpsRef = useRef(new Map<string, { token: symbol; root: string; cellKey: string }>())

  function operationKey(operationRoot: string, cellKey: string): string {
    return JSON.stringify([operationRoot, cellKey])
  }

  function syncSavingKeys(): void {
    const currentRoot = rootRef.current
    setSavingKeys(
      [...savingOpsRef.current.values()]
        .filter((operation) => operation.root === currentRoot)
        .map((operation) => operation.cellKey),
    )
  }

  // config 探测（cancelled 守卫同 SkillChain：卸载后回来的响应不再 setState）。
  useEffect(() => {
    let cancelled = false
    // A pending request from an earlier visit to the same root is not authoritative for this root
    // incarnation. Supersede it before consulting the shared cache/in-flight registry.
    if (configEffectRootRef.current !== root) {
      configEffectRootRef.current = root
      clearMandatoryConfig(root)
    }
    const cached = peekMandatoryConfig(root)
    setCfg(cached)
    setSaveErrors({})
    setSavingKeys(
      [...savingOpsRef.current.values()]
        .filter((operation) => operation.root === root)
        .map((operation) => operation.cellKey),
    )
    if (cached !== null) return
    void loadMandatoryConfig(root).then((r) => {
      if (!cancelled) setCfg(r)
    })
    return () => {
      cancelled = true
    }
  }, [root])

  // registry 挂载即拉（同 SkillChain v6 T10 纪律）：chips 的「未装」徽章与添加候选都需要
  // installed 信息。fail-soft：失败即 regFailed，registry 恒为 null → 添加入口禁用
  // （不可判就不给写入口，保守，不谎报）；regFailed 同时兼作「已试过」守卫，不重试打转。
  useEffect(() => {
    if (registry !== null || regFailed) return
    let cancelled = false
    fetchSkillsRegistry()
      .then((skills) => {
        if (!cancelled) setRegistry(skills)
      })
      .catch(() => {
        if (!cancelled) setRegFailed(true)
      })
    return () => {
      cancelled = true
    }
  }, [registry, regFailed])

  // ⚠️ 这条路径不是乐观更新（别照 hooksConfig 的 useHooksConfig，那是另一套乐观+回滚范式）。
  // 逐字沿用 SkillChain.tsx:361-399 的既有语义：
  //   · 等响应，res.ok 后才 setCfg —— 故无需回滚（失败时 cfg/cfgCache 从未被动过，只 setSaveError）；
  //   · 成功后不重新 GET，就地 merge 并同步推进模块级 cfgCache（sheet 里的 SkillChain 重挂即读到新值）；
  //   · res.ok 必须在 res.json() 之前（server 错误也是 JSON 信封，既有教训）。
  const tracks = cfg?.tracks ?? []
  const matrixTracks = tracks.filter((track) => track.policyProfile.skills.matrix)
  const selectedTrack = matrixTracks.find((track) => track.id === requestedTrack) ?? matrixTracks[0] ?? null
  const track = selectedTrack?.id ?? null

  async function saveMandatory(phase: string, skills: string[], selected: WbTrackDefinition): Promise<void> {
    const cellKey = `${phase}.${selected.id}`
    const requestRoot = root
    const requestCfg = cfg
    const op = { token: Symbol(cellKey), root: requestRoot, cellKey }
    const opKey = operationKey(requestRoot, cellKey)
    savingOpsRef.current.set(opKey, op)
    syncSavingKeys()
    setSaveErrors((current) => {
      if (!(cellKey in current)) return current
      const next = { ...current }
      delete next[cellKey]
      return next
    })
    const isCurrent = (): boolean =>
      savingOpsRef.current.get(opKey)?.token === op.token && rootRef.current === requestRoot
    try {
      const res = await postMandatorySkills({ phase, track: selected.id, skills, root: requestRoot })
      let body: unknown = null
      let parsed = false
      try {
        body = await res.json()
        parsed = true
      } catch {
        /* 无 JSON 体：走下方通用错误文案 */
      }
      const locale = localeRef.current
      const success = parsed
        ? decodeMandatorySkillWriteSuccess(body, { phase, track: selected.id })
        : null
      const serverError = parsed ? decodeMandatorySkillsPostError(body) : null
      if (!res.ok) {
        if (parsed && success === null && serverError === null) {
          if (isCurrent()) setSaveErrors((current) => ({ ...current, [cellKey]: locale.t('common.invalid_response') }))
          return
        }
        if (isCurrent()) {
          setSaveErrors((current) => ({
            ...current,
            [cellKey]:
            locale.lang === 'zh' && serverError?.error
              ? serverError.error
              : locale.t('workbench.mand_save_failed', { status: res.status }),
          }))
        }
        return
      }
      if (serverError !== null) {
        if (isCurrent()) {
          setSaveErrors((current) => ({
            ...current,
            [cellKey]:
            locale.lang === 'zh' && serverError.error
              ? serverError.error
              : locale.t('workbench.mand_save_failed', { status: res.status }),
          }))
        }
        return
      }
      if (success === null) {
        if (isCurrent()) setSaveErrors((current) => ({ ...current, [cellKey]: locale.t('common.invalid_response') }))
        return
      }
      const next = await mergeMandatoryConfigCell(requestRoot, cellKey, success.skills, requestCfg)
      if (next !== null && isCurrent()) setCfg(next)
    } catch (e) {
      if (isCurrent()) {
        const locale = localeRef.current
        setSaveErrors((current) => ({
          ...current,
          [cellKey]: formatApiError(e, locale.t, { exposeServerDetail: locale.lang === 'zh' }),
        }))
      }
    } finally {
      if (savingOpsRef.current.get(opKey)?.token === op.token) {
        savingOpsRef.current.delete(opKey)
        syncSavingKeys()
      }
    }
  }

  function setSkills(phase: string, skills: string[]): void {
    if (cfg === null || selectedTrack === null || phase === 'archive') return
    const cell = resolveMandatoryCell(cfg.table, selectedTrack, phase, cfg.writableProfiles)
    if (!cfg.capable || !cell.editable || cell.source !== 'explicit') return
    if (savingOpsRef.current.has(operationKey(root, `${phase}.${selectedTrack.id}`))) return
    void saveMandatory(phase, skills, selectedTrack)
  }

  async function reloadConfig(): Promise<void> {
    const requestRoot = root
    if (
      rootRef.current !== requestRoot ||
      reloadRootRef.current !== requestRoot ||
      reloadRootEpochRef.current !== renderRootEpoch
    ) return
    const request = ++reloadRequestRef.current
    clearMandatoryConfig(requestRoot)
    // Keep the last authoritative config rendered while the replacement is fetched. Publishing
    // a transient null here unmounts Track Settings during a successful mutation and discards the
    // workspace lifecycle before the caller can close only its submitted editor.
    const next = await loadMandatoryConfig(requestRoot)
    if (
      rootRef.current === requestRoot &&
      reloadRootRef.current === requestRoot &&
      reloadRootEpochRef.current === renderRootEpoch &&
      reloadRequestRef.current === request &&
      peekMandatoryConfig(requestRoot) === next
    ) setCfg(next)
  }

  return {
    root,
    revision: cfg?.revision ?? '',
    table: cfg?.table ?? null,
    // 加载中（cfg===null）时按不可写算——写入口在 table===null 分支下根本不渲染，此值不被读到。
    capable: cfg?.capable ?? false,
    tracks,
    matrixTracks,
    writableProfiles: cfg?.writableProfiles ?? [],
    configError: cfg?.error ?? null,
    track,
    setTrack: (next) => {
      if (matrixTracks.some((candidate) => candidate.id === next)) setRequestedTrack(next)
    },
    savingKey: savingKeys[0] ?? null,
    savingKeys,
    saveError: Object.values(saveErrors)[0] ?? null,
    saveErrors,
    saveErrorKey: Object.keys(saveErrors)[0] ?? null,
    setSkills,
    registry,
    reloadConfig,
  }
}

// ══════════════════════════════════════════════════════════════════════════
// B3：LaneMandatorySkills —— 画布 default 泳道的技能区
// ══════════════════════════════════════════════════════════════════════════

// ── 原子类合集（定稿 .setchips/.tracktabs/.minibadge 等值搬运；颜色全走 token，
//    字号守契约 §0.2 下限：徽章 ≥11.5px、说明 12.5px、chip 13px 同 P0 产出 chip）──
