/**
 * TransitionApplicationResult.kind → HTTP code + JSON body 的纯映射。
 *
 * 分类判定发生在 kernel createTransitionApplication 内部；这里只把结构化拒绝翻成 HTTP，
 * 消息模板逐字对齐 CLI 的同一条拒绝。单独成文件是为了让 transition.ts 保持在控制器行数上限内。
 */
import { ownerRequiredMessage, renderAgentBlocker } from '@tenon/kernel'
import type { TransitionApplicationResult } from '@tenon/kernel'

export interface TransitionOutcome {
  code: number
  body: Record<string, unknown>
}

export function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

export function mapTransitionResult(name: string, event: string, result: TransitionApplicationResult): TransitionOutcome {
  switch (result.kind) {
    case 'applied': {
      // warnings 逐条转译成 stderr WARN 行（best-effort 收尾失败，不影响已经成功的 200）。
      for (const warning of result.warnings) {
        // Legacy ABI signal only: current revision capture never emits it, and server keeps the
        // historical contract of not projecting this deprecated warning.
        if (warning.kind === 'build-sha-missing') continue
        switch (warning.projection) {
          case 'state-yaml':
            process.stderr.write(`WARN: state YAML projection 写入失败（canonical 已提交）: ${errText(warning.cause)}\n`)
            break
          case 'breadcrumb':
            process.stderr.write(`WARN: breadcrumb 写入失败: ${errText(warning.cause)}\n`)
            break
          case 'history':
            process.stderr.write(`WARN: history 写入失败: ${errText(warning.cause)}\n`)
            break
        }
      }
      return { code: 200, body: { ok: true, name, event, from: result.from, to: result.to } }
    }
    case 'unknown-event':
      return { code: 400, body: { ok: false, error: `未知 event: ${result.event}` } }
    case 'event-source-mismatch':
      return {
        code: 409,
        body: {
          ok: false,
          error: `event '${result.event}' 与当前 phase '${result.current}' 不匹配（期望来自 '${result.expected}'）`,
        },
      }
    case 'illegal-transition':
      return { code: 409, body: { ok: false, error: `illegal transition: ${result.from} -> ${result.to}` } }
    case 'precondition-violated':
      return { code: 409, body: { ok: false, error: result.lines[0], detail: result.lines } }
    case 'revision-untrusted':
      return {
        code: 409,
        body: {
          ok: false,
          error: 'Verify build revision is not trustworthy',
          code: result.blocker.code,
          reason: result.blocker.reason,
          remediation: result.blocker.remediation,
          ...(result.blocker.stateHash === undefined ? {} : { stateHash: result.blocker.stateHash }),
          ...(result.blocker.revisionHash === undefined ? {} : { revisionHash: result.blocker.revisionHash }),
        },
      }
    case 'workflow-not-found':
      return {
        code: 409,
        body: {
          ok: false,
          error: `workflow '${result.workflowName}' 未找到（期望 .pipeline/workflows/${result.workflowName}.yaml）`,
        },
      }
    case 'document-governance-invalid':
      return {
        code: 409,
        body: { ok: false, error: result.reason, code: 'document-governance-invalid' },
      }
    case 'step-not-in-graph':
      return { code: 409, body: { ok: false, error: `step '${result.stepId}' 不在 workflow '${result.workflowName}' 里` } }
    case 'event-unsupported':
      return {
        code: 409,
        body: {
          ok: false,
          error: `step '${result.stepId}' 不支持 event '${result.event}'；该 step 支持：${result.available.join(', ') || '(无)'}`,
        },
      }
    case 'step-guard-failed': {
      // server 原有 PreconditionError 的 {error: lines[0], detail: lines} 形状——注意跟 CLI 不
      // 一样：这句没有 "ERROR:" 前缀、没有结尾冒号（CLI 那份是独立的 stderr 文案套路，两边故意
      // 不同，不是需要对齐的疏漏）。
      const lines = [`step '${result.stepId}' guard 未通过`, ...result.failures]
      return { code: 409, body: { ok: false, error: lines[0], detail: lines } }
    }
    case 'step-skills-incomplete': {
      const lines = [`step '${result.stepId}' 尚未完成声明的 skill`, ...result.missing]
      return {
        code: 409,
        body: { ok: false, error: lines[0], detail: lines, code: 'step-skills-incomplete' },
      }
    }
    case 'step-agents-incomplete': {
      const lines = [
        `step '${result.stepId}' 的 agent 未通过`,
        ...result.blockers.map((blocker) => renderAgentBlocker(blocker, name)),
      ]
      return {
        code: 409,
        body: { ok: false, error: lines[0], detail: lines, code: 'step-agents-incomplete' },
      }
    }
    case 'document-evidence-failed': {
      const lines = [`OpenSpec 文档证据未通过（phase=${result.phase}）`, ...result.blockers]
      return { code: 409, body: { ok: false, error: lines[0], detail: lines, code: 'document-evidence-failed' } }
    }
    case 'test-evidence-failed': {
      const lines = [`测试证据未通过（step=${result.stepId}）`, ...result.blockers]
      return { code: 409, body: { ok: false, error: lines[0], detail: lines, code: 'test-evidence-failed' } }
    }
    case 'owner-required':
      return {
        code: 403,
        body: { ok: false, code: 'owner-required', owner: result.owner, error: ownerRequiredMessage(name, result.owner) },
      }
    case 'review-approval-required':
      return {
        code: 409,
        body: {
          ok: false,
          error: `phase '${result.phase}' 的产物尚未取得人工确认`,
          code: 'review-approval-required',
        },
      }
    case 'constraint-denied':
      return {
        code: 409,
        body: {
          ok: false,
          error: `automation constraint denied transition: ${result.reason}`,
          code: 'constraint-denied',
          reason: result.reason,
        },
      }
  }
}
