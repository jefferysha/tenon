import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { artifactNamespaceForChange, openArtifactService, openArtifactSubmissionService } from '../../../packages/automation/dist/index.js'
import { StageArtifactRuntime } from '../../../packages/automation/dist/artifact-runtime/stage-runtime.js'

const root = await mkdtemp(join(tmpdir(), 'tenon-unified-submission-'))
const now = '2026-09-12T18:30:00.000Z'
const namespace = artifactNamespaceForChange(root)
const adapterCalls = []
const evidence = {
  workflow: 'current-unified-submission-e2e',
  gitSha: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  namespace,
  stages: [],
  assertions: [],
}

try {
  await mkdir(join(root, 'docs'), { recursive: true })
  await writeFile(join(root, 'docs', 'design.md'), '# design\n')
  const runtime = await openArtifactService({ rootDir: root, scopeId: namespace })
  await runtime.beginAttempt({ workflowRunId: 'run-current', stageId: 'build', stageAttemptId: 'build-1' })
  const submission = await openArtifactSubmissionService({
    changeDir: root,
    namespace,
    now: () => now,
    document: { record: async input => { adapterCalls.push({ projection: 'document', logicalKey: input.logicalKey, subjectId: input.subjectRef.subject_id }); return {} } },
    field: { record: async input => { adapterCalls.push({ projection: 'field', logicalKey: input.logicalKey, subjectId: input.subjectRef.subject_id }); return {} } },
    runtime,
  })

  const document = await submission.submit({ projection: 'document', logicalKey: 'design', path: 'docs/design.md', documentKind: 'design', producer: 'skill.design', recordedAt: now })
  const field = await submission.submit({ projection: 'field', logicalKey: 'design', path: 'docs/design.md', field: 'design_doc', value: 'docs/design.md', producer: 'skill.design', recordedAt: now })
  const runtimeProjection = await submission.submit({
    projection: 'runtime', logicalKey: 'design', path: 'docs/design.md', stageAttemptId: 'build-1', producer: 'skill.design', recordedAt: now,
    runtime: { data: '# design\n', mediaType: 'text/markdown', disposition: 'deliverable', publish: true, origin: 'stage' },
  })
  await runtime.endAttempt('build-1', 'completed')
  evidence.stages.push({ stage: 'build', submissions: [document, field, runtimeProjection], adapterCalls })

  const verify = await StageArtifactRuntime.open({ service: runtime, rootDir: root, workflowRunId: 'run-current', stageId: 'verify', stageAttemptId: 'verify-1', dependencyStages: ['build'] })
  await writeFile(join(root, 'tmp-debug.log'), 'host noise\n')
  const changes = await verify.reconcile()
  const beforeRename = await verify.catalog({ includeCandidates: false, includeHistory: false })
  const withCandidates = await verify.catalog({ includeCandidates: true, includeHistory: true })
  const renamed = await runtime.rename('verify-1', runtimeProjection.subjectRef.subject_id, 'docs/architecture.md')
  const restarted = await openArtifactService({ rootDir: root, scopeId: namespace })
  const inspected = await restarted.inspect(runtimeProjection.subjectRef.subject_id, runtimeProjection.subjectRef.version)
  await verify.end('completed')
  evidence.stages.push({ stage: 'verify', reconcileChanges: changes, defaultCatalog: beforeRename.entries.map(entry => ({ path: entry.source?.path, disposition: entry.disposition, declarationStatus: entry.declarationStatus })), candidates: withCandidates.entries.map(entry => ({ path: entry.source?.path, disposition: entry.disposition, declarationStatus: entry.declarationStatus })), renamed: renamed?.subjectRef, restarted: inspected.version.subjectRef })
  evidence.assertions.push(
    ['shared-subject-id', document.subjectRef.subject_id === field.subjectRef.subject_id && field.subjectRef.subject_id === runtimeProjection.subjectRef.subject_id],
    ['shared-namespace', document.subjectRef.namespace === namespace && runtimeProjection.subjectRef.namespace === namespace],
    ['runtime-declared', runtimeProjection.subjectRef.projection === 'runtime'],
    ['reconcile-intermediate', withCandidates.entries.some(entry => entry.source?.path === 'tmp-debug.log' && entry.disposition === 'intermediate' && entry.declarationStatus === 'undeclared-candidate')],
    ['default-hides-reconcile', !beforeRename.entries.some(entry => entry.source?.path === 'tmp-debug.log')],
    ['rename-stable-subject', renamed?.subjectRef?.subject_id === runtimeProjection.subjectRef.subject_id],
    ['restart-readable', inspected.version.subjectRef?.subject_id === runtimeProjection.subjectRef.subject_id],
  )
  if (evidence.assertions.some(([, ok]) => !ok)) throw new Error(JSON.stringify(evidence))
  console.log(JSON.stringify(evidence, null, 2))
} finally {
  await rm(root, { recursive: true, force: true })
}
