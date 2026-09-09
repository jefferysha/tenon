import { useEffect, useRef, useState } from 'react'
import { Check, CircleAlert, LoaderCircle } from 'lucide-react'
import { useT } from '../i18n'
import { Icon } from './Icon'
import { CreateChangeDialog } from '../progress/CreateChangeDialog'

export interface OnboardingProps {
  kind: 'no-project' | 'no-change'
  /** no-change 形态：当前项目 root（拼 CLI 命令用）。 */
  root?: string
  onCreated?: (name: string) => void | Promise<void>
  onToast?: (message: string) => void
  /** 测试边界；production 默认使用浏览器 Clipboard API。 */
  copyText?: (text: string) => Promise<void>
}

/** 建 change 的教学命令（字面终端命令，非 i18n——命令本身不翻译）。 */
const INIT_CMD = 'tenon init my-change --track chat'

// ── tailwind 类串（v10b 迁移：.empty/.ob-* 全局类退役，样式全由原子类承载）──
/** 教学空态卡片基底（max-width 按形态各自补：no-change 460px / no-project 小屏 620px）。 */
const EMPTY_CLS = 'mx-auto my-[8vh] rounded-md border border-border bg-card px-8 py-8 text-center'
const EMPTY_MARK_CLS = 'mx-auto mb-3.5 grid h-[42px] w-[42px] place-items-center rounded-md bg-ink text-ink-fg'
const EMPTY_TITLE_CLS = 'mb-2 text-title font-bold text-text'
const EMPTY_DESC_CLS = 'mb-4 text-caption leading-[1.7] text-text-3'
const STEP_LABEL_CLS = 'text-caption leading-[1.6] text-text-2'
const STEP_N_CLS = 'h-[22px] w-[22px] flex-none rounded-full bg-ink text-center text-caption font-bold leading-[22px] text-ink-fg'
const STEP_CARD_CLS =
  'flex gap-3 min-[1024px]:h-full min-[1024px]:min-w-0 min-[1024px]:rounded-md min-[1024px]:border min-[1024px]:border-border min-[1024px]:bg-fill/55 min-[1024px]:p-3.5'

type CopyState = 'idle' | 'pending' | 'success' | 'error'

function writeClipboard(text: string): Promise<void> {
  const clipboard = navigator.clipboard
  if (!clipboard?.writeText) return Promise.reject(new Error('Clipboard API unavailable'))
  return clipboard.writeText(text)
}

/**
 * 单条可复制命令行（$ 提示符 + 命令 + 复制钮），以真实 clipboard 结果驱动四态反馈。
 * 前端只读，唯一动作是把真命令拷进剪贴板导回终端——不做假注册/假安装（决议#7）。
 */
function CmdRow({
  cmd,
  testid,
  copyTestid,
  copyText,
}: {
  cmd: string
  testid: string
  copyTestid: string
  copyText: (text: string) => Promise<void>
}): JSX.Element {
  const { t } = useT()
  const [state, setState] = useState<CopyState>('idle')
  const copyTimerRef = useRef<number | null>(null)
  const mountedRef = useRef(true)
  const generationRef = useRef(0)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      generationRef.current += 1
      if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current)
    }
  }, [])

  function copy(): void {
    if (state === 'pending') return
    if (copyTimerRef.current !== null) {
      window.clearTimeout(copyTimerRef.current)
      copyTimerRef.current = null
    }
    const generation = ++generationRef.current
    setState('pending')
    void Promise.resolve()
      .then(() => copyText(cmd))
      .then(
        () => settle('success', 2000),
        () => settle('error', 4000),
      )

    function settle(next: 'success' | 'error', resetAfter: number): void {
      if (!mountedRef.current || generationRef.current !== generation) return
      setState(next)
      copyTimerRef.current = window.setTimeout(() => {
        if (!mountedRef.current || generationRef.current !== generation) return
        copyTimerRef.current = null
        setState('idle')
      }, resetAfter)
    }
  }

  const label =
    state === 'pending'
      ? t('onboard.copying')
      : state === 'success'
        ? t('onboard.copied')
        : state === 'error'
          ? t('onboard.copy_retry')
          : t('onboard.copy')
  const status =
    state === 'pending'
      ? t('onboard.copying_status')
      : state === 'success'
        ? t('onboard.copied')
        : state === 'error'
          ? t('onboard.copy_error')
          : null
  const statusTone =
    state === 'error' ? 'text-red-d' : state === 'success' ? 'text-green-d' : 'text-text-3'

  return (
    <div className="min-w-0">
      <div className="flex items-center gap-2 rounded-sm border border-code-border bg-code-bg px-3 py-2 font-mono text-caption">
        <span className="flex-none text-text-3" aria-hidden="true">$</span>
        <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap text-text" data-testid={testid}>{cmd}</code>
        <button
          type="button"
          className="inline-flex min-h-6 flex-none cursor-pointer items-center gap-1 rounded-sm px-2 whitespace-nowrap text-micro font-bold text-accent-d transition-colors motion-reduce:transition-none hover:text-(--accent) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--accent) aria-disabled:cursor-wait aria-disabled:opacity-60"
          data-testid={copyTestid}
          aria-label={t('onboard.copy_command', { command: cmd })}
          aria-disabled={state === 'pending'}
          onClick={copy}
        >
          {state === 'pending' ? (
            <LoaderCircle size={12} strokeWidth={1.75} aria-hidden="true" />
          ) : state === 'success' ? (
            <Check size={12} strokeWidth={1.75} aria-hidden="true" />
          ) : state === 'error' ? (
            <CircleAlert size={12} strokeWidth={1.75} aria-hidden="true" />
          ) : (
            <Icon name="copy" size={12} />
          )}
          {label}
        </button>
      </div>
      {status && (
        <div
          className={`mt-1.5 flex min-h-4 items-center gap-1.5 px-1 text-micro leading-4 ${statusTone}`}
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          {state === 'error' ? (
            <CircleAlert size={12} strokeWidth={1.75} aria-hidden="true" />
          ) : state === 'success' ? (
            <Check size={12} strokeWidth={1.75} aria-hidden="true" />
          ) : (
            <LoaderCircle size={12} strokeWidth={1.75} aria-hidden="true" />
          )}
          <span>{status}</span>
        </div>
      )}
    </div>
  )
}

