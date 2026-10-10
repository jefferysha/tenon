import { realpathSync } from 'node:fs'
import type { DoctorProbes, SourceDriftFacts } from '../deps.js'
import {
  checkTenonSourceRepo, compareDevSource, computeDevSourceIdentity, realGitRun, type GitRun,
} from '../runtime/dev-source-identity.js'
import type { RuntimeReleaseManifest } from '../runtime/types.js'
import { green, yellow, type DoctorCheck } from './doctor-check.js'

const ID = 'source:drift'

/** 收集事实：不在 Tenon 源码仓库就什么都不算；在的话读 active release 的渠道并重算工作区身份。 */
export async function collectSourceDriftFacts(input: {
  readonly cwd: string
  readonly inspectActive: () => Promise<RuntimeReleaseManifest | null>
  readonly git?: GitRun
}): Promise<SourceDriftFacts> {
  const git = input.git ?? realGitRun
  let top: string
  try {
    top = realpathSync(git(input.cwd, ['rev-parse', '--show-toplevel']).trim())
  } catch {
    return { state: 'not-source-repo' }
  }
  if (!checkTenonSourceRepo(top).ok) return { state: 'not-source-repo' }
  let active: RuntimeReleaseManifest | null
  try {
    active = await input.inspectActive()
  } catch {
    // runtime 状态读不出来按「没有可验证的 runtime」处理，doctor 不因此抛错。
    active = null
  }
  let live: ReturnType<typeof computeDevSourceIdentity> | { readonly error: string }
  try {
    live = computeDevSourceIdentity(top, git)
  } catch (error) {
    live = { error: error instanceof Error ? error.message : String(error) }
  }
  if (active === null) return { state: 'source-repo', repo: top, installed: null, live }
  if (active.version === 2 && active.devSource !== undefined) {
    return {
      state: 'source-repo',
      repo: top,
      installed: {
        channel: 'dev',
        host: active.source.host === 'codex' ? 'codex' : 'claude',
        releaseId: active.releaseId,
        devSource: active.devSource,
      },
      live,
    }
  }
  return {
    state: 'source-repo',
    repo: top,
    installed: { channel: 'stable', host: active.source.host, version: active.source.pluginVersion },
    live,
  }
}

export async function checkSourceDrift(p: DoctorProbes): Promise<DoctorCheck> {
  if (p.sourceDrift === undefined) {
    return yellow(ID, '源码漂移探针未装配', '这是 main.ts 集成缺口：无法判断已装版本与源码仓库是否一致')
  }
  const facts = await p.sourceDrift()
  if (facts.state === 'not-source-repo') return green(ID, '当前目录不在 Tenon 源码仓库，不适用')
  const command = (host: string): string => `tenon setup --${host === 'codex' ? 'codex' : 'claude'} --from-source ${facts.repo}`
  if (facts.installed === null) {
    return yellow(
      ID,
      `在 Tenon 源码仓库 ${facts.repo} 里，但没有可验证的 managed runtime`,
      `${command('claude')}（用 Codex 时把 --claude 换成 --codex）`,
    )
  }
  if (facts.installed.channel === 'stable') {
    return yellow(
      ID,
      `在 Tenon 源码仓库 ${facts.repo} 里，已装的是正式版 ${facts.installed.version}：技能、hooks 与 CLI 不是仓库源码`,
      command(facts.installed.host),
    )
  }
  if ('error' in facts.live) {
    return yellow(ID, `无法计算仓库当前身份：${facts.live.error}`, '检查 git 与仓库状态后重跑 tenon doctor')
  }
  const reasons = compareDevSource(facts.installed.devSource, facts.live)
  if (reasons.length === 0) {
    return green(
      ID,
      `开发安装与仓库工作区一致（commit ${facts.installed.devSource.commit.slice(0, 7)}`
        + `${facts.installed.devSource.dirty ? '，安装时工作区有未提交改动' : ''}）`,
    )
  }
  return yellow(
    ID,
    `已装的开发安装与仓库工作区不一致：${reasons.join('；')}`,
    command(facts.installed.host),
  )
}
