import { dirname, join, resolve } from 'node:path'
import { readAutomationJson } from '@tenon/automation'
import { PREREQ_HINTS } from '@tenon/kernel'
import { errMsg, type CliDeps } from '../deps.js'
import { nodeExecDocker, probeAfkReadiness, type AfkReadiness, type CredLight, type ExecDockerFn } from '../afkReadiness.js'
import { REAL_RUNTIME_INSTALLER, type RuntimeInstaller } from '../runtime/installer.js'
import { resolveRuntimePaths } from '../runtime/paths.js'
import { loadSkillSources, type SkillSource, type SkillSourcesResult, type SkillTier } from '../skillSources.js'
import {
  REAL_RELEASED_DASHBOARD_STARTER,
} from './released-dashboard-starter.js'
import type { ReleasedDashboardStarter } from './dashboard.js'
import {
  hostFlag,
  installedPipelineRoot,
  isNativePipelineHost,
  nativeInstallPlan,
  selectPipelineHost,
  type NativePipelineHost,
  type PipelineHost,
  type PipelineHostFlags,
} from './plugin-host.js'
import type { SetupOpts } from './setupEnvironment.js'

// ── 注入面（测试注入临时 HOME / spy;真实现 = node:fs + os.homedir）──────────────────

export interface RuntimeEnv {
  /** 原始 docker exec（超时收敛由 probeAfkReadiness 内部包裹;spawn 失败按不可用降级）。 */
  exec: ExecDockerFn
  /** 宿主 env 快照（凭证灯读 CLAUDE_CODE_OAUTH_TOKEN/OPENAI_API_KEY/CODEX_HOME）。 */
  hostEnv: Record<string, string | undefined>
  /** Codex CLI 缺省登录目录；测试缺省不注入，避免读取开发机真实凭证态。 */
  defaultCodexHome?: string
  /** 默认目录 auth.json 可读探针；只回布尔，绝不读/回凭证内容。 */
  canReadFile?: (path: string) => boolean
  /** 配置镜像解析（同 afk run 口径:.pipeline/automation.json 的 image ?? 内置 sandcastle:local）。 */
  resolveImage: (cwd: string) => string
}

export const REAL_RUNTIME_ENV: RuntimeEnv = {
  exec: nodeExecDocker,
  hostEnv: process.env,
  defaultCodexHome: join(homedir(), '.codex'),
  resolveImage: (cwd) => readAutomationJson(cwd).image ?? 'sandcastle:local',
}

const READY_TAG = '[就绪]'
const MISS_TAG = '[缺失]'

/** 凭证灯人读串:已配标 source（宿主 env/secrets 文件），永不回显值。 */
function credSource(light: CredLight): string {
  const source = light.source === 'host-env'
    ? '宿主 env'
    : light.source === 'default-home'
      ? '默认 ~/.codex 登录'
      : 'secrets 文件'
  return `已配（${source}）`
}

/** 「怎么拿」引导行缩进（视觉从属于其上的 [缺失] 行;走 kernel PREREQ_HINTS 单一真相源）。 */
const HINT_INDENT = '         '

/**
 * 一条凭证清单行:required 缺 → 给「去配 X」硬指引 + 附一行「怎么拿」获取引导（acquireHint,走 kernel
 * PREREQ_HINTS 单一真相源，缺则不引导只对缺项引导）;optional 缺 → 仅标可选（不误导必配）。
 * 凭证只报 set/未设 + 获取路径，永不回显任何值。
 */
function emitCredLine(
  deps: CliDeps, runner: string, key: string, light: CredLight, required: boolean, note = '', acquireHint = '',
): void {
  if (light.set) {
    deps.io.out(`  ${READY_TAG} ${runner} 凭证 ${key} ${credSource(light)}`)
  } else if (required) {
    deps.io.out(`  ${MISS_TAG} ${runner} 凭证 ${key} 未配 → 去配 ${key}（pipeline 机器级 secrets 或宿主 env）`)
    if (acquireHint !== '') deps.io.out(`${HINT_INDENT}怎么拿：${acquireHint}`)
  } else {
    deps.io.out(`  ${MISS_TAG} ${runner} ${key} 未配${note}`)
  }
}

