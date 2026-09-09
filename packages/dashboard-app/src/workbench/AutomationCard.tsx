import { useEffect, useState } from 'react'
import { fetchAfkReadiness, fetchAutomationSettings, fetchDockerImages, postAutomationSettings, type WbAfkReadiness, type WbAutomationSettings, type WbDockerImages } from '../api/client'
import { useT } from '../i18n'
import { formatApiError } from '../api/transport'
import { LpSlider, WbAdvanced, WB_TW } from './LoopCard'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'

/**
 * AutomationCard（T21）——「AFK 执行」卡：per-root .pipeline/automation.json 的编排面，
 * 跟在 Loop 卡之后。参数作用于本项目全部 AFK 运行：并发沙箱上限（1-8，推荐 4）、失败自动
 * 重试（0-3，推荐 1）、默认入队开关、沙箱镜像（空 = 内置 sandcastle:local）。
 *
 * 交互对齐 LoopCard 的既有拍板：全部参数走「dirty 汇总 → 卡头保存钮」一次 POST
 * /api/automation；保存成功后**再 GET 回读**以 server 归一真值重置草稿（验收「保存后 GET
 * 回读一致」——不信任本地草稿，信落盘真值）。滑杆复用 LoopCard 导出的 LpSlider（同一
 * 滑杆样式纪律）。加载失败行内报错不渲染控件（诚实占位，不谎报可配）。
 *
 * 真实起效链路（不是假开关）：写盘 → automation 包 readAutomationJson → sdk.ts createAutomation
 * 装配（maxParallel/maxRetries/defaultOptIn）+ cli afk run 的 dockerRunChange image 同源。
 *
 * v10b 全量迁移（Phase 2 / W2）：wb-/afk-/lp- 手写全局类退役，样式改 tailwind 原子类（共享
 * 词汇 import LoopCard 的 WB_TW）；就绪灯状态由 data-state="ok"/"no" 承载（测试同步改断言
 * data 属性），灯色 token/color-mix 派生，无新硬编码色值、无内联 style。
 */

// 推荐值（DEFAULT_CONFIG 同源：maxParallel 4 / maxRetries 1）。
const RECO_PARALLEL = 4
const RECO_RETRIES = 1
const PARALLEL_MIN = 1
const PARALLEL_MAX = 8
const RETRIES_MIN = 0
const RETRIES_MAX = 3

const same = (a: WbAutomationSettings, b: WbAutomationSettings): boolean =>
  (a.enabled ?? false) === (b.enabled ?? false) &&
  a.max_parallel === b.max_parallel && a.max_retries === b.max_retries &&
  a.default_opt_in === b.default_opt_in && a.image === b.image

/** 就绪灯点：绿=既有 --green，未就绪黄=红绿 oklch 取中派生（决议 #9，禁新原色）；状态走 data-state。 */
function RdDot({ ok }: { ok: boolean }): JSX.Element {
  return (
    <span
      className={cn('size-2 flex-none rounded-full', ok ? 'bg-green' : 'bg-[color-mix(in_oklch,var(--red)_52%,var(--green))]')}
      data-state={ok ? 'ok' : 'no'}
      aria-hidden="true"
    />
  )
}

/** 就绪灯区「独占一行」小字（旧 .afk-rd-howto / .afk-rd-caveat——文字色 color-mix 自 --text-2 派生）。 */
const RD_HOWTO_TW = 'basis-full text-micro leading-[1.4] text-[color-mix(in_srgb,var(--text-2)_82%,transparent)]'
const RD_CAVEAT_TW = 'basis-full text-micro leading-[1.4] text-[color-mix(in_srgb,var(--text-2)_70%,transparent)]'

export interface AutomationCardProps {
  root: string
  /** v6 T9/T8：就绪三灯重拉信号——SecretsCard 保存/删除成功后由宿主 +1(显式动作触发,不轮询,G22 纪律)。 */
  refreshToken?: number
  /** 宿主离开守卫只消费真实草稿差异；加载态与仅打开面板不算 dirty。 */
  onDirtyChange?: (dirty: boolean) => void
  onBusyChange?: (busy: boolean) => void
}

