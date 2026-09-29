import {
  Accessibility, AppWindow, FileCheck, FileJson, Flame, FlaskConical, Gauge, Globe, Layers, ListChecks,
  MonitorPlay, Palette, Percent, RotateCcw, Ruler, Eye, Wrench, type LucideIcon,
} from 'lucide-react'

/** 种类 → 图标。种类名本身不翻译（协议标识），图标只是扫读辅助，名字始终在旁边。 */
const ICONS: Readonly<Record<string, LucideIcon>> = {
  unit: FlaskConical,
  integration: Layers,
  regression: RotateCcw,
  e2e: Globe,
  playwright: MonitorPlay,
  browser: AppWindow,
  benchmark: Gauge,
  typecheck: FileCheck,
  lint: ListChecks,
  coverage: Percent,
  a11y: Accessibility,
  visual: Eye,
  contract: FileJson,
  smoke: Flame,
  'code-size': Ruler,
  'design-system': Palette,
  custom: Wrench,
}

export function KindIcon({ kind, className = 'size-4 flex-none text-text-3', testId }: { kind: string; className?: string; testId?: string }): JSX.Element {
  const Icon = Object.prototype.hasOwnProperty.call(ICONS, kind) ? ICONS[kind] ?? Wrench : Wrench
  return <Icon className={className} aria-hidden="true" data-kind={kind} data-testid={testId} />
}
