/**
 * doctor 里两项与「现在坐在哪个宿主里」有关的检查：Claude 专属 statusline、本机 Codex 登录。
 *
 * 判定用的是正在跑这条命令的宿主，不是 runtime 的安装来源。一台机器可以 `tenon setup --codex`
 * 装好 runtime，然后在 Claude Code 会话里跑 tenon；按安装来源判定会对着 Claude Code 讲 Codex 的
 * 登录步骤，同时跳过 Claude 的 statusline 检查——两项都答错了自己的问题。纯终端（既非 Codex 也非
 * Claude Code）时没有会话宿主可言，才退回安装来源。
 */
import { join } from 'node:path'
import type { DoctorProbes } from '../deps.js'
import { renderCodexAuthLines } from '../codexAuth.js'
import { green, yellow, type DoctorCheck } from './doctor-check.js'

export async function activeHost(p: DoctorProbes): Promise<'codex' | 'claude' | null> {
  const live = p.hostKind()
  if (live === 'codex') return 'codex'
  if (live === 'claude-code') return 'claude'
  return p.nativeRuntimeHost()
}

export async function checkStatusline(p: DoctorProbes): Promise<DoctorCheck> {
  if (await activeHost(p) === 'codex') {
    return green('guard:statusline', '当前会话宿主为 Codex；Claude 专属 statusline 不适用（不影响 Dashboard 或 pipeline hooks）')
  }
  if (p.statuslineConfigured()) return green('guard:statusline', 'statusline 已接入 settings（终端零开销状态生效）')
  return yellow(
    'guard:statusline',
    'statusline 未接入 settings——终端状态面不可见（功能降级）',
    `在 ~/.claude/settings.json 加 "statusLine": {"type": "command", "command": "bash ${join(p.pluginRoot, 'hooks', 'statusline.sh')}"}`,
  )
}

export async function checkCodexAuth(p: DoctorProbes): Promise<DoctorCheck> {
  if (await activeHost(p) !== 'codex') {
    return green('auth:codex', '当前会话宿主非 Codex；本机 Codex 登录检查不适用')
  }
  const status = await p.codexAuthStatus()
  if (status.state === 'authenticated') {
    return green('auth:codex', 'Codex CLI 已登录（ChatGPT 方案或 API Key）')
  }
  const lines = renderCodexAuthLines(status)
  return yellow(
    'auth:codex',
    status.state === 'unauthenticated'
      ? 'Codex CLI 尚未登录；插件已安装，但调用 Codex 前需要完成认证'
      : '暂时无法确认 Codex CLI 登录状态；插件仍可安装和检查',
    lines.slice(1).map((line) => line.trim()).join('；'),
  )
}
