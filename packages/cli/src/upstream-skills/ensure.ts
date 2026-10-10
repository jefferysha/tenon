import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseUpstreamSkillSources } from '@tenon/kernel'
import {
  installUpstreamSkills,
  type UpstreamSkillInstallInput,
  type UpstreamSkillInstallResult,
} from './install.js'
import { writeUpstreamSkillRunReport } from './report.js'

/** `skills/sources.yaml` 声明的全部上游技能 id；清单无效时抛错（调用方折算成失败）。 */
export function upstreamSkillIds(repo: string): readonly string[] {
  const text = readFileSync(join(repo, 'skills', 'sources.yaml'), 'utf8')
  return parseUpstreamSkillSources(text).skills.map((source) => source.id)
}

/** 仓库工作区里还缺哪些上游技能目录，以及本机拉取索引（被 git 忽略）是否缺失。 */
export function upstreamSkillGap(repo: string): {
  readonly missingIds: readonly string[]
  readonly indexMissing: boolean
} {
  const ids = upstreamSkillIds(repo)
  return {
    missingIds: ids.filter((id) => !existsSync(join(repo, 'skills', id, 'SKILL.md'))),
    indexMissing: ids.length > 0 && !existsSync(join(repo, 'skills', 'skills.lock.json')),
  }
}

export type EnsureUpstreamSkillsOutcome =
  | { readonly state: 'present' }
  | { readonly state: 'fetched' }
  | { readonly state: 'failed'; readonly detail: string }

export interface EnsureUpstreamSkillsInput {
  readonly repo: string
  readonly env: UpstreamSkillInstallInput['env']
  readonly workRoot: string
  readonly stateRoot: string
  readonly now: () => string
  readonly log: (line: string) => void
  /** 测试注入口；缺省走真实的 installUpstreamSkills（git clone）。 */
  readonly install?: (input: UpstreamSkillInstallInput) => Promise<UpstreamSkillInstallResult>
}

/**
 * 开发安装的初始化步骤：上游技能与本机索引都不进仓库，所以新 checkout / 新 worktree 里它们是缺的。
 * 缺才拉（等价 `npm run skills:fetch`，把仓库自己当作 previousRoot），都在位就一次网络都不碰——
 * 两次初始化之间不会自动重拉。任何失败整体中止，调用方据此不创建事务、不改宿主。
 */
export async function ensureUpstreamSkillsForSource(
  input: EnsureUpstreamSkillsInput,
): Promise<EnsureUpstreamSkillsOutcome> {
  let gap: ReturnType<typeof upstreamSkillGap>
  try {
    gap = upstreamSkillGap(input.repo)
  } catch (error) {
    return { state: 'failed', detail: `skills/sources.yaml 无效：${error instanceof Error ? error.message : String(error)}` }
  }
  if (gap.missingIds.length === 0 && !gap.indexMissing) return { state: 'present' }
  input.log(
    `[setup] 开发安装：缺 ${gap.missingIds.length} 个上游技能${gap.indexMissing ? '与本机拉取索引' : ''}，`
    + '按 skills/sources.yaml 获取（两次初始化之间不会自动重拉）',
  )
  const install = input.install ?? installUpstreamSkills
  let fetched: UpstreamSkillInstallResult
  try {
    fetched = await install({
      env: input.env,
      pluginRoot: input.repo,
      previousRoot: input.repo,
      host: 'dev',
      workRoot: input.workRoot,
      now: input.now,
      log: input.log,
    })
  } catch (error) {
    return { state: 'failed', detail: `上游技能获取失败：${error instanceof Error ? error.message : String(error)}` }
  }
  try {
    await writeUpstreamSkillRunReport(input.stateRoot, fetched.report)
  } catch {
    // 报告只是 doctor 的诊断输入，写不下不改变安装结论。
  }
  const missing = fetched.report.results.filter((entry) => entry.outcome === 'missing')
  if (missing.length > 0) {
    return {
      state: 'failed',
      detail: `上游技能获取失败，已中止且未改动宿主：${missing.map((entry) => `${entry.id}（${entry.reason ?? 'unknown'}）`).join('、')}`,
    }
  }
  try {
    const after = upstreamSkillGap(input.repo)
    if (after.missingIds.length > 0 || after.indexMissing) {
      return {
        state: 'failed',
        detail: `获取结束后仍缺：${after.missingIds.join('、')}${after.indexMissing ? ' 与拉取索引' : ''}`,
      }
    }
  } catch (error) {
    return { state: 'failed', detail: `获取后复核失败：${error instanceof Error ? error.message : String(error)}` }
  }
  return { state: 'fetched' }
}
