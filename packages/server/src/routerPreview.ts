/**
 * Track Router 公共预览用例。
 *
 * 真相源仍是 effective Track Registry；本模块只复刻 hooks/router.sh 的热路径决策：
 * `grep -ciE` 行命中数 → score → priority → registry order，再加 standard 通道的两条规则
 * （见 `applyStandardLane`）。生产 scorer 直接执行 grep，不用 JavaScript RegExp 另造一套 ERE 方言。
 * UI 与测试可注入 scorer，但同一决策函数不分叉。
 */
import { spawn } from 'node:child_process'
import { isDefaultWorkflowName, type TrackDefinition } from '@tenon/kernel'

export type RouterPatternScorer = (pattern: string, prompt: string) => Promise<number>

export interface RouterPreviewCandidate {
  readonly track: TrackDefinition
  readonly order: number
  readonly priority: number
  readonly score: number
  readonly routable: boolean
  readonly excluded: boolean
}

export interface RouterPreviewResult {
  readonly winner: RouterPreviewCandidate | null
  readonly candidates: readonly RouterPreviewCandidate[]
  /** 非空表示 UserPromptSubmit hook 会在评分前跳过；候选分数仍返回，供显式创建 Change 时手选。 */
  readonly suppressed_reason: 'system-notification' | 'slash-command' | 'discussion' | null
}

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null
}

/** HTTP 草稿边界：预览允许把一个尚未保存的 custom Track 临时放进 effective registry，但绝不
 * 把未经形状校验的对象交给 scorer。该草稿仅存在于本次请求内。 */
export function parseRouterDraft(value: unknown): TrackDefinition {
  const row = object(value)
  const workflow = object(row?.workflow)
  const policy = object(row?.policyProfile)
  const routing = object(policy?.routing)
  const skills = object(policy?.skills)
  const id = row?.id
  const label = row?.label
  const allowed = workflow?.allowed
  const reviewSeed = policy?.reviewSeed
  const autoEnqueueOnSpecComplete = policy?.autoEnqueueOnSpecComplete
  const coverageProfile = policy?.coverageProfile
  if (typeof id !== 'string' || !/^[a-z][a-z0-9_-]{0,31}$/.test(id)) throw new Error('draft_track.id 非法')
  if (typeof label !== 'string' || label.trim() === '') throw new Error('draft_track.label 不得为空')
  if (row?.builtin !== false) throw new Error('draft_track.builtin 必须为 false')
  if (typeof workflow?.default !== 'string' || workflow.default.trim() === '') throw new Error('draft_track.workflow.default 不得为空')
  if (allowed !== '*' && (!Array.isArray(allowed) || allowed.length === 0 || allowed.some((item) => typeof item !== 'string' || item === ''))) {
    throw new Error("draft_track.workflow.allowed 须为 '*' 或非空 string[]")
  }
  if (reviewSeed !== 'pending' && reviewSeed !== 'skipped') throw new Error('draft_track.policyProfile.reviewSeed 非法')
  if (autoEnqueueOnSpecComplete !== undefined && typeof autoEnqueueOnSpecComplete !== 'boolean') {
    throw new Error('draft_track.policyProfile.autoEnqueueOnSpecComplete 须为 boolean')
  }
  if (typeof policy?.automationEligible !== 'boolean') throw new Error('draft_track.policyProfile.automationEligible 须为 boolean')
  if (!['none', 'pm', 'frontend', 'backend'].includes(String(coverageProfile))) throw new Error('draft_track.policyProfile.coverageProfile 非法')
  if (typeof routing?.enabled !== 'boolean') throw new Error('draft_track.policyProfile.routing.enabled 须为 boolean')
  const parsedRouting: TrackDefinition['policyProfile']['routing'] = routing.enabled
    ? (() => {
        if (typeof routing.pattern !== 'string' || routing.pattern === '') throw new Error('draft_track routing.pattern 不得为空')
        if (routing.excludePattern !== undefined && (typeof routing.excludePattern !== 'string' || routing.excludePattern === '')) {
          throw new Error('draft_track routing.excludePattern 提供时须为非空字符串')
        }
        if (!Number.isSafeInteger(routing.priority) || Number(routing.priority) < 0) throw new Error('draft_track routing.priority 须为非负整数')
        return {
          enabled: true,
          pattern: routing.pattern,
          ...(routing.excludePattern === undefined ? {} : { excludePattern: routing.excludePattern }),
          priority: Number(routing.priority),
        }
      })()
    : { enabled: false }
  if (typeof skills?.matrix !== 'boolean' || typeof skills.profile !== 'string' || skills.profile === '') {
    throw new Error('draft_track.policyProfile.skills 非法')
  }
  return {
    id,
    label: label.trim(),
    builtin: false,
    workflow: { default: workflow.default.trim(), allowed: allowed as '*' | string[] },
    policyProfile: {
      reviewSeed,
      ...(autoEnqueueOnSpecComplete === undefined ? {} : { autoEnqueueOnSpecComplete }),
      automationEligible: policy.automationEligible,
      coverageProfile: coverageProfile as TrackDefinition['policyProfile']['coverageProfile'],
      routing: parsedRouting,
      skills: { matrix: skills.matrix, profile: skills.profile },
    },
  }
}

