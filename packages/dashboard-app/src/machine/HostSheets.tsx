import type { DefinitionCatalogAdapter } from '../api/client'
import type { HostId, HostOperation, HostTarget } from '../api/hostTargetPlanTypes'
import { AdapterCapabilityBadges, AdapterCapabilityLegend } from '../hostPlan/AdapterCapabilityBadges'
import { HostOperationPlanPanel, type HostPlanRequestState } from '../hostPlan/HostOperationPlanPanel'
import { hostName, localizedError } from '../hostPlan/useHostTargetPlan'
import { useT } from '../i18n'

export interface PlanSheetProps {
  target: HostTarget
  selectedOperation: HostOperation | null
  planState: HostPlanRequestState
  copyText: (text: string) => Promise<void>
  onRequestPlan: (host: HostId, operation: HostOperation) => void
}

/** 安装计划 sheet：操作选择（安装 / 更新）+ 只读计划预览 + 复制命令，全部由 HostOperationPlanPanel 承担。 */
export function PlanSheet({ target, selectedOperation, planState, copyText, onRequestPlan }: PlanSheetProps): JSX.Element {
  const { t } = useT()
  return (
    <HostOperationPlanPanel
      target={target}
      targetLabel={hostName(target)}
      selectedOperation={selectedOperation}
      planState={planState}
      copyText={copyText}
      onRequestPlan={onRequestPlan}
      errorMessage={(error) => localizedError(error, t)}
    />
  )
}

export interface CapabilitiesSheetProps {
  target: HostTarget
  /** 当前项目定义目录里的适配器；null = 无项目或目录不可读。 */
  adapters: DefinitionCatalogAdapter[] | null
  currentRoot: string
}

/**
 * 能力 sheet：宿主目录登记的事实（类型 / 范围 / CLI 参数 / 支持操作 / 能力标签）；
 * 只有当前项目定义目录里存在同 id 适配器时才追加 inject / veto / track 三档能力徽章，否则明说没有。
 */
export function CapabilitiesSheet({ target, adapters, currentRoot }: CapabilitiesSheetProps): JSX.Element {
  const { t } = useT()
  const adapter = adapters?.find((candidate) => candidate.id === target.id) ?? null
  const facts: Array<[string, string]> = [
    [t('machines.capabilities_kind'), t(`hostPlan.kind.${target.kind}`)],
    [t('machines.capabilities_scope'), t(`hostPlan.scope.${target.target_scope}`)],
    [t('machines.capabilities_flag'), target.cli_flag],
    [t('machines.capabilities_operations'), target.supported_operations.map((operation) => t(`hostPlan.operation.${operation}`)).join(' / ')],
  ]
  return (
    <section data-testid="host-capabilities">
      <div className="mb-3.5 flex items-baseline justify-between gap-4">
        <h2 className="text-section font-bold text-text">{t('machines.capabilities_title')}</h2>
        <span className="font-mono text-body text-text-3">{target.id}</span>
      </div>
      <dl className="grid gap-2">
        {facts.map(([label, value]) => (
          <div key={label} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-md border border-border bg-card px-4 py-3">
            <dt className="text-body text-text-2">{label}</dt>
            <dd className="font-mono text-body text-text">{value}</dd>
          </div>
        ))}
      </dl>
      <div className="mt-4 flex flex-wrap gap-1.5" data-testid="host-capability-tags">
        {target.capabilities.length === 0 ? (
          <p className="text-body text-text-3">{t('machines.capabilities_none')}</p>
        ) : target.capabilities.map((capability) => (
          <span key={capability} className="rounded-full border border-accent-b bg-accent-t px-2.5 py-1 text-caption font-semibold text-(--accent)">
            {t(`hostPlan.capability.${capability}`)}
          </span>
        ))}
      </div>

      <div className="mt-7 mb-3.5 flex items-baseline justify-between gap-4">
        <h2 className="text-section font-bold text-text">{t('machines.capabilities_catalog', { root: currentRoot === '' ? '—' : currentRoot.split(/[\\/]+/).filter(Boolean).pop() ?? currentRoot })}</h2>
        {adapter !== null && <span className="text-body text-text-3">{t('hostPlan.installer.tier', { tier: adapter.tier })}</span>}
      </div>
      {currentRoot === '' ? (
        <p className="text-body text-text-3" role="status" data-testid="host-capabilities-no-project">{t('machines.capabilities_catalog_no_project')}</p>
      ) : adapter === null ? (
        <p className="text-body text-text-3" role="status" data-testid="host-capabilities-catalog-missing">{t('machines.capabilities_catalog_missing')}</p>
      ) : (
        <div className="rounded-md border border-border bg-card px-4 py-3">
          <p className="text-body text-text-2">{t(`hostPlan.installer.tier_detail.${adapter.tier}`)}</p>
          <AdapterCapabilityBadges adapter={adapter} t={t} />
          <AdapterCapabilityLegend t={t} />
        </div>
      )}
    </section>
  )
}
