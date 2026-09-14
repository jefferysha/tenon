/**
 * 沙箱内 pipeline 驱动 + 结构化握手解析（BACKLOG #29）。
 *
 * 老仓真相源：scheduler/runChange.ts:447-545（parseSandboxReport / findLastOutputTag /
 * unwrapFences）+ sdk/output/extractStructuredOutput.ts（取最后 tag + fence 剥离）+
 * runner/docker/tenon-afk-run.sh（沙箱内 /tenon-build → /tenon-verify → ship）。
 *
 * exec 是注入面：production 绑真 docker exec（IT），单测绑 fake。缺 docker → honest skip（见
 * docker.integration.test.ts）；任何路径不为绿伪造 pass——非零退出真抛错。
 */
import { assertLoopRunner, type LoopRunner } from '@tenon/kernel'
import { type PhaseEvent, PHASE_EVENTS } from '../types.js'

export const EXECUTION_MODES = ['agent/codex', 'agent/claude-code', 'deterministic-test-fallback'] as const
export type ExecutionMode = typeof EXECUTION_MODES[number]

/** Provider 自身结构化协议给出的单次调用用量；不是 agent 文本自报。 */
export interface ProviderStructuredUsage {
  readonly provider: 'openai-codex'
  readonly request_id?: string
  readonly tokens: {
    readonly input: number
    readonly cached_input: number
    readonly output: number
    readonly reasoning: number
    readonly total: number
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const tokenCount = (usage: Record<string, unknown>, key: string): number => {
  const value = usage[key]
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`Codex JSONL usage ${key} must be a non-negative safe-integer token count`)
  }
  return value as number
}

/**
 * 解析 `codex exec --json` 的官方 JSONL 事件。没有 completed usage 时返回 undefined，调用方
 * 因而只能回退 reservation estimate；畸形或互相矛盾的 provider 数值 fail-loud。
 */
export const parseCodexJsonlUsage = (jsonl: string): ProviderStructuredUsage | undefined => {
  let requestId: string | undefined
  let completed: ProviderStructuredUsage['tokens'] | undefined
  const lines = jsonl.split(/\r?\n/)
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]?.trim() ?? ''
    if (line.length === 0) continue
    let event: unknown
    try {
      event = JSON.parse(line)
    } catch (error) {
      throw new Error(`Codex JSONL line ${index + 1} is invalid: ${String(error)}`)
    }
    if (!isRecord(event)) throw new Error(`Codex JSONL line ${index + 1} is not an object`)
    if (event.type === 'thread.started') {
      if (typeof event.thread_id !== 'string' || event.thread_id.length === 0) {
        throw new Error('Codex JSONL thread.started is missing thread_id')
      }
      if (requestId !== undefined && requestId !== event.thread_id) {
        throw new Error('Codex JSONL contains multiple thread ids')
      }
      requestId = event.thread_id
      continue
    }
    if (event.type !== 'turn.completed') continue
    if (completed !== undefined) throw new Error('Codex JSONL contains multiple turn.completed usage events')
    if (!isRecord(event.usage)) throw new Error('Codex JSONL turn.completed is missing structured usage')
    const input = tokenCount(event.usage, 'input_tokens')
    const cached_input = tokenCount(event.usage, 'cached_input_tokens')
    const output = tokenCount(event.usage, 'output_tokens')
    const reasoning = tokenCount(event.usage, 'reasoning_output_tokens')
    if (cached_input > input) throw new Error('Codex JSONL cached input tokens exceed input tokens')
    if (reasoning > output) throw new Error('Codex JSONL reasoning tokens exceed output tokens')
    const total = input + output
    if (!Number.isSafeInteger(total)) throw new Error('Codex JSONL total token count exceeds safe integer range')
    completed = { input, cached_input, output, reasoning, total }
  }
  if (completed === undefined) return undefined
  return {
    provider: 'openai-codex',
    ...(requestId === undefined ? {} : { request_id: requestId }),
    tokens: completed,
  }
}

