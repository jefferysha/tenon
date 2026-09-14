/** G1 canonical state / legacy YAML projection 的显式运维入口。 */
import { lstat, readFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import {
  compileEffectiveWorkflowPlan,
  ensureWorkflowPlanSnapshot,
  parseWorkflow,
  resolveWorkflowName,
  workflowPlanSnapshot,
} from '@tenon/kernel'
import type { CliDeps } from '../deps.js'

export interface StateProjectionCommandOptions {
  readonly json?: boolean
  readonly forceCanonical?: boolean
  readonly workflowFile?: string
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export async function cmdStateProjection(
  deps: CliDeps,
  sub: string,
  name: string,
  opts: StateProjectionCommandOptions = {},
): Promise<number> {
  const changeDir = join(deps.cwd, 'openspec', 'changes', name)
  try {
    switch (sub) {
      case 'status': {
        const status = await deps.store.inspectProjection(changeDir)
        deps.io.out(opts.json ? JSON.stringify(status) : `${name}: ${status.status}`)
        return status.status === 'drift' ? 2 : 0
      }
      case 'repair-projection': {
        const status = await deps.store.repairProjection(changeDir, {
          forceCanonical: opts.forceCanonical,
        })
        deps.io.out(opts.json ? JSON.stringify(status) : `${name}: ${status.status}`)
        return 0
      }
      case 'import-legacy': {
        const result = await deps.store.importLegacyProjection(changeDir)
        if (result.ignoredProtectedFields.length > 0) {
          deps.io.err(`WARN: import-legacy 已忽略受保护字段（保留 canonical 值）：${result.ignoredProtectedFields.join(', ')}`)
        }
        const body = {
          status: 'imported',
          projection: result.projection.status,
          ignored_protected_fields: result.ignoredProtectedFields,
        }
        deps.io.out(opts.json ? JSON.stringify(body) : `${name}: imported (${result.projection.status})`)
        return result.projection.status === 'updated' ? 0 : 2
      }
      case 'pin-workflow-snapshot': {
        if (!opts.workflowFile) {
          deps.io.err('ERROR: pin-workflow-snapshot 必须提供 --workflow-file')
          return 1
        }
        const state = await deps.store.read(changeDir)
        const metadata = state.runMetadata
        if (metadata?.workflowPlanFingerprint === undefined) {
          throw new Error('Change 未绑定 workflow plan fingerprint，不能补快照')
        }
        if (metadata.workflowPlanSnapshot !== undefined) {
          deps.io.out(opts.json
            ? JSON.stringify({ status: 'already-pinned' })
            : `${name}: workflow snapshot already pinned`)
          return 0
        }
        const sourcePath = isAbsolute(opts.workflowFile)
          ? opts.workflowFile
          : resolve(deps.cwd, opts.workflowFile)
        const info = await lstat(sourcePath)
        if (!info.isFile() || info.isSymbolicLink()) {
          throw new Error(`workflow file 必须是非 symlink 普通文件: ${sourcePath}`)
        }
        const workflowId = resolveWorkflowName(state)
        const plan = compileEffectiveWorkflowPlan(
          workflowId,
          parseWorkflow(await readFile(sourcePath, 'utf8')),
        )
        if (plan.workflowFingerprint !== metadata.workflowPlanFingerprint) {
          throw new Error(
            `workflow file fingerprint 不匹配：expected=${metadata.workflowPlanFingerprint} `
            + `actual=${plan.workflowFingerprint}`,
          )
        }
        await ensureWorkflowPlanSnapshot(changeDir, metadata.runId, workflowPlanSnapshot(plan))
        deps.io.out(opts.json
          ? JSON.stringify({ status: 'pinned', workflow: workflowId, fingerprint: plan.workflowFingerprint })
          : `${name}: workflow snapshot pinned (${plan.workflowFingerprint})`)
        return 0
      }
      default:
        deps.io.err('用法：tenon state <status|repair-projection|import-legacy|pin-workflow-snapshot> <change>')
        return 1
    }
  } catch (error) {
    deps.io.err(`ERROR: ${message(error)}`)
    return 1
  }
}