/** 将 custom Track 草稿应用到一次性候选快照：同 id 原位替换，新 id 尾部追加；内建 policy 锁死。 */
export function applyRouterDraft(tracks: readonly TrackDefinition[], draft: TrackDefinition): readonly TrackDefinition[] {
  const index = tracks.findIndex((track) => track.id === draft.id)
  if (index >= 0 && tracks[index]?.builtin) throw new Error(`内建 Track '${draft.id}' 的 policy 不可预览覆盖`)
  if (index < 0) return [...tracks, { ...draft, builtin: false }]
  return tracks.map((track, position) => position === index ? { ...draft, builtin: false } : track)
}

const SYSTEM_MARKERS = ['<task-notification>', '<task-id>', '<output-file>', '<workflow-state>', '<pipeline-router'] as const
const DISCUSSION_MARKERS = [
  '如何使用', '怎么用', '是什么', '为什么', '解释', '文档在哪', '在哪里', '意思是',
  '我觉得', '我感觉', '你觉得', '是不是', '怎么样', '看法', '聊聊', '讨论一下', '有没有更好',
] as const

export function routerSuppressionReason(prompt: string): RouterPreviewResult['suppressed_reason'] {
  if (SYSTEM_MARKERS.some((marker) => prompt.includes(marker))) return 'system-notification'
  if (prompt.startsWith('/')) return 'slash-command'
  if (DISCUSSION_MARKERS.some((marker) => prompt.includes(marker))) return 'discussion'
  if (/^[\t\n\v\f\r ]*(what|why|how|when|where|who|can you (tell|explain|describe))\b/i.test(prompt)) {
    return 'discussion'
  }
  return null
}

/** 生产实现：真执行 `grep -ciE -- pattern`，exit 1=零命中；其它非零一律 fail-loud。 */
export function scoreRouterPatternWithGrep(pattern: string, prompt: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn('grep', ['-ciE', '--', pattern], {
      env: { ...process.env, LC_ALL: 'C' },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let stdinError: Error | null = null
    let settled = false
    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fn()
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish(() => reject(new Error('router grep 超时（2000ms）')))
    }, 2000)
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => { stdout += chunk })
    child.stderr.on('data', (chunk: string) => { stderr += chunk })
    child.on('error', (error) => finish(() => reject(new Error(`router grep 启动失败：${error.message}`))))
    child.on('close', (code, signal) => {
      finish(() => {
        if (signal !== null) return reject(new Error(`router grep 被信号 ${signal} 终止`))
        // grep 可在发现非法 ERE 后立刻以 2 退出，此时尚未写完的 stdin 会并发收到 EPIPE。
        // 进程 exit code 是命令本身的权威结论；只有 grep 正常退出 0/1 时，stdin 写失败才是
        // 独立的输入完整性错误。不能让事件到达顺序把 exit 2 覆盖成偶发 EPIPE。
        if (code !== 0 && code !== 1) return reject(new Error(`router grep exit ${String(code)}：${stderr.trim() || 'unknown error'}`))
        if (stdinError !== null) return reject(new Error(`router grep stdin 失败：${stdinError.message}`))
        if (code === 1) return resolve(0)
        const score = Number(stdout.trim())
        if (!Number.isSafeInteger(score) || score < 0) {
          return reject(new Error(`router grep 返回非法计分：${JSON.stringify(stdout.trim())}`))
        }
        return resolve(score)
      })
    })
    child.stdin.on('error', (error) => { stdinError = error })
    child.stdin.end(prompt)
  })
}

