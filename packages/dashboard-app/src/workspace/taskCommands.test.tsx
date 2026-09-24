import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { takeoverPrompt } from './taskCommands'

// vitest 在仓库根运行（同 designSystem.test 的 process.cwd() 口径）。
const PROMPT_INTENT = join(process.cwd(), 'hooks/prompt-intent.sh')

/** 用 router hook 同一份 shell 判定跑提示词：0 = 命中。 */
function hookAccepts(fn: 'pipeline_prompt_requests_resume' | 'pipeline_prompt_names_change', prompt: string, change: string): boolean {
  try {
    execFileSync('bash', ['-c', `. "$1"; ${fn} "$2" "$3"`, 'probe', PROMPT_INTENT, prompt, change], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

describe('takeoverPrompt', () => {
  it('复制发给 agent 的恢复提示词：/tenon 继续 <change>，不是 tenon session activate', () => {
    expect(takeoverPrompt('demo-task')).toBe('/tenon 继续 demo-task')
    expect(takeoverPrompt('demo-task')).not.toContain('session activate')
  })

  it('router hook 把它识别为点名该 change 的恢复（完整 token，不误命中前缀同名）', () => {
    const prompt = takeoverPrompt('demo-task')
    expect(hookAccepts('pipeline_prompt_names_change', prompt, 'demo-task')).toBe(true)
    expect(hookAccepts('pipeline_prompt_requests_resume', prompt, 'demo-task')).toBe(true)
    expect(hookAccepts('pipeline_prompt_names_change', prompt, 'demo')).toBe(false)
  })
})
