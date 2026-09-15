import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

async function text(path) {
  return readFile(join(root, path), 'utf8')
}

function workflowRunScript(workflow, stepName) {
  const lines = workflow.split('\n')
  const nameIndex = lines.findIndex((line) => line.trim() === `- name: ${stepName}`)
  assert.notEqual(nameIndex, -1, `missing workflow step: ${stepName}`)
  const runIndex = lines.findIndex((line, index) =>
    index > nameIndex && /^\s+run: \|$/.test(line),
  )
  assert.notEqual(runIndex, -1, `missing run block for workflow step: ${stepName}`)
  const runIndent = lines[runIndex].match(/^\s*/)[0].length
  const body = []
  for (const line of lines.slice(runIndex + 1)) {
    const indent = line.match(/^\s*/)[0].length
    if (line.trim() !== '' && indent <= runIndent) break
    body.push(line.slice(Math.min(runIndent + 2, line.length)))
  }
  return `${body.join('\n')}\n`
}

async function writeExecutable(path, source) {
  await writeFile(path, source, 'utf8')
  await chmod(path, 0o755)
}

function runBash(script, cwd, env = {}) {
  return spawnSync('bash', ['-c', script], {
    cwd,
    env: { ...process.env, ...env },
    encoding: 'utf8',
  })
}

