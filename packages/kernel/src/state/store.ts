/**
 * StateStore —— G1 canonical revision/current 存储 + legacy `.pipeline.yaml` adapter。
 * 官方读写以 `.pipeline-run/current.json` 为真相；YAML 只在 current 从未出现时兼容读取，并在每次
 * canonical commit 后 best-effort 投影。互斥走 mkdir 原子锁，kernel 零第三方运行时依赖。
 */
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { atomicLinkPublish, atomicReplaceFile } from './atomic-publish.js'
import {
  QuoteGateError,
  FIELD_ORDER,
  PRE_VERIFY_REVIEW_FIELD,
  REVIEW_GATE_FIELDS,
  type FieldName,
  type InitOptions,
  type LegacyImportResult,
  type PipelineState,
  type RepairProjectionOptions,
  type StateMutationKind,
  type StateProjectionStatus,
  type StateStore,
  type StateWriteIntent,
  type StateWriteResult,
} from '../types.js'
import { mergeLegacyImportFields } from './legacy-import.js'
import { withLock } from './lock.js'
import { parsePipeline, quoteGate, serializePipeline } from './parse.js'
import {
  projectionMetadataFor, publishInitialRunRevision, publishRunRevision,
  readCurrentRunRevision, readImmutableRunRevision,
  type RunRevision,
} from './run-revision-store.js'
import { splitPreVerifyReviewAnchor } from './run-revision-codec.js'
import {
  priorLogicalProjectionContent,
  projectionContent,
} from './state-projection-codec.js'
import {
  defaultStateClock,
  detectBaseBranch,
  initialFields,
  initialRunMetadata,
} from './state-init.js'
import { ensureDocumentLocalePin } from './document-locale.js'
import {
  attachWorkflowGovernanceBinding,
  ensureWorkflowGovernanceBinding,
  readWorkflowGovernanceBinding,
  withoutWorkflowGovernanceBinding,
} from './workflow-governance-binding.js'
import {
  attachWorkflowPlanSnapshot,
  ensureWorkflowPlanSnapshot,
  readWorkflowPlanSnapshot,
} from './workflow-plan-snapshot.js'
import {
  assertValidChangeName,
  discardInitialChangeCandidate,
  prepareInitialChangePublication,
  publishInitialChange,
  releaseInitialChangePublication,
  writeInitialChangeFiles,
} from './initial-change-publish.js'

export const STATE_FILE_NAME = '.pipeline.yaml'

export class StateProjectionDriftError extends Error {
  readonly _tag = 'StateProjectionDriftError'
}

export interface StateStoreOptions {
  /** 崩溃点/IO 故障注入；生产缺省仍是同目录 tmp+rename。 */
  readonly writeProjection?: (target: string, content: string) => Promise<void>
  /** Test-only boundary after the complete private Change candidate is ready. */
  readonly beforeInitialPublish?: (
    stagingChangeDir: string,
    finalChangeDir: string,
  ) => void | Promise<void>
}

function stateFilePath(changeDir: string): string {
  return path.join(changeDir, STATE_FILE_NAME)
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined
  const code = Reflect.get(error, 'code')
  return typeof code === 'string' ? code : undefined
}


/** 同目录 tmp + rename，写入原子可见（对齐老内核 `> tmp && mv`）。导出为公开原语，但目前
 * 唯一真实消费方是本文件下方 `.pipeline.yaml` 自己的 write()——W1 第二增量的
 * transition-record-store.ts **没有**复用它：rename 在 POSIX 上总是静默覆盖同名目标，
 * 无法表达"不可变"（同 sequence+id 两次写会悄悄改写第一次内容），那里改用自己的
 * tmp + link + unlink（见该文件头部注释）。 */
export const atomicWriteFile = atomicReplaceFile

function gateValue(field: FieldName, value: string | string[]): void {
  if (Array.isArray(value)) {
    for (const item of value) quoteGate(field, item)
  } else {
    quoteGate(field, value)
  }
}

function stateWithoutProjection(state: PipelineState): PipelineState {
  return {
    fields: structuredClone(state.fields),
    ...(state.runMetadata === undefined
      ? {}
      : { runMetadata: withoutWorkflowGovernanceBinding(structuredClone(state.runMetadata)) }),
    opaqueTail: state.opaqueTail,
  }
}

