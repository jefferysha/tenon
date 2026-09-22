/**
 * 哪个宿主正在跑这条命令。
 *
 * 与「这份 runtime 是为哪个宿主装的」（release.json 的 `source.host`）是两件事：一台机器可以用
 * `tenon setup --codex` 装 runtime，然后在 Claude Code 会话里跑 tenon。按安装来源判定「当前宿主」
 * 会让诊断给错建议——对着 Claude Code 讲 Codex 的登录步骤，同时跳过 Claude 专属的 statusline 检查。
 * 判定口径与 test run 记录 `host.kind` 的那份一致（两处共用本函数，不各写一套）。
 */
export type TenonHostKind = 'claude-code' | 'codex' | 'terminal'

export interface HostEnvironment {
  readonly kind: TenonHostKind
  /** Codex 沙箱等级；非 Codex 宿主为 null。 */
  readonly sandbox: string | null
}

export function detectHostEnvironment(env: NodeJS.ProcessEnv): HostEnvironment {
  const sandbox = env.CODEX_SANDBOX ?? null
  if (sandbox !== null || env.CODEX_THREAD_ID !== undefined) return { kind: 'codex', sandbox }
  if (env.CLAUDECODE === '1') return { kind: 'claude-code', sandbox }
  return { kind: 'terminal', sandbox }
}