async function fixtureDir(t) {
  const directory = await mkdtemp(join(tmpdir(), 'tenon-release-workflow-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return directory
}

const candidateSha = '1234567890abcdef1234567890abcdef12345678'
const conflictingSha = 'abcdef1234567890abcdef1234567890abcdef12'
const artifactHex = 'a'.repeat(64)
const artifactDigest = `sha256:${artifactHex}`
const manifestDigest = 'b'.repeat(64)

function approvalEvidence(overrides = {}) {
  return {
    sha: candidateSha,
    tag: 'v1.0.1',
    version: '1.0.1',
    source_run_id: '991',
    source_workflow_ref: 'example/tenon/.github/workflows/release-candidate.yml@refs/heads/main',
    source_workflow_sha: candidateSha,
    payload_artifact_id: '442',
    payload_artifact_name: `release-candidate-payload-${candidateSha}`,
    payload_artifact_digest: artifactDigest,
    payload_manifest_sha256: manifestDigest,
    ...overrides,
  }
}

const mockGhSource = `#!/usr/bin/env node
const { appendFileSync, copyFileSync, mkdirSync, readFileSync, writeSync } = require('node:fs')
const { join } = require('node:path')
const args = process.argv.slice(2)
appendFileSync(process.env.MOCK_GH_LOG, JSON.stringify(args) + '\\n')
const scenario = process.env.MOCK_GH_SCENARIO || 'fresh'
const endpoint = args.find((arg) => arg.startsWith('repos/')) || ''
const output = (value) => process.stdout.write(typeof value === 'string' ? value + '\\n' : JSON.stringify(value) + '\\n')
if (args[0] === 'run' && args[1] === 'download') {
  const repoIndex = args.indexOf('--repo')
  if (repoIndex < 0 || args[repoIndex + 1] !== process.env.GITHUB_REPOSITORY) process.exit(91)
  const dir = args[args.indexOf('--dir') + 1]
  mkdirSync(dir, { recursive: true })
  copyFileSync(process.env.MOCK_APPROVAL_SOURCE, join(dir, 'approved.json'))
  process.exit(0)
}
if (args[0] === 'api') {
  if (endpoint.includes('/git/matching-refs/tags/')) {
    if (scenario === 'tag-fresh') process.exit(0)
    output({
      ref: 'refs/tags/v1.0.1',
      object: {
        sha: scenario === 'tag-conflict' ? process.env.MOCK_CONFLICTING_SHA : process.env.MOCK_TAG_OBJECT_SHA,
        type: scenario === 'tag-conflict' ? 'commit' : 'tag',
      },
    })
    process.exit(0)
  }
  if (endpoint.includes('/git/tags/') && !args.includes('--method')) {
    output({ object: { sha: process.env.MOCK_CANDIDATE_SHA, type: 'commit' } })
    process.exit(0)
  }
  if (endpoint.endsWith('/branches/main')) {
    output(process.env.MOCK_CANDIDATE_SHA)
    process.exit(0)
  }
  if (endpoint.endsWith('/git/tags') && args.includes('POST')) {
    output(process.env.MOCK_TAG_OBJECT_SHA)
    process.exit(0)
  }
  if (endpoint.endsWith('/git/refs') && args.includes('POST')) process.exit(0)
  if (endpoint.includes('/actions/artifacts/') && endpoint.endsWith('/zip')) {
    writeSync(1, readFileSync(process.env.MOCK_PAYLOAD_ZIP))
    process.exit(0)
  }
  if (endpoint.includes('/actions/artifacts/')) {
    output({
      id: Number(process.env.MOCK_ARTIFACT_ID),
      name: process.env.MOCK_ARTIFACT_NAME,
      digest: process.env.MOCK_ARTIFACT_DIGEST,
      expired: false,
      workflow_run: {
        id: Number(process.env.MOCK_SOURCE_RUN_ID),
        head_sha: process.env.MOCK_CANDIDATE_SHA,
      },
    })
    process.exit(0)
  }
}
if (args[0] === 'release' && args[1] === 'view') {
  if (!args.includes('--json')) process.exit(scenario === 'release-fresh' ? 1 : 0)
  output({
    tagName: 'v1.0.1',
    isDraft: false,
    isPrerelease: false,
    assets: scenario === 'partial' ? [{ name: 'SHA256SUMS' }] : [],
  })
  process.exit(0)
}
if (args[0] === 'release' && args[1] === 'download') {
  const name = args[args.indexOf('--pattern') + 1]
  const dir = args[args.indexOf('--dir') + 1]
  mkdirSync(dir, { recursive: true })
  copyFileSync(join(process.env.MOCK_EXISTING_ASSETS, name), join(dir, name))
  process.exit(0)
}
if (args[0] === 'release' && (args[1] === 'create' || args[1] === 'upload')) process.exit(0)
process.stderr.write('unexpected gh invocation: ' + JSON.stringify(args) + '\\n')
process.exit(97)
`

async function installMockGh(directory) {
  const bin = join(directory, 'bin')
  await mkdir(bin)
  await writeExecutable(join(bin, 'gh'), mockGhSource)
  return bin
}

async function readGhCalls(path) {
  const content = await readFile(path, 'utf8')
  return content.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
}

async function preparePayload(directory) {
  const payload = join(directory, 'payload')
  const existing = join(directory, 'existing-assets')
  await mkdir(payload)
  await mkdir(existing)
  const assetName = 'tenon-legacy-bridge-1.0.1.tar.gz'
  await writeFile(join(payload, assetName), 'verified release bytes\n', 'utf8')
  const digest = spawnSync('sha256sum', [join(payload, assetName)], { encoding: 'utf8' })
    .stdout.split(/\s+/)[0]
  const manifest = `${digest}  ${assetName}\n`
  await writeFile(join(payload, 'SHA256SUMS'), manifest, 'utf8')
  await cp(join(payload, 'SHA256SUMS'), join(existing, 'SHA256SUMS'))
  const zip = join(directory, 'payload.zip')
  const zipped = spawnSync('zip', ['-q', '-j', zip, join(payload, 'SHA256SUMS'), join(payload, assetName)], {
    encoding: 'utf8',
  })
  assert.equal(zipped.status, 0, zipped.stderr)
  const manifestSha = spawnSync('sha256sum', [join(payload, 'SHA256SUMS')], { encoding: 'utf8' })
    .stdout.split(/\s+/)[0]
  return { assetName, existing, manifestSha, zip }
}

function mockEnvironment({
  bin,
  log,
  scenario,
  artifactName = `release-candidate-payload-${candidateSha}`,
  existing = '',
  manifestSha = manifestDigest,
  zip = '',
}) {
  return {
    PATH: `${bin}:${process.env.PATH}`,
    GITHUB_REPOSITORY: 'example/tenon',
    MOCK_GH_LOG: log,
    MOCK_GH_SCENARIO: scenario,
    MOCK_CANDIDATE_SHA: candidateSha,
    MOCK_CONFLICTING_SHA: conflictingSha,
    MOCK_TAG_OBJECT_SHA: 'c'.repeat(40),
    MOCK_ARTIFACT_ID: '442',
    MOCK_ARTIFACT_NAME: artifactName,
    MOCK_ARTIFACT_DIGEST: artifactDigest,
    MOCK_SOURCE_RUN_ID: '991',
    MOCK_EXISTING_ASSETS: existing,
    MOCK_PAYLOAD_ZIP: zip,
    PAYLOAD_MANIFEST_SHA256: manifestSha,
  }
}

test('release candidate actions are immutable full-SHA pins', async () => {
  const candidate = await text('.github/workflows/release-candidate.yml')

  assert.match(candidate, /actions\/checkout@11d5960a326750d5838078e36cf38b85af677262/)
  assert.match(candidate, /actions\/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020/)
  assert.equal(
    candidate.match(/actions\/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02/g)?.length,
    2,
  )
  assert.doesNotMatch(candidate, /uses:\s+actions\/[^@\s]+@v\d+\b/)
})

test('canonical CI actions are immutable full-SHA pins', async () => {
  const ci = await text('.github/workflows/ci.yml')

  assert.match(ci, /actions\/checkout@11d5960a326750d5838078e36cf38b85af677262/)
  assert.match(ci, /actions\/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020/)
  assert.doesNotMatch(ci, /actions\/(?:checkout|setup-node)@v\d+\b/)
})

test('every clean-install workflow uses the pinned trusted Codex acceptance root', async () => {
  for (const path of [
    '.github/workflows/ci.yml',
    '.github/workflows/release-candidate.yml',
    '.github/workflows/release-public-acceptance.yml',
  ]) {
    const workflow = await text(path)
    assert.match(workflow, /tools\/prepare-trusted-codex-acceptance\.sh/)
    assert.doesNotMatch(workflow, /npm install --global @openai\/codex/)
  }
  const helper = await text('tools/prepare-trusted-codex-acceptance.sh')
  assert.match(helper, /@openai\/codex@0\.144\.1/)
  assert.match(helper, /cp "\$NODE_SOURCE" "\$TOOL_ROOT\/bin\/node"/)
})

test('trusted Codex acceptance helper materializes Node and the pinned CLI in one owner root', async (t) => {
  const directory = await fixtureDir(t)
  const bin = join(directory, 'bin')
  const target = join(directory, 'trusted-tools')
  await mkdir(bin)
  await writeExecutable(join(bin, 'node'), '#!/bin/sh\nexit 0\n')
  await writeExecutable(join(bin, 'npm'), `#!/bin/sh
set -eu
prefix=''
while [ "$#" -gt 0 ]; do
  if [ "$1" = --prefix ]; then prefix="$2"; shift 2; continue; fi
  [ "$1" != '@openai/codex@0.144.1' ] || seen=1
  shift
done
[ "${'$'}{seen:-0}" = 1 ]
mkdir -p "$prefix/node_modules/.bin"
printf '#!/bin/sh\\nexit 0\\n' > "$prefix/node_modules/.bin/codex"
chmod 0755 "$prefix/node_modules/.bin/codex"
`)

  const result = spawnSync(
    'bash',
    [join(root, 'tools', 'prepare-trusted-codex-acceptance.sh'), target],
    { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, encoding: 'utf8' },
  )
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout.trim(), join(target, 'bin'))
  assert.equal(await readFile(join(target, 'bin', 'node'), 'utf8'), '#!/bin/sh\nexit 0\n')
  assert.equal(await readFile(join(target, 'bin', 'codex'), 'utf8'), '#!/bin/sh\nexit 0\n')
})

test('release publication and public latest acceptance share one non-cancelling queue', async () => {
  const writer = await text('.github/workflows/release-writer.yml')
  const acceptance = await text('.github/workflows/release-public-acceptance.yml')
  const shared = 'group: stable-release-${{ github.event.repository.full_name }}'

  assert.match(writer, new RegExp(shared.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.match(acceptance, new RegExp(shared.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.match(writer, /concurrency:\s*\n\s+group:[^\n]+\n\s+cancel-in-progress: false/u)
  assert.match(acceptance, /concurrency:\s*\n\s+group:[^\n]+\n\s+cancel-in-progress: false/u)
})

test('canonical CI never exposes the real-Codex secret to pull-request code', async () => {
  const ci = await text('.github/workflows/ci.yml')
  const mainPush = "github.event_name == 'push' && github.ref == 'refs/heads/main'"
  const secretLines = ci.split('\n')
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => line.includes('OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}'))

  assert.equal(secretLines.length, 2)
  for (const { index } of secretLines) {
    const stepStart = ci.split('\n').slice(0, index + 1)
      .findLastIndex((line) => line.trim().startsWith('- name:'))
    const stepPrefix = ci.split('\n').slice(stepStart, index).join('\n')
    assert.match(stepPrefix, new RegExp(`if: ${mainPush.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))
  }
  assert.match(
    ci,
    /if: github\.event_name != 'push' \|\| github\.ref != 'refs\/heads\/main'\n\s+run: echo "\[HONEST SKIP\] 非 main push；真实 Codex H14 未接收仓库 secret，未执行且未声明通过。"/,
  )
})

test('candidate converts the upload action bare digest into the REST digest ABI', async (t) => {
  const candidate = await text('.github/workflows/release-candidate.yml')
  const script = workflowRunScript(candidate, 'Write approval evidence for the default-branch writer')
  const directory = await fixtureDir(t)
  await mkdir(join(directory, '.release-candidate', 'payload'), { recursive: true })
  await writeFile(join(directory, '.release-candidate', 'payload', 'SHA256SUMS'), 'manifest\n', 'utf8')

  const result = runBash(script, directory, {
    CANDIDATE_SHA: candidateSha,
    RELEASE_TAG: 'v1.0.1',
    RELEASE_VERSION: '1.0.1',
    SOURCE_RUN_ID: '991',
    SOURCE_WORKFLOW_ID: 'example/tenon/.github/workflows/release-candidate.yml@refs/heads/main',
    SOURCE_WORKFLOW_SHA: candidateSha,
    PAYLOAD_ARTIFACT_ID: '442',
    PAYLOAD_ARTIFACT_NAME: `release-candidate-payload-${candidateSha}`,
    PAYLOAD_ARTIFACT_DIGEST_HEX: artifactHex,
  })

  assert.equal(result.status, 0, result.stderr)
  const approval = JSON.parse(
    await readFile(join(directory, '.release-candidate', 'approved.json'), 'utf8'),
  )
  assert.equal(approval.payload_artifact_digest, artifactDigest)
})

test('candidate rejects prefixed, uppercase, or truncated upload action digests', async (t) => {
  const candidate = await text('.github/workflows/release-candidate.yml')
  const script = workflowRunScript(candidate, 'Write approval evidence for the default-branch writer')
  for (const invalidDigest of [artifactDigest, artifactHex.toUpperCase(), artifactHex.slice(1)]) {
    const directory = await fixtureDir(t)
    await mkdir(join(directory, '.release-candidate', 'payload'), { recursive: true })
    await writeFile(join(directory, '.release-candidate', 'payload', 'SHA256SUMS'), 'manifest\n', 'utf8')
    const result = runBash(script, directory, {
      CANDIDATE_SHA: candidateSha,
      RELEASE_TAG: 'v1.0.1',
      RELEASE_VERSION: '1.0.1',
      SOURCE_RUN_ID: '991',
      SOURCE_WORKFLOW_ID: 'example/tenon/.github/workflows/release-candidate.yml@refs/heads/main',
      SOURCE_WORKFLOW_SHA: candidateSha,
      PAYLOAD_ARTIFACT_ID: '442',
      PAYLOAD_ARTIFACT_NAME: `release-candidate-payload-${candidateSha}`,
      PAYLOAD_ARTIFACT_DIGEST_HEX: invalidDigest,
    })
    assert.notEqual(result.status, 0, `unexpectedly accepted digest: ${invalidDigest}`)
    assert.match(result.stderr, /invalid bare SHA-256 digest/)
  }
})

test('writer downloads approval evidence without relying on a checkout', async (t) => {
  const writer = await text('.github/workflows/release-writer.yml')
  const script = workflowRunScript(writer, 'Download approval evidence from the trusted upstream run')
  const directory = await fixtureDir(t)
  const bin = await installMockGh(directory)
  const log = join(directory, 'gh-calls.jsonl')
  const source = join(directory, 'approved-source.json')
  await writeFile(source, JSON.stringify(approvalEvidence()), 'utf8')

  const result = runBash(script, directory, {
    ...mockEnvironment({ bin, log, scenario: 'tag-fresh' }),
    MOCK_APPROVAL_SOURCE: source,
    UPSTREAM_RUN_ID: '991',
  })

  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(JSON.parse(await readFile(
    join(directory, '.release-candidate', 'approved.json'),
    'utf8',
  )), approvalEvidence())
  const calls = await readGhCalls(log)
  assert.ok(calls.some((args) =>
    args[0] === 'run'
      && args[1] === 'download'
      && args.includes('--repo')
      && args.includes('example/tenon'),
  ))
})

async function runWriterTagFixture(t, scenario) {
  const writer = await text('.github/workflows/release-writer.yml')
  const script = workflowRunScript(writer, 'Validate approval, artifact, and create or recover the approved tag')
  const directory = await fixtureDir(t)
  const bin = await installMockGh(directory)
  const log = join(directory, 'gh-calls.jsonl')
  const output = join(directory, 'github-output')
  await mkdir(join(directory, '.release-candidate'))
  await writeFile(
    join(directory, '.release-candidate', 'approved.json'),
    JSON.stringify(approvalEvidence()),
    'utf8',
  )
  await writeFile(output, '', 'utf8')
  const result = runBash(script, directory, {
    ...mockEnvironment({ bin, log, scenario }),
    UPSTREAM_RUN_ID: '991',
    UPSTREAM_HEAD_SHA: candidateSha,
    GITHUB_OUTPUT: output,
  })
  return { calls: await readGhCalls(log), output, result }
}

test('writer executable fixture creates a new annotated tag and ref', async (t) => {
  const { calls, output, result } = await runWriterTagFixture(t, 'tag-fresh')

  assert.equal(result.status, 0, result.stderr)
  assert.ok(calls.some((args) => args.includes('repos/example/tenon/git/tags') && args.includes('POST')))
  assert.ok(calls.some((args) => args.includes('repos/example/tenon/git/refs') && args.includes('POST')))
  assert.match(await readFile(output, 'utf8'), new RegExp(`sha=${candidateSha}`))
})

test('writer executable fixture recovers a matching existing tag without writing another ref', async (t) => {
  const { calls, result } = await runWriterTagFixture(t, 'tag-existing')

  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /tag already exists at approved commit; continuing release recovery/)
  assert.equal(calls.some((args) => args.includes('POST')), false)
})

test('writer executable fixture rejects an existing conflicting tag', async (t) => {
  const { calls, result } = await runWriterTagFixture(t, 'tag-conflict')

  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /existing tag points to a different commit/)
  assert.equal(calls.some((args) => args.includes('POST')), false)
})

async function runReleaseFixture(t, scenario) {
  const release = await text('.github/workflows/release.yml')
  const script = workflowRunScript(release, 'Verify approved payload and create or repair GitHub Release')
  const directory = await fixtureDir(t)
  const bin = await installMockGh(directory)
  const log = join(directory, 'gh-calls.jsonl')
  const runner = join(directory, 'runner')
  await mkdir(runner)
  const payload = await preparePayload(directory)
  const result = runBash(script, directory, {
    ...mockEnvironment({
      bin,
      log,
      scenario,
      existing: payload.existing,
      manifestSha: payload.manifestSha,
      zip: payload.zip,
    }),
    EXPECTED_SHA: candidateSha,
    RELEASE_TAG: 'v1.0.1',
    RELEASE_VERSION: '1.0.1',
    SOURCE_RUN_ID: '991',
    PAYLOAD_ARTIFACT_ID: '442',
    PAYLOAD_ARTIFACT_NAME: `release-candidate-payload-${candidateSha}`,
    PAYLOAD_ARTIFACT_DIGEST: artifactDigest,
    RUNNER_TEMP: runner,
  })
  return { calls: await readGhCalls(log), payload, result }
}

test('release executable fixture creates a first release and uploads the approved closed asset set', async (t) => {
  const { calls, result } = await runReleaseFixture(t, 'release-fresh')

  assert.equal(result.status, 0, result.stderr)
  assert.ok(
    calls.some((args) => args[0] === 'release' && args[1] === 'create'),
    JSON.stringify({ calls, result }),
  )
  assert.equal(calls.filter((args) => args[0] === 'release' && args[1] === 'upload').length, 2)
})

test('release executable fixture verifies existing assets and fills only missing assets', async (t) => {
  const { calls, payload, result } = await runReleaseFixture(t, 'partial')

  assert.equal(result.status, 0, result.stderr)
  assert.equal(calls.some((args) => args[0] === 'release' && args[1] === 'create'), false)
  assert.ok(
    calls.some((args) =>
      args[0] === 'release' && args[1] === 'download' && args.includes('SHA256SUMS'),
    ),
    JSON.stringify({ calls, result }),
  )
  const uploads = calls.filter((args) => args[0] === 'release' && args[1] === 'upload')
  assert.equal(uploads.length, 1)
  assert.ok(uploads[0].some((arg) => arg.endsWith(payload.assetName)))
})

test('release publishing is callable only from the default-branch writer workflow', async () => {
  const [candidate, writer, release] = await Promise.all([
    text('.github/workflows/release-candidate.yml'),
    text('.github/workflows/release-writer.yml'),
    text('.github/workflows/release.yml'),
  ])

  assert.match(candidate, /^\s{2}workflow_dispatch:\s*$/m)
  assert.doesNotMatch(candidate, /uses: \.\/\.github\/workflows\/release\.yml/)
  assert.match(writer, /^\s{2}workflow_run:\s*$/m)
  assert.match(writer, /uses: \.\/\.github\/workflows\/release\.yml/)
  assert.match(release, /^\s{2}workflow_call:\s*$/m)
  assert.doesNotMatch(release, /^\s{2}(push|workflow_dispatch):\s*$/m)
})

test('manual dispatch stays read-only and only a default-branch workflow_run can reach release writers', async () => {
  const [candidate, writer] = await Promise.all([
    text('.github/workflows/release-candidate.yml'),
    text('.github/workflows/release-writer.yml'),
  ])

  assert.match(candidate, /^\s{2}workflow_dispatch:\s*$/m)
  assert.doesNotMatch(candidate, /contents: write/)
  assert.doesNotMatch(candidate, /repos\/\$GITHUB_REPOSITORY\/git\/(?:tags|refs)/)
  assert.doesNotMatch(candidate, /uses: \.\/\.github\/workflows\/release\.yml/)

  assert.match(writer, /^\s{2}workflow_run:\s*$/m)
  assert.match(writer, /workflows: \[Release candidate \(pre-tag\)\]/)
  assert.match(writer, /types: \[completed\]/)
  assert.match(writer, /github\.ref == 'refs\/heads\/main'/)
  assert.match(writer, /github\.event\.repository\.default_branch == 'main'/)
  assert.match(writer, /github\.event\.workflow_run\.head_branch == 'main'/)
  assert.match(writer, /github\.event\.workflow_run\.event == 'workflow_dispatch'/)
  assert.match(writer, /github\.event\.workflow_run\.conclusion == 'success'/)
  assert.match(
    writer,
    /\.github\/workflows\/release-candidate\.yml@refs\/heads\/main/,
  )
  assert.match(
    writer,
    /WRITER_WORKFLOW_REF.*\n[\s\S]*release-writer\.yml@refs\/heads\/main/,
  )
  assert.match(writer, /\[ "\$WRITER_WORKFLOW_SHA" = "\$WRITER_SHA" \]/)
  assert.match(writer, /\[ "\$UPSTREAM_REPOSITORY_ID" = "\$CURRENT_REPOSITORY_ID" \]/)
  assert.match(writer, /\[ "\$UPSTREAM_HEAD_REPOSITORY_ID" = "\$CURRENT_REPOSITORY_ID" \]/)
  assert.match(writer, /repos\/\$GITHUB_REPOSITORY\/actions\/workflows\/release-candidate\.yml/)
  assert.match(writer, /\[ "\$UPSTREAM_WORKFLOW_ID" = "\$canonical_workflow_id" \]/)
  assert.match(writer, /gh run download "\$UPSTREAM_RUN_ID"/)
  assert.match(writer, /\[ "\$SOURCE_RUN_ID" = "\$UPSTREAM_RUN_ID" \]/)
  assert.match(writer, /\[ "\$SOURCE_WORKFLOW_SHA" = "\$UPSTREAM_HEAD_SHA" \]/)
  assert.match(writer, /contents: write/)
  assert.match(writer, /repos\/\$GITHUB_REPOSITORY\/git\/tags/)
  assert.match(writer, /repos\/\$GITHUB_REPOSITORY\/git\/refs/)
  assert.match(writer, /uses: \.\/\.github\/workflows\/release\.yml/)
})

test('every release stage accepts only a complete stable v-prefixed SemVer tag', async () => {
  const workflows = await Promise.all([
    text('.github/workflows/release-candidate.yml'),
    text('.github/workflows/release-writer.yml'),
    text('.github/workflows/release.yml'),
  ])
  const strictStableSemver =
    '[[ "$RELEASE_TAG" =~ ^v(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)$ ]]'

  for (const workflow of workflows) {
    assert.ok(workflow.includes(strictStableSemver))
    assert.doesNotMatch(workflow, /v\[0-9\]\*\.\[0-9\]\*\.\[0-9\]\*/)
  }
})

test('candidate proves exact main before and after all gates, then publishes bounded approval evidence', async () => {
  const candidate = await text('.github/workflows/release-candidate.yml')
  const firstIdentity = candidate.indexOf('Prove exact current main candidate and compatible tag')
  const fullTests = candidate.indexOf('Full runtime, Dashboard, hook, adapter, migration, and oracle verification')
  const secondIdentity = candidate.indexOf('Re-prove main identity immediately before approval')
  const ciProof = candidate.indexOf('Prove canonical CI passed for exact candidate SHA')
  const approval = candidate.indexOf('Write approval evidence for the default-branch writer')

  assert.ok(firstIdentity >= 0)
  assert.ok(fullTests > firstIdentity)
  assert.ok(secondIdentity > fullTests)
  assert.ok(ciProof > secondIdentity)
  assert.ok(approval > ciProof)
  assert.match(candidate, /\[ "\$\(git rev-parse origin\/main\)" = "\$CANDIDATE_SHA" \]/)
  assert.match(candidate, /name: release-candidate-approval/)
  assert.match(candidate, /source_workflow_sha: \$source_workflow_sha/)
  assert.doesNotMatch(candidate, /gh api --method POST/)
})

test('CI and the read-only candidate share advisory and full dependency-tree gates', async () => {
  const [packageJson, ci, candidate] = await Promise.all([
    text('package.json'),
    text('.github/workflows/ci.yml'),
    text('.github/workflows/release-candidate.yml'),
  ])
  const scripts = JSON.parse(packageJson).scripts

  assert.equal(scripts['check:dependency-tree'], 'npm ls --all')
  assert.equal(
    scripts['check:dependencies'],
    'npm audit --audit-level=high && npm run check:dependency-tree',
  )
  for (const workflow of [ci, candidate]) {
    assert.match(workflow, /npm run check:dependencies/)
    assert.match(workflow, /npm run check:release-workflows/)
    assert.match(workflow, /npm run check:openspec/)
  }
})

test('OpenSpec validation is lockfile-pinned and strict in canonical CI and release candidate', async () => {
  const [packageJson, packageLock, ci, candidate] = await Promise.all([
    text('package.json'),
    text('package-lock.json'),
    text('.github/workflows/ci.yml'),
    text('.github/workflows/release-candidate.yml'),
  ])
  const manifest = JSON.parse(packageJson)
  const lock = JSON.parse(packageLock)

  assert.equal(manifest.devDependencies['@fission-ai/openspec'], '1.6.0')
  assert.equal(lock.packages['node_modules/@fission-ai/openspec'].version, '1.6.0')
  assert.equal(
    manifest.scripts['check:openspec'],
    'node --test tools/check-openspec.node-test.mjs && node tools/check-openspec.mjs',
  )
  for (const workflow of [ci, candidate]) {
    assert.match(workflow, /name: OpenSpec strict governance validation/)
    assert.match(workflow, /run: npm run check:openspec/)
  }
})

test('untrusted candidate verification is read-only and tag creation is a minimal isolated writer', async () => {
  const [candidate, writer] = await Promise.all([
    text('.github/workflows/release-candidate.yml'),
    text('.github/workflows/release-writer.yml'),
  ])
  const preTagStart = candidate.indexOf('\n  pre-tag:')
  const createTagStart = writer.indexOf('\n  create-tag:')
  const releaseStart = writer.indexOf('\n  release:')

  assert.ok(preTagStart >= 0)
  assert.ok(createTagStart >= 0)
  assert.ok(releaseStart > createTagStart)

  const preTag = candidate.slice(preTagStart)
  const createTag = writer.slice(createTagStart, releaseStart)
  assert.match(preTag, /permissions:\s*\n\s+contents: read\s*\n\s+actions: read/)
  assert.match(preTag, /persist-credentials: false/)
  assert.doesNotMatch(preTag, /contents: write/)

  assert.match(createTag, /permissions:\s*\n\s+contents: write/)
  assert.doesNotMatch(createTag, /actions\/checkout|npm (?:ci|run|test)|node packages\//)
  assert.match(createTag, /actions\/workflows\/release-candidate\.yml/)
  assert.match(createTag, /repos\/\$GITHUB_REPOSITORY\/git\/tags/)
  assert.match(createTag, /repos\/\$GITHUB_REPOSITORY\/git\/refs/)
})

test('candidate fails closed unless canonical push CI succeeded for the exact approved SHA', async () => {
  const candidate = await text('.github/workflows/release-candidate.yml')
  const ciProof = candidate.indexOf('Prove canonical CI passed for exact candidate SHA')
  const approval = candidate.indexOf('Write approval evidence for the default-branch writer')

  assert.ok(ciProof >= 0)
  assert.ok(approval > ciProof)
  assert.match(candidate, /actions\/workflows\/ci\.yml\/runs\?head_sha=\$CANDIDATE_SHA/)
  assert.match(candidate, /event=push/)
  assert.match(candidate, /status=completed/)
  assert.match(candidate, /conclusion == "success"/)
  assert.match(candidate, /grep -Fqx -- "\$CANDIDATE_SHA"/)
})

test('candidate packages a digest-bound payload before publishing approval evidence', async () => {
  const candidate = await text('.github/workflows/release-candidate.yml')
  const packagePayload = candidate.indexOf('Package the verified release payload')
  const uploadPayload = candidate.indexOf('Upload the digest-bound release payload')
  const approval = candidate.indexOf('Write approval evidence for the default-branch writer')

  assert.ok(packagePayload >= 0)
  assert.ok(uploadPayload > packagePayload)
  assert.ok(approval > uploadPayload)
  assert.match(candidate, /npm run build:legacy-bridge/)
  assert.match(candidate, /npm pack \.release\/npx-package/)
  assert.match(candidate, /SHA256SUMS/)
  assert.match(candidate, /id: payload/)
  assert.match(candidate, /payload_artifact_id: \$payload_artifact_id/)
  assert.match(candidate, /payload_artifact_digest: \$payload_artifact_digest/)
  assert.match(candidate, /payload_manifest_sha256: \$payload_manifest_sha256/)
  assert.match(candidate, /steps\.payload\.outputs\.artifact-id/)
  assert.match(candidate, /steps\.payload\.outputs\.artifact-digest/)
  assert.doesNotMatch(candidate, /\$\{\{\s*secrets\./)
  assert.doesNotMatch(candidate, /npm publish/)
})

test('privileged workflows never checkout or execute candidate code and inherit no secrets', async () => {
  const [writer, release] = await Promise.all([
    text('.github/workflows/release-writer.yml'),
    text('.github/workflows/release.yml'),
  ])

  assert.match(writer, /expected_sha: \$\{\{ needs\.create-tag\.outputs\.sha \}\}/)
  const releaseCall = writer.slice(writer.indexOf('\n  release:'))
  assert.match(releaseCall, /permissions:\s*\n\s+contents: write\s*\n\s+actions: read/)
  assert.doesNotMatch(writer, /secrets: inherit/)
  assert.doesNotMatch(writer, /\$\{\{\s*secrets\./)
  assert.doesNotMatch(release, /\$\{\{\s*secrets\./)
  assert.doesNotMatch(release, /actions\/checkout|actions\/setup-node/)
  assert.doesNotMatch(release, /npm (?:ci|run|test|publish|pack)|node (?:tools|packages)\//)
  assert.doesNotMatch(writer, /actions\/checkout|actions\/setup-node/)
  assert.doesNotMatch(writer, /npm (?:ci|run|test|publish|pack)|node (?:tools|packages)\//)
  assert.match(release, /expected_sha:\s*\n\s+description: Approved candidate commit SHA/)
  assert.match(release, /EXPECTED_SHA: \$\{\{ inputs\.expected_sha \}\}/)
  assert.match(release, /contents: write/)
  assert.match(release, /actions: read/)
})

test('writer accepts an existing tag only when its peeled commit is the approved SHA', async () => {
  const writer = await text('.github/workflows/release-writer.yml')

  assert.match(writer, /resolve_tag_commit/)
  assert.match(writer, /existing_commit="\$\(resolve_tag_commit/)
  assert.match(writer, /\[ "\$existing_commit" = "\$CANDIDATE_SHA" \]/)
  assert.match(writer, /existing tag points to a different commit/)
  assert.match(writer, /main advanced before tag creation/)
  assert.match(writer, /tag already exists at approved commit; continuing/)
})

test('privileged release verifies the exact artifact and recovers an existing release', async () => {
  const [writer, release] = await Promise.all([
    text('.github/workflows/release-writer.yml'),
    text('.github/workflows/release.yml'),
  ])

  assert.match(writer, /payload_artifact_id/)
  assert.match(writer, /payload_artifact_digest/)
  assert.match(writer, /payload_manifest_sha256/)
  assert.match(release, /actions\/artifacts\/\$PAYLOAD_ARTIFACT_ID/)
  assert.match(release, /\[ "\$artifact_digest" = "\$PAYLOAD_ARTIFACT_DIGEST" \]/)
  assert.match(release, /SHA256SUMS/)
  assert.match(release, /sha256sum --check --strict/)
  assert.match(release, /resolve_tag_commit/)
  assert.match(release, /\[ "\$tag_commit" = "\$EXPECTED_SHA" \]/)
  assert.match(release, /gh release view "\$RELEASE_TAG"/)
  assert.match(release, /gh release download "\$RELEASE_TAG"/)
  assert.match(release, /existing release asset digest mismatch/)
  assert.match(release, /gh release upload "\$RELEASE_TAG"/)
  assert.match(release, /gh release create "\$RELEASE_TAG"/)
})

test('release automation never publishes to npm', async () => {
  const workflows = await Promise.all([
    text('.github/workflows/release-candidate.yml'),
    text('.github/workflows/release-writer.yml'),
    text('.github/workflows/release.yml'),
  ])

  for (const workflow of workflows) {
    assert.doesNotMatch(workflow, /npm publish/)
    assert.doesNotMatch(workflow, /NPM_TOKEN|NODE_AUTH_TOKEN/)
  }
})

test('published stable releases trigger an isolated public install, repeat, update and Dashboard acceptance', async () => {
  const workflow = await text('.github/workflows/release-public-acceptance.yml')
  const writer = await text('.github/workflows/release-writer.yml')
  assert.match(workflow, /release:\s*\n\s+types: \[published\]/)
  assert.match(workflow, /workflow_dispatch:\s*\n\s+inputs:\s*\n\s+tag:/)
  assert.match(
    workflow,
    /gh release view "\$RELEASE_TAG"[\s\\]+--repo "\$GITHUB_REPOSITORY"/,
  )
  assert.match(workflow, /\[ "\$RELEASE_DRAFT" = false \]/)
  assert.match(workflow, /\[ "\$RELEASE_PRERELEASE" = false \]/)
  assert.match(workflow, /\[ "\$RELEASE_TARGET" = main \]/)
  assert.match(workflow, /\.github\/workflows\/release-public-acceptance\.yml@refs\/heads\/main/)
  assert.match(workflow, /persist-credentials: false/)
  assert.match(
    workflow,
    /clean-codex-install-acceptance\.mjs --mode public --public-ref "\$RELEASE_TAG"/,
  )
  assert.doesNotMatch(workflow, /contents: write|\$\{\{\s*secrets\./)

  assert.match(writer, /dispatch-public-acceptance:/)
  assert.match(writer, /needs: \[create-tag, release\]/)
  assert.match(writer, /actions: write/)
  assert.match(writer, /gh workflow run release-public-acceptance\.yml/)
  assert.match(writer, /--ref main/)
  assert.match(writer, /-f tag="\$RELEASE_TAG"/)
})

test('CI and release candidate accept only the documented N-1 skip exit and never hard-code the pinned release', async () => {
  const [ci, candidate, fixture] = await Promise.all([
    text('.github/workflows/ci.yml'),
    text('.github/workflows/release-candidate.yml'),
    text('tools/fixtures/n-minus-one-release.json'),
  ])
  const meta = JSON.parse(fixture)
  assert.equal(meta.schemaVersion, 3)
  assert.ok(['none', 'pinned'].includes(meta.status))
  for (const script of [
    workflowRunScript(ci, '准备真实 N-1 已发布 bundle'),
    workflowRunScript(candidate, 'Build complete release payload and prove committed freshness'),
  ]) {
    assert.match(script, /if bash tools\/prepare-n-minus-one-release\.sh "\$[a-z_]+"; then/)
    assert.match(script, /code=\$\?\n\s*\[ "\$code" -eq 78 \] \|\| exit "\$code"/)
    assert.doesNotMatch(script, /v1\.0\.1/)
  }
})

const N_MINUS_ONE_ENTRIES = ['.claude-plugin/plugin.json', '.codex-plugin/plugin.json', 'packages/cli/dist/tenon.mjs']

function fixtureGit(cwd, ...args) {
  const result = spawnSync('git', [
    '-c', 'user.name=Tenon Test',
    '-c', 'user.email=test@example.invalid',
    '-c', 'commit.gpgsign=false',
    '-c', 'tag.gpgsign=false',
    '-c', 'core.hooksPath=/dev/null',
    ...args,
  ], { cwd, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.trim()
}

async function nMinusOneReleaseRoot(t, versions) {
  const directory = await fixtureDir(t)
  await mkdir(join(directory, 'tools', 'fixtures'), { recursive: true })
  await cp(
    join(root, 'tools/prepare-n-minus-one-release.sh'),
    join(directory, 'tools/prepare-n-minus-one-release.sh'),
  )
  fixtureGit(directory, 'init', '-q')
  const releases = {}
  for (const version of versions) {
    const cli = `// tenon ${version}\n`
    for (const manifestDir of ['.claude-plugin', '.codex-plugin']) {
      await mkdir(join(directory, manifestDir), { recursive: true })
      await writeFile(join(directory, manifestDir, 'plugin.json'), JSON.stringify({ version }))
    }
    await mkdir(join(directory, 'packages/cli/dist'), { recursive: true })
    await writeFile(join(directory, 'packages/cli/dist/tenon.mjs'), cli)
    fixtureGit(directory, 'add', ...N_MINUS_ONE_ENTRIES)
    fixtureGit(directory, 'commit', '-q', '-m', `release ${version}`)
    fixtureGit(directory, 'tag', `v${version}`)
    releases[version] = {
      gitCommit: fixtureGit(directory, 'rev-parse', 'HEAD'),
      cliSha256: createHash('sha256').update(cli).digest('hex'),
    }
  }
  let runs = 0
  const run = async (current, fixture) => {
    await writeFile(join(directory, 'package.json'), JSON.stringify({ version: current }))
    await writeFile(join(directory, 'tools/fixtures/n-minus-one-release.json'), JSON.stringify(fixture))
    runs += 1
    const result = spawnSync(
      'bash',
      [join(directory, 'tools/prepare-n-minus-one-release.sh'), join(directory, `out-${runs}`)],
      { encoding: 'utf8' },
    )
    return { status: result.status, output: `${result.stdout}${result.stderr}` }
  }
  const pinned = (version, overrides = {}) => ({
    schemaVersion: 3,
    status: 'pinned',
    tag: `v${version}`,
    pluginVersion: version,
    gitCommit: releases[version].gitCommit,
    cliEntry: 'packages/cli/dist/tenon.mjs',
    cliSha256: releases[version].cliSha256,
    payloadEntries: N_MINUS_ONE_ENTRIES,
    ...overrides,
  })
  return { run, pinned, releases }
}

async function assertPrepare(run, current, fixture, status, message) {
  const result = await run(current, fixture)
  assert.equal(result.status, status, result.output)
  assert.ok(result.output.includes(message), result.output)
}

test('N-1 prepare accepts only fixture schema 3 and skips exactly once for the release it names', async (t) => {
  const { run, pinned } = await nMinusOneReleaseRoot(t, ['0.1.0'])
  const none = {
    schemaVersion: 3,
    status: 'none',
    release: 'v0.1.0',
    reason: 'first release after the version reset; no earlier 0.x release exists',
  }

  await assertPrepare(run, '0.1.1', { ...pinned('0.1.0'), schemaVersion: 2 }, 1, 'N-1 fixture 结构非法')
  await assertPrepare(run, '0.1.0', { ...none, status: 'skipped' }, 1, 'N-1 fixture 结构非法')
  await assertPrepare(run, '0.1.0', { ...none, reason: '' }, 1, 'N-1 fixture 结构非法')
  await assertPrepare(
    run,
    '0.1.0',
    none,
    78,
    'N-1 skipped: v0.1.0 first release after the version reset; no earlier 0.x release exists',
  )
  await assertPrepare(run, '0.1.1', none, 1, 'N-1 一次性跳过只适用于 v0.1.0；当前 v0.1.1 必须固定最近的正式版本')
})

test('N-1 prepare pins the latest non-retired stable release once the current version leaves the retired line', async (t) => {
  const { run, pinned, releases } = await nMinusOneReleaseRoot(t, ['1.0.1', '1.0.9', '0.1.0', '0.1.1', '1.1.5'])

  await assertPrepare(run, '1.1.5', pinned('1.0.1'), 0, 'N-1 release ready: v1.0.1 plugin@1.0.1')
  await assertPrepare(run, '0.1.1', pinned('1.0.1'), 1, 'N-1 基线不能是已退役版本 v1.0.1')
  await assertPrepare(run, '0.1.1', pinned('0.1.0'), 0, 'N-1 release ready: v0.1.0 plugin@0.1.0')
  await assertPrepare(run, '0.2.0', pinned('0.1.0'), 1, 'N-1 基线 v0.1.0 不是低于 v0.2.0 的最近正式版本 v0.1.1')
  await assertPrepare(run, '0.2.0', pinned('0.1.1'), 0, 'N-1 release ready: v0.1.1 plugin@0.1.1')
  await assertPrepare(run, '1.2.0', pinned('0.1.1'), 0, 'N-1 release ready: v0.1.1 plugin@0.1.1')
  await assertPrepare(
    run,
    '0.2.0',
    pinned('0.1.1', { gitCommit: releases['0.1.0'].gitCommit }),
    1,
    'N-1 tag 未绑定固定 commit',
  )
  await assertPrepare(
    run,
    '0.2.0',
    pinned('0.1.1', { tag: 'v0.1.5', pluginVersion: '0.1.5' }),
    1,
    'N-1 tag 未绑定固定 commit',
  )
  await assertPrepare(run, '0.2.0', pinned('0.1.1', { cliSha256: '0'.repeat(64) }), 1, 'N-1 CLI 摘要不匹配')
})