const FIELD_SET = new Set<string>(FIELD_ORDER)
const REVIEW_GATE_FIELD_SET = new Set<string>(REVIEW_GATE_FIELDS)

/**
 * Older releases can omit the complete review receipt, the later pre-Verify tail field,
 * or both. Accept only those exact omission shapes when projection metadata still pins the YAML to
 * the current canonical revision and parsing recreates the same semantic state. This is
 * deliberately narrower than generic "missing YAML field = default" compatibility.
 */
function isPreciseLegacyFieldProjection(
  raw: string,
  parsed: PipelineState,
  current: RunRevision,
): boolean {
  const expected = projectionMetadataFor(current)
  const metadata = parsed.projectionMetadata
  if (!metadata
    || metadata.stateRevision !== expected.stateRevision
    || metadata.stateRevisionId !== expected.stateRevisionId
    || metadata.stateDigest !== expected.stateDigest) return false
  try {
    const normalized = splitPreVerifyReviewAnchor(stateWithoutProjection(parsed)).state
    if (serializePipeline(normalized) !== serializePipeline(current.state)) return false
  } catch {
    return false
  }

  const seen = new Set<string>()
  for (const line of raw.split('\n')) {
    const match = /^([A-Za-z0-9_]+):/.exec(line)
    if (!match) continue
    const key = match[1] ?? ''
    if (!FIELD_SET.has(key)) break
    if (seen.has(key)) return false
    seen.add(key)
  }
  const omitsCompleteReviewGate = REVIEW_GATE_FIELDS.every((field) => !seen.has(field))
  const omitsPreVerifyReview = !seen.has(PRE_VERIFY_REVIEW_FIELD)
  if (!omitsCompleteReviewGate && !omitsPreVerifyReview) return false
  return FIELD_ORDER.every((field) =>
    seen.has(field)
    || (omitsCompleteReviewGate && REVIEW_GATE_FIELD_SET.has(field))
    || (omitsPreVerifyReview && field === PRE_VERIFY_REVIEW_FIELD))
}

async function inspectProjectionAgainst(
  changeDir: string,
  current?: RunRevision,
): Promise<StateProjectionStatus> {
  if (current === undefined) return { status: 'legacy' }
  const identity = { revision: current.revision, revisionId: current.revisionId }
  let raw: string
  try {
    raw = await readFile(stateFilePath(changeDir), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'missing', ...identity }
    throw error
  }
  if (raw === projectionContent(current) || raw === priorLogicalProjectionContent(current)) {
    return { status: 'current', ...identity }
  }
  let parsed: PipelineState
  try {
    parsed = parsePipeline(raw)
  } catch (error) {
    return { status: 'drift', ...identity, reason: `YAML adapter 无法解析: ${String(error)}` }
  }
  const metadata = parsed.projectionMetadata
  if (metadata === undefined) {
    // current 已提交但首次 projection 尚未完成的崩溃窗口：legacy bytes 只要语义与 current 完全
    // 一致即可安全前滚；任何字段差异都可能是旧 writer 越过断代点，必须拒绝。
    try {
      if (serializePipeline(stateWithoutProjection(parsed)) === serializePipeline(current.state)) {
        return { status: 'legacy-compatible', ...identity }
      }
    } catch (error) {
      return { status: 'drift', ...identity, reason: `legacy adapter 不可重建: ${String(error)}` }
    }
    return {
      status: 'drift', ...identity,
      reason: 'canonical 存在但 adapter 无 revision 且内容不同',
    }
  }
  if (isPreciseLegacyFieldProjection(raw, parsed, current)) {
    return { status: 'current', ...identity }
  }
  const referenced = await readImmutableRunRevision(changeDir, metadata.stateRevision, metadata.stateRevisionId)
  if (referenced !== undefined && referenced.stateDigest === metadata.stateDigest
    && (
      raw === projectionContent(referenced)
      || raw === priorLogicalProjectionContent(referenced)
      || isPreciseLegacyFieldProjection(raw, parsed, referenced)
    )) return { status: 'stale', ...identity }
  return {
    status: 'drift', ...identity,
    reason: 'revision metadata 与 adapter 内容不一致',
  }
}