/** 沙箱最后一行打印的结构化握手（老仓 SandboxReport）。 */
export interface SandboxReport {
  readonly verify_result: 'pass' | 'fail'
  readonly build_sha?: string
  readonly branch?: string
  /** H10 r6：真实 agent 路径或显式测试 fallback；旧握手兼容为缺席。 */
  readonly execution_mode?: ExecutionMode
  /** H6：仅由 host 固定的 Codex JSONL 解析器产出的 provider 结构化用量。 */
  readonly provider_usage?: ProviderStructuredUsage
  /** 该 run 推进过的相位（build/verify/ship）。 */
  readonly phase_event: PhaseEvent
}

/** 沙箱内命令 exec 面（onLine 供 race.ts 逐行流式；lite 只用 buffered 形态）。 */
export type SandboxExec = (
  cmd: string,
  options?: { onLine?: (line: string) => void },
) => Promise<{ stdout: string; stderr: string; exitCode: number }>

/**
 * 握手缺失 / 畸形 / schema 非法时抛（老仓 StructuredOutputError）。carries rawMatched（最后一个
 * <output> tag 内原文，或 "") 供重试反馈引用。
 */
export class StructuredOutputError extends Error {
  override readonly name = 'StructuredOutputError'
  readonly _tag = 'StructuredOutputError'
  readonly rawMatched: string
  constructor(message: string, rawMatched: string) {
    super(message)
    this.rawMatched = rawMatched
  }
}

/** 取最后一个 <output>...</output> 块（verbose agent 会 emit 多次）。 */
const findLastOutputTag = (stdout: string): string | undefined => {
  const re = /<output>\s*([\s\S]*?)\s*<\/output>/g
  let last: string | undefined
  for (let m = re.exec(stdout); m !== null; m = re.exec(stdout)) last = m[1]
  return last
}

/** 剥 agent 可能包的 ```json / ``` fence。 */
const unwrapFences = (s: string): string => {
  const t = s.trim()
  const fence = t.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/)
  return fence?.[1] !== undefined ? fence[1].trim() : t
}

/**
 * 解析 <output>{...}</output> 握手 —— last-wins、fence-tolerant、schema-validated。
 * 抛 StructuredOutputError（非裸 Error）以便重试 wrapper 区分"可恢复的 output-shape 失败"与真崩。
 */
export const parseSandboxReport = (stdout: string): SandboxReport => {
  const raw = findLastOutputTag(stdout)
  if (raw === undefined) {
    throw new StructuredOutputError('sandbox produced no <output>{...}</output> report', '')
  }
  let parsed: Record<string, unknown>
  try {
    const value: unknown = JSON.parse(unwrapFences(raw))
    if (!isRecord(value)) throw new Error('report must be a JSON object')
    parsed = value
  } catch (err) {
    throw new StructuredOutputError(`sandbox <output> is not valid JSON: ${String(err)}`, raw)
  }
  if (parsed.verify_result !== 'pass' && parsed.verify_result !== 'fail') {
    throw new StructuredOutputError('sandbox report missing/invalid verify_result (want "pass"|"fail")', raw)
  }
  // B10：沙箱自报字段不可信——phase_event 校验 PHASE_EVENTS 枚举（`?? 'verify-pass'` 只兜
  // null/undefined，兜不住非法字符串），非法值回退 verify-pass 不透传污染下游；build_sha/branch
  // 校验 string 类型（数字/对象/null 视缺失）。build_sha 权威源本就是命名分支 HEAD（barrier.ts
  // 派生，不信 report.build_sha），这里只做形状诚实化。
  const rawPhase: unknown = parsed.phase_event
  const phase_event: PhaseEvent =
    typeof rawPhase === 'string' && (PHASE_EVENTS as readonly string[]).includes(rawPhase)
      ? (rawPhase as PhaseEvent)
      : 'verify-pass'
  const build_sha = typeof parsed.build_sha === 'string' ? parsed.build_sha : undefined
  const branch = typeof parsed.branch === 'string' ? parsed.branch : undefined
  const execution_mode = typeof parsed.execution_mode === 'string'
    && (EXECUTION_MODES as readonly string[]).includes(parsed.execution_mode)
    ? parsed.execution_mode as ExecutionMode
    : undefined
  let provider_usage: ProviderStructuredUsage | undefined
  if (Object.prototype.hasOwnProperty.call(parsed, 'provider_usage')) {
    const candidate = parsed.provider_usage
    try {
      if (!isRecord(candidate) || candidate.provider !== 'openai-codex' || !isRecord(candidate.tokens)) {
        throw new Error('provider_usage must be an openai-codex structured usage object')
      }
      const input = tokenCount(candidate.tokens, 'input')
      const cached_input = tokenCount(candidate.tokens, 'cached_input')
      const output = tokenCount(candidate.tokens, 'output')
      const reasoning = tokenCount(candidate.tokens, 'reasoning')
      const total = tokenCount(candidate.tokens, 'total')
      if (cached_input > input) throw new Error('cached input tokens exceed input tokens')
      if (reasoning > output) throw new Error('reasoning tokens exceed output tokens')
      if (total !== input + output) throw new Error('total tokens must equal input plus output')
      if (candidate.request_id !== undefined
        && (typeof candidate.request_id !== 'string' || candidate.request_id.length === 0)) {
        throw new Error('request_id must be a non-empty string when present')
      }
      provider_usage = {
        provider: 'openai-codex',
        ...(candidate.request_id === undefined ? {} : { request_id: candidate.request_id as string }),
        tokens: { input, cached_input, output, reasoning, total },
      }
    } catch (error) {
      throw new StructuredOutputError(`sandbox report has invalid provider_usage: ${String(error)}`, raw)
    }
  }
  return {
    verify_result: parsed.verify_result,
    build_sha,
    branch,
    phase_event,
    ...(execution_mode === undefined ? {} : { execution_mode }),
    ...(provider_usage === undefined ? {} : { provider_usage }),
  }
}

