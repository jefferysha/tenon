import type { KeyboardEvent, RefCallback } from 'react'
import { X } from 'lucide-react'
import type { OrchestrationEdge, OrchestrationNode } from '../api/orchestrationGraphClient'

interface OrchestrationGraphNodeButtonProps {
  readonly label: string
  readonly kindLabel: string
  readonly statusLabel: string
  readonly selected: boolean
  readonly className: string
  readonly tone: string
  readonly setRef: RefCallback<HTMLButtonElement>
  readonly onSelect: () => void
  readonly onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void
}

export function OrchestrationGraphNodeButton({
  label,
  kindLabel,
  statusLabel,
  selected,
  className,
  tone,
  setRef,
  onSelect,
  onKeyDown,
}: OrchestrationGraphNodeButtonProps): JSX.Element {
  return (
    <button
      ref={setRef}
      type="button"
      aria-pressed={selected}
      aria-label={`${label} · ${kindLabel}${statusLabel === '' ? '' : ` · ${statusLabel}`}`}
      className={`${className} relative rounded-md border px-3 py-2.5 text-left outline-none transition-[border-color,box-shadow,background-color] hover:shadow-sm focus-visible:ring-2 focus-visible:ring-(--accent) focus-visible:ring-offset-2 focus-visible:ring-offset-card aria-pressed:border-(--accent) aria-pressed:ring-2 aria-pressed:ring-(--accent) motion-reduce:transition-none ${tone}`}
      onClick={onSelect}
      onKeyDown={onKeyDown}
    >
      {selected && <span className="absolute top-1.5 right-1.5 text-accent-d" aria-hidden="true">✓</span>}
      <span className="block truncate pr-3 text-caption font-semibold text-text">{label}</span>
      <span className="mt-0.5 block truncate text-micro text-text-3">
        {kindLabel}{statusLabel === '' ? '' : ` · ${statusLabel}`}
      </span>
    </button>
  )
}

interface OrchestrationGraphRelationshipListProps {
  readonly edges: readonly OrchestrationEdge[]
  readonly nodes: ReadonlyMap<string, OrchestrationNode>
  readonly heading: string
  readonly emptyLabel: string
  readonly nodeLabel: (node: OrchestrationNode) => string
  readonly edgeLabel: (edge: OrchestrationEdge) => string
}

export function OrchestrationGraphRelationshipList({
  edges,
  nodes,
  heading,
  emptyLabel,
  nodeLabel,
  edgeLabel,
}: OrchestrationGraphRelationshipListProps): JSX.Element {
  return (
    <section className="rounded-md border border-border bg-card px-3 py-2.5" aria-label={heading} data-testid="orchestration-relationships">
      <h4 className="mb-1.5 text-micro font-semibold text-text-3">{heading}</h4>
      {edges.length === 0 ? (
        <p className="m-0 text-micro text-text-3">{emptyLabel}</p>
      ) : (
        <ul className="m-0 grid max-h-64 gap-1 overflow-y-auto pl-4 text-micro leading-5 text-text-2 sm:grid-cols-2">
          {edges.map((edge) => {
            const source = nodes.get(edge.source)
            const target = nodes.get(edge.target)
            return (
              <li key={edge.id} data-edge-kind={edge.kind}>
                {source === undefined ? '?' : nodeLabel(source)} · {edgeLabel(edge)} · {target === undefined ? '?' : nodeLabel(target)}
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

interface OrchestrationGraphSelectionProps {
  readonly node: OrchestrationNode
  readonly edges: readonly OrchestrationEdge[]
  readonly nodes: ReadonlyMap<string, OrchestrationNode>
  readonly kindLabel: string
  readonly clearLabel: string
  readonly incomingLabel: string
  readonly outgoingLabel: string
  readonly noEdgesLabel: string
  readonly nodeLabel: (node: OrchestrationNode) => string
  readonly statusLabel: (status: string | null) => string
  readonly metadataLabel: (key: string) => string
  readonly metadataValue: (key: string, value: string) => string
  readonly edgeLabel: (edge: OrchestrationEdge) => string
  readonly onClear: () => void
}

export function OrchestrationGraphSelection(props: OrchestrationGraphSelectionProps): JSX.Element {
  return (
    <div className="mt-2.5 rounded-md border border-blue-b bg-blue-t px-3 py-2.5" data-testid="orchestration-selection">
      <div className="flex items-baseline justify-between gap-3">
        <strong className="text-caption text-text">{props.nodeLabel(props.node)}</strong>
        <div className="flex items-center gap-2">
          <span className="text-micro text-blue-d">{props.kindLabel}</span>
          <button type="button" className="rounded-xs p-0.5 text-text-3 outline-none hover:bg-card focus-visible:ring-2 focus-visible:ring-(--accent)" aria-label={props.clearLabel} onClick={props.onClear}>
            <X className="size-3.5" aria-hidden="true" />
          </button>
        </div>
      </div>
      {props.node.status !== null && <p className="mt-1 mb-0 text-caption text-text-2">{props.statusLabel(props.node.status)}</p>}
      {props.node.metadata.length > 0 && (
        <dl className="mt-2 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-1 text-micro">
          {props.node.metadata.map((item) => (
            <div key={item.key} className="contents">
              <dt className="text-text-3">{props.metadataLabel(item.key)}</dt>
              <dd className="m-0 truncate text-text-2">{props.metadataValue(item.key, item.value)}</dd>
            </div>
          ))}
        </dl>
      )}
      {props.edges.length > 0 && (
        <div className="mt-2 grid gap-2 text-micro sm:grid-cols-2">
          {(['incoming', 'outgoing'] as const).map((direction) => {
            const edges = props.edges.filter((edge) => direction === 'incoming' ? edge.target === props.node.id : edge.source === props.node.id)
            return (
              <div key={direction}>
                <h4 className="m-0 font-semibold text-text-3">{direction === 'incoming' ? props.incomingLabel : props.outgoingLabel}</h4>
                {edges.length === 0 ? <p className="mt-1 mb-0 text-text-3">{props.noEdgesLabel}</p> : (
                  <ul className="mt-1 mb-0 space-y-1 pl-4 text-text-2">
                    {edges.map((edge) => {
                      const peer = props.nodes.get(direction === 'incoming' ? edge.source : edge.target)
                      return <li key={edge.id}>{props.edgeLabel(edge)} · {peer === undefined ? '?' : props.nodeLabel(peer)}</li>
                    })}
                  </ul>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
