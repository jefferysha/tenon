/**
 * integration harness 的 agent 侧：库装配镜像 main.ts（官方 agent 从仓库 payload 同步、项目层读临时项目），
 * 外加 satisfyStepAgents 读 `tenon agent next|prompt --json` 用的窄解码。
 * 测试进程本身常跑在 Claude Code / Codex 里：宿主只认用例显式给的 `TENON_HARNESS_HOST`
 * （claude-code | codex），不看继承来的环境；缺省终端，不生成宿主 agent 文件。
 */
import { loadAgentLibrary, resolveProductPaths } from '@tenon/kernel'
import type { CliDeps } from './deps.js'
import { pluginSkillIds } from './pluginSkillIds.js'

export function harnessAgentDeps(
  repoRoot: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
): Pick<CliDeps, 'agentLibrary' | 'agentPaths' | 'hostKind' | 'knownSkillIds'> {
  const configRoot = (): string => resolveProductPaths({ env }).configRoot
  const host = env.TENON_HARNESS_HOST
  return {
    agentLibrary: () => loadAgentLibrary({ payloadRoot: repoRoot, configRoot: configRoot(), projectRoot: cwd }),
    agentPaths: () => ({ payloadRoot: repoRoot, configRoot: configRoot() }),
    hostKind: () => (host === 'claude-code' || host === 'codex' ? host : 'terminal'),
    knownSkillIds: () => pluginSkillIds(repoRoot),
  }
}

/** `tenon agent next --json` 的窄解码：只取本波要跑的 agent，形状不符就当没有。 */
export function agentWave(json: string): string[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return []
  }
  if (typeof parsed !== 'object' || parsed === null) return []
  const wave = (parsed as Record<string, unknown>).wave
  return Array.isArray(wave) ? wave.filter((id): id is string => typeof id === 'string') : []
}

/** `tenon agent prompt --json` 的窄解码：形状不符返回 null，由调用方 fail-loud。 */
export function agentPromptResult(json: string): { run_id: string; report_path: string; role: string } | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const row = parsed as Record<string, unknown>
  if (typeof row.run_id !== 'string' || typeof row.report_path !== 'string' || typeof row.role !== 'string') return null
  return { run_id: row.run_id, report_path: row.report_path, role: row.role }
}
