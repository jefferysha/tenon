import { access, mkdtemp, mkdir, open, readFile, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  TaskRunJournalCorruptError,
  TaskRunRevisionConflictError,
  appendTaskRunAttempt,
  appendTaskRunOperation,
  appendTaskRunValidatorVerdict,
  readTaskRunJournal,
} from './journal.js'

async function changeDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'tenon-task-run-journal-'))
  const change = join(root, 'change')
  await mkdir(change)
  return change
}

function journalPath(change: string): string {
  return join(change, '.pipeline', 'task-runs', 'revision-1', 'events.jsonl')
}

function operationEvent(sequence: number, operationId: string): string {
  return `${JSON.stringify({
    schema_version: 'task-run-event/v1',
    sequence,
    type: 'operation',
    operation: {
      operation_id: operationId,
      operation: 'resume',
      expected_run_revision: sequence - 1,
      expected_state: 'blocked',
      recorded_at: '2026-08-04T00:00:00.000Z',
    },
  })}\n`
}

describe('task run journal', () => {
  it('keeps an empty read side-effect free', async () => {
    const change = await changeDir()
    await expect(readTaskRunJournal(change, 'revision-1')).resolves.toEqual({
      run_revision: 0, attempts: [], operations: [], validator_verdicts: [],
    })
    await expect(access(join(change, '.pipeline'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('reads through the server-owned directory fd path without trusting ordinary symlinks', async () => {
    const change = await changeDir()
    const handle = await open(change, 'r')
    try {
      const prefix = process.platform === 'linux' ? '/proc/self/fd' : '/dev/fd'
      await expect(readTaskRunJournal(`${prefix}/${handle.fd}`, 'revision-1')).resolves.toEqual({
        run_revision: 0, attempts: [], operations: [], validator_verdicts: [],
      })
    } finally {
      await handle.close()
    }
  })

  it('fails closed on a symlinked journal leaf without following it for reads or appends', async () => {
    const change = await changeDir()
    const directory = join(change, '.pipeline', 'task-runs', 'revision-1')
    const target = join(change, 'outside-events.jsonl')
    const leaf = journalPath(change)
    const targetContents = operationEvent(1, 'target-operation')
    await mkdir(directory, { recursive: true })
    await writeFile(target, targetContents, 'utf8')
    await symlink(target, leaf)

    await expect(readTaskRunJournal(change, 'revision-1'))
      .rejects.toBeInstanceOf(TaskRunJournalCorruptError)
    await expect(appendTaskRunOperation(change, 'revision-1', {
      operation_id: 'new-operation', operation: 'resume', expected_run_revision: 1,
      expected_state: 'blocked', recorded_at: '2026-08-04T00:00:01.000Z',
    })).rejects.toBeInstanceOf(TaskRunJournalCorruptError)
    await expect(readFile(target, 'utf8')).resolves.toBe(targetContents)
  })

  it('fails closed on a non-regular journal leaf', async () => {
    const change = await changeDir()
    const leaf = journalPath(change)
    await mkdir(leaf, { recursive: true })

    await expect(readTaskRunJournal(change, 'revision-1'))
      .rejects.toBeInstanceOf(TaskRunJournalCorruptError)
    await expect(appendTaskRunOperation(change, 'revision-1', {
      operation_id: 'new-operation', operation: 'resume', expected_run_revision: 0,
      expected_state: 'blocked', recorded_at: '2026-08-04T00:00:01.000Z',
    })).rejects.toBeInstanceOf(TaskRunJournalCorruptError)
  })

  it('rejects an incomplete final JSONL line as corrupt', async () => {
    const change = await changeDir()
    const leaf = journalPath(change)
    await mkdir(join(change, '.pipeline', 'task-runs', 'revision-1'), { recursive: true })
    await writeFile(leaf, operationEvent(1, 'incomplete').trimEnd(), 'utf8')

    await expect(readTaskRunJournal(change, 'revision-1'))
      .rejects.toBeInstanceOf(TaskRunJournalCorruptError)
  })

  it('rejects an append that would exceed the journal byte budget before writing', async () => {
    const change = await changeDir()
    const leaf = journalPath(change)
    await mkdir(join(change, '.pipeline', 'task-runs', 'revision-1'), { recursive: true })
    const maxBytes = 8 * 1024 * 1024
    const baseEvent = {
      schema_version: 'task-run-event/v1',
      sequence: 1,
      type: 'operation' as const,
      operation: {
        operation_id: 'fill-operation', operation: 'resume' as const, expected_run_revision: 0,
        expected_state: '', recorded_at: '2026-08-04T00:00:00.000Z',
      },
    }
    const baseBytes = Buffer.byteLength(`${JSON.stringify(baseEvent)}\n`)
    const event = {
      ...baseEvent,
      operation: { ...baseEvent.operation, expected_state: 'b'.repeat(maxBytes - baseBytes - 1) },
    }
    const contents = `${JSON.stringify(event)}\n`
    expect(Buffer.byteLength(contents)).toBe(maxBytes - 1)
    await writeFile(leaf, contents, 'utf8')
    const before = await readFile(leaf)

    await expect(appendTaskRunOperation(change, 'revision-1', {
      operation_id: 'overflow-operation', operation: 'resume', expected_run_revision: 1,
      expected_state: 'blocked', recorded_at: '2026-08-04T00:00:01.000Z',
    })).rejects.toBeInstanceOf(TaskRunJournalCorruptError)
    // Buffer.equals is one memcmp; expect(...).toEqual on two 8 MiB Buffers compares element by element (~8 s).
    const after = await readFile(leaf)
    expect(after.byteLength).toBe(before.byteLength)
    expect(after.equals(before)).toBe(true)
  })

  it('appends attempt and operation facts without rewriting history', async () => {
    const change = await changeDir()
    await appendTaskRunAttempt(change, 'revision-1', 0, {
      attempt_id: 'item-1',
      work_item_id: 'item',
      attempt_number: 1,
      status: 'failed',
      recorded_at: '2026-08-04T00:00:00.000Z',
      input_digests: {},
    })
    await appendTaskRunOperation(change, 'revision-1', {
      operation_id: 'operation-1',
      operation: 'retry',
      work_item_id: 'item',
      expected_run_revision: 1,
      expected_state: 'failed',
      recorded_at: '2026-08-04T00:00:01.000Z',
    })

    const journal = await readTaskRunJournal(change, 'revision-1')
    expect(journal.run_revision).toBe(2)
    expect(journal.attempts).toHaveLength(1)
    expect(journal.operations).toHaveLength(1)
  })

  it('accepts an append-only running-to-terminal transition for one attempt identity', async () => {
    const change = await changeDir()
    const running = {
      attempt_id: 'item-1', work_item_id: 'item', attempt_number: 1,
      status: 'running' as const, recorded_at: '2026-08-04T00:00:00.000Z', input_digests: {},
    }
    await appendTaskRunAttempt(change, 'revision-1', 0, running)
    await appendTaskRunAttempt(change, 'revision-1', 1, {
      ...running, status: 'succeeded', recorded_at: '2026-08-04T00:00:01.000Z', output_digest: 'sha256:item',
    })

    const journal = await readTaskRunJournal(change, 'revision-1')
    expect(journal.attempts).toMatchObject([
      { attempt_id: 'item-1', status: 'running', journal_sequence: 1 },
      { attempt_id: 'item-1', status: 'succeeded', journal_sequence: 2 },
    ])
  })

  it('rejects an invalid terminal transition before writing it', async () => {
    const change = await changeDir()
    const failed = {
      attempt_id: 'item-1', work_item_id: 'item', attempt_number: 1,
      status: 'failed' as const, recorded_at: '2026-08-04T00:00:00.000Z', input_digests: {},
    }
    await appendTaskRunAttempt(change, 'revision-1', 0, failed)
    await expect(appendTaskRunAttempt(change, 'revision-1', 1, {
      ...failed, status: 'succeeded', recorded_at: '2026-08-04T00:00:01.000Z',
    })).rejects.toBeInstanceOf(TaskRunJournalCorruptError)
    await expect(readTaskRunJournal(change, 'revision-1')).resolves.toMatchObject({
      run_revision: 1, attempts: [{ status: 'failed' }],
    })
  })

  it('keeps validator history append-only while projecting the latest verdict per identity', async () => {
    const change = await changeDir()
    await appendTaskRunValidatorVerdict(change, 'revision-1', 0, {
      validator_id: 'integration', scope: 'run', status: 'pending',
      recorded_at: '2026-08-04T00:00:00.000Z',
    })
    await appendTaskRunValidatorVerdict(change, 'revision-1', 1, {
      validator_id: 'integration', scope: 'run', status: 'passed',
      recorded_at: '2026-08-04T00:00:01.000Z',
    })
    const journal = await readTaskRunJournal(change, 'revision-1')
    expect(journal.run_revision).toBe(2)
    expect(journal.validator_verdicts).toEqual([{
      validator_id: 'integration', scope: 'run', status: 'passed',
      recorded_at: '2026-08-04T00:00:01.000Z',
    }])
  })

  it('allows only one concurrent operation for the same expected revision', async () => {
    const change = await changeDir()
    const operation = (id: string) => appendTaskRunOperation(change, 'revision-1', {
      operation_id: id,
      operation: 'resume' as const,
      expected_run_revision: 0,
      expected_state: 'blocked',
      recorded_at: '2026-08-04T00:00:00.000Z',
    })

    const results = await Promise.allSettled([operation('first'), operation('second')])
    expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(1)
    const rejected = results.find(({ status }) => status === 'rejected')
    expect(rejected).toMatchObject({ status: 'rejected', reason: expect.any(TaskRunRevisionConflictError) })
    expect((await readTaskRunJournal(change, 'revision-1')).operations).toHaveLength(1)
  })
})