/**
 * 仓库 tools/sandcastle/tenon-afk-run.sh 现内容的 sha256 —— 镜像 ↔ 仓库脚本的版本对账锚点
 * （真机验收 P1，2026-07-11：现役 sandcastle:local 镜像内置的旧版脚本无 codex/TENON_RUNNER
 * 分支，runner: codex 被静默降级走确定性路径并「成功」结算 paused，exit 96 诚实报错路径不可达，
 * 而镜像与仓库脚本此前没有任何对账机制，漂移完全不可见）。
 *
 * 同步纪律（两道闸，缺一不可）：
 *   ① runner.test.ts 的 sha 同步测试把本常量与仓库脚本现内容钉死——改脚本不 bump 常量 → 单测红；
 *   ② buildAfkRunCommand 把本常量嵌进 run 前置守卫——镜像内脚本 sha 不符 → exit 95 + 重建指引，
 *      经 ports.ts runWork 非零退出 throw 流进 automation_last_error，绝不带陈旧脚本静默跑。
 * bump 方式：shasum -a 256 tools/sandcastle/tenon-afk-run.sh。bump 后旧镜像自动 fail-loud，
 * 重建入口 tools/sandcastle/build.sh（构建完自验镜像内 sha，见该脚本）。
 */
export const AFK_RUN_SCRIPT_SHA256 = 'baaa2b93afb4526579f71cdb7bda9240b6d93cb9af8f56eb75e80646bc194ed2'

/** 对账失败的沙箱退出码（与脚本内 96=codex CLI 缺失、97=tap proxy 未起同段的硬错误码位）。 */
export const AFK_RUN_DRIFT_EXIT_CODE = 95
export const IMAGE_AFK_RUN_PATH = '/usr/local/bin/tenon-afk-run'
export const IMAGE_CLI_DIST_PATH = '/opt/pipeline/packages/cli/dist/tenon.mjs'
export const IMAGE_ATTESTATION_PATH = '/opt/pipeline/image-attestation.env'

/**
 * H10 r6：host 装配可传入当前实际运行的 CLI bundle 摘要。该值在运行时算出/传入，不写成
 * tenon.mjs 内常量，避免“文件包含自己的摘要”这一不可解自引用。
 */
export interface ImageRunExpectation {
  readonly cliDistSha256?: string
}

/**
 * runner 凭证边界。普通 env 原样保留；Codex 永不接收 Claude token，显式 Claude 永不接收
 * OpenAI key/CODEX_HOME。SDK、lifecycle 与真实 Docker port 共用这一纯函数，避免旁路口径分叉。
 */
