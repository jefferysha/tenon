/**
 * 指令模板与指令文件写入的作者记录：`<configRoot>/templates/instructions/audit.jsonl`，一行一条，只追加。
 *
 * - 身份来自 server 注入的 resolveUser（声明式身份）；token 只是路由凭据、不代表人，所以缺身份的写端点 412 拒绝。
 * - 审计行在文件真正落盘之后追加；追加失败只写 stderr 告警，既不回滚已写入的文件，也不改变响应。
 * - 目标文件拒绝符号链接（O_NOFOLLOW），权限 0600，与 token、user.json 同级别。
 */
import { closeSync, constants, mkdirSync, openSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { USER_MISSING_HINT, actorOf, isTenonUser, type RecordActor, type TenonUserResolution } from '@tenon/kernel'

/** design §3.1 的固定动作集。 */
export type InstructionAuditAction =
  | 'template-save'
  | 'template-copy'
  | 'template-delete'
  | 'instruction-apply'
  | 'instruction-delete'
  | 'project-create'

export interface InstructionAuditRow {
  readonly at: string
  readonly actor: RecordActor
  readonly action: InstructionAuditAction
  readonly target: string
  readonly digest_before: string
  readonly digest_after: string
}

export type ResolveInstructionUser = (root: string) => TenonUserResolution

/** 缺声明身份时的统一拒绝：与 change / owner 写端点同码同文案。 */
export const IDENTITY_REQUIRED = { status: 412, body: { ok: false, code: 'user-missing', error: USER_MISSING_HINT } }

/** 请求 root 上的声明身份；未注入、缺身份与非法身份都返回 null。 */
export function auditActor(resolve: ResolveInstructionUser | undefined, root: string): RecordActor | null {
  const resolution = resolve?.(root)
  return resolution !== undefined && isTenonUser(resolution) ? actorOf(resolution) : null
}

/** 落盘成功后记一行；时间取本机时钟，与 history 同精度。 */
export function recordInstructionAudit(configRoot: string, row: Omit<InstructionAuditRow, 'at'>): void {
  const path = join(configRoot, 'templates', 'instructions', 'audit.jsonl')
  let fd: number | undefined
  try {
    mkdirSync(dirname(path), { recursive: true })
    fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW, 0o600)
    writeFileSync(fd, `${JSON.stringify({ at: new Date().toISOString(), ...row })}\n`, 'utf8')
  } catch (error) {
    process.stderr.write(`WARN: audit.jsonl 追加失败: ${error instanceof Error ? error.message : String(error)}\n`)
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}
