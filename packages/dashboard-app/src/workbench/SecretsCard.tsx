import { useEffect, useRef, useState } from 'react'
import { deleteSecret, fetchSecrets, postSecret, type WbSecretsKeys } from '../api/client'
import { useT } from '../i18n'
import { formatApiError } from '../api/transport'
import { WbAdvanced, WB_TW } from './LoopCard'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

/**
 * SecretsCard(v6 T8)——独立「凭证」卡：Tenon 配置域 secrets.json 的审阅/写入面，
 * 跟在 AFK 执行卡之后(决策 C.5:不并入 AutomationCard——那张卡是 per-root dirty→保存语义,
 * 凭证是机器级逐键即时写,两种保存语义混在一卡会互相污染)。
 *
 * 红线与语义:
 *   · write-only:编辑态输入框永远从空开始,绝不回填明文;已配态只显示 server 给的掩码。
 *   · per-runner:claude-code 用 CLAUDE_CODE_OAUTH_TOKEN;codex 用 OPENAI_API_KEY(+CODEX_HOME,
 *     后者是路径不是密钥,不进 secrets 存储,只作只读说明行——决策 C2b,不做假输入框)。
 *   · 优先级提示:宿主 env 显式非空 > 此处保存的文件值(C4,与 afk run 注入的真实合并序一致)。
 *   · 保存/删除成功 → 重拉本卡 + onChanged 通知宿主(AutomationCard 就绪三灯 refreshToken +1);
 *     显式动作触发,不轮询(G22 纪律)。
 *
 * v10b 全量迁移（Phase 2 / W2）：wb-/lp-/sc- 手写全局类退役,样式改 tailwind 原子类（共享
 * 词汇 import LoopCard 的 WB_TW,行布局沿旧 .lp-policy/.sc-row 同族）,无新硬编码色值。
 */

const EDITABLE_KEYS = ['CLAUDE_CODE_OAUTH_TOKEN', 'OPENAI_API_KEY'] as const
type EditableKey = (typeof EDITABLE_KEYS)[number]

export interface SecretsCardProps {
  /** 保存/删除成功后的宿主通知(就绪三灯重拉)。 */
  onChanged?: () => void
  /** write-only 输入里只有真实非空用户草稿才算未保存。 */
  onDirtyChange?: (dirty: boolean) => void
  onBusyChange?: (busy: boolean) => void
}

