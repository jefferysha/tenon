/**
 * 匿名请求拿到的登录页（401）与登录链接无效页（403）。
 *
 * 这是服务端渲染的静态页：不含任何应用数据、会话或写 token，只有页面自己需要的内联样式与一小段复制脚本。
 * 外观取 Dashboard 的 token（暖灰底、深绿 accent、Inter / 应用字体栈、13–34 字号刻度，浅色 / 暗色跟随系统）；
 * 一种语言——按 Accept-Language 选：en 优先于 zh 用英文，其余一律中文——并同步 `<html lang>`。
 * 页面只有标题、一条命令（带复制钮）和「继续」链接；解释放在 title。
 *
 * CSP 保持严格：default-src 'none'，样式与脚本各一个 sha256（哈希由内联内容算出，改内容自动跟着变），
 * 不开 'unsafe-inline'、不用 nonce（页面是静态的）。
 */
import { createHash } from 'node:crypto'

export type SignInReason = 'required' | 'invalid'
export type SignInLang = 'zh' | 'en'

interface Copy {
  readonly heading: string
  /** 标题与命令块的 title：为什么要登录 / 链接为什么失效。 */
  readonly why: string
  readonly copy: string
  readonly copied: string
  readonly continue: string
  readonly continueHint: string
}

const COPY: Readonly<Record<SignInLang, Readonly<Record<SignInReason, Copy>>>> = {
  zh: {
    required: {
      heading: '需要登录',
      why: 'Dashboard 不向未登录的请求提供任何数据。在终端运行这条命令，浏览器会自动打开并登录。',
      copy: '复制命令', copied: '已复制', continue: '继续', continueHint: '已经登录过：进入 Dashboard',
    },
    invalid: {
      heading: '登录链接无效或已过期',
      why: '一次性登录链接只能用一次，且 2 分钟内有效。在终端重新运行这条命令。',
      copy: '复制命令', copied: '已复制', continue: '继续', continueHint: '已经登录过：进入 Dashboard',
    },
  },
  en: {
    required: {
      heading: 'Sign in required',
      why: 'The Dashboard serves nothing to unauthenticated requests. Run this command in a terminal; your browser opens signed in.',
      copy: 'Copy command', copied: 'Copied', continue: 'Continue', continueHint: 'Already signed in: open the Dashboard',
    },
    invalid: {
      heading: 'Sign-in link invalid or expired',
      why: 'A one-time sign-in link works once and expires after 2 minutes. Run this command in a terminal again.',
      copy: 'Copy command', copied: 'Copied', continue: 'Continue', continueHint: 'Already signed in: open the Dashboard',
    },
  },
}

export const SIGN_IN_COMMAND = 'tenon dashboard --open'

/** Accept-Language 的 q 值与出现顺序决定语言：en 严格优先于 zh 才用英文；没有 en / zh 或 zh 不低于 en 都是中文。 */
export function signInLanguage(acceptLanguage: string | undefined): SignInLang {
  if (acceptLanguage === undefined) return 'zh'
  let best: { lang: SignInLang; q: number } | null = null
  for (const part of acceptLanguage.split(',')) {
    const [range = '', ...params] = part.trim().split(';')
    const primary = range.trim().toLowerCase().split('-', 1)[0]
    if (primary !== 'en' && primary !== 'zh') continue
    const given = params.map((param) => param.trim()).find((param) => /^q=/iu.test(param))
    const q = given === undefined ? 1 : Number.parseFloat(given.slice(2))
    if (!Number.isFinite(q) || q <= 0) continue
    // 严格大于才换：同一 q 取先出现的（Accept-Language 的书写顺序即偏好顺序）。
    if (best === null || q > best.q) best = { lang: primary, q }
  }
  return best?.lang ?? 'zh'
}

