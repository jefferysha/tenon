import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { I18nProvider, useT } from './index'
import { en, zh, type Dict } from './translations'

beforeEach(() => {
  localStorage.clear()
})

function keyPaths(d: Dict, prefix = ''): string[] {
  const out: string[] = []
  for (const [k, v] of Object.entries(d)) {
    const path = prefix ? `${prefix}.${k}` : k
    if (typeof v === 'string') out.push(path)
    else out.push(...keyPaths(v, path))
  }
  return out
}

function stringLeaves(d: Dict, prefix = '', out: Record<string, string> = {}): Record<string, string> {
  for (const [key, value] of Object.entries(d)) {
    const path = prefix ? `${prefix}.${key}` : key
    if (typeof value === 'string') out[path] = value
    else stringLeaves(value, path, out)
  }
  return out
}

describe('i18n completeness（zh / en 键结构逐一对齐）', () => {
  it('zh 与 en 键集合完全一致', () => {
    const zhKeys = keyPaths(zh).sort()
    const enKeys = keyPaths(en).sort()
    expect(zhKeys).toEqual(enKeys)
  })

  it('中英文相同值仅允许品牌、命令、协议 token 与纯占位符，不把英文产品文案漏进中文词典', () => {
    const allowed = new Set([
      'solution.setup_cmd',
      'machine.docker',
      'common.switch_to_english',
      'inbox.act_forward',
      'inbox.act_backward',
      'detail.related_sessions.platform_claude',
      'detail.related_sessions.platform_codex',
      'detail.related_sessions.platform_opencode',
      'detail.related_sessions.platform_pi',
      'detail.workflow_definition.workflow',
      'advanced.traffic_duration_ms',
      'operations.result_loop_doc_cas',
      'onboard.register_placeholder',
      'workbench.lp_scope_placeholder',
      'workbench.afk_rd_docker',
      'progress.act_fail_http',
    ])
    const zhLeaves = stringLeaves(zh)
    const enLeaves = stringLeaves(en)
    const identical = Object.keys(zhLeaves)
      .filter((key) => zhLeaves[key] !== '' && zhLeaves[key] === enLeaves[key])
      .sort()
    expect(identical).toEqual([...allowed].sort())
  })

  it('编排图标题、核心节点类型和治理元数据提供真正的中文文案', () => {
    const graph = ((zh.detail as Dict).orchestration_graph as Dict)
    expect(graph).toMatchObject({
      heading: '编排图',
      kind_workflow: '工作流',
      kind_change: '变更',
      meta_track: '轨道',
      meta_preset: '预设',
    })
  })
})

/**
 * v11 P1 新增守门：**源码里 t() 调用的键必须真的存在于字典**。
 *
 * 为什么需要这条：t() 找不到键时 **静默回落成键名本身**（index.tsx:16-24 的 resolvePath）——
 * 那是给「server 新加 hook 而前端词典没跟上」这类动态键留的兜底，但对静态字面量键来说是个陷阱：
 * 类型检查过、单元测试全绿、界面上却赫然显示 `workbench.board_gate_off` 这串原文。
 * 真踩过：P1 的 board_gate_off 就是这么溜到真机截图上的（上面的 zh/en 对称测试查不出——
 * 键在两侧「同样地不存在」，对称得很）。
 *
 * 只扫**字面量**调用 t('a.b')；模板/变量键（t(`workbench.hk_name_${id}`)）是有意的动态兜底，跳过。
 */
