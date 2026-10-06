/**
 * `tenon verify --ci` 的文本源：kernel 的渲染与发现生成只认键（`CiTextKey`），文案在 CLI 的消息目录里（`verify.<键>`），
 * 语言取命令依赖面的 `locale`（`TENON_LANG` → `LC_ALL` → `LC_MESSAGES` → `LANG`，缺省中文）。
 */
import type { CiText } from '@tenon/kernel'
import { msg, type MessageCode, type MessageParams } from '../i18n/messages.js'
import type { CliDeps } from '../deps.js'

export function ciTextOf(deps: CliDeps): CiText {
  return (key, params) => msg(deps, `verify.${key}` as MessageCode, params)
}

/** CLI 自己生成的文案（键不在 kernel 的 CI_TEXT_KEYS 里）。 */
export function verifyMsg(deps: CliDeps, code: Extract<MessageCode, `verify.${string}`>, params: MessageParams = {}): string {
  return msg(deps, code, params)
}

/** 浅克隆答不了「任务起点以来改了什么」：受保护文件的批准与测试完整性都按这条原因失败关闭 / 提示。 */
export function shallowReason(deps: CliDeps): string {
  return verifyMsg(deps, 'verify.shallowReason')
}