class FsStateStore implements StateStore {
  private readonly writeProjection: (target: string, content: string) => Promise<void>
  private readonly beforeInitialPublish?: StateStoreOptions['beforeInitialPublish']

  constructor(options: StateStoreOptions = {}) {
    this.writeProjection = options.writeProjection ?? atomicWriteFile
    this.beforeInitialPublish = options.beforeInitialPublish
  }

  async read(changeDir: string): Promise<PipelineState> {
    const current = await readCurrentRunRevision(changeDir)
    if (current !== undefined) {
      const state = structuredClone(current.state)
      const binding = await readWorkflowGovernanceBinding(changeDir)
      const governedMetadata = attachWorkflowGovernanceBinding(state.runMetadata, binding)
      const metadata = attachWorkflowPlanSnapshot(
        governedMetadata,
        await readWorkflowPlanSnapshot(changeDir),
      )
      return {
        ...state,
        ...(metadata === undefined ? {} : { runMetadata: metadata }),
      }
    }
    return parsePipeline(await readFile(stateFilePath(changeDir), 'utf8'))
  }

  async write(
    changeDir: string,
    state: PipelineState,
    mutation: StateWriteIntent = { kind: 'replace' },
  ): Promise<StateWriteResult> {
    return withLock(changeDir, () => this.writeUnderLock(changeDir, state, mutation))
  }

  async writeUnderLock(
    changeDir: string,
    state: PipelineState,
    mutation: StateWriteIntent = { kind: 'replace' },
  ): Promise<StateWriteResult> {
    if (state.runMetadata !== undefined && (
      state.runMetadata.documentProfile !== undefined
      || state.runMetadata.documentGovernanceFingerprint !== undefined
      || state.runMetadata.workflowPlanFingerprint !== undefined
    )) {
      await ensureWorkflowGovernanceBinding(changeDir, state.runMetadata)
    }
    if (state.runMetadata?.workflowPlanSnapshot !== undefined) {
      await ensureWorkflowPlanSnapshot(
        changeDir,
        state.runMetadata.runId,
        state.runMetadata.workflowPlanSnapshot,
      )
    }
    const nextState = stateWithoutProjection(state)
    // current 是唯一提交点；所有可预见的 adapter 表示错误必须在它之前失败，不能先提交再因
    // quote gate 等确定性问题留下永久 pending projection。
    serializePipeline(nextState)
    let current = await readCurrentRunRevision(changeDir)
    if (current === undefined) {
      const legacy = parsePipeline(await readFile(stateFilePath(changeDir), 'utf8'))
      current = await publishInitialRunRevision(changeDir, legacy, defaultStateClock(), 'migration')
    } else {
      const status = await inspectProjectionAgainst(changeDir, current)
      if (status.status === 'drift') {
        throw new StateProjectionDriftError(`YAML projection drift：${status.reason}`)
      }
    }
    const next = await publishRunRevision(changeDir, current, nextState, {
      kind: mutation.kind,
      observedAt: defaultStateClock(),
      ...(mutation.transitionRecordId === undefined ? {} : { transitionRecordId: mutation.transitionRecordId }),
    })
    try {
      await this.writeProjection(stateFilePath(changeDir), projectionContent(next))
      return { projection: { status: 'updated' } }
    } catch (error) {
      return { projection: { status: 'pending', error } }
    }
  }

  async get(changeDir: string, field: FieldName): Promise<string | string[] | undefined> {
    const state = await this.read(changeDir)
    return state.fields[field]
  }

  async set(changeDir: string, field: FieldName, value: string | string[]): Promise<void> {
    await this.setMany(changeDir, { [field]: value }, 'set')
  }

  async setMany(
    changeDir: string,
    kv: Partial<Record<FieldName, string | string[]>>,
    mutationKind: 'set' | 'set-many' = 'set-many',
  ): Promise<void> {
    const entries = Object.entries(kv).filter(
      (e): e is [FieldName, string | string[]] => e[1] !== undefined,
    )
    // 闸前置：任一值触闸 → 整批拒绝、零落盘（不进锁）
    for (const [field, value] of entries) gateValue(field, value)
    if (entries.length === 0) return
    await withLock(changeDir, async () => {
      const state = await this.read(changeDir)
      for (const [field, value] of entries) state.fields[field] = value
      await this.writeUnderLock(changeDir, state, { kind: mutationKind })
    })
  }

