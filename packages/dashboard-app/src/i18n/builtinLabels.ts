/**
 * 内置工作流数据的显示名：存下来的名字仍是出厂中文名时，按界面语言取词典（`builtin.*`）；
 * 用户改过的、自建工作流的名字原样显示。不改存储、不改编辑框里的值——只改「看到的」名字。
 *
 * 匹配只认 内置标识 + 出厂中文名：工作流 id + 阶段 id、工作流 id + 轨道 id、测试方向 id。
 * 自建 / 复制出来的工作流 id 不同，不会被误译；内置的名字被改过也不会被覆盖。
 */
import { useMemo } from 'react'
import { useT } from './index'
import { translations } from './translations'
import type { Dict } from './translations'

type Translate = (key: string, vars?: Record<string, string | number>) => string

/** 词典里 zh 这一条（= 出厂中文名）；没有这个键时 undefined。 */
function shipped(key: string): string | undefined {
  let node: string | Dict | undefined = translations.zh
  for (const part of key.split('.')) {
    if (node === undefined || typeof node === 'string' || !Object.prototype.hasOwnProperty.call(node, part)) return undefined
    node = node[part]
  }
  return typeof node === 'string' ? node : undefined
}

function localized(t: Translate, key: string, label: string): string {
  if (shipped(key) !== label) return label
  const text = t(key)
  return text === key ? label : text
}

const unnamed = (workflow: string | null | undefined): workflow is null | undefined => workflow === null || workflow === undefined || workflow === ''

/** 内置工作流的阶段名；`workflow` 为空（读不到工作流名）或不是内置的，原样返回。 */
export function builtinStepLabel(t: Translate, workflow: string | null | undefined, step: string, label: string): string {
  return unnamed(workflow) ? label : localized(t, `builtin.step.${workflow}.${step}`, label)
}

/** 内置工作流的轨道名。 */
export function builtinTrackLabel(t: Translate, workflow: string | null | undefined, track: string, label: string): string {
  return unnamed(workflow) ? label : localized(t, `builtin.track.${workflow}.${track}`, label)
}

/** 内置测试方向的名字（`direction` 可以是测试项自己的 id：出厂测试项的 id 与方向同名）。 */
export function builtinDirectionLabel(t: Translate, direction: string, label: string): string {
  return localized(t, `builtin.direction.${direction}`, label)
}

export interface BuiltinLabels {
  step: (workflow: string | null | undefined, step: string, label: string) => string
  track: (workflow: string | null | undefined, track: string, label: string) => string
  direction: (direction: string, label: string) => string
}

/** 绑定当前界面语言的三个显示名函数；换语言时才换身份（可放进依赖数组）。 */
export function useBuiltinLabels(): BuiltinLabels {
  const { t } = useT()
  return useMemo(() => ({
    step: (workflow, id, label) => builtinStepLabel(t, workflow, id, label),
    track: (workflow, id, label) => builtinTrackLabel(t, workflow, id, label),
    direction: (id, label) => builtinDirectionLabel(t, id, label),
  }), [t])
}