const STYLE = `
:root{color-scheme:light dark;--bg:#f6f6f3;--card:#fff;--border:#dcdbd4;--text:#1a1a17;--text-2:#57574f;--text-3:#6c6c64;--accent:#236a50;--accent-d:#17543e;--code-bg:#f1f0eb;--code-border:#e6e5df;--fill:#e7e6e0;--ink:#18251f;--ink-fg:#fff;--shadow:0 0 0 1px rgb(24 32 27/.06),0 2px 4px -1px rgb(24 32 27/.06),0 12px 28px -6px rgb(24 32 27/.14);--font:"Inter Variable",Inter,"PingFang SC","Microsoft YaHei UI","Microsoft YaHei","Noto Sans CJK SC",-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;--mono:ui-monospace,"SF Mono",SFMono-Regular,Menlo,Consolas,monospace}
@media(prefers-color-scheme:dark){:root{--bg:#131513;--card:#1a1c1a;--border:#2c2f2c;--text:#ebebe6;--text-2:#b8b8b0;--text-3:#909088;--accent:#74c29e;--accent-d:#9dd5bb;--code-bg:#202320;--code-border:#2c2f2c;--fill:#2b2e2b;--ink:#ebebe6;--ink-fg:#131513;--shadow:inset 0 1px 0 rgb(255 255 255/.04),0 0 0 1px rgb(0 0 0/.5),0 12px 32px -6px rgb(0 0 0/.55)}}
*{box-sizing:border-box}
html,body{margin:0}
body{min-height:100vh;display:grid;place-items:center;padding:16px;background:var(--bg);color:var(--text);font:400 16px/22px var(--font);-webkit-font-smoothing:antialiased}
main{width:100%;max-width:440px;display:grid;gap:24px;padding:32px;background:var(--card);border-radius:14px;box-shadow:var(--shadow)}
.mark{display:grid;place-items:center;width:36px;height:36px;border-radius:8px;background:var(--ink);color:var(--ink-fg);font:600 19px/1 var(--font)}
h1{margin:0;font-size:24px;line-height:34px;font-weight:600;letter-spacing:-.015em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cmd{display:flex;align-items:center;gap:4px;min-width:0;padding-left:12px;border-radius:8px;background:var(--code-bg);border:1px solid var(--code-border)}
code{flex:1;min-width:0;padding:8px 0;font:400 16px/22px var(--mono);white-space:nowrap;overflow-x:auto;color:var(--text)}
button{position:relative;flex:none;display:grid;place-items:center;width:32px;height:32px;margin:0;padding:0;border:0;border-radius:8px;background:transparent;color:var(--text-3);cursor:pointer}
button::after{content:"";position:absolute;inset:-4px}
button:hover{background:var(--fill);color:var(--text)}
button svg{width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
button .ok{display:none;color:var(--accent)}
button[data-copied=true] .ok{display:block}
button[data-copied=true] .copy{display:none}
a{justify-self:start;display:inline-flex;align-items:center;min-height:40px;padding:0 4px;margin:-8px 0 -8px -4px;border-radius:4px;font-size:14px;line-height:19px;font-weight:500;color:var(--accent);text-decoration:none;white-space:nowrap}
a:hover{color:var(--accent-d);text-decoration:underline;text-underline-offset:3px}
a:focus-visible,button:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
`.trim()

/** 复制钮：成功短暂变勾；没有剪贴板权限时把命令选中，用户 Ctrl/Cmd+C 即可。 */
const SCRIPT = `
(function(){
var b=document.getElementById('copy'),c=document.getElementById('cmd'),s=document.getElementById('status');
if(!b||!c)return;
function pick(){var r=document.createRange();r.selectNodeContents(c);var g=window.getSelection();if(g){g.removeAllRanges();g.addRange(r)}}
function done(){
b.setAttribute('data-copied','true');b.setAttribute('aria-label',b.getAttribute('data-done'));b.title=b.getAttribute('data-done');if(s)s.textContent=b.getAttribute('data-done');
setTimeout(function(){b.removeAttribute('data-copied');b.setAttribute('aria-label',b.getAttribute('data-label'));b.title=b.getAttribute('data-label');if(s)s.textContent=''},1200)}
b.addEventListener('click',function(){
var t=c.textContent||'';
if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(t).then(done,pick)}else{pick()}
})
})();
`.trim()

const sha256 = (text: string): string => `'sha256-${createHash('sha256').update(text, 'utf8').digest('base64')}'`

/** 登录页的 CSP：只放行自己的内联样式与脚本（按内容哈希），其余一律拒绝。 */
export const SIGN_IN_CSP = [
  "default-src 'none'",
  `style-src ${sha256(STYLE)}`,
  `script-src ${sha256(SCRIPT)}`,
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ')

const escape = (text: string): string => text.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;').replace(/"/gu, '&quot;')

const COPY_ICON = '<svg class="copy" viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h8"/></svg>'
const OK_ICON = '<svg class="ok" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>'

/** 静态登录页：没有脚本数据、没有 token，交给任何调用方都安全。 */
export function signInPage(reason: SignInReason, acceptLanguage?: string): string {
  const lang = signInLanguage(acceptLanguage)
  const text = COPY[lang][reason]
  return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8">`
    + `<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark">`
    + `<title>Tenon Dashboard</title><style>${STYLE}</style></head>`
    + `<body data-testid="sign-in-required" data-reason="${reason}"><main>`
    + `<span class="mark" aria-hidden="true">t</span>`
    + `<h1 title="${escape(text.why)}" data-testid="sign-in-heading">${escape(text.heading)}</h1>`
    + `<div class="cmd" title="${escape(text.why)}" data-testid="sign-in-command-block">`
    + `<code id="cmd" data-testid="sign-in-command">${SIGN_IN_COMMAND}</code>`
    + `<button type="button" id="copy" aria-label="${escape(text.copy)}" title="${escape(text.copy)}" data-label="${escape(text.copy)}" data-done="${escape(text.copied)}" data-testid="sign-in-copy">${COPY_ICON}${OK_ICON}</button>`
    + `</div>`
    + `<a href="/" title="${escape(text.continueHint)}" data-testid="sign-in-continue">${escape(text.continue)}</a>`
    + `<span class="sr" id="status" role="status"></span>`
    + `</main><script>${SCRIPT}</script></body></html>`
}