export function SecretsCard({ onChanged, onDirtyChange, onBusyChange }: SecretsCardProps): JSX.Element {
  const { t, lang } = useT()
  const [keys, setKeys] = useState<WbSecretsKeys | null>(null)
  const [loadError, setLoadError] = useState<unknown | null>(null)
  const [editing, setEditing] = useState<EditableKey | null>(null)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [opError, setOpError] = useState<unknown | null>(null)
  const dirty = editing !== null && draft !== ''
  useEffect(() => {
    onDirtyChange?.(dirty)
  }, [dirty, onDirtyChange])
  useEffect(() => () => {
    onDirtyChange?.(false)
  }, [onDirtyChange])
  useEffect(() => {
    onBusyChange?.(busy)
  }, [busy, onBusyChange])
  useEffect(() => () => {
    onBusyChange?.(false)
  }, [onBusyChange])

  // Bug7：reload seq 守卫（参照 SkillChain/SkillHealthPanel）——挂载 + 每次保存/删除后都重拉，
  // 无守卫时慢响应会盖快响应（out-of-order），卸载后回来则 setState-after-unmount。每次 reload 递增
  // seq，仅最新一发的响应落态；卸载时再 +1 令全部在途失效。
  const seqRef = useRef(0)
  function reload(): void {
    const seq = ++seqRef.current
    fetchSecrets()
      .then((k) => {
        if (seqRef.current !== seq) return
        setKeys(k)
        setLoadError(null)
      })
      .catch((err: unknown) => {
        if (seqRef.current !== seq) return
        setLoadError(err)
      })
  }
  // 挂载拉一次(机器级资源,与 root 无关)；卸载令在途 reload 失效。
  useEffect(() => {
    reload()
    return () => {
      seqRef.current += 1
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  function startEdit(key: EditableKey): void {
    setEditing(key)
    setDraft('') // write-only:永不回填明文
    setOpError(null)
  }

  async function save(): Promise<void> {
    if (editing === null || draft === '' || busy) return
    setBusy(true)
    setOpError(null)
    try {
      await postSecret(editing, draft)
      setEditing(null)
      setDraft('')
      reload()
      onChanged?.()
    } catch (err) {
      setOpError(err)
    } finally {
      setBusy(false)
    }
  }

  async function remove(key: EditableKey): Promise<void> {
    if (busy) return
    setBusy(true)
    setOpError(null)
    try {
      await deleteSecret(key)
      reload()
      onChanged?.()
    } catch (err) {
      setOpError(err)
    } finally {
      setBusy(false)
    }
  }

  /** 旧 .sc-howto：每键「怎么拿」引导——独占一行(basis-full),沿 wb-note 次级色,无新原色。 */
  const HOWTO_TW = cn(WB_TW.note, 'mt-1 basis-full text-micro')

  return (
    <section className={WB_TW.card} data-testid="wb-secrets-card">
      <div className={WB_TW.head}>
        <b className={WB_TW.headB}>{t('workbench.sc_title')}</b>
        <span className="inline-block whitespace-nowrap rounded-full border border-border bg-fill px-2 py-0.5 font-mono text-micro font-semibold text-text">
          {t('workbench.sc_scope')}
        </span>
        <span className="flex-1" />
        <span className={WB_TW.headSub}>{t('workbench.sc_head_sub')}</span>
      </div>
      {loadError !== null && <p className={WB_TW.loadError} data-tone="error" data-testid="sc-load-error" role="alert">{t('workbench.sc_load_error', { msg: formatApiError(loadError, t, { exposeServerDetail: lang === 'zh' }) })}</p>}
      {opError !== null && <p className={WB_TW.loadError} data-tone="error" role="alert" data-testid="sc-op-error">{formatApiError(opError, t, { exposeServerDetail: lang === 'zh' })}</p>}
      {keys && (
        <div className={WB_TW.sec} data-sec="">
          {EDITABLE_KEYS.map((key) => {
            const light = keys[key]
            const isEditing = editing === key
            return (
              <div key={key} className={WB_TW.policyRow} data-testid={`sc-row-${key}`}>
                <span className={cn(WB_TW.flabel, 'font-mono')}>{key}</span>
                <span className={WB_TW.note}>{t(`workbench.sc_runner_${key}`)}</span>
                {!isEditing && light.set && (
                  <span className="font-mono text-text-2" data-testid={`sc-masked-${key}`}>{light.masked}</span>
                )}
                {!isEditing && !light.set && (
                  <span className={WB_TW.note} data-testid={`sc-unset-${key}`}>{t('workbench.sc_unset')}</span>
                )}
                {!isEditing && (
                  <>
                    <Button variant="ghost" size="sm" className={WB_TW.btnGhost} data-testid={`sc-edit-${key}`} onClick={() => startEdit(key)}>
                      {light.set ? t('workbench.sc_update') : t('workbench.sc_set')}
                    </Button>
                    {light.set && (
                      <Button variant="ghost" size="sm" className={WB_TW.btnGhost} data-testid={`sc-del-${key}`} disabled={busy} onClick={() => void remove(key)}>
                        {t('workbench.sc_delete')}
                      </Button>
                    )}
                  </>
                )}
                {isEditing && (
                  <>
                    <input
                      className={cn(WB_TW.input, 'font-mono')}
                      type="password"
                      data-testid={`sc-input-${key}`}
                      placeholder={t('workbench.sc_placeholder')}
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault()
                          void save()
                        }
                      }}
                    />
                    <Button size="sm" className={WB_TW.btnSolid} data-testid={`sc-save-${key}`} disabled={draft === '' || busy} onClick={() => void save()}>
                      {t('workbench.sc_save')}
                    </Button>
                    <Button variant="ghost" size="sm" className={WB_TW.btnGhost} data-testid={`sc-cancel-${key}`} onClick={() => { setEditing(null); setDraft('') }}>
                      {t('workbench.sc_cancel')}
                    </Button>
                  </>
                )}
              </div>
            )
          })}
          {/* IA 精简：「怎么拿」引导 + CODEX_HOME 只读路径 + 优先级说明都是解释性次要内容，
              收进「▸ 高级设置」默认折叠——核心第一屏只留两把可写凭证的掩码/编辑列表。testid 全保留。 */}
          <WbAdvanced testid="sc-adv">
            {/* G2:前置缺失引导——不光报「未配置」,补一句「怎么拿」(已配态也常驻,兼作轮换指引)。
                静态命令文本,不触碰凭证值,write-only 不受影响(单源见 kernel PREREQ_HINTS)。 */}
            {EDITABLE_KEYS.map((key) => (
              <div key={key} className={WB_TW.policyRow} data-testid={`sc-howto-row-${key}`}>
                <span className={cn(WB_TW.flabel, 'font-mono')}>{key}</span>
                <span className={cn(WB_TW.note, 'basis-full text-micro')} data-testid={`sc-howto-${key}`}>{t(`workbench.sc_howto_${key}`)}</span>
              </div>
            ))}
            {/* CODEX_HOME:路径不是密钥,不进 secrets 存储(决策 C2b)——只读说明,不做假输入框。 */}
            <div className={WB_TW.policyRow} data-testid="sc-row-CODEX_HOME">
              <span className={cn(WB_TW.flabel, 'font-mono')}>CODEX_HOME</span>
              <span className={WB_TW.note}>{t('workbench.sc_codex_home_note')}</span>
              {/* G2:即便是只读路径行,也顺手指一句怎么来的(codex login 自动设),闭合 codex 凭证获取故事。 */}
              <span className={HOWTO_TW} data-testid="sc-howto-CODEX_HOME">{t('workbench.sc_howto_CODEX_HOME')}</span>
            </div>
            <p className={cn(WB_TW.note, 'mt-2.5')}>{t('workbench.sc_precedence_note')}</p>
          </WbAdvanced>
        </div>
      )}
    </section>
  )
}
