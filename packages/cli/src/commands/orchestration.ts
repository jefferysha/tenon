import { randomUUID } from 'node:crypto'
import { createOrchestrationLedger, type BoardCommandV2, type BoardSnapshotV2, type GateEvaluationV2 } from '@tenon/kernel'
import type { CliDeps } from '../deps.js'
import { changeDir, isValidChangeName } from '../paths.js'

type ControlType = 'pause-change' | 'resume-change' | 'cancel-change' | 'replan-change' | 'start-change'

function ledgerDir(deps: CliDeps, change: string): string | undefined {
  if (!isValidChangeName(change)) {
    deps.io.err(`ERROR: change-name 非法: '${change}'`)
    return undefined
  }
  return changeDir(deps.cwd, change)
}

function printSnapshot(deps: CliDeps, snapshot: BoardSnapshotV2, json: boolean): void {
  if (json) {
    deps.io.out(JSON.stringify({ schema_version: 'orchestration-cli-status/v2', snapshot }))
    return
  }
  deps.io.out(`change ${snapshot.change_id}`)
  deps.io.out(`status ${snapshot.status}`)
  deps.io.out(`revision ${snapshot.revision}`)
  deps.io.out(`work-items ${snapshot.work_items.filter((item) => item.status === 'completed').length}/${snapshot.work_items.length}`)
  if (snapshot.blockers.length > 0) deps.io.out(`blockers ${snapshot.blockers.join(', ')}`)
}

export async function cmdOrchestrationStatus(deps: CliDeps, change: string, json: boolean): Promise<number> {
  const dir = ledgerDir(deps, change)
  if (!dir) return 1
  const snapshot = await createOrchestrationLedger().readSnapshot(dir)
  if (!snapshot) {
    deps.io.err(`ERROR: orchestration ledger 未初始化: ${change}`)
    return 1
  }
  printSnapshot(deps, snapshot, json)
  return 0
}

export async function cmdOrchestrationEvents(deps: CliDeps, change: string, after: number, json: boolean): Promise<number> {
  const dir = ledgerDir(deps, change)
  if (!dir || !Number.isSafeInteger(after) || after < 0) {
    if (dir) deps.io.err('ERROR: after 必须是非负整数')
    return 1
  }
  const events = await createOrchestrationLedger().readEvents(dir, { fromRevision: after + 1 })
  if (json) deps.io.out(JSON.stringify({ schema_version: 'orchestration-cli-events/v2', after_revision: after, events }))
  else for (const event of events) deps.io.out(`${event.revision}\t${event.event_type}\t${event.event_id}`)
  return 0
}

export async function cmdOrchestrationInit(deps: CliDeps, change: string, project: string, correlation: string): Promise<number> {
  const dir = ledgerDir(deps, change)
  if (!dir || project.trim() === '' || correlation.trim() === '') return 1
  const snapshot = await createOrchestrationLedger().initialize(dir, { project_id: project, change_id: change, correlation_id: correlation, updated_at: deps.clock() })
  printSnapshot(deps, snapshot, true)
  return 0
}

export async function cmdOrchestrationControl(deps: CliDeps, change: string, type: ControlType, reason: string): Promise<number> {
  const dir = ledgerDir(deps, change)
  if (!dir) return 1
  const ledger = createOrchestrationLedger()
  const snapshot = await ledger.readSnapshot(dir)
  if (!snapshot) { deps.io.err(`ERROR: orchestration ledger 未初始化: ${change}`); return 1 }
  const nonce = randomUUID()
  const command: BoardCommandV2 = {
    schema_version: 'board-command/v2', command_id: `cli:${type}:${nonce}`, idempotency_key: `cli:${type}:${nonce}`,
    expected_revision: snapshot.revision, actor: { kind: 'user', id: 'cli' }, issued_at: deps.clock(), correlation_id: snapshot.correlation_id,
    ...(snapshot.event_head_id === undefined ? {} : { causation_id: snapshot.event_head_id }), change_id: snapshot.change_id,
    type, ...(['resume-change', 'start-change'].includes(type) ? {} : { reason }),
  } as BoardCommandV2
  const result = await ledger.append(dir, command)
  if (result.kind === 'rejected') { deps.io.err(`ERROR: ${result.rejection.reason_code}: ${result.rejection.message}`); return 1 }
  printSnapshot(deps, result.snapshot, true)
  return 0
}