export function AutomationCard({ root, refreshToken = 0, onDirtyChange, onBusyChange }: AutomationCardProps): JSX.Element {
  const { t, lang } = useT()
  // settings = server 已保存真值（GET/保存后回读）；draft = 编辑草稿。
  const [settings, setSettings] = useState<WbAutomationSettings | null>(null)
  const [loadError, setLoadError] = useState<unknown | null>(null)
  const [draft, setDraft] = useState<WbAutomationSettings | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<unknown | null>(null)
  const [saveOk, setSaveOk] = useState(false)
  // v6 T9：镜像下拉候选(机器级,一次拉取;不可用/失败 → null=降级纯文本框,零行为差异)。
  const [images, setImages] = useState<WbDockerImages | null>(null)
  // v6 T9：就绪三灯(docker/镜像/凭证);失败 → null=不渲染灯区,不阻塞其余控件。
  const [readiness, setReadiness] = useState<WbAfkReadiness | null>(null)

  useEffect(() => {
    let cancelled = false
    fetchDockerImages()
      .then((r) => {
        if (!cancelled) setImages(r)
      })
      .catch(() => {
        /* 降级纯文本框(fail-open) */
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    fetchAfkReadiness(root)
      .then((r) => {
        if (!cancelled) setReadiness(r)
      })
      .catch(() => {
        if (!cancelled) setReadiness(null)
      })
    return () => {
      cancelled = true
    }
  }, [root, refreshToken])

  // 换 root：清态重载（上一项目的参数不能在新项目语境下多渲染一拍——useLoops 同款纪律）。
  useEffect(() => {
    let cancelled = false
    setSettings(null)
    setDraft(null)
    setLoadError(null)
    setSaveError(null)
    setSaveOk(false)
    fetchAutomationSettings(root)
      .then((s) => {
        if (cancelled) return
        setSettings(s)
        setLoadError(null)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setLoadError(err)
      })
    return () => {
      cancelled = true
    }
  }, [root])

  // settings 对象换新（首载/保存后回读）→ 草稿以 server 真值重置（LoopCard 同款托管）。
  useEffect(() => {
    setDraft(settings ? { ...settings } : null)
  }, [settings])

  const dirty = draft !== null && settings !== null && !same(draft, settings)
  useEffect(() => {
    onDirtyChange?.(dirty)
  }, [dirty, onDirtyChange])
  useEffect(() => () => {
    onDirtyChange?.(false)
  }, [onDirtyChange])
  useEffect(() => {
    onBusyChange?.(saving)
  }, [saving, onBusyChange])
  useEffect(() => () => {
    onBusyChange?.(false)
  }, [onBusyChange])

  function edit(part: Partial<WbAutomationSettings>): void {
    setDraft((prev) => (prev ? { ...prev, ...part } : prev))
    setSaveOk(false)
  }

  async function save(): Promise<void> {
    if (!draft || !dirty || saving) return
    setSaving(true)
    setSaveError(null)
    setSaveOk(false)
    try {
      await postAutomationSettings({ root, ...draft, image: draft.image.trim() })
      // 保存后 GET 回读：以真落盘值为准重置 settings（草稿随上方 effect 归位）。
      const fresh = await fetchAutomationSettings(root)
      setSettings(fresh)
      setSaveOk(true)
    } catch (err) {
      setSaveError(err)
    } finally {
      setSaving(false)
    }
  }

  if (loadError) {
    return (
      <section className={WB_TW.card} data-testid="wb-afk-card">
        <div className={WB_TW.head}><b className={WB_TW.headB}>{t('workbench.afk_title')}</b></div>
        <p className={WB_TW.loadError} data-tone="error" data-testid="afk-load-error" role="alert">{t('workbench.afk_load_error', { msg: formatApiError(loadError, t, { exposeServerDetail: lang === 'zh' }) })}</p>
      </section>
    )
  }
  if (!draft) {
    return (
      <section className={WB_TW.card} data-testid="wb-afk-card">
        <div className={WB_TW.head}><b className={WB_TW.headB}>{t('workbench.afk_title')}</b></div>
        <p className={WB_TW.loading} role="status" aria-live="polite">{t('common.loading')}</p>
      </section>
    )
  }

  return (
    <section className={WB_TW.card} data-testid="wb-afk-card">
      <div className={WB_TW.head}>
        <b className={WB_TW.headB}>{t('workbench.afk_title')}</b>
        <span className="flex-1" />
        {dirty && <span className={WB_TW.statusDirty} data-state="dirty" data-testid="afk-dirty" role="status" aria-live="polite">{t('workbench.afk_dirty')}</span>}
        {saveOk && !dirty && <span className={WB_TW.statusOk} data-state="ok" data-testid="afk-save-ok" role="status" aria-live="polite">{t('workbench.afk_save_ok')}</span>}
        <Button size="sm" className={WB_TW.btnSolid} data-testid="afk-save" onClick={() => void save()} disabled={!dirty || saving}>
          {t('workbench.afk_save')}
        </Button>
        <span className={WB_TW.headSub}>{t('workbench.afk_head_sub')}</span>
      </div>

      {saveError !== null && (
        <ul className={WB_TW.saveErrors} data-testid="afk-save-error" role="alert">
          <li className={WB_TW.saveErrorsLi}>{formatApiError(saveError, t, { exposeServerDetail: lang === 'zh' })}</li>
        </ul>
      )}

      <div className={WB_TW.sec} data-sec="">
        <div className={WB_TW.secH}>
          {t('workbench.afk_sec')}
          <span className={WB_TW.hint}>{t('workbench.afk_sec_hint')}</span>
        </div>
        <div className="grid grid-cols-2 items-start gap-x-7 gap-y-2 mobile:grid-cols-1">
          <div>
            <LpSlider
              id="afk-sld-parallel"
              label={t('workbench.afk_sld_parallel')}
              value={draft.max_parallel}
              min={PARALLEL_MIN}
              max={PARALLEL_MAX}
              display={t('workbench.afk_val_parallel', { n: draft.max_parallel })}
              recoLabel={t('workbench.lp_reco', { v: RECO_PARALLEL })}
              recoFrac={(RECO_PARALLEL - PARALLEL_MIN) / (PARALLEL_MAX - PARALLEL_MIN)}
              onValue={(v) => edit({ max_parallel: v })}
            />
            {/* 验收反馈②-④：讲清楚这是「整机」上限，不是单 change 的配额 */}
            <p className={cn(WB_TW.note, 'mt-1')}>{t('workbench.afk_sld_parallel_note')}</p>
          </div>
          <LpSlider
            id="afk-sld-retries"
            label={t('workbench.afk_sld_retries')}
            value={draft.max_retries}
            min={RETRIES_MIN}
            max={RETRIES_MAX}
            display={t('workbench.afk_val_retries', { n: draft.max_retries })}
            recoLabel={t('workbench.lp_reco', { v: RECO_RETRIES })}
            recoFrac={(RECO_RETRIES - RETRIES_MIN) / (RETRIES_MAX - RETRIES_MIN)}
            onValue={(v) => edit({ max_retries: v })}
          />
        </div>

        <div className={WB_TW.policyRow}>
          <span className={WB_TW.flabel}>{t('workbench.afk_enabled')}</span>
          <Switch
            className={WB_TW.switch}
            checked={draft.enabled === true}
            aria-label={t('workbench.afk_enabled')}
            data-testid="afk-enabled"
            onCheckedChange={() => edit({ enabled: draft.enabled !== true })}
          />
          <span className={WB_TW.note}>{t('workbench.afk_enabled_note')}</span>
        </div>

        <div className={WB_TW.policyRow}>
          <span className={WB_TW.flabel}>{t('workbench.afk_opt_in')}</span>
          <Switch
            className={WB_TW.switch}
            checked={draft.default_opt_in}
            aria-label={t('workbench.afk_opt_in')}
            data-testid="afk-opt-in"
            onCheckedChange={() => edit({ default_opt_in: !draft.default_opt_in })}
          />
          <span className={WB_TW.note}>{t('workbench.afk_opt_in_note')}</span>
        </div>

        <div className={WB_TW.policyRow}>
          <label className={WB_TW.flabel} htmlFor="afk-image">{t('workbench.afk_image')}</label>
          <input
            className={cn(WB_TW.input, 'font-mono')}
            id="afk-image"
            data-testid="afk-image"
            placeholder="sandcastle:local"
            value={draft.image}
            list={images?.available ? 'afk-image-list' : undefined}
            onChange={(e) => edit({ image: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.preventDefault() // Enter 守卫：保存只走卡头保存钮（LoopCard 纪律）
            }}
          />
          {/* v6 T9：原生 datalist(决策 B.3)——docker 不可用/接口失败不渲染,输入框零行为差异降级;
              手输未来 tag 不被候选限制(原生语义),IMAGE_RE 值域校验仍在 server 侧。 */}
          {images?.available && (
            <datalist id="afk-image-list" data-testid="afk-image-list">
              {images.images.map((im) => (
                <option key={im} value={im} />
              ))}
            </datalist>
          )}
          <span className={WB_TW.note}>{t('workbench.afk_image_note')}</span>
        </div>
      </div>

      {/* IA 精简：就绪三灯是只读诊断（docker/镜像/凭证），收进「▸ 高级设置」默认折叠——核心第一屏
          只留并发/重试/入队/镜像参数。readiness 拉不到就整块不渲染(连折叠钮一起),不谎报（原逻辑不变）。 */}
      {readiness && (
        <WbAdvanced testid="afk-adv">
          <div className="mt-0.5 mb-1 flex flex-wrap items-center gap-x-2.5 gap-y-1.5 text-caption text-text-2" data-testid="afk-rd">
            <RdDot ok={readiness.docker.available} />
            <span data-testid="afk-rd-docker">
              {t('workbench.afk_rd_docker')}:{readiness.docker.available ? t('workbench.afk_rd_ok') : t('workbench.afk_rd_no')}
            </span>
            {/* G2:docker 不可用时不光报「未就绪」,补一句「怎么装」引导(独占一行,与镜像 build_hint
                复制钮语义不重复——那是命令可复制,docker 是装 App 无单条命令,故给安装入口 URL)。 */}
            {!readiness.docker.available && (
              <span className={RD_HOWTO_TW} data-testid="afk-rd-docker-howto">{t('workbench.afk_rd_docker_howto')}</span>
            )}
            <RdDot ok={readiness.image.present} />
            <span data-testid="afk-rd-image" title={readiness.image.configured}>
              {t('workbench.afk_rd_image')}:{readiness.image.present ? t('workbench.afk_rd_ok') : t('workbench.afk_rd_no')}
            </span>
            {/* Bug2：build 引导 gate 在 docker.available 之后——docker 没起时 image inspect 被短路，present
                恒 false 并非「镜像真缺」，且 build 本身需 docker 必失败；故此时不给走不通的 build CTA，改明示
                「先起 docker」。docker 起着且镜像真缺 → 才给 build_hint 复制钮。 */}
            {!readiness.image.present && readiness.docker.available && (
              <button
                type="button"
                className="ml-1 flex-none cursor-pointer rounded-full border-0 bg-[color-mix(in_oklch,var(--red)_52%,var(--green))] px-1.5 py-px text-micro font-bold whitespace-nowrap text-card"
                data-testid="afk-rd-build-copy"
                title={readiness.image.build_hint}
                onClick={() => void navigator.clipboard?.writeText(readiness.image.build_hint)}
              >
                {t('workbench.afk_rd_build_copy')}
              </button>
            )}
            {!readiness.image.present && !readiness.docker.available && (
              <span className={RD_HOWTO_TW} data-testid="afk-rd-image-needs-docker">{t('workbench.afk_rd_image_needs_docker')}</span>
            )}
            {/* full-install W1：凭证 per-runner 双灯——claude-code 与 codex 同等可见(各自灯色+文案,不靠 tooltip)。
                旅程唯一真·不对等修复(P1-F1):数据齐(credentials 含两 runner),此前 UI 只渲染 claude-code。 */}
            <RdDot ok={readiness.credentials['claude-code'].CLAUDE_CODE_OAUTH_TOKEN.set} />
            <span data-testid="afk-rd-cred-claude">
              {t('workbench.afk_rd_cred')}:
              {readiness.credentials['claude-code'].CLAUDE_CODE_OAUTH_TOKEN.set
                ? t('workbench.afk_rd_ok')
                : t('workbench.afk_rd_unset')}
            </span>
            {/* Codex CLI 支持 API key 或 Codex home 登录；两条任一可用即是真就绪。 */}
            <RdDot ok={readiness.credentials.codex.OPENAI_API_KEY.set || readiness.credentials.codex.CODEX_HOME.set} />
            <span
              data-testid="afk-rd-cred-codex"
              title={t('workbench.afk_rd_codex_hint', {
                o: readiness.credentials.codex.OPENAI_API_KEY.set ? t('workbench.afk_rd_ok') : t('workbench.afk_rd_unset'),
                c: readiness.credentials.codex.CODEX_HOME.set ? t('workbench.afk_rd_ok') : t('workbench.afk_rd_unset'),
              })}
            >
              {t('workbench.afk_rd_cred_codex')}:
              {readiness.credentials.codex.OPENAI_API_KEY.set || readiness.credentials.codex.CODEX_HOME.set
                ? t('workbench.afk_rd_ok')
                : t('workbench.afk_rd_unset')}
            </span>
            {/* 诚实 caveat(P1-F2/P1-X1)：凭证灯是服务进程视角快照,终端 doctor/setup 才是凭证权威。整行独占(basis-full)。 */}
            <span className={RD_CAVEAT_TW} data-testid="afk-rd-cred-caveat">{t('workbench.afk_rd_cred_caveat')}</span>
          </div>
        </WbAdvanced>
      )}
    </section>
  )
}