/**
 * 教学式空状态（G18，spec §3.2；视觉真相源 demo all-views §6）：空状态不只说"没有数据"，而是
 * 教会界面怎么用。
 *
 * full-install W2（旅程 P0 断点）：纯 dashboard 新用户曾撞死胡同——无注册入口、切换器 >1 才现、
 * 空收件箱 CTA「去进度」也空成死循环。no-project 态从「单条 tenon init」升级为「诚实两步
 * checklist」：能看到 Dashboard 说明 setup 已完成，这里只引导创建 Change 并运行 doctor 校验
 * （tenon init → doctor），做完刷新本页即可。决议#7 不反悔加注册 UI：不做假注册/假安装
 * 按钮，前端只把命令导回终端，也不猜测宿主是 Codex 还是 Claude。
 *
 * T17（决议#7 + T2）：tenon init best-effort 自动登记项目（kernel projectRegistry），注册表单
 * 与 POST /api/projects 调用退役（端点仅兼容保留），幽灵命令 `pipeline projects add` 一并清除。
 */
export function Onboarding({ kind, root, onCreated, onToast, copyText = writeClipboard }: OnboardingProps): JSX.Element {
  const { t } = useT()
  const [createOpen, setCreateOpen] = useState(false)

  if (kind === 'no-change') {
    const cli = `cd ${root || '<project>'} && ${INIT_CMD}`
    return (
      <div className={`${EMPTY_CLS} max-w-[460px]`} data-testid="onboard-no-change">
        <div className={EMPTY_MARK_CLS} aria-hidden="true"><Icon name="flow" size={20} /></div>
        <h1 className={EMPTY_TITLE_CLS}>{t('onboard.no_change_title')}</h1>
        <p className={EMPTY_DESC_CLS}>{t('onboard.no_change_desc')}</p>
        <button
          type="button"
          className="mb-4 inline-flex items-center justify-center rounded-md bg-btn-bg px-4 py-2 text-caption font-bold text-btn-fg transition-colors motion-reduce:transition-none hover:bg-btn-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--accent)"
          data-testid="onboard-new-change"
          onClick={() => setCreateOpen(true)}
        >
          {t('change_create.create')}
        </button>
        <div className="mb-2 text-micro font-bold uppercase tracking-[0.14em] text-text-3">{t('onboard.cli_fallback')}</div>
        <CmdRow key={cli} cmd={cli} testid="onboard-cli" copyTestid="onboard-copy" copyText={copyText} />
        {createOpen && root && (
          <CreateChangeDialog
            root={root}
            onClose={() => setCreateOpen(false)}
            onCreated={onCreated ?? (() => undefined)}
            onToast={onToast}
          />
        )}
      </div>
    )
  }

  // no-project：tenon init 会自动登记项目；界面只保留可复制的真实终端步骤，不再要求用户
  // 暴露本机绝对路径或理解项目注册表。
  return (
    <div className={`${EMPTY_CLS} max-w-[620px] min-[1024px]:max-w-[920px]`} data-testid="onboard-no-project">
      <div className={EMPTY_MARK_CLS} aria-hidden="true"><Icon name="folder" size={20} /></div>
      <h1 className={EMPTY_TITLE_CLS}>{t('onboard.no_project_title')}</h1>
      <p className={EMPTY_DESC_CLS}>{t('onboard.no_project_desc')}</p>
      <ol className="mt-1 flex list-none flex-col gap-3.5 p-0 text-left min-[1024px]:grid min-[1024px]:grid-cols-1 min-[1100px]:grid-cols-2">
        <li className={STEP_CARD_CLS}>
          <span className={STEP_N_CLS} aria-hidden="true">1</span>
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <div className={STEP_LABEL_CLS}>{t('onboard.step_init')}</div>
            <CmdRow cmd={INIT_CMD} testid="onboard-cli" copyTestid="onboard-copy" copyText={copyText} />
          </div>
        </li>
        <li className={STEP_CARD_CLS}>
          <span className={STEP_N_CLS} aria-hidden="true">2</span>
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <div className={STEP_LABEL_CLS}>{t('onboard.step_doctor')}</div>
            <CmdRow cmd="tenon doctor" testid="onboard-cmd-doctor" copyTestid="onboard-copy-doctor" copyText={copyText} />
          </div>
        </li>
      </ol>
    </div>
  )
}
