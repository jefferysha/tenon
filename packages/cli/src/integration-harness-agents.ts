/**
 * integration harness 的 agent 侧：库装配镜像 main.ts（官方 agent 从仓库 payload 同步、项目层读临时项目）。
 * satisfyStepAgents 读 `tenon agent next|prompt --json` 的窄解码在 integration-harness-json.ts。
 * 测试进程本身常跑在 Claude Code / Codex 里：宿主只认用例显式给的 `TENON_HARNESS_HOST`
 * （claude-code | codex），不看继承来的环境；缺省终端，不生成宿主 agent 文件。
 */
import { dirname, join } from 'node:path'
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
    // 用户目录根落在测试产品 home 之下的 home/：宿主 agent 的安装/卸载用例不会碰真实的 ~/.claude、~/.codex。
    // 宿主配置目录的环境变量只转发这两个（vitest 启动时已清掉继承来的，用例经 run({ env }) 显式给才会生效），与 main.ts 的 process.env 同口径。
    agentPaths: () => ({
      payloadRoot: repoRoot,
      configRoot: configRoot(),
      homeDir: join(dirname(configRoot()), 'home'),
      hostEnv: { CLAUDE_CONFIG_DIR: env.CLAUDE_CONFIG_DIR, CODEX_HOME: env.CODEX_HOME },
    }),
    hostKind: () => (host === 'claude-code' || host === 'codex' ? host : 'terminal'),
    knownSkillIds: () => pluginSkillIds(repoRoot),
  }
}
