import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { SIGN_IN_COMMAND, SIGN_IN_CSP, signInPage, type SignInReason } from './serverSignIn.js'

const REASONS: readonly SignInReason[] = ['required', 'invalid']

/** 页面里内联的样式 / 脚本正文。 */
function inline(html: string, tag: 'style' | 'script'): string {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'u').exec(html)
  if (match === null) throw new Error(`页面里没有内联 <${tag}>`)
  return match[1] ?? ''
}

const sha256 = (text: string): string => `'sha256-${createHash('sha256').update(text, 'utf8').digest('base64')}'`

describe('登录页的命令块', () => {
  it.each(REASONS)('%s：命令里的两个短横必须是两个 ASCII 连字符，命令块关掉字体连字，复制出来的文本不变', (reason) => {
    const html = signInPage(reason, 'en')
    expect(SIGN_IN_COMMAND).toBe('tenon dashboard --open')
    expect(html).toContain(`<code id="cmd" data-testid="sign-in-command">${SIGN_IN_COMMAND}</code>`)
    const style = inline(html, 'style')
    const rule = /(?:^|\n)code\{([^}]*)\}/u.exec(style)
    expect(rule?.[1], '样式里有 code 规则').toBeDefined()
    // 等宽字体的上下文替代会把 `--` 画成一条长横（看上去像 en dash）：连字与 calt 都要关。
    expect(rule?.[1]).toContain('font-variant-ligatures:none')
    expect(rule?.[1]).toContain('font-feature-settings:"liga" 0,"calt" 0')
    expect(rule?.[1]).toContain('var(--mono)')
  })

  it.each(REASONS)('%s：CSP 的样式哈希就是这一份内联样式的哈希（样式改了哈希跟着变，仍不开 unsafe-inline）', (reason) => {
    const html = signInPage(reason)
    expect(SIGN_IN_CSP).toContain(`style-src ${sha256(inline(html, 'style'))}`)
    expect(SIGN_IN_CSP).toContain(`script-src ${sha256(inline(html, 'script'))}`)
    expect(SIGN_IN_CSP).not.toContain('unsafe-inline')
    expect(SIGN_IN_CSP).toContain("default-src 'none'")
  })
})
