import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { ChevronRight, RefreshCw, Search } from 'lucide-react'
import {
  fetchOrchestrationGraph,
  OrchestrationGraphApiError,
  ORCHESTRATION_NODE_KINDS,
  type OrchestrationGraph,
  type OrchestrationNode,
  type OrchestrationNodeKind,
} from '../api/orchestrationGraphClient'
import { ApiError } from '../api/transport'
import { useT } from '../i18n'
import {
  compareNodes,
  deferredLabel,
  edgeLabel,
  metadataLabel,
  metadataValue,
  nodeLabel,
  orchestrationGraphSections,
  statusLabel,
  toneByKind,
  toggledKinds,
  usesBuiltinPhaseLabels,
} from './orchestrationGraphPresentation'
import { OrchestrationGraphAccessibleList } from './OrchestrationGraphAccessibleList'
import { OrchestrationGraphNodeButton, OrchestrationGraphRelationshipList, OrchestrationGraphSelection } from './OrchestrationGraphEdge'

interface OrchestrationGraphCardProps { readonly root: string; readonly change: string }

type LoadState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly graph: OrchestrationGraph }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'error' }

const MAX_CANVAS_NODES = 21
const CORE_NODE_KINDS = new Set<OrchestrationNodeKind>(['workflow', 'change', 'phase'])

