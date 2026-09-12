import { describe, expect, test } from 'vitest'
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { StageArtifactRuntime, type ArtifactServicePort } from './stage-runtime.js'

describe('StageArtifactRuntime', () => {
  test('reconciles unknown writes and publishes only when explicitly requested', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'tenon-artifact-runtime-'))
    const observed: string[] = []; const ended: string[] = []; const published: string[] = []
    const service: ArtifactServicePort = {
      async beginAttempt() { return {} as never },
      async observe(_id, content) { observed.push(content.source?.path ?? ''); return { artifactId: 'a', version: 'v1', contentDigest: '0'.repeat(64), size: 5, mediaType: 'text/markdown', kind: 'text', origin: content.origin ?? 'unknown', ...(content.producer ? { producer: content.producer } : {}), contentUri: 'artifact://a/v1', disposition: 'candidate', quality: 'unchecked', createdAt: new Date().toISOString() } },
      async publish(_id, input) { published.push(input.path); return { artifactId: 'a', version: 'v1', contentDigest: '0'.repeat(64), size: 1, mediaType: 'text/plain', kind: 'text', origin: 'unknown', contentUri: 'artifact://a/v1', disposition: input.disposition ?? 'candidate', quality: 'unchecked', createdAt: new Date().toISOString() } },
      async endAttempt(_id, status) { ended.push(status) },
    }
    try {
      const runtime = await StageArtifactRuntime.open({ service, rootDir: root, workflowRunId: 'run', stageId: 'stage', stageAttemptId: 'attempt' })
      await mkdir(path.join(root, 'nested'))
      await writeFile(path.join(root, 'nested', 'result.md'), 'hello')
      const changes = await runtime.reconcile()
      expect(changes).toEqual([{ path: path.join('nested', 'result.md'), kind: 'created', digest: expect.any(String) }])
      expect(observed).toEqual([path.join('nested', 'result.md')])
      await runtime.publish('nested/result.md', 'deliverable')
      expect(observed).toEqual([path.join('nested', 'result.md'), path.join('nested', 'result.md')])
      expect(published).toEqual(['nested/result.md'])
      await runtime.end('completed')
      expect(ended).toEqual(['completed'])
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  test('rejects paths escaping the scoped root', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'tenon-artifact-runtime-'))
    const service: ArtifactServicePort = { async beginAttempt() { return {} as never }, async observe() {}, async publish() { return {} as never }, async endAttempt() {} }
    try {
      const runtime = await StageArtifactRuntime.open({ service, rootDir: root, workflowRunId: 'run', stageId: 'stage', stageAttemptId: 'attempt' })
      await expect(runtime.publish('../outside')).rejects.toThrow('escapes root')
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  test('ignores orchestration state during reconciliation and managed observation', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'tenon-artifact-runtime-'))
    const observed: string[] = []
    const service: ArtifactServicePort = {
      async beginAttempt() { return {} as never },
      async observe(_id, content) { observed.push(content.source?.path ?? ''); return { artifactId: 'a', version: 'v1', contentDigest: '0'.repeat(64), size: 1, mediaType: 'text/plain', kind: 'text', origin: 'unknown', contentUri: 'artifact://a/v1', disposition: 'candidate', quality: 'unchecked', createdAt: new Date().toISOString() } },
      async publish() { return {} as never },
      async endAttempt() {},
    }
    try {
      const runtime = await StageArtifactRuntime.open({ service, rootDir: root, workflowRunId: 'run', stageId: 'stage', stageAttemptId: 'attempt' })
      await mkdir(path.join(root, '.orchestration-v2'))
      await writeFile(path.join(root, '.orchestration-v2', 'event.json'), '{}')
      await writeFile(path.join(root, 'report.txt'), 'ok')
      await runtime.reconcile()
      expect(observed).toEqual(['report.txt'])
      await expect(runtime.observePath('.orchestration-v2/event.json')).rejects.toThrow('ignored artifact path')
    } finally { await rm(root, { recursive: true, force: true }) }
  })
})