describe('i18n 无缺键（源码 t() 字面量键 ⊆ 字典键）', () => {
  it('src 下所有 t(\'…\') 字面量键都能在 zh 字典里解析到', async () => {
    const { readdirSync, readFileSync, statSync } = await import('node:fs')
    const { join, dirname } = await import('node:path')
    const { fileURLToPath } = await import('node:url')
    // 从**测试文件自身**定位 src/（本文件在 src/i18n/ 下，上溯一层即 src/），不读 process.cwd()：
    // vitest.config.ts 的 test.root 只影响 vitest 自己的文件解析，**不改 process.cwd()**——从仓库根
    // 跑 `npm run test:web` 时 cwd 就是仓库根，join(cwd,'src') 指向不存在的 <repo>/src 直接 ENOENT
    // （只有 cd 进包目录跑才碰巧成立）。本式与调用方 cwd 无关，两种跑法都对。
    //
    // 写法有坑，别改成 `new URL('..', import.meta.url)`：**字面量** + import.meta.url 是 Vite 的
    // 资源 URL 特例模式，transform 期就被重写成 http://localhost:3000/@fs/… 的伺服地址，
    // fileURLToPath 收到非 file: scheme 直接 throw（真踩过）。import.meta.url 自身仍是干净的
    // file:// URL，故先 fileURLToPath 成字符串再用 path 上溯，绕开该重写。
    const SRC = join(dirname(fileURLToPath(import.meta.url)), '..')

    // 跳过 components（vendored shadcn，不含 t()）与 i18n 自己：字典/Provider 里出现的
    // `t('x.y')` 只会是**注释里的示例**，朴素正则分不出注释与真调用，扫它必假阳性（真踩过）。
    const SKIP_DIRS = new Set(['components', 'i18n'])
    function walk(dir: string): string[] {
      return readdirSync(dir).flatMap((n) => {
        const p = join(dir, n)
        if (statSync(p).isDirectory()) return SKIP_DIRS.has(n) ? [] : walk(p)
        return /\.tsx?$/.test(n) && !/\.test\.tsx?$/.test(n) ? [p] : []
      })
    }

    const known = new Set(keyPaths(zh))
    const missing: string[] = []
    for (const file of walk(SRC)) {
      const src = readFileSync(file, 'utf8')
      // 只取纯字面量：t('x.y') / t("x.y")；含 ${} 的模板字面量不在此正则的捕获范围内。
      for (const m of src.matchAll(/\bt\(\s*['"]([a-zA-Z0-9_.]+)['"]/g)) {
        const key = m[1]!
        if (!known.has(key)) missing.push(`${file.replace(SRC, '')} → ${key}`)
      }
    }
    expect(missing).toEqual([])
  })
})

describe('i18n 生产 TSX 不直写中文产品文案', () => {
  it('可见文案、ARIA、title 与产品常量必须通过词典；仅允许明确登记的内部诊断', async () => {
    const { readdirSync, readFileSync, statSync } = await import('node:fs')
    const { join, dirname, relative } = await import('node:path')
    const { fileURLToPath } = await import('node:url')
    const ts = await import('typescript')
    const SRC = join(dirname(fileURLToPath(import.meta.url)), '..')
    const ALLOWED_INTERNAL = new Set([
      'AppErrorBoundary.tsx:[dashboard] render 抛错，已被顶层 ErrorBoundary 兜底：',
    ])
    function walk(dir: string): string[] {
      return readdirSync(dir).flatMap((name) => {
        const file = join(dir, name)
        if (statSync(file).isDirectory()) return name === 'i18n' ? [] : walk(file)
        return name.endsWith('.tsx') && !name.endsWith('.test.tsx') ? [file] : []
      })
    }
    const leaks: string[] = []
    for (const file of walk(SRC)) {
      const source = readFileSync(file, 'utf8')
      const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
      const visit = (node: import('typescript').Node): void => {
        let text: string | undefined
        if (ts.isJsxText(node)) text = node.getText(ast).trim().replace(/\s+/g, ' ')
        else if (
          ts.isStringLiteral(node)
          || ts.isNoSubstitutionTemplateLiteral(node)
          || ts.isTemplateHead(node)
          || ts.isTemplateMiddle(node)
          || ts.isTemplateTail(node)
        ) text = node.text
        if (text && /[\u3400-\u9fff]/.test(text)) {
          const key = `${relative(SRC, file)}:${text}`
          if (!ALLOWED_INTERNAL.has(key)) {
            const line = ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1
            leaks.push(`${relative(SRC, file)}:${line} → ${text}`)
          }
        }
        ts.forEachChild(node, visit)
      }
      visit(ast)
    }
    expect(leaks).toEqual([])
  })
})

describe('i18n 生产 TSX 不直出 Error.message', () => {
  it('错误必须在 locale render boundary 格式化；仅允许本地翻译校验对象', async () => {
    const { readdirSync, readFileSync, statSync } = await import('node:fs')
    const { join, dirname, relative } = await import('node:path')
    const { fileURLToPath } = await import('node:url')
    const ts = await import('typescript')
    const SRC = join(dirname(fileURLToPath(import.meta.url)), '..')
    function walk(dir: string): string[] {
      return readdirSync(dir).flatMap((name) => {
        const file = join(dir, name)
        if (statSync(file).isDirectory()) return name === 'i18n' ? [] : walk(file)
        return name.endsWith('.tsx') && !name.endsWith('.test.tsx') ? [file] : []
      })
    }
    const leaks: string[] = []
    for (const file of walk(SRC)) {
      const source = readFileSync(file, 'utf8')
      const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
      const visit = (node: import('typescript').Node): void => {
        if (ts.isPropertyAccessExpression(node) && node.name.text === 'message') {
          const owner = node.expression.getText(ast)
          // VerificationEvidenceComposer.validate() creates this object from current-locale t() output.
          if (owner !== 'validation') {
            const line = ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1
            leaks.push(`${relative(SRC, file)}:${line} → ${node.getText(ast)}`)
          }
        }
        ts.forEachChild(node, visit)
      }
      visit(ast)
    }
    expect(leaks).toEqual([])
  })
})

function Probe(): JSX.Element {
  const { t, lang, setLang } = useT()
  return (
    <div>
      {/* 收件箱退役：示例键改用存活键——纯文本用 nav.progress，变量插值用 inbox.badge_failed（{n}）。 */}
      <span data-testid="txt">{t('nav.progress')}</span>
      <span data-testid="var">{t('inbox.badge_failed', { n: 3 })}</span>
      <span data-testid="lang">{lang}</span>
      <button data-testid="to-en" onClick={() => setLang('en')}>en</button>
    </div>
  )
}

describe('useT 真 render（默认 zh、变量插值、切换 en）', () => {
  it('默认中文，插值替换 {n}', () => {
    render(
      <I18nProvider>
        <Probe />
      </I18nProvider>,
    )
    expect(screen.getByTestId('lang').textContent).toBe('zh')
    expect(screen.getByTestId('txt').textContent).toBe('工作台')
    expect(screen.getByTestId('var').textContent).toBe('失败 ×3 · 等你决定')
  })

  it('切到 en 后组件真更新为英文', () => {
    render(
      <I18nProvider>
        <Probe />
      </I18nProvider>,
    )
    fireEvent.click(screen.getByTestId('to-en'))
    expect(screen.getByTestId('txt').textContent).toBe('Workbench')
    expect(screen.getByTestId('var').textContent).toBe('Failed ×3 · your call')
  })
})
