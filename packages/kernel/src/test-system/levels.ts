/**
 * 测试档位的定义（目录顶层键 `levels`）与内建缺省：工作流步骤只记档位名（`test: changed`），
 * 档位的含义——哪些测试类必需、哪些只在被改动碰到时才跑、场景映射与各项门槛——在这里。
 * 目录里没写的档或键取内建缺省，所以没有 `levels` 的目录与引入本特性之前逐字相同。
 *
 * 纯数据与纯函数；解码与写出在 levels-codec.ts。
 */
import type { CoverageMetric, TestClass } from './vocabulary.js'

export const LEVEL_NAMES = ['plan', 'changed', 'full'] as const
export type LevelName = (typeof LEVEL_NAMES)[number]

export interface LevelThresholds {
  /** 场景映射要求：off（缺省）不要求；required 每个场景至少映射一个用例或已批准豁免；passing 且映射用例本轮通过。 */
  readonly scenarios: 'off' | 'required' | 'passing'
  readonly coverage?: Readonly<Partial<Record<CoverageMetric, number>>>
  readonly flaky?: { readonly max: number; readonly fail_on_new: boolean }
  /** 基准缺同机器画像的基线时是否挡出口。 */
  readonly require_baseline: boolean
}

export interface ResolvedLevel extends LevelThresholds {
  readonly name: LevelName
  /** 必需的测试类：目录里必须有这类套件（或已批准的不适用声明）。 */
  readonly required: readonly TestClass[]
  /** 只在被改动碰到时才跑的测试类；plan 档恒为 []。 */
  readonly touched: readonly TestClass[]
  /** 档位整体来自目录或缺省（目录写了这一档任意键即为 catalog）。 */
  readonly source: 'catalog' | 'default'
}

/** 目录里 `levels` 的形状：每档每键都可省略，省略的键取内建缺省。 */
export type CatalogLevels = Partial<Record<LevelName, Partial<Omit<ResolvedLevel, 'name' | 'source'>>>>

function level(name: LevelName, required: readonly TestClass[], touched: readonly TestClass[]): ResolvedLevel {
  return Object.freeze({
    name,
    required: Object.freeze([...required]),
    touched: Object.freeze([...touched]),
    scenarios: 'off',
    require_baseline: false,
    source: 'default',
  })
}

/** 内建缺省：普通任务少测——full 档也只跑被改动碰到的非必需类，缺省不设覆盖率与不稳定用例门槛。 */
export const DEFAULT_LEVELS: Readonly<Record<LevelName, ResolvedLevel>> = Object.freeze({
  plan: level('plan', ['unit'], []),
  changed: level('changed', ['unit'], ['static']),
  full: level('full', ['unit'], ['integration', 'e2e', 'static', 'benchmark']),
})

/**
 * 某一档的生效定义：目录写了的键覆盖缺省，其余取缺省。目录没写这一档（或为 undefined）时原样返回缺省，
 * `source: 'default'`；目录写了这一档的任意键则 `source: 'catalog'`。不修改入参。
 * 参数是 `TestCatalog` 的结构化超类型（只读它的 `levels`），本模块不必反向导入 catalog-types.ts（后者已导入 CatalogLevels）。
 */
export function resolveLevel(name: LevelName, catalog: { readonly levels?: CatalogLevels } | undefined): ResolvedLevel {
  const base = DEFAULT_LEVELS[name]
  const declared = catalog?.levels?.[name]
  if (declared === undefined || Object.keys(declared).length === 0) return base
  const coverage = declared.coverage ?? base.coverage
  const flaky = declared.flaky ?? base.flaky
  return {
    name,
    required: declared.required ?? base.required,
    touched: name === 'plan' ? [] : declared.touched ?? base.touched,
    scenarios: declared.scenarios ?? base.scenarios,
    ...(coverage === undefined ? {} : { coverage }),
    ...(flaky === undefined ? {} : { flaky }),
    require_baseline: declared.require_baseline ?? base.require_baseline,
    source: 'catalog',
  }
}
