import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  checkMarkdownImages,
  checkReferenceIdentities,
  checkTrackedFiles,
} from './check-repository-hygiene.mjs'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'tenon-repository-hygiene-'))
  await mkdir(join(root, 'docs-site', 'public', 'images'), { recursive: true })
  await mkdir(join(root, 'docs'), { recursive: true })
  await writeFile(join(root, 'docs-site', 'public', 'images', 'dashboard-progress.webp'), 'webp')
  return root
}

test('rejects old QA images and accepts bounded official dashboard WebP assets', async () => {
  const root = await fixture()
  try {
    assert.deepEqual(checkTrackedFiles(root, ['docs-site/public/images/dashboard-progress.webp']), [])
    assert.match(
      checkTrackedFiles(root, ['design-demos/shots/qa.png'])[0],
      /禁止跟踪/,
    )
    assert.match(checkTrackedFiles(root, ['random.png'])[0], /allowlist/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('resolves README and Pages-style image links and rejects dangling links', async () => {
  const root = await fixture()
  try {
    await writeFile(
      join(root, 'README.md'),
      '![进度](docs-site/public/images/dashboard-progress.webp)\n',
    )
    await writeFile(
      join(root, 'docs', 'guide.md'),
      '![进度](/images/dashboard-progress.webp)\n',
    )
    assert.deepEqual(checkMarkdownImages(root, ['README.md', 'docs/guide.md']), [])
    await writeFile(join(root, 'README.md'), '![丢失](docs-site/public/images/missing.webp)\n')
    assert.match(checkMarkdownImages(root, ['README.md'])[0], /不存在/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('rejects reference identities in tracked paths and ordinary managed text', async () => {
  const root = await fixture()
  const firstIdentity = String.fromCharCode(116, 114, 101, 108, 108, 105, 115)
  const secondIdentity = String.fromCharCode(99, 111, 109, 101, 116)
  const thirdIdentity = String.fromCharCode(
    97, 119, 101, 115, 111, 109, 101, 45, 100, 101, 115, 105, 103, 110, 45, 109, 100,
  )
  const contentPath = 'docs/reference.md'
  const additionalContentPath = 'docs/additional-reference.md'
  await writeFile(join(root, contentPath), `derived from ${secondIdentity}\n`)
  await writeFile(join(root, additionalContentPath), `derived from ${thirdIdentity}\n`)
  try {
    const failures = checkReferenceIdentities(root, [
      `docs/${firstIdentity}-layout.md`,
      contentPath,
      additionalContentPath,
    ])
    assert.equal(failures.length, 3)
    assert.ok(failures.every((failure) => !failure.toLowerCase().includes(firstIdentity)))
    assert.ok(failures.every((failure) => !failure.toLowerCase().includes(secondIdentity)))
    assert.ok(failures.every((failure) => !failure.toLowerCase().includes(thirdIdentity)))
    assert.match(failures[0], /路径/)
    assert.match(failures[1], /文本/)
    assert.match(failures[2], /文本/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('allows the first-party workflow directory while retaining competitor checks', async () => {
  const root = await fixture()
  const firstIdentity = String.fromCharCode(116, 114, 101, 108, 108, 105, 115)
  const secondIdentity = String.fromCharCode(99, 111, 109, 101, 116)
  const workflowDir = `.${firstIdentity}`
  await mkdir(join(root, workflowDir), { recursive: true })
  await writeFile(join(root, workflowDir, 'workflow.md'), `Managed by ${firstIdentity}.\n`)
  await writeFile(join(root, workflowDir, 'unsafe.md'), `Reference to ${secondIdentity}.\n`)
  try {
    assert.deepEqual(checkReferenceIdentities(root, [`${workflowDir}/workflow.md`]), [])
    const failures = checkReferenceIdentities(root, [`${workflowDir}/unsafe.md`])
    assert.equal(failures.length, 1)
    assert.match(failures[0], /文本/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('allows fixed trace-timeline research and governance paths but rejects source and unrelated docs', async () => {
  const root = await fixture()
  const firstIdentity = String.fromCharCode(116, 114, 101, 108, 108, 105, 115)
  const secondIdentity = String.fromCharCode(99, 111, 109, 101, 116)
  const unrelatedReference = String.fromCharCode(
    97, 119, 101, 115, 111, 109, 101, 45, 100, 101, 115, 105, 103, 110, 45, 109, 100,
  )
  const allowed = [
    'docs/adr/trace-timeline.md',
    'docs/superpowers/specs/2026-07-29-trace-timeline-tenon-upstreams-research.md',
    'docs/superpowers/specs/trace-timeline-design.md',
    'openspec/changes/trace-timeline/proposal.md',
    'openspec/changes/trace-timeline/tasks.md',
    'openspec/changes/archive/2026-07-29-trace-timeline/proposal.md',
    'openspec/changes/archive/2026-07-29-trace-timeline/tasks.md',
  ]
  const rejected = [
    'packages/server/src/serverGetRoutes.ts',
    'docs/reference.md',
    'openspec/changes/trace-timeline/design.md',
    'openspec/changes/trace-timeline/copied-source.ts',
    'openspec/changes/archive/2026-07-29-other-change/proposal.md',
  ]
  for (const path of [...allowed, ...rejected]) {
    await mkdir(join(root, path, '..'), { recursive: true })
    await writeFile(join(root, path), `Fixed research: ${firstIdentity} and ${secondIdentity}.\n`)
  }
  const identityInPath = `docs/adr/${firstIdentity}.md`
  await writeFile(join(root, identityInPath), 'evidence\n')
  try {
    assert.deepEqual(checkReferenceIdentities(root, allowed), [])
    await writeFile(join(root, allowed[0]), `Fixed research: ${firstIdentity}, ${secondIdentity}, and ${unrelatedReference}.\n`)
    assert.equal(checkReferenceIdentities(root, [allowed[0]]).length, 1)
    const rejectedFailures = checkReferenceIdentities(root, rejected)
    assert.equal(rejectedFailures.length, rejected.length)
    assert.ok(rejectedFailures.every((failure) => /受管理文本/.test(failure)))
    const pathFailures = checkReferenceIdentities(root, [identityInPath])
    assert.equal(pathFailures.length, 1)
    assert.match(pathFailures[0], /路径/)
    assert.ok(!pathFailures[0].toLowerCase().includes(firstIdentity))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('allows review-handshake upstream identities only in its fixed research and design evidence', async () => {
  const root = await fixture()
  const firstIdentity = String.fromCharCode(116, 114, 101, 108, 108, 105, 115)
  const secondIdentity = String.fromCharCode(99, 111, 109, 101, 116)
  const allowed = [
    'docs/superpowers/specs/2026-07-30-review-handshake-upstream-research.md',
    'docs/superpowers/specs/2026-07-30-review-handshake-status-design.md',
  ]
  const rejected = [
    'packages/server/src/reviewHandshake.ts',
    'docs/superpowers/specs/2026-07-30-other-feature.md',
    'openspec/changes/review-handshake-status-20260730/proposal.md',
  ]
  for (const path of [...allowed, ...rejected]) {
    await mkdir(join(root, path, '..'), { recursive: true })
    await writeFile(join(root, path), `Fixed research: ${firstIdentity} and ${secondIdentity}.\n`)
  }
  try {
    assert.deepEqual(checkReferenceIdentities(root, allowed), [])
    const failures = checkReferenceIdentities(root, rejected)
    assert.equal(failures.length, rejected.length)
    assert.ok(failures.every((failure) => /受管理文本/.test(failure)))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('allows orchestration graph upstream identities only in fixed research and governed Change evidence', async () => {
  const root = await fixture()
  const firstIdentity = String.fromCharCode(116, 114, 101, 108, 108, 105, 115)
  const secondIdentity = String.fromCharCode(99, 111, 109, 101, 116)
  const allowed = [
    'docs/superpowers/specs/2026-07-30-chorus-orchestration-graph-research.md',
    'docs/superpowers/specs/frozen-workflow-definition-status-20260730-design.md',
    'openspec/changes/frozen-workflow-definition-status-20260730/proposal.md',
    'openspec/changes/frozen-workflow-definition-status-20260730/tasks.md',
    'openspec/changes/archive/2026-07-30-frozen-workflow-definition-status-20260730/proposal.md',
  ]
  const rejected = [
    'packages/server/src/orchestrationGraph.ts',
    'docs/superpowers/specs/other-graph.md',
    'openspec/changes/frozen-workflow-definition-status-20260730/design.md',
    'openspec/changes/archive/2026-07-30-other-change/proposal.md',
  ]
  for (const path of [...allowed, ...rejected]) {
    await mkdir(join(root, path, '..'), { recursive: true })
    await writeFile(join(root, path), `Fixed research: ${firstIdentity} and ${secondIdentity}.\n`)
  }
  try {
    assert.deepEqual(checkReferenceIdentities(root, allowed), [])
    const failures = checkReferenceIdentities(root, rejected)
    assert.equal(failures.length, rejected.length)
    assert.ok(failures.every((failure) => /受管理文本/.test(failure)))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('allows canonical-version upstream identities only in its fixed research evidence', async () => {
  const root = await fixture()
  const firstIdentity = String.fromCharCode(116, 114, 101, 108, 108, 105, 115)
  const secondIdentity = String.fromCharCode(99, 111, 109, 101, 116)
  const unrelatedReference = String.fromCharCode(
    97, 119, 101, 115, 111, 109, 101, 45, 100, 101, 115, 105, 103, 110, 45, 109, 100,
  )
  const allowed = [
    'docs/superpowers/specs/2026-07-30-canonical-state-version-status-upstream-research.md',
  ]
  const rejected = [
    'packages/kernel/src/state/run-revision-codec.ts',
    'docs/superpowers/specs/2026-07-30-canonical-state-version-status-design.md',
  ]
  for (const path of [...allowed, ...rejected]) {
    await mkdir(join(root, path, '..'), { recursive: true })
    await writeFile(join(root, path), `Reference: ${firstIdentity} and ${secondIdentity}.\n`)
  }
  try {
    assert.deepEqual(checkReferenceIdentities(root, allowed), [])
    await writeFile(
      join(root, allowed[0]),
      `Fixed research: ${firstIdentity}, ${secondIdentity}, and ${unrelatedReference}.\n`,
    )
    assert.equal(checkReferenceIdentities(root, allowed).length, 1)
    const failures = checkReferenceIdentities(root, rejected)
    assert.equal(failures.length, rejected.length)
    assert.ok(failures.every((failure) => /受管理文本/.test(failure)))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('allows fixed host-target-plan research and governance paths but rejects source and unrelated docs', async () => {
  const root = await fixture()
  const firstIdentity = String.fromCharCode(116, 114, 101, 108, 108, 105, 115)
  const secondIdentity = String.fromCharCode(99, 111, 109, 101, 116)
  const unrelatedReference = String.fromCharCode(
    97, 119, 101, 115, 111, 109, 101, 45, 100, 101, 115, 105, 103, 110, 45, 109, 100,
  )
  const allowed = [
    'docs/adr/host-target-plan-dashboard.md',
    `docs/superpowers/specs/2026-07-28-host-target-plan-${secondIdentity}-platform-research.md`,
    `docs/superpowers/specs/2026-07-28-host-target-plan-${firstIdentity}-context-research.md`,
    'openspec/changes/host-target-plan-dashboard/design.md',
    'openspec/changes/archive/2026-07-28-host-target-plan-dashboard/applied-spec.md',
    'openspec/specs/host-target-plan/spec.md',
  ]
  const rejected = [
    'packages/server/src/hostTargetPlanProtocol.ts',
    'docs/reference.md',
    'openspec/changes/host-target-plan-dashboard/copied-source.ts',
    'openspec/changes/host-target-plan-dashboard/notes.md',
    'openspec/changes/archive/2026-07-28-other-change/design.md',
    'openspec/specs/other-capability/spec.md',
  ]
  for (const path of [...allowed, ...rejected]) {
    await mkdir(join(root, path, '..'), { recursive: true })
    await writeFile(
      join(root, path),
      `Fixed research: https://github.com/example/${secondIdentity}/commit/2945693 and ${firstIdentity} 12e279a8.\n`,
    )
  }
  try {
    assert.deepEqual(checkReferenceIdentities(root, allowed), [])
    await writeFile(
      join(root, allowed[0]),
      `Fixed research: ${secondIdentity}, ${firstIdentity}, and ${unrelatedReference}.\n`,
    )
    assert.equal(checkReferenceIdentities(root, [allowed[0]]).length, 1)
    const failures = checkReferenceIdentities(root, rejected)
    assert.equal(failures.length, rejected.length)
    assert.ok(failures.every((failure) => /受管理文本/.test(failure)))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('reference identity matching is case-insensitive and diagnostics never echo the identity', async () => {
  const root = await fixture()
  const identity = String.fromCharCode(116, 114, 101, 108, 108, 105, 115)
  const mixedCase = identity
    .split('')
    .map((character, index) => index % 2 === 0 ? character.toUpperCase() : character)
    .join('')
  const path = `docs/${mixedCase}-notes.md`
  await writeFile(join(root, path), `${mixedCase}\n`)
  try {
    const failures = checkReferenceIdentities(root, [path])
    assert.equal(failures.length, 2)
    assert.ok(failures.every((failure) => !failure.toLowerCase().includes(identity)))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('rejects historical test-project identities from tracked paths', async () => {
  const root = await fixture()
  const testProjectIdentity = String.fromCharCode(
    112, 101, 116, 45, 97, 100, 111, 112, 116, 105, 111, 110, 45, 99, 101, 110, 116, 101, 114,
  )
  try {
    const failures = checkTrackedFiles(root, [
      `design-demos/${testProjectIdentity}.html`,
    ])
    assert.equal(failures.length, 1)
    assert.match(failures[0], /历史测试项目/)
    assert.ok(!failures[0].toLowerCase().includes(testProjectIdentity))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('allows fixed archived screenshot evidence while retaining image allowlist', async () => {
  const root = await fixture()
  try {
    const archived = `.${String.fromCharCode(116, 114, 101, 108, 108, 105, 115)}/tasks/archive/2026-09/09-09-dashboard-template-refactor/prototype/screens/1.png`
    assert.deepEqual(checkTrackedFiles(root, [archived]), [])
    assert.match(checkTrackedFiles(root, ['other/archive.png'])[0], /allowlist/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('allows product identity in the fixed runtime artifact audit record', async () => {
  const root = await fixture()
  const identity = String.fromCharCode(116, 114, 101, 108, 108, 105, 115)
  const path = 'docs/research/2026-09-12-runtime-artifact-code-findings.md'
  await mkdir(join(root, 'docs', 'research'), { recursive: true })
  await writeFile(join(root, path), `Audit of ${identity} runtime artifacts.\n`)
  try {
    assert.deepEqual(checkReferenceIdentities(root, [path]), [])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
