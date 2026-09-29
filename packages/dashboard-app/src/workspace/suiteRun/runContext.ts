import { testArtifactUrl } from '../../api/testEvidenceClient'
import { shellQuote } from '../../shared/shellQuote'

/** 一次运行的定位：产物下载 URL 与本机路径都由它派生。 */
export interface RunContext {
  readonly root: string
  readonly change: string
  readonly user: string
  readonly runId: string
  /** 本次运行的产物目录（相对项目根），来自记录明细。 */
  readonly artifactsDir: string
}

export function runHref(ctx: RunContext, path: string, tail?: number): string {
  return testArtifactUrl(ctx.root, ctx.change, ctx.user, ctx.runId, path, tail)
}

/** 产物在本机的绝对路径（项目根 + 运行目录 + 相对路径），复制 show-trace 命令用。 */
export function localArtifactPath(ctx: RunContext, path: string): string {
  return [ctx.root.replace(/\/+$/u, ''), ctx.artifactsDir, path].join('/')
}

export function showTraceCommand(ctx: RunContext, path: string): string {
  return `npx playwright show-trace ${shellQuote(localArtifactPath(ctx, path))}`
}
