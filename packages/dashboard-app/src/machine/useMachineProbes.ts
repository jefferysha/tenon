import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  fetchAfkReadiness,
  fetchDefinitionCatalog,
  fetchDockerImages,
  fetchLoopsSnapshot,
  fetchSecrets,
  fetchSkillsRegistry,
  type DefinitionCatalogAdapter,
  type WbAfkReadiness,
  type WbDockerImages,
  type WbLoopRow,
  type WbSecretsKeys,
  type WbSkillEntry,
} from '../api/client'
import { formatApiError } from '../api/transport'
import { useT } from '../i18n'
import type { Snapshot } from '../types'
import { blocksMachine, machineRisks, type ProjectRisk, type ReadinessState } from './machineModel'

export interface MachineProbes {
  reload: () => void
  readiness: WbAfkReadiness | null
  images: WbDockerImages | null
  secrets: WbSecretsKeys | null
  skills: WbSkillEntry[] | null
  loops: WbLoopRow[] | null
  /** 当前项目定义目录里的适配器（含能力档位）；无项目或目录不可读时为 null，界面不得据此编造。 */
  adapters: DefinitionCatalogAdapter[] | null
  dockerState: ReadinessState
  imageState: ReadinessState
  codexState: ReadinessState
  skillState: ReadinessState
  operationsState: ReadinessState
  readinessCounts: { ready: number; blocked: number; unknown: number }
  blockers: string[]
  blockersPending: boolean
  coreFactsUnknown: boolean
  risks: ProjectRisk[]
  dockerDetail: string
  configuredImage: string
  secretSource: string
  installedSkills: number
}

/**
 * 机器级五路探测（AFK 就绪 / Docker 镜像 / 凭证 / 技能库 / 定时任务）+ 项目定义目录。
 * 所有状态都来自真实端点；请求失败保持 unknown 并进入 blocker 清单，绝不把「没读到」画成 ready。
 * 只有选中项目时才探测项目级 AFK 就绪；未选项目时项目级事实保持未知。
 */