  async cas(changeDir: string, field: FieldName, expect: string, next: string): Promise<boolean> {
    quoteGate(field, next)
    return withLock(changeDir, async () => {
      const state = await this.read(changeDir)
      if (state.fields[field] !== expect) return false
      state.fields[field] = next
      await this.writeUnderLock(changeDir, state, { kind: 'cas' })
      return true
    })
  }

  async casMany(
    changeDir: string,
    field: FieldName,
    expects: readonly string[],
    kv: Partial<Record<FieldName, string | string[]>>,
  ): Promise<boolean> {
    const entries = Object.entries(kv).filter(
      (e): e is [FieldName, string | string[]] => e[1] !== undefined,
    )
    for (const [entryField, value] of entries) gateValue(entryField, value)
    return withLock(changeDir, async () => {
      const state = await this.read(changeDir)
      const observed = state.fields[field]
      if (typeof observed !== 'string' || !expects.includes(observed)) return false
      for (const [entryField, value] of entries) state.fields[entryField] = value
      await this.writeUnderLock(changeDir, state, { kind: 'cas-many' })
      return true
    })
  }

  async inspectProjection(changeDir: string): Promise<StateProjectionStatus> {
    return inspectProjectionAgainst(changeDir, await readCurrentRunRevision(changeDir))
  }

  async repairProjection(
    changeDir: string,
    opts: RepairProjectionOptions = {},
  ): Promise<StateProjectionStatus> {
    return withLock(changeDir, async () => {
      const current = await readCurrentRunRevision(changeDir)
      if (current === undefined) {
        throw new StateProjectionDriftError('repair-projection: canonical current 不存在；仍是 legacy change')
      }
      const status = await inspectProjectionAgainst(changeDir, current)
      if (status.status === 'current') return status
      if (status.status === 'drift' && opts.forceCanonical !== true) {
        throw new StateProjectionDriftError(
          `repair-projection 拒绝覆盖未知 YAML drift：${status.reason}；显式选择 canonical 覆盖或 legacy import`,
        )
      }
      await this.writeProjection(stateFilePath(changeDir), projectionContent(current))
      return { status: 'current', revision: current.revision, revisionId: current.revisionId }
    })
  }

  async importLegacyProjection(changeDir: string): Promise<LegacyImportResult> {
    return withLock(changeDir, async () => {
      const current = await readCurrentRunRevision(changeDir)
      if (current === undefined) {
        throw new StateProjectionDriftError('import-legacy: canonical current 不存在；无需解决双主 drift')
      }
      const legacy = parsePipeline(await readFile(stateFilePath(changeDir), 'utf8'))
      const merged = mergeLegacyImportFields(legacy.fields, current.state.fields)
      const imported: PipelineState = {
        fields: merged.fields,
        ...(current.state.runMetadata === undefined
          ? {}
          : { runMetadata: structuredClone(current.state.runMetadata) }),
        opaqueTail: legacy.opaqueTail,
      }
      serializePipeline(imported)
      const next = await publishRunRevision(changeDir, current, imported, {
        kind: 'legacy-import',
        observedAt: defaultStateClock(),
      })
      try {
        await this.writeProjection(stateFilePath(changeDir), projectionContent(next))
        return { projection: { status: 'updated' }, ignoredProtectedFields: merged.ignoredProtectedFields }
      } catch (error) {
        return { projection: { status: 'pending', error }, ignoredProtectedFields: merged.ignoredProtectedFields }
      }
    })
  }

