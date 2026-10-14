/**
 * 旧 phase-manifest 引擎读的轨道策略位。
 *
 * 仍要按旧规则走完的在途任务（快照记着 `executionModel: 'phase-manifest'`）靠这张表按轨道 id 取旧值，
 * 新计划（读分支声明）不经这里。与 legacy-phase-manifest/ 整目录同生共死。
 */
import type { CoverageProfile } from '../../types.js'
import type { TrackAutomation } from '../types.js'

interface LegacyTrackPolicy {
  /** 规格出口 coverage 矩阵适用的剖面。 */
  readonly coverageProfile: CoverageProfile
  readonly automationEligible: boolean
  /** 规格完成后自动入队。 */
  readonly autoEnqueueOnSpecComplete: boolean
}

const PLAIN: LegacyTrackPolicy = {
  coverageProfile: 'none',
  automationEligible: false,
  autoEnqueueOnSpecComplete: false,
}

const LEGACY_TRACK_POLICIES: Readonly<Record<string, LegacyTrackPolicy>> = {
  chat: { ...PLAIN, automationEligible: true },
  simple: PLAIN,
  standard: PLAIN,
  pm: { coverageProfile: 'pm', automationEligible: true, autoEnqueueOnSpecComplete: true },
  frontend: { ...PLAIN, coverageProfile: 'frontend', automationEligible: true },
  backend: { ...PLAIN, coverageProfile: 'backend', automationEligible: true },
  free: PLAIN,
}

/** 旧登记表对「只在工作流 YAML 里声明的分支」的缺省：可进 AFK，其余位全关。 */
const UNREGISTERED: LegacyTrackPolicy = { ...PLAIN, automationEligible: true }

export interface LegacyPlanTrack {
  readonly coverageProfile: CoverageProfile
  readonly automation: { readonly eligible: boolean; readonly autoEnqueueOnSpecComplete: boolean }
}

/**
 * 旧引擎计划的轨道策略位：按轨道 id 取旧表（与登记表删除前逐位一致）；分支自己在 YAML 里声明了
 * `automation` 的以声明为准（如轻量轨道 `eligible: false`）。没有轨道语境（`undefined` / 空）= 全关。
 */
export function legacyPlanTrack(trackId: string | undefined, declared: TrackAutomation | undefined): LegacyPlanTrack {
  if (trackId === undefined || trackId === '') {
    return { coverageProfile: 'none', automation: { eligible: false, autoEnqueueOnSpecComplete: false } }
  }
  const legacy = Object.hasOwn(LEGACY_TRACK_POLICIES, trackId) ? (LEGACY_TRACK_POLICIES[trackId] ?? UNREGISTERED) : UNREGISTERED
  return {
    coverageProfile: legacy.coverageProfile,
    automation: {
      eligible: declared?.eligible ?? legacy.automationEligible,
      autoEnqueueOnSpecComplete: declared?.enqueueAfterSpec ?? legacy.autoEnqueueOnSpecComplete,
    },
  }
}
