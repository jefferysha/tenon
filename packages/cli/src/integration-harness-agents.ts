/**
 * integration harness 的 agent 库装配：镜像 main.ts（官方 agent 从仓库 payload 同步、项目层读临时项目）。
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
