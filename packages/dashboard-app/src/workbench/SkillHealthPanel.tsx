import { useEffect, useState } from 'react'
import { cn } from '@/lib/utils'
import { fetchSkillsRegistry, type WbSkillEntry } from '../api/client'
import { formatApiError } from '../api/transport'
import { useT } from '../i18n'
import { WbAdvanced } from './LoopCard'

/**
 * SkillHealthPanel（full-install W4，计划 2026-07-12-full-install-experience 批 2 Wave B，
 * 闭 P1-F3/BF10）—— dashboard 右栏只读「技能齐全度」面：消费既有 GET /api/skills/registry
 * （v6 T6，返回 {skills: WbSkillEntry[]}，每条含 installed 布尔）→ 展示「已装 N / 未装 M」计数
 * + 未装技能名 +「去终端跑 tenon setup 装齐」可复制引导。
 *
 * 边界纪律（决议边界）：前端只读不装——装技能是终端 tenon setup 的事，本面只做齐全度呈现
 * + 引导回终端，不提供任何前端安装按钮。命令真实（tenon setup / tenon doctor 都是仓库
 * 真命令，非 i18n 文案，硬编码为常量避免翻译层漂移），与终端同源（BF11：文案/命令与 setup/
 * doctor 一致）。
 *
 * fail-soft（不谎报全绿）：
 *   · registry fetch 失败 → 行内错误提示，不阻塞、不崩、绝不落「已装齐」；
 *   · registry 空/未就绪（skills 长度 0）→「未就绪，跑 tenon doctor 查」，不谎报全绿——
 *     对齐 cli doctor.ts「registry 未就绪…不误报 green」的既有口径。
 *
 * 数据面走 client.fetchSkillsRegistry 接缝（dashboard-client-seam 收拢；错误文案仍在本站点）。
 */

// 真命令常量（BF11 与终端同源，不进 i18n——命令本体不随语言变，翻译层不得改写）。
const SETUP_CMD = 'tenon setup'
const DOCTOR_CMD = 'tenon doctor'

// ── W3 tailwind 迁移：原 styles.ts 规则的等值原子类串（颜色全走 token）。──
/** 原 .wb-note。 */
const NOTE_CLS = 'text-caption leading-[1.55] text-text-3'
/** 原 .side-card__row（相邻行分隔线在第二行上用 border-t 直给）。 */
const ROW_CLS = 'flex items-center gap-2 py-2 text-caption text-text-2'
/** 原 .side-card__row-value（警示变体 text-red-d 由调用点条件叠加）。 */
const ROW_VALUE_CLS = 'flex-none font-mono text-base font-[750] text-accent-d'

export function SkillHealthPanel(): JSX.Element {
  const { t, lang } = useT()
  const [registry, setRegistry] = useState<WbSkillEntry[] | null>(null)
  const [regError, setRegError] = useState<unknown | null>(null)

  // 挂载拉一次（机器级技能库，与 root/workflow 无关；G22 纪律：不轮询）。失败 fail-soft。
  useEffect(() => {
    let cancelled = false
    fetchSkillsRegistry()
      .then((skills) => {
        if (!cancelled) setRegistry(skills)
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setRegError(err)
        }
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 挂载只拉一次；t 变化不重拉
  }, [])

  const cmdButton = (cmd: string, testid: string): JSX.Element => (
    <button
      type="button"
      className="inline-flex max-w-full cursor-pointer items-center self-start rounded-sm border border-border bg-fill/55 px-2.5 py-1 transition-colors hover:border-text-3 hover:bg-fill"
      data-testid={testid}
      title={t('workbench.skh_copy_hint')}
      onClick={() => void navigator.clipboard?.writeText(cmd)}
    >
      <code className="truncate font-mono text-caption text-text">{cmd}</code>
    </button>
  )

  const installed = registry?.filter((e) => e.installed) ?? []
  const missing = registry?.filter((e) => !e.installed) ?? []

  return (
    // 旧 `.wb8-pane > .side-card` 剥皮语义（Phase 4 视觉验收 #3）：本面只在技能健康 pane 内渲染，
    // pane 自带外卡壳——根节点不套第二层 border/bg-card/shadow（卡内卡），head/body 左右内边距收平
    // （旧 .side-card__head/__body 在 pane 内 padding-left/right:0），与同 pane 矩阵区（wb-mx-card）统一。
    <div className="side-card" data-testid="wb-side-skillhealth">
      <div className="side-card__head flex items-center gap-2 border-b border-border py-3 text-text-3">
        <b className="text-body font-bold text-text">{t('workbench.skh_title')}</b>
      </div>
      <div className="side-card__body pt-0.5 pb-1">
        {/* fail-soft：fetch 失败——行内错误，不谎报全绿。 */}
        {regError !== null && (
          <p className="p-5 text-body text-red" data-testid="skh-error" role="alert">
            {t('workbench.skh_error', {
              msg: formatApiError(regError, t, { exposeServerDetail: lang === 'zh' }),
            })}
          </p>
        )}

        {!regError && registry === null && <p className={NOTE_CLS} role="status" aria-live="polite">{t('common.loading')}</p>}

        {/* registry 空/未就绪：不谎报「已装齐」，导向终端 doctor（对齐 doctor「不误报 green」）。 */}
        {!regError && registry !== null && registry.length === 0 && (
          <div data-testid="skh-unready" role="status" aria-live="polite">
            <p className={NOTE_CLS}>{t('workbench.skh_unready')}</p>
            {cmdButton(DOCTOR_CMD, 'skh-copy-doctor')}
          </div>
        )}

        {!regError && registry !== null && registry.length > 0 && (
          <div data-testid="skh-ready">
            <div className={ROW_CLS}>
              <span className="min-w-0 flex-1 truncate font-[550]">{t('workbench.skh_installed')}</span>
              <span className={ROW_VALUE_CLS} data-testid="skh-installed-n">
                {installed.length}
              </span>
            </div>
            <div className={cn(ROW_CLS, 'border-t border-border')}>
              <span className="min-w-0 flex-1 truncate font-[550]">{t('workbench.skh_missing')}</span>
              <span
                className={cn(ROW_VALUE_CLS, missing.length > 0 && 'text-red-d')}
                data-testid="skh-missing-n"
              >
                {missing.length}
              </span>
            </div>
            {missing.length === 0 ? (
              <p className={NOTE_CLS} data-testid="skh-all-good">
                {t('workbench.skh_all_installed')}
              </p>
            ) : (
              // IA 精简：未装技能长列表 + setup 引导收进「▸ 高级设置」默认折叠——核心第一屏只留
              // 「已装 N / 未装 M」两行齐全度数字（未装 M 亮红即诚实告警，展开才看逐条名单）。
              <WbAdvanced testid="skh-adv">
                <p className={cn(NOTE_CLS, 'break-words')} data-testid="skh-missing-names">
                  {t('workbench.skh_missing_names', { names: missing.map((e) => e.name).join('、') })}
                </p>
                <div className="mt-2 flex flex-col gap-1.5">
                  <p className={NOTE_CLS}>{t('workbench.skh_guide')}</p>
                  {cmdButton(SETUP_CMD, 'skh-copy-setup')}
                </div>
              </WbAdvanced>
            )}
          </div>
        )}

        {/* 只读边界（始终在场）：装技能在终端，本面只呈现齐全度 + 引导，不提供前端安装按钮。 */}
        <p className={cn(NOTE_CLS, 'mt-2.5')}>{t('workbench.skh_readonly_note')}</p>
      </div>
    </div>
  )
}