const STANDARD_TRACK = 'standard'
const DOMAIN_TRACKS: readonly string[] = ['frontend', 'backend']

function isBuiltin(candidate: RouterPreviewCandidate, id: string): boolean {
  return candidate.track.id === id && candidate.track.builtin && candidate.routable
}

/**
 * hooks/router.sh 在评分循环之后的两条 standard 通道规则，这里逐条镜像：
 *   1. 评分是按行计数的，多行 prompt 里 frontend / backend 可能以更高的行数压过 standard；只要 standard 本轮命中
 *      （得分 > 0、没被重型信号排除），就让它赢过 default 工作流的领域轨。
 *   2. 重型的实现类请求（standard 的正则命中、却被排除正则挡掉）而没有任何轨道认领：回落到 backend 轨，不能无人治理。
 */
async function applyStandardLane(
  winner: RouterPreviewCandidate | null,
  candidates: readonly RouterPreviewCandidate[],
  prompt: string,
  scorer: RouterPatternScorer,
): Promise<RouterPreviewCandidate | null> {
  const standard = candidates.find((candidate) => isBuiltin(candidate, STANDARD_TRACK))
  const domain = winner !== null && DOMAIN_TRACKS.includes(winner.track.id) && winner.track.builtin
    && isDefaultWorkflowName(winner.track.workflow.default)
  if (domain && standard !== undefined && standard.score > 0) return standard
  if (winner !== null || standard === undefined || !standard.excluded || !standard.track.policyProfile.routing.enabled) return winner
  if (await scorer(standard.track.policyProfile.routing.pattern, prompt) <= 0) return winner
  const backend = candidates.find((candidate) => isBuiltin(candidate, 'backend'))
  return backend === undefined ? winner : { ...backend, score: 1 }
}

export async function previewTrackRouting(
  prompt: string,
  tracks: readonly TrackDefinition[],
  scorer: RouterPatternScorer = scoreRouterPatternWithGrep,
): Promise<RouterPreviewResult> {
  const candidates = await Promise.all(tracks.map(async (track, order): Promise<RouterPreviewCandidate> => {
    const routing = track.policyProfile.routing
    const excluded = routing.enabled && routing.excludePattern !== undefined
      ? await scorer(routing.excludePattern, prompt) > 0
      : false
    const score = routing.enabled && !excluded ? await scorer(routing.pattern, prompt) : 0
    if (!Number.isSafeInteger(score) || score < 0) {
      throw new Error(`router scorer 为 track '${track.id}' 返回非法计分 ${String(score)}`)
    }
    return {
      track,
      order,
      priority: routing.enabled ? routing.priority : 0,
      score,
      routable: routing.enabled,
      excluded,
    }
  }))

  let winner: RouterPreviewCandidate | null = null
  for (const candidate of candidates) {
    if (!candidate.routable || candidate.score <= 0) continue
    if (winner === null
      || candidate.score > winner.score
      || (candidate.score === winner.score && candidate.priority > winner.priority)) {
      winner = candidate
    }
  }
  const suppressedReason = routerSuppressionReason(prompt)
  return {
    winner: suppressedReason === null ? await applyStandardLane(winner, candidates, prompt, scorer) : null,
    candidates,
    suppressed_reason: suppressedReason,
  }
}