/** 就绪清单渲染:docker / 镜像（缺给 build_hint 一键）/ 两 runner 凭证对称呈现（codex 不缺席）。 */
function renderRuntimeReadiness(deps: CliDeps, r: AfkReadiness, dryRun: boolean): void {
  deps.io.out('[setup runtime] AFK 运行时就绪清单（终端 doctor/setup 为凭证权威——即将 afk run 的 shell 当刻真值）')

  // docker（不可用不光报缺:附一行「怎么拿」——装 OrbStack / Docker Desktop,走 kernel 单一真相源）
  if (r.docker.available) deps.io.out(`  ${READY_TAG} docker daemon 可用`)
  else {
    deps.io.out(`  ${MISS_TAG} docker 不可用——AFK 容器执行降级（AFK 为可选能力;装 docker 并起 daemon 后重探）`)
    deps.io.out(`${HINT_INDENT}怎么拿：${PREREQ_HINTS.docker}`)
  }

  // 镜像（缺 → build_hint 一键;走探测里的 kernel 单一真相源常量，不另写字面串）
  const img = r.image
  if (img.present) deps.io.out(`  ${READY_TAG} AFK 镜像 ${img.configured} 在位`)
  else if (r.docker.available) deps.io.out(`  ${MISS_TAG} AFK 镜像 ${img.configured} 不在本机 → 构建:${img.build_hint}`)
  else deps.io.out(`  ${MISS_TAG} AFK 镜像 ${img.configured} 未能核（docker 不可用）→ 起 docker 后重探;缺则构建:${img.build_hint}`)

  // 两 runner 凭证对称:claude-code 的 CLAUDE_CODE_OAUTH_TOKEN + codex 的 OPENAI_API_KEY/CODEX_HOME
  // 各自缺时附「怎么拿」获取引导（claude setup-token / codex login·openai keys,走 kernel PREREQ_HINTS）
  emitCredLine(deps, 'claude-code', 'CLAUDE_CODE_OAUTH_TOKEN', r.credentials['claude-code'].CLAUDE_CODE_OAUTH_TOKEN, true, '', PREREQ_HINTS.claudeToken)
  const codexKey = r.credentials.codex.OPENAI_API_KEY
  const codexHome = r.credentials.codex.CODEX_HOME
  if (!codexKey.set && codexHome.set) {
    deps.io.out(`  ${READY_TAG} codex 凭证 ${credSource(codexHome)}（OPENAI_API_KEY 非必需）`)
  } else {
    emitCredLine(deps, 'codex', 'OPENAI_API_KEY', codexKey, true, '', PREREQ_HINTS.openaiKey)
    emitCredLine(deps, 'codex', 'CODEX_HOME', codexHome, false, '（可选,缺省 ~/.codex）')
  }

  if (dryRun) deps.io.out('  （--dry-run:只探测只打印,未写任何文件）')
}

/**
 * 运行时检查段（Phase 3 · R1）:解析配置镜像 → probeAfkReadiness（docker info/image inspect + 两 runner
 * 凭证）→ 打印就绪清单。全程只读探测（本段不写任何文件），--dry-run 与常态同路径、仅追加 dry-run 说明。
 * docker 不可用一律降级（清单标缺失 + 重探指引），不抛不改退出码——AFK 为可选能力，exit 恒 0。
 * 凭证复用 deps.readSecretsEnv（与 afk run 同源）+ 注入 hostEnv;值永不回显（只 set/未设 + source）。
 */
export async function cmdSetupRuntime(
  deps: CliDeps,
  opts: SetupOpts,
  rt: RuntimeEnv = REAL_RUNTIME_ENV,
): Promise<number> {
  const image = rt.resolveImage(deps.cwd)
  const secretsEnv = deps.readSecretsEnv ? await deps.readSecretsEnv().catch(() => ({})) : {}
  const readiness = await probeAfkReadiness({
    image,
    exec: rt.exec,
    secretsEnv,
    hostEnv: rt.hostEnv,
    defaultCodexHome: rt.defaultCodexHome,
    canReadFile: rt.canReadFile,
  })
  renderRuntimeReadiness(deps, readiness, opts.dryRun ?? false)
  return 0
}

/**
 * `tenon setup [sub]` —— 安装后全功能就绪引导。
 *   空 sub:必须显式指定一个 host（如 `--codex`）。先验证/部署该 host（绝不双装；上游技能随宿主安装获取）→
 *          PATH/adapter → 运行时就绪清单。
 *   sub=runtime:仅运行时就绪清单（真 docker/镜像/凭证探测）。
 *   未知 sub:stderr + exit 1（对齐 loops 未知子命令口径）。
 * --dry-run:零副作用（不软链/不写文件/不起 docker）——空 sub 的运行时段**只提示不真探测**（R1 concern#1:
 *   避免 buildProgram 单测经空 sub 起真 docker 子进程）;非 dry-run 才经注入 rt 真探测（单测注入 fakeRt 仍零真 docker）。
 * --yes:跳技能安装确认位。env/rt 缺省真实现;测试注入临时 HOME / spy / fakeRt 快速回归。
 */
import { homedir } from 'node:os'
