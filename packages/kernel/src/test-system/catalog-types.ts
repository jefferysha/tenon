/**
 * 项目测试目录（`.tenon/tests/catalog.yaml`）的领域形状：项目有哪些测试套件、怎么跑、怎么读报告、
 * 需要哪些服务。解析后默认值全部补齐，键名与 YAML 同为 snake_case（目录是人可编辑的配置，
 * 形状即文件形状，与工作流步骤测试项同一口径）。
 *
 * 路径约定：`files` / `covers` / `report.path` / `coverage.path` / `artifacts` 都相对套件的 `cwd`；
 * 报告、覆盖率与产物必须落在工作区指纹排除的测试输出目录下，否则跑一次测试就会让记录绑定的候选失效。
 */
import type { MachineProfileMode } from './machine-profile.js'
import type {
  CoverageFormat, ReportFormat, ServiceStopSignal, TestKind, TestRunner,
} from './vocabulary.js'

export const TEST_CATALOG_SCHEMA = 'tenon-test-catalog/v1'

export interface CatalogSelect {
  /** 含 `{files}` 占位符的命令模板；按文件选择运行。 */
  readonly files?: string
  /** 含 `{pattern}` 占位符的命令模板；按用例名过滤运行（重试失败用例也走它）。 */
  readonly grep?: string
}

export interface CatalogReport {
  readonly format: ReportFormat
  /** exit-code 格式没有报告文件，其余格式必有。 */
  readonly path?: string
}

export interface CatalogCoverage {
  readonly format: CoverageFormat
  readonly path: string
}

export interface BenchmarkMetricSpec {
  readonly name: string
  readonly unit?: string
  readonly better: 'lower' | 'higher'
  /** 相对同画像基线中位数的退化上限（百分比）。 */
  readonly max_regression_pct?: number
  /** 绝对上下限：有没有基线都生效。 */
  readonly max?: number
  readonly min?: number
}

export interface BenchmarkSpec {
  /** 重复运行次数；报告自身已多次采样时为 1。 */
  readonly runs: number
  readonly warmup: number
  readonly metrics: readonly BenchmarkMetricSpec[]
}

export interface CatalogSuite {
  readonly id: string
  readonly label?: string
  readonly kind: TestKind
  readonly runner: TestRunner
  readonly command: string
  readonly cwd: string
  readonly timeout_s: number
  /** 本套件拥有的测试文件（glob）：未登记文件判定与按文件选择都用它。 */
  readonly files: readonly string[]
  /** 影响范围（glob）：改到这些源码时建议把本套件纳入计划。 */
  readonly covers: readonly string[]
  readonly select?: CatalogSelect
  readonly report: CatalogReport
  readonly coverage?: CatalogCoverage
  readonly artifacts: readonly string[]
  /** 只列变量名；值来自宿主环境或 tenon secrets，记录里只存名字与是否存在。 */
  readonly env: readonly string[]
  readonly services: readonly string[]
  readonly retries: number
  /** 可与同批其他 parallel 套件并发。 */
  readonly parallel: boolean
  readonly tags: readonly string[]
  /** Playwright project 名；报告按项目分组，缺项目判 browser-project-missing。 */
  readonly browsers: readonly string[]
  readonly benchmark?: BenchmarkSpec
}

/** 就绪探测三选一：URL 返回 2xx、端口可连、日志出现指定文本。 */
export type CatalogServiceReady =
  | { readonly url: string; readonly timeout_s: number }
  | { readonly port: number; readonly timeout_s: number }
  | { readonly log: string; readonly timeout_s: number }

export interface CatalogService {
  readonly id: string
  readonly start: string
  readonly cwd: string
  readonly ready: CatalogServiceReady
  readonly stop: ServiceStopSignal
  readonly env: readonly string[]
}

/**
 * 项目级「这个种类在本项目不适用」声明（如纯 JavaScript 项目的 typecheck）。策略对已批准的种类不再要求登记 / 运行；
 * `approved_by` 由评审确认写入（`tenon review request` 列出、`tenon review acknowledge` 批准，与计划豁免同一机制），
 * null = 还没批准，不生效。
 */
export interface CatalogNotApplicable {
  readonly kind: TestKind
  readonly reason: string
  readonly approved_by: string | null
}

export interface TestCatalog {
  readonly schema: typeof TEST_CATALOG_SCHEMA
  /**
   * 机器画像口径（machine-profile.ts）：省略 = 细口径 `fine`；`coarse` 让同规格的运行器（如托管 CI）共用一份基线。
   * 解析时显式写的 `fine` 归一为省略，没有声明的旧目录摘要逐字不变。
   */
  readonly profile?: MachineProfileMode
  /** 参与机器画像的环境变量名。 */
  readonly profiles_env: readonly string[]
  readonly suites: readonly CatalogSuite[]
  readonly services: readonly CatalogService[]
  /** 项目级不适用声明；没有声明时省略（目录摘要与旧目录逐字相同）。 */
  readonly not_applicable?: readonly CatalogNotApplicable[]
}

export const CATALOG_DEFAULT_TIMEOUT_S = 900
export const SERVICE_DEFAULT_READY_TIMEOUT_S = 60