export function OrchestrationGraphCard({ root, change }: OrchestrationGraphCardProps): JSX.Element {
  const { t } = useT()
  const requestId = useRef(0)
  const nodeRefs = useRef(new Map<string, HTMLButtonElement>())
  const [attempt, setAttempt] = useState(0)
  const [state, setState] = useState<LoadState>({ kind: 'loading' })
  const [query, setQuery] = useState('')
  const [kinds, setKinds] = useState<Set<OrchestrationNodeKind>>(
    new Set(['workflow', 'change', 'phase']),
  )
  const [selectedId, setSelectedId] = useState<string | null>(null)

  useEffect(() => {
    const id = ++requestId.current
    const controller = new AbortController()
    setState({ kind: 'loading' })
    setSelectedId(null)
    fetchOrchestrationGraph(root, change, controller.signal)
      .then((graph) => {
        if (requestId.current === id && !controller.signal.aborted) setState({ kind: 'ready', graph })
      })
      .catch((error: unknown) => {
        if (requestId.current !== id || controller.signal.aborted) return
        const oldServer404 = error instanceof ApiError
          && error.status === 404
          && (!(error instanceof OrchestrationGraphApiError) || error.code === undefined)
        setState(oldServer404
          ? { kind: 'unavailable' }
          : { kind: 'error' })
      })
    return () => controller.abort()
  }, [attempt, change, root])

  const graph = state.kind === 'ready' ? state.graph : null
  const localizeBuiltinPhaseIds = usesBuiltinPhaseLabels(graph)
  const renderNodeLabel = (node: OrchestrationNode): string =>
    nodeLabel(node, t, localizeBuiltinPhaseIds)
  const visibleNodes = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase()
    return (graph?.nodes ?? [])
      .filter((node) => kinds.size === 0 || kinds.has(node.kind))
      .filter((node) => needle === '' || renderNodeLabel(node).toLocaleLowerCase().includes(needle))
      .sort(compareNodes)
  }, [graph, kinds, localizeBuiltinPhaseIds, query, t])
  const visibleIds = useMemo(() => new Set(visibleNodes.map((node) => node.id)), [visibleNodes])
  const visibleEdges = useMemo(
    () => (graph?.edges ?? []).filter((edge) =>
      visibleIds.has(edge.source) && visibleIds.has(edge.target)),
    [graph, visibleIds],
  )
  const canvasNodes = useMemo(() => {
    if (visibleNodes.length <= MAX_CANVAS_NODES) return visibleNodes
    const core = visibleNodes.filter((node) => CORE_NODE_KINDS.has(node.kind))
    const resources = visibleNodes.filter((node) => !CORE_NODE_KINDS.has(node.kind))
    return [...core, ...resources.slice(0, Math.max(0, MAX_CANVAS_NODES - core.length))]
  }, [visibleNodes])
  const canvasIds = useMemo(() => new Set(canvasNodes.map((node) => node.id)), [canvasNodes])
  const canvasEdges = useMemo(
    () => visibleEdges.filter((edge) => canvasIds.has(edge.source) && canvasIds.has(edge.target)),
    [canvasIds, visibleEdges],
  )
  const canvasSections = useMemo(
    () => orchestrationGraphSections(canvasNodes, canvasEdges),
    [canvasEdges, canvasNodes],
  )
  const fullSections = useMemo(
    () => orchestrationGraphSections(graph?.nodes ?? [], graph?.edges ?? []),
    [graph],
  )
  const selected = visibleIds.has(selectedId ?? '')
    ? graph?.nodes.find((node) => node.id === selectedId) ?? null
    : null
  const selectedEdges = selected === null ? [] : (graph?.edges ?? [])
    .filter((edge) => edge.source === selected.id || edge.target === selected.id)
  const nodeById = useMemo(
    () => new Map((graph?.nodes ?? []).map((node) => [node.id, node])),
    [graph],
  )
  const relationshipEdges = selected === null
    ? visibleEdges.filter((edge) => !fullSections.trunkEdgeIds.has(edge.id))
    : selectedEdges
  const displayMetadataValue = (key: string, value: string): string => {
    if (key === 'phase' || key === 'phase_id') {
      const phase = nodeById.get(`phase:${value}`)
      if (phase !== undefined) return renderNodeLabel(phase)
    }
    return metadataValue(key, value, t)
  }
  function toggleKind(kind: OrchestrationNodeKind): void {
    setKinds((current) => toggledKinds(current, kind))
  }
  function onNodeKeyDown(event: KeyboardEvent<HTMLButtonElement>, node: OrchestrationNode): void {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      setSelectedId(null)
      return
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      setSelectedId(node.id)
      return
    }
    const navigationNodes = node.kind === 'phase' ? canvasSections.phases : canvasNodes
    const current = navigationNodes.findIndex((item) => item.id === node.id)
    let target = current
    if (event.key === 'ArrowRight') target = Math.min(navigationNodes.length - 1, current + 1)
    else if (event.key === 'ArrowLeft') target = Math.max(0, current - 1)
    else if (event.key === 'Home') target = 0
    else if (event.key === 'End') target = navigationNodes.length - 1
    else return
    event.preventDefault()
    nodeRefs.current.get(navigationNodes[target]?.id ?? '')?.focus()
  }
  function nodeButton(node: OrchestrationNode, className: string): JSX.Element {
    const label = renderNodeLabel(node)
    return (
      <OrchestrationGraphNodeButton
        key={node.id}
        label={label}
        kindLabel={t(`detail.orchestration_graph.kind_${node.kind}`)}
        statusLabel={statusLabel(node.status, t)}
        selected={selectedId === node.id}
        className={className}
        tone={toneByKind[node.kind]}
        setRef={(element) => {
          if (element === null) nodeRefs.current.delete(node.id)
          else nodeRefs.current.set(node.id, element)
        }}
        onSelect={() => setSelectedId(node.id)}
        onKeyDown={(event) => onNodeKeyDown(event, node)}
      />
    )
  }

  return (
    <section
      className="border-b border-border py-3 last:border-b-0"
      aria-label={t('detail.orchestration_graph.region')}
      data-testid="orchestration-graph"
      data-settled={state.kind === 'loading' ? 'false' : 'true'}
    >
      <div className="mb-2.5 flex items-baseline justify-between gap-3">
        <div>
          <h3 className="m-0 text-caption font-bold text-text">{t('detail.orchestration_graph.heading')}</h3>
          <p className="mt-0.5 mb-0 text-micro text-text-3">{t('detail.orchestration_graph.read_only')}</p>
        </div>
        {graph !== null && (
          <span className="text-micro tabular-nums text-text-3">
            {t('detail.orchestration_graph.count', { nodes: visibleNodes.length, edges: visibleEdges.length })}
          </span>
        )}
      </div>

      {state.kind === 'loading' && (
        <div className="flex items-center gap-2 text-caption text-text-3" role="status">
          <RefreshCw className="size-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" />
          {t('detail.orchestration_graph.loading')}
        </div>
      )}
      {state.kind === 'unavailable' && (
        <p className="m-0 rounded-md border border-border bg-fill px-3 py-2.5 text-caption text-text-3" role="status">
          {t('detail.orchestration_graph.unavailable')}
        </p>
      )}
      {state.kind === 'error' && (
        <div className="flex items-center justify-between gap-3 rounded-md border border-red-b bg-red-t px-3 py-2.5" role="alert">
          <span className="text-caption text-red-d">{t('detail.orchestration_graph.error')}</span>
          <button
            type="button"
            className="rounded-sm border border-red-b bg-card px-2.5 py-1 text-caption font-semibold text-red-d outline-none hover:bg-red-t focus-visible:ring-2 focus-visible:ring-(--accent)"
            onClick={() => setAttempt((value) => value + 1)}
          >
            {t('detail.orchestration_graph.retry')}
          </button>
        </div>
      )}

      {graph !== null && (
        <>
          <div className="mb-2.5 flex flex-wrap items-center gap-1.5" aria-label={t('detail.orchestration_graph.filters')}>
            <button
              type="button"
              aria-pressed={kinds.size === 0}
              className={`rounded-full border px-2 py-1 text-micro font-semibold outline-none focus-visible:ring-2 focus-visible:ring-(--accent) ${
                kinds.size === 0
                  ? 'border-blue-b bg-blue-t text-blue-d'
                  : 'border-border bg-card text-text-3 hover:bg-fill'
              }`}
              onClick={() => setKinds(new Set())}
            >
              <span aria-hidden="true">{kinds.size === 0 ? '✓ ' : ''}</span>
              {t('detail.orchestration_graph.kind_all')}
            </button>
            {ORCHESTRATION_NODE_KINDS.map((kind) => (
              <button
                key={kind}
                type="button"
                aria-pressed={kinds.size === 0 || kinds.has(kind)}
                className={`rounded-full border px-2 py-1 text-micro font-semibold outline-none focus-visible:ring-2 focus-visible:ring-(--accent) ${
                  kinds.size === 0 || kinds.has(kind)
                    ? 'border-blue-b bg-blue-t text-blue-d'
                    : 'border-border bg-card text-text-3 hover:bg-fill'
                }`}
                onClick={() => toggleKind(kind)}
              >
                <span aria-hidden="true">{kinds.size === 0 || kinds.has(kind) ? '✓ ' : ''}</span>
                {t(`detail.orchestration_graph.kind_${kind}`)}
              </button>
            ))}
            <label className="ml-auto flex min-w-[190px] flex-1 items-center gap-1.5 rounded-sm border border-border bg-card px-2 py-1.5 focus-within:ring-2 focus-within:ring-(--accent)">
              <Search className="size-3.5 text-text-3" aria-hidden="true" />
              <span className="sr-only">{t('detail.orchestration_graph.search_label')}</span>
              <input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter' || visibleNodes.length !== 1) return
                  event.preventDefault()
                  const node = visibleNodes[0]
                  if (node === undefined) return
                  setSelectedId(node.id)
                  nodeRefs.current.get(node.id)?.focus()
                }}
                placeholder={t('detail.orchestration_graph.search_placeholder')}
                className="min-w-0 flex-1 border-0 bg-transparent p-0 text-caption text-text outline-none placeholder:text-text-3"
              />
            </label>
          </div>

          {graph.nodes.length === 0 ? (
            <p className="m-0 rounded-md border border-dashed border-border px-3 py-5 text-center text-caption text-text-3" role="status">
              {t('detail.orchestration_graph.empty')}
            </p>
          ) : visibleNodes.length === 0 ? (
            <p className="m-0 rounded-md border border-dashed border-border px-3 py-5 text-center text-caption text-text-3" role="status">
              {t('detail.orchestration_graph.filtered_empty')}
            </p>
          ) : (
            <>
              {canvasNodes.length < visibleNodes.length && (
                <p className="mb-2 rounded-md border border-blue-b bg-blue-t px-3 py-2 text-micro leading-relaxed text-blue-d" data-testid="orchestration-canvas-limited">
                  {t('detail.orchestration_graph.canvas_limited', { shown: canvasNodes.length, total: visibleNodes.length })}
                </p>
              )}
              <div className="min-w-0 space-y-3 rounded-md border border-border bg-fill/30 p-3" aria-label={t('detail.orchestration_graph.canvas')} data-testid="orchestration-canvas">
                {canvasSections.scope.length > 0 && (
                  <div className="grid min-w-0 gap-2 sm:grid-cols-2" data-testid="orchestration-scope">
                    {canvasSections.scope.map((node) => nodeButton(node, 'min-h-[58px] min-w-0'))}
                  </div>
                )}

                {canvasSections.phases.length > 0 && (
                  <div className="max-w-full overflow-x-auto pb-1" data-testid="orchestration-phase-trunk">
                    <div className="flex min-w-max items-center">
                      {canvasSections.phases.map((node, index) => {
                        const next = canvasSections.phases[index + 1]
                        const connected = next !== undefined && canvasEdges.some((edge) =>
                          fullSections.trunkEdgeIds.has(edge.id)
                          && edge.source === node.id
                          && edge.target === next.id)
                        return (
                          <div className="flex items-center" key={node.id}>
                            {nodeButton(node, 'min-h-[64px] w-[132px] flex-none')}
                            {next !== undefined && (
                              <span
                                className={`mx-1.5 h-px w-5 flex-none ${connected ? 'bg-text-3' : ''}`}
                                data-phase-connector={connected ? 'transition' : 'gap'}
                                aria-hidden="true"
                              >
                                {connected && <span className="relative -top-[7px] left-[14px] text-micro text-text-3">›</span>}
                              </span>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  </div>
                )}

                {canvasSections.resources.size > 0 && (
                  <div className="grid gap-2 sm:grid-cols-2" data-testid="orchestration-resources">
                    {[...canvasSections.resources].map(([kind, nodes]) => (
                      <section className="min-w-0 rounded-md border border-border bg-card/70 p-2" data-testid={`orchestration-resource-${kind}`} key={kind}>
                        <h4 className="mb-1.5 text-micro font-semibold text-text-3">{t(`detail.orchestration_graph.kind_${kind}`)}</h4>
                        <div className="grid gap-1.5">
                          {nodes.map((node) => nodeButton(node, 'min-h-[54px] w-full min-w-0'))}
                        </div>
                      </section>
                    ))}
                  </div>
                )}
              </div>

              <OrchestrationGraphRelationshipList
                edges={relationshipEdges}
                nodes={nodeById}
                heading={t('detail.orchestration_graph.edges')}
                emptyLabel={t('detail.orchestration_graph.no_edges')}
                nodeLabel={renderNodeLabel}
                edgeLabel={(edge) => edgeLabel(edge, t)}
              />
            </>
          )}

          {selected !== null && (
            <OrchestrationGraphSelection
              node={selected}
              edges={selectedEdges}
              nodes={nodeById}
              kindLabel={t(`detail.orchestration_graph.kind_${selected.kind}`)}
              clearLabel={t('detail.orchestration_graph.clear_selection')}
              incomingLabel={t('detail.orchestration_graph.incoming')}
              outgoingLabel={t('detail.orchestration_graph.outgoing')}
              noEdgesLabel={t('detail.orchestration_graph.no_edges')}
              nodeLabel={renderNodeLabel}
              statusLabel={(status) => statusLabel(status, t)}
              metadataLabel={(key) => metadataLabel(key, t)}
              metadataValue={displayMetadataValue}
              edgeLabel={(edge) => edgeLabel(edge, t)}
              onClear={() => setSelectedId(null)}
            />
          )}

          <details className="group mt-2.5 rounded-md border border-border bg-card">
            <summary className="flex cursor-pointer list-none items-center gap-1.5 rounded-md px-3 py-2 text-caption font-semibold text-text-2 outline-none focus-visible:ring-2 focus-visible:ring-(--accent) [&::-webkit-details-marker]:hidden">
              <ChevronRight className="size-3.5 transition-transform group-open:rotate-90 motion-reduce:transition-none" aria-hidden="true" />
              {t('detail.orchestration_graph.accessible_list')}
            </summary>
            <OrchestrationGraphAccessibleList
              nodes={visibleNodes}
              visibleEdges={visibleEdges}
              adjacencyEdges={graph.edges}
              allNodes={nodeById}
              localizeBuiltinPhaseIds={localizeBuiltinPhaseIds}
              displayMetadataValue={displayMetadataValue}
              t={t}
            />
          </details>

          {graph.coverage.deferred.length > 0 && (
            <p className="mt-2 mb-0 text-micro leading-[1.5] text-text-3">
              {t('detail.orchestration_graph.deferred', {
                items: graph.coverage.deferred.map((item) => deferredLabel(item, t)).join(' · '),
              })}
            </p>
          )}
        </>
      )}
    </section>
  )
}
