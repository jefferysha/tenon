import type { OrchestrationEdge, OrchestrationNode } from '../api/orchestrationGraphClient'
import {
  edgeLabel,
  metadataLabel,
  nodeLabel,
  statusLabel,
  type Translate,
} from './orchestrationGraphPresentation'

interface Props {
  readonly nodes: readonly OrchestrationNode[]
  readonly visibleEdges: readonly OrchestrationEdge[]
  readonly adjacencyEdges: readonly OrchestrationEdge[]
  readonly allNodes: ReadonlyMap<string, OrchestrationNode>
  readonly localizeBuiltinPhaseIds: boolean
  readonly displayMetadataValue: (key: string, value: string) => string
  readonly t: Translate
}

export function OrchestrationGraphAccessibleList({
  nodes,
  visibleEdges,
  adjacencyEdges,
  allNodes,
  localizeBuiltinPhaseIds,
  displayMetadataValue,
  t,
}: Props): JSX.Element {
  const labelFor = (id: string): string => {
    const node = allNodes.get(id)
    return node === undefined ? id : nodeLabel(node, t, localizeBuiltinPhaseIds)
  }
  return (
    <div className="grid gap-3 border-t border-border px-3 py-2.5 text-caption md:grid-cols-2" data-testid="orchestration-accessible-list">
      <div>
        <h4 className="m-0 text-micro font-bold text-text-3">{t('detail.orchestration_graph.nodes')}</h4>
        <ul className="mt-1.5 mb-0 space-y-2 pl-4 text-text-2">
          {nodes.map((node) => {
            const adjacent = adjacencyEdges.filter(
              (edge) => edge.source === node.id || edge.target === node.id,
            )
            return (
              <li key={node.id}>
                {labelFor(node.id)} · {t(`detail.orchestration_graph.kind_${node.kind}`)}
                {node.status === null ? '' : ` · ${statusLabel(node.status, t)}`}
                {node.metadata.length > 0 && (
                  <dl className="mt-1 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-2">
                    {node.metadata.map((item) => (
                      <div className="contents" key={item.key}>
                        <dt>{metadataLabel(item.key, t)}</dt>
                        <dd className="m-0">{displayMetadataValue(item.key, item.value)}</dd>
                      </div>
                    ))}
                  </dl>
                )}
                {(['incoming', 'outgoing'] as const).map((direction) => {
                  const related = adjacent.filter((edge) =>
                    direction === 'incoming' ? edge.target === node.id : edge.source === node.id)
                  return (
                    <div className="mt-1" key={direction}>
                      <span className="font-semibold">{t(`detail.orchestration_graph.${direction}`)}: </span>
                      {related.length === 0
                        ? t('detail.orchestration_graph.no_edges')
                        : related.map((edge) =>
                          `${edgeLabel(edge, t)} · ${labelFor(direction === 'incoming' ? edge.source : edge.target)}`,
                        ).join('; ')}
                    </div>
                  )
                })}
              </li>
            )
          })}
        </ul>
      </div>
      <div>
        <h4 className="m-0 text-micro font-bold text-text-3">{t('detail.orchestration_graph.edges')}</h4>
        <ul className="mt-1.5 mb-0 space-y-1 pl-4 text-text-2">
          {visibleEdges.map((edge) => (
            <li key={edge.id}>{edgeLabel(edge, t)}: {labelFor(edge.source)} → {labelFor(edge.target)}</li>
          ))}
        </ul>
      </div>
    </div>
  )
}