export function useMachineProbes(snapshot: Snapshot | null, probeRoot: string): MachineProbes {
  const { t, lang } = useT()
  const [reloadKey, setReloadKey] = useState(0)
  const [readiness, setReadiness] = useState<WbAfkReadiness | null>(null)
  const [images, setImages] = useState<WbDockerImages | null>(null)
  const [secrets, setSecrets] = useState<WbSecretsKeys | null>(null)
  const [skills, setSkills] = useState<WbSkillEntry[] | null>(null)
  const [loops, setLoops] = useState<WbLoopRow[] | null>(null)
  const [adapters, setAdapters] = useState<DefinitionCatalogAdapter[] | null>(null)
  const [errors, setErrors] = useState<Array<{ source: string; cause: unknown }>>([])

  const reload = useCallback(() => setReloadKey((value) => value + 1), [])

  useEffect(() => {
    let live = true
    setReadiness(null)
    setImages(null)
    setSecrets(null)
    setSkills(null)
    setLoops(null)
    setAdapters(null)
    setErrors([])

    const report = (source: string, error: unknown): void => {
      if (!live) return
      setErrors((current) => [...current, { source, cause: error }])
    }

    if (probeRoot !== '') {
      void fetchAfkReadiness(probeRoot).then((value) => { if (live) setReadiness(value) }, (error) => report('readiness', error))
      void fetchDefinitionCatalog(probeRoot).then((value) => { if (live) setAdapters(value.adapters) }, () => { /* 目录不可读时保持 null，不进 blocker */ })
    }

    void fetchDockerImages().then((value) => { if (live) setImages(value) }, (error) => report('docker images', error))
    void fetchSecrets().then((value) => { if (live) setSecrets(value) }, (error) => report('secrets', error))
    void fetchSkillsRegistry().then((body) => { if (live) setSkills(body) }, (error) => report('skills', error))
    void fetchLoopsSnapshot().then((value) => { if (live) setLoops(value.rows) }, (error) => report('loops', error))

    return () => { live = false }
  }, [probeRoot, reloadKey])

  const dockerImagesError = errors.find(({ source }) => source === 'docker images')?.cause
  const dockerState: ReadinessState = dockerImagesError !== undefined
    ? 'optional-unavailable'
    : images === null ? 'unknown' : images.available ? 'ready' : 'optional-unavailable'
  const imageState: ReadinessState = dockerImagesError !== undefined
    ? 'optional-unavailable'
    : readiness === null || images === null ? 'unknown' : readiness.image.present || images.images.includes(readiness.image.configured) ? 'ready' : 'optional-unavailable'
  const codexState: ReadinessState = secrets === null
    ? 'unknown'
    : readiness?.credentials.codex.OPENAI_API_KEY.set
      || readiness?.credentials.codex.CODEX_HOME.set
      || secrets.OPENAI_API_KEY.set ? 'ready' : 'unknown'
  const skillState: ReadinessState = skills === null
    ? 'unknown'
    : skills.length > 0 && skills.filter(blocksMachine).every((skill) => skill.installed) ? 'ready' : 'blocked'
  const operationsState: ReadinessState = snapshot === null ? 'unknown' : snapshot.capabilities.operations === true ? 'ready' : 'blocked'
  const readinessStates = [codexState, skillState, operationsState]
  const readinessCounts = {
    ready: readinessStates.filter((state) => state === 'ready').length,
    blocked: readinessStates.filter((state) => state === 'blocked').length,
    unknown: readinessStates.filter((state) => state === 'unknown').length,
  }

  const blockers = useMemo(() => {
    const sourceLabels: Record<string, string> = {
      readiness: t('machine.source_readiness'),
      'docker images': t('machine.source_images'),
      secrets: t('machine.source_secrets'),
      skills: t('machine.source_skills'),
      loops: t('machine.source_loops'),
    }
    const values = errors
      .filter(({ source }) => source !== 'docker images')
      .map(({ source, cause }) => `${sourceLabels[source] ?? source}: ${formatApiError(cause, t, { exposeServerDetail: lang === 'zh' })}`)
    for (const skill of skills ?? []) if (blocksMachine(skill) && !skill.installed) values.push(t('machine.blocker_skill', { skill: skill.name, command: skill.installCmd ?? t('machine.no_install_command') }))
    if (snapshot && snapshot.capabilities.operations !== true) values.push(t('machine.blocker_operations'))
    return values
  }, [errors, lang, skills, snapshot, t])
  const blockersPending = blockers.length === 0 && (
    secrets === null
    || skills === null
    || snapshot === null
    || (probeRoot !== '' && readiness === null)
  )
  const coreFactsUnknown = readinessStates.some((state) => state === 'unknown')

  const risks = useMemo(() => machineRisks(snapshot, loops ?? [], t, lang === 'zh'), [lang, loops, snapshot, t])

  const dockerProbeError = dockerImagesError === undefined
    ? null
    : `${t('machine.source_images')}: ${formatApiError(dockerImagesError, t, { exposeServerDetail: lang === 'zh' })}`
  const configuredImage = dockerProbeError
    ?? readiness?.image.configured
    ?? t('machine.loading_signal')
  const installedSkills = skills?.filter((skill) => skill.installed).length ?? 0
  const secretSource = readiness?.credentials.codex.OPENAI_API_KEY.source
    ?? readiness?.credentials.codex.CODEX_HOME.source
    ?? (secrets?.OPENAI_API_KEY.set ? 'secrets' : 'not detected')
  const dockerDetail = dockerProbeError ?? (images === null
    ? t('machine.loading_signal')
    : images.available === false
      ? t('machine.docker_unavailable_detail')
      : t('machine.docker_detail', { count: images.images.length }))

  return {
    reload,
    readiness,
    images,
    secrets,
    skills,
    loops,
    adapters,
    dockerState,
    imageState,
    codexState,
    skillState,
    operationsState,
    readinessCounts,
    blockers,
    blockersPending,
    coreFactsUnknown,
    risks,
    dockerDetail,
    configuredImage,
    secretSource,
    installedSkills,
  }
}