export const filterRunnerEnvironment = (
  runner: LoopRunner,
  env: Readonly<Record<string, string>> | undefined,
): Record<string, string> => {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(env ?? {})) {
    if (runner === 'codex' && key === 'CLAUDE_CODE_OAUTH_TOKEN') continue
    if (runner === 'claude-code' && (key === 'OPENAI_API_KEY' || key === 'CODEX_HOME')) continue
    out[key] = value
  }
  return out
}

const checksumGuard = (path: string, digest: string, attestationKey: string, label: string): string =>
  `actual_sha="$(sha256sum ${path} 2>/dev/null | awk '{print $1}')"; ` +
  `[ "$actual_sha" = "${digest}" ] && ` +
  `grep -qx "${attestationKey}=${digest}" ${IMAGE_ATTESTATION_PATH} 2>/dev/null` +
  ` || { echo "sandcastle 镜像内 ${label} 与 host 期望或镜像 attestation 不一致——请重建镜像：tools/sandcastle/build.sh" >&2; exit ${AFK_RUN_DRIFT_EXIT_CODE}; }`

/**
 * run 前置对账守卫（沙箱内执行，busybox sha256sum/grep 皆为 alpine 自带 applet）：镜像内
 * /usr/local/bin/tenon-afk-run 的 sha256 必须等于 AFK_RUN_SCRIPT_SHA256，否则打清晰 stderr
 * 并 exit 95——绝不让陈旧脚本静默跑（sha256sum 输出格式 "<hash>  <path>"，锚 "^<hash> " 两端皆容）。
 */
const AFK_RUN_DRIFT_GUARD = checksumGuard(
  IMAGE_AFK_RUN_PATH,
  AFK_RUN_SCRIPT_SHA256,
  'pipeline_afk_run_sha256',
  'tenon-afk-run',
)

/**
 * 沙箱内 afk-run 命令（老仓 runner/docker/tenon-afk-run.sh，全链 #29c）。整条经
 * container.ts::buildExecArgs 的 `sh -c` 单参执行，故守卫与真命令可用 `;` 串接，守卫恒在前。
 *
 * v5 T20 runner 分派：runner === 'codex' → 注入 TENON_RUNNER=codex，沙箱脚本据此改起
 * codex exec 无头会话（codex CLI 惯例；脚本内 CLI 缺失时打清晰错误并非零退出——错误经
 * ports.ts runWork 的 throw 流进 scheduler 写 automation_last_error，绝不静默）。缺省走 codex；
 * claude-code 只保留为显式兼容选择；显式未知值先经 kernel 闭集 guard fail-loud。
 */
export const buildAfkRunCommand = (
  name: string,
  runner?: LoopRunner | string,
  expectation: ImageRunExpectation = {},
): string => {
  const selected = assertLoopRunner(runner ?? 'codex')
  const cliGuard = expectation.cliDistSha256 === undefined
    ? ''
    : `; ${checksumGuard(IMAGE_CLI_DIST_PATH, expectation.cliDistSha256, 'pipeline_cli_dist_sha256', 'Tenon CLI dist')}`
  const command = selected === 'codex'
    ? `TENON_AFK=1 TENON_RUNNER=codex tenon-afk-run ${name}`
    : `TENON_AFK=1 tenon-afk-run ${name}`
  return `${AFK_RUN_DRIFT_GUARD}${cliGuard}; ${command}`
}

/**
 * 跑一个 change 的 build→verify→ship 并回读握手（注入 exec 面）。非零退出 = build/verify 真失败
 * → 抛错（**绝不伪造 pass**）。真 docker 走 IT，缺 docker honest skip。
 */
export const runPipeline = async (exec: SandboxExec, name: string, _signal: AbortSignal): Promise<SandboxReport> => {
  const { stdout, stderr, exitCode } = await exec(buildAfkRunCommand(name))
  if (exitCode !== 0) {
    throw new Error(`tenon afk-run failed (exit ${exitCode}): ${stderr.slice(0, 200)}`)
  }
  return parseSandboxReport(stdout)
}