  async init(opts: InitOptions): Promise<string> {
    const { name } = opts
    assertValidChangeName(name)
    const clock = opts.clock ?? defaultStateClock
    const publication = await prepareInitialChangePublication(opts.repoRoot, name)
    const { candidateChangeDir: changeDir, finalChangeDir } = publication
    let published = false
    try {
      const requestedDocumentLocale = opts.documentLocale ?? 'zh-CN'

      const ts = clock()
      const baseBranch = await detectBaseBranch(opts.repoRoot)
      // created_by 是不可信入参：四闸校验挪到构造 fields 之前、纯内存判定——命中闸就地降级回安全
      // 占位 'unknown'，不阻断 init（身份是软信息，绝不允许它写坏状态文件），也不再需要独占创建
      // 之后再补一次 write 才能落这个字段（第 7 轮 codex review P1：那样的两步之间有竞态窗口，
      // 第二步失败还会被调用方吞掉、init 仍报成功）。
      let createdBy = 'unknown'
      if (opts.user !== undefined && opts.user !== '' && opts.user !== 'unknown') {
        try {
          quoteGate('created_by', opts.user)
          createdBy = opts.user
        } catch (err) {
          if (!(err instanceof QuoteGateError)) throw err
        }
      }
      // runId 提供时随独占创建一次性写入 runMetadata（W1 第二增量）；custom workflow 首态
      // （opts.initialWorkflow）同理——这一整个 state 对象在下面同一次原子发布里落盘，不存在
      // "先创建 default/open、再 setMany 改成 custom/首 step"两步竞态（第 7 轮 codex review 另一个
      // P1：两步之间的并发 transition 会对 provisional default/open 提交 canonical record，第二次
      // 写入后 canonical head 与实际 workflow/state 不一致；第二步写失败还会留下一个错误的
      // default change）。写入本身失败则 init 直接抛错（fail-loud，调用方不能吞掉后仍报成功），
      // 成功则身份、custom 首态与其余字段同时可见，没有中间态。
      const fullRunMetadata = initialRunMetadata(opts)
      const state: PipelineState = {
        fields: initialFields(opts, ts, baseBranch, createdBy),
        ...(fullRunMetadata === undefined
          ? {}
          : { runMetadata: withoutWorkflowGovernanceBinding(fullRunMetadata) }),
        opaqueTail: '',
      }
      // 所有 canonical、projection、locale、governance 与初始文档先写入私有 Change 候选目录。
      // 发布先用 mkdir 独占最终名称，再以 no-replace hard-link 复制，canonical current 最后成为
      // 官方读取提交点；任何层级的竞态对象都不会被覆盖。
      await ensureDocumentLocalePin(changeDir, requestedDocumentLocale)
      if (fullRunMetadata !== undefined && (
        fullRunMetadata.documentProfile !== undefined
        || fullRunMetadata.documentGovernanceFingerprint !== undefined
        || fullRunMetadata.workflowPlanFingerprint !== undefined
      )) {
        await ensureWorkflowGovernanceBinding(changeDir, fullRunMetadata)
      }
      if (fullRunMetadata?.workflowPlanSnapshot !== undefined) {
        if (fullRunMetadata.workflowPlanFingerprint === undefined) {
          throw new Error('init workflow plan snapshot 缺少 workflow plan fingerprint')
        }
        await ensureWorkflowPlanSnapshot(
          changeDir,
          fullRunMetadata.runId,
          fullRunMetadata.workflowPlanSnapshot,
        )
      }
      const revision = await publishInitialRunRevision(changeDir, state, ts)
      try {
        await atomicLinkPublish(
          changeDir, '.pipeline.yaml.tmp', stateFilePath(changeDir), projectionContent(revision),
        )
      } catch {
        // current 已经是提交点，不能把 projection 故障伪装成 init 未发生。官方读路径仍可立即使用；
        // inspect/repair-projection 会把缺失 adapter 显式暴露并幂等修复。
      }
      await writeInitialChangeFiles(changeDir, opts.initialFiles)
      await this.beforeInitialPublish?.(changeDir, finalChangeDir)
      await publishInitialChange(publication)
      published = true
      return finalChangeDir
    } finally {
      if (!published) await discardInitialChangeCandidate(changeDir)
      await releaseInitialChangePublication(publication)
    }
  }

  async withLock<T>(changeDir: string, fn: () => Promise<T>): Promise<T> {
    return withLock(changeDir, fn)
  }
}

/** StateStore 工厂（types.ts 接口的唯一官方入口） */
export function createStateStore(options: StateStoreOptions = {}): StateStore {
  return new FsStateStore(options)
}