export async function cmdOrchestrationRun(deps: CliDeps, change: string): Promise<number> {
  const dir = ledgerDir(deps, change)
  if (!dir || deps.orchestrationRuntime === undefined) {
    deps.io.err('ERROR: production orchestration runtime 未装配')
    return 1
  }
  try {
    const result = await deps.orchestrationRuntime(dir).then(runtime => runtime.run())
    deps.io.out(JSON.stringify({ schema_version: 'orchestration-cli-run/v2', ok: result.ok, snapshot: result.snapshot, diagnostics: result.diagnostics }))
    return result.ok ? 0 : 1
  } catch (error) {
    deps.io.err(`ERROR: orchestration run 失败: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
}

export async function cmdOrchestrationRetry(deps: CliDeps, change: string, workItemId: string): Promise<number> {
  const dir = ledgerDir(deps, change)
  if (!dir) return 1
  const ledger = createOrchestrationLedger(); const snapshot = await ledger.readSnapshot(dir)
  const item = snapshot?.work_items.find((entry) => entry.work_item_id === workItemId)
  const previous = snapshot?.runs.filter((run) => run.work_item_id === workItemId).at(-1)
  if (!snapshot || !item || !previous) { deps.io.err(`ERROR: retry 需要存在的失败/中断工作项和历史 run: ${workItemId}`); return 1 }
  const nonce = randomUUID()
  return appendCommand(deps, ledger, dir, snapshot, { type: 'retry-work-item', work_item_id: workItemId, attempt_id: `attempt:cli:${nonce}`, run_id: `run:cli:${nonce}` })
}

export async function cmdOrchestrationGate(deps: CliDeps, change: string, status: 'passed' | 'rejected', gateId: string, evidence: readonly string[], rationale: string): Promise<number> {
  const dir = ledgerDir(deps, change)
  if (!dir) return 1
  const ledger = createOrchestrationLedger(); const snapshot = await ledger.readSnapshot(dir)
  if (!snapshot) { deps.io.err(`ERROR: orchestration ledger 未初始化: ${change}`); return 1 }
  const gate: GateEvaluationV2 = { schema_version: 'gate-evaluation/v2', record_id: `gate:${gateId}`, project_id: snapshot.project_id, change_id: snapshot.change_id, revision: snapshot.revision, correlation_id: snapshot.correlation_id, actor: { kind: 'user', id: 'cli' }, created_at: deps.clock(), gate_id: gateId, kind: 'verification', status, required_evidence_refs: evidence, decision_revision: snapshot.revision, rationale }
  return appendCommand(deps, ledger, dir, snapshot, { type: 'evaluate-gate', gate })
}

export async function cmdOrchestrationBindArtifact(deps: CliDeps, change: string, workItemId: string, artifactRef: string, artifactDigest: string): Promise<number> {
  const dir = ledgerDir(deps, change)
  if (!dir || artifactRef.trim() === '' || !/^sha256:[a-f0-9]{64}$/u.test(artifactDigest)) { deps.io.err('ERROR: artifact ref 或 sha256 digest 非法'); return 1 }
  const ledger = createOrchestrationLedger(); const snapshot = await ledger.readSnapshot(dir)
  if (!snapshot) { deps.io.err(`ERROR: orchestration ledger 未初始化: ${change}`); return 1 }
  return appendCommand(deps, ledger, dir, snapshot, { type: 'bind-artifact', work_item_id: workItemId, artifact_ref: artifactRef, digest: artifactDigest as `sha256:${string}` })
}

export async function cmdOrchestrationWatch(deps: CliDeps, change: string, json: boolean, follow: boolean, intervalMs = 1_000): Promise<number> {
  const dir = ledgerDir(deps, change)
  if (!dir) return 1
  let snapshot = await createOrchestrationLedger().readSnapshot(dir)
  if (!snapshot) { deps.io.err(`ERROR: orchestration ledger 未初始化: ${change}`); return 1 }
  let cursor = snapshot.revision
  printSnapshot(deps, snapshot, json)
  if (!follow) return 0
  while (!['completed', 'cancelled', 'failed'].includes(snapshot.status)) {
    await new Promise((resolve) => setTimeout(resolve, Math.max(100, Math.min(intervalMs, 30_000))))
    const ledger = createOrchestrationLedger(); const current = await ledger.readSnapshot(dir)
    if (!current) return 1
    if (current.revision > cursor) {
      const events = await ledger.readEvents(dir, { fromRevision: cursor + 1, toRevision: current.revision })
      if (json) for (const event of events) deps.io.out(JSON.stringify({ schema_version: 'orchestration-cli-event/v2', event }))
      else for (const event of events) deps.io.out(`${event.revision}\t${event.event_type}\t${event.event_id}`)
      cursor = current.revision; snapshot = current
    }
  }
  return 0
}

async function appendCommand(deps: CliDeps, ledger: ReturnType<typeof createOrchestrationLedger>, dir: string, snapshot: BoardSnapshotV2, payload: Record<string, unknown>): Promise<number> {
  const nonce = randomUUID(); const type = payload.type as BoardCommandV2['type']
  const command: BoardCommandV2 = {
    schema_version: 'board-command/v2', command_id: `cli:${type}:${nonce}`, idempotency_key: `cli:${type}:${nonce}`,
    expected_revision: snapshot.revision, actor: { kind: 'user', id: 'cli' }, issued_at: deps.clock(), correlation_id: snapshot.correlation_id,
    ...(snapshot.event_head_id === undefined ? {} : { causation_id: snapshot.event_head_id }), change_id: snapshot.change_id, ...payload,
  } as BoardCommandV2
  const result = await ledger.append(dir, command)
  if (result.kind === 'rejected') { deps.io.err(`ERROR: ${result.rejection.reason_code}: ${result.rejection.message}`); return 1 }
  printSnapshot(deps, result.snapshot, true); return 0
}

export function parseOrchestrationAfter(value: string | undefined): number {
  if (value === undefined || !/^(0|[1-9][0-9]*)$/.test(value)) return -1
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= 0 && parsed <= 2_048 ? parsed : -1
}
