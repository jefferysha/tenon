#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, readFile, writeFile, appendFile, readdir, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

function runCodex(args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn('codex', args, { ...options, stdio: ['pipe', 'pipe', 'pipe'] })
    const stdout = []; const stderr = []
    child.stdout.on('data', (chunk) => stdout.push(Buffer.from(chunk)))
    child.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)))
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(Object.assign(new Error('codex child timed out'), { stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString() })) }, options.timeout ?? 15 * 60 * 1000)
    child.once('error', (error) => { clearTimeout(timer); reject(Object.assign(error, { stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString() })) })
    child.once('close', (code, signal) => { clearTimeout(timer); const out = Buffer.concat(stdout).toString(); const err = Buffer.concat(stderr).toString(); if (code === 0) resolve({ stdout: out, stderr: err }); else reject(Object.assign(new Error(`codex exited with code ${code ?? 'null'}${signal ? ` (${signal})` : ''}`), { stdout: out, stderr: err, code, signal })) })
    child.stdin.end()
  })
}
function runLocal(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: ['pipe', 'pipe', 'pipe'] })
    const stdout = []; const stderr = []
    child.stdout.on('data', (chunk) => stdout.push(Buffer.from(chunk)))
    child.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)))
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(Object.assign(new Error(`${command} timed out`), { stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString() })) }, options.timeout ?? 120000)
    child.once('error', (error) => { clearTimeout(timer); reject(Object.assign(error, { stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString() })) })
    child.once('close', (code, signal) => { clearTimeout(timer); const out = Buffer.concat(stdout).toString(); const err = Buffer.concat(stderr).toString(); resolve({ code, signal, stdout: out, stderr: err }) })
    child.stdin.end()
  })
}
const here = path.dirname(new URL(import.meta.url).pathname)
let repo = process.cwd()
while (repo !== path.dirname(repo) && !existsSync(path.join(repo, 'packages/automation/dist/index.js'))) repo = path.dirname(repo)
const { createAutonomousOrchestratorV2 } = await import(path.join(repo, 'packages/automation/dist/index.js'))
const { openArtifactService } = await import(path.join(repo, 'packages/automation/dist/index.js'))

const args = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, xs) => { if (x.startsWith('--')) a.push([x.slice(2), xs[i + 1] ?? true]); return a }, []))
if (!args.project || !args.evidence) {
  console.error('usage: live-driver.mjs --project <dir> --evidence <dir> [--plan-only]')
  process.exit(2)
}
const project = path.resolve(String(args.project)); const evidence = path.resolve(String(args.evidence)); const changeDir = path.join(project, 'openspec/changes/tasks-service')
await mkdir(evidence, { recursive: true }); await mkdir(changeDir, { recursive: true })
const scenario = JSON.parse(await readFile(path.join(changeDir, 'scenario.json'), 'utf8'))
const stages = scenario.stages ?? []
if (!Array.isArray(stages) || stages.length < 2) throw new Error('scenario must define at least two stages')
const startIndex = Math.max(0, Math.min(stages.length - 1, Number(args.from ?? 0)))
const log = path.join(evidence, 'live-driver.log'); const outcomePath = path.join(evidence, 'live-driver-outcome.json')
const now = () => new Date().toISOString(); const sha = (v) => `sha256:${crypto.createHash('sha256').update(v).digest('hex')}`
const record = async (v) => appendFile(log, `${JSON.stringify({ at: now(), ...v })}\n`)
const schemaPath = path.join(evidence, 'skill-output.schema.json')
await writeFile(schemaPath, JSON.stringify({ type: 'object', additionalProperties: false, required: ['summary', 'outputs', 'consumed', 'status'], properties: { summary: { type: 'string' }, outputs: { type: 'array', items: { type: 'string', minLength: 1 } }, consumed: { type: 'array', items: { type: 'string' } }, status: { enum: ['completed', 'blocked'] } } }, 2))

// The planner V2 wire enum represents project-installed skills as user-owned
// descriptors.  The source path remains recorded in the scenario/skill files;
// using `project` here would be rejected before planning because it is not a
// valid planner source enum.
const descriptors = stages.map((s, i) => ({ id: String(s.skill_id ?? s.id), version: String(s.version ?? '1.0.0'), source: 'user', availability: 'available', capabilities: [String(s.capability ?? `backend.${s.id}`)], supports_parallel: false, permissions: ['repo.read', 'repo.write'], resource_claims: [{ kind: 'path', key: '.', access: 'write' }], output_schema_id: 'workflow/skill-output-v1', output_media_types: ['application/json', 'text/markdown'], validators: ['child-validator'], depends_on: i ? [String(stages[i - 1].skill_id ?? stages[i - 1].id)] : [] }))
const catalog = { skills: descriptors, mcps: [], allowed_permissions: ['repo.read', 'repo.write'] }
if (args['plan-only']) { await writeFile(path.join(evidence, 'plan.json'), JSON.stringify({ stages: stages.map((s, i) => ({ id: s.id, skill_id: descriptors[i].id, depends_on: s.depends_on ?? (i ? [stages[i - 1].id] : []) })), catalog }, null, 2)); console.log(`plan written: ${path.join(evidence, 'plan.json')}`); process.exit(0) }

// Exercise the same public durable orchestrator used by production callers. The
// scenario driver below supplies the provider adapter (real codex children),
// while this probe records a real planner/runtime snapshot before execution.
const probeRoot = path.join(evidence, '.orchestrator-probe'); await mkdir(probeRoot, { recursive: true })
const probeNow = now(); const probeProjectId = 'live-project'; const probeDescriptor = { id: 'probe-api', version: '1.0.0', source: 'user', availability: 'available', capabilities: ['backend.api'], supports_parallel: false, permissions: ['repo.read', 'repo.write'], resource_claims: [], output_schema_id: 'workflow/skill-output-v1', output_media_types: ['application/json'], validators: ['probe-validator'], depends_on: [] }
const probeRequest = { schema_version: 'development-request/v2', record_id: 'probe-request', project_id: probeProjectId, change_id: 'orchestrator-probe', revision: 0, correlation_id: 'probe-correlation', actor: { kind: 'user', id: 'live-driver' }, created_at: probeNow, request_id: 'probe-request', intent: 'backend api probe', interaction_policy: 'recommended-defaults', requested_effects: ['read', 'write'], constraints: [], user_skills: [{ id: 'probe-api', version: '1.0.0', mode: 'serial', depends_on: [] }], user_mcps: [], auto_select: false }
const probeContext = { schema_version: 'repository-context/v2', record_id: 'probe-context', project_id: probeProjectId, change_id: 'orchestrator-probe', revision: 0, correlation_id: 'probe-correlation', actor: { kind: 'system', id: 'live-driver' }, created_at: probeNow, request_id: 'probe-request', repository: { ref: project, branch: 'live-e2e', base_branch: 'live-e2e', head_sha: 'workspace', dirty: true }, workspace_fingerprint: sha(project), policy_digest: sha('live-policy'), skill_catalog_digest: sha(JSON.stringify({ skills: [probeDescriptor] })), mcp_catalog_digest: sha(''), observed_facts: [] }
const probe = createAutonomousOrchestratorV2({ change_dir: probeRoot, request: probeRequest, context: probeContext, catalog: { skills: [probeDescriptor], mcps: [], allowed_permissions: ['repo.read', 'repo.write'] }, worker_id: 'live-driver-probe', clock: () => now(), executor: { async execute() { return { output: { summary: 'orchestrator probe', outputs: [], consumed: [], status: 'completed' }, artifacts: [], diagnostics: [] } } }, validator: { async validate() { return { status: 'pass', checks: [{ id: 'probe', status: 'pass' }], target_digests: [], evidence_refs: ['orchestrator-probe'] } } }, retry: { max_attempts: 1, max_parallel: 1 } })
let probeOutcome; try { probeOutcome = await probe.run() } catch (error) { probeOutcome = { ok: false, stage: 'probe', issues: [error instanceof Error ? error.message : String(error)] } }
await writeFile(path.join(evidence, 'orchestrator-probe.json'), JSON.stringify(probeOutcome, null, 2))

const service = await openArtifactService({ rootDir: changeDir, scopeId: 'live-workflow' })
const results = []; const started = now()
for (let i = startIndex; i < stages.length; i++) {
  const stage = stages[i]; const skillId = descriptors[i].id; const stageId = String(stage.id); const stageEvidence = path.join(evidence, `${String(i + 1).padStart(2, '0')}-${stageId}`); await mkdir(stageEvidence, { recursive: true })
  const skillText = stage.skill_path ? await readFile(path.resolve(String(stage.skill_path)), 'utf8').catch(() => '') : ''
  const prior = i ? await service.events() : []
  const priorRefs = prior.filter(e => e.type === 'artifact.published' && e.version && e.artifactId).slice(-20).map(e => `${e.artifactId}@${e.version}`)
  const requestId = `request:${stageId}:${crypto.randomUUID()}`; const correlation = `corr:${crypto.randomUUID()}`; const timestamp = now()
  const request = { schema_version: 'development-request/v2', record_id: `record:${requestId}`, project_id: project, change_id: 'tasks-service', revision: 0, correlation_id: correlation, actor: { kind: 'user', id: 'live-driver' }, created_at: timestamp, request_id: requestId, intent: String(stage.goal ?? `Complete ${stageId}`), interaction_policy: 'recommended-defaults', requested_effects: ['read', 'write'], constraints: [], user_skills: [{ id: skillId, version: descriptors[i].version, mode: 'serial', depends_on: i ? [descriptors[i - 1].id] : [] }], user_mcps: [], auto_select: false }
  const context = { schema_version: 'repository-context/v2', record_id: `context:${requestId}`, project_id: project, change_id: 'tasks-service', revision: 0, correlation_id: correlation, actor: { kind: 'system', id: 'live-driver' }, created_at: timestamp, request_id: requestId, repository: { ref: project, branch: 'live-e2e', base_branch: 'live-e2e', head_sha: 'workspace', dirty: true }, workspace_fingerprint: sha(project), policy_digest: sha('live-policy'), skill_catalog_digest: sha(JSON.stringify(catalog)), mcp_catalog_digest: sha(''), observed_facts: [] }
  const childPrompt = `You are executing stage ${stageId} of a real backend workflow.\nGoal: ${stage.goal ?? stageId}\nScoped change directory: ${changeDir}\nRead and follow this skill instruction:\n${skillText}\nUpstream artifact references (read them from the filesystem or inspect as useful): ${JSON.stringify(priorRefs)}\nPerform the work now. Write all durable outputs inside the scoped change directory. Do not claim files you did not create. End with exactly one JSON object matching the supplied output schema: {"summary": string, "outputs": string[], "consumed": string[], "status": "completed"|"blocked"}.`
  await writeFile(path.join(stageEvidence, 'prompt.txt'), childPrompt)
  await record({ type: 'stage-start', stage: stageId, skill: skillId, dependencies: stage.depends_on ?? [], priorRefs })
  const attemptId = `live:${stageId}:${crypto.randomUUID()}`
  const runtime = await import(path.join(repo, 'packages/automation/dist/index.js')).then(m => m.StageArtifactRuntime.open({ service, rootDir: changeDir, workflowRunId: 'live-workflow', stageId, stageAttemptId: attemptId, dependencyStages: i ? [String(stages[i - 1].id)] : [] }))
  let child; let parsed; let childError
  try {
    // Close stdin explicitly.  `codex exec` appends piped stdin when it is
    // open, even when a prompt argument is present; an inherited pipe would
    // therefore leave every child waiting forever after its model response.
    child = await runCodex(['exec', '--ignore-user-config', '--ephemeral', '--json', '--output-schema', schemaPath, '-C', changeDir, '--skip-git-repo-check', '--sandbox', 'workspace-write', '-c', 'approval_policy="never"', childPrompt], { cwd: project, timeout: 15 * 60 * 1000 })
    await writeFile(path.join(stageEvidence, 'codex.stdout.jsonl'), child.stdout); await writeFile(path.join(stageEvidence, 'codex.stderr.log'), child.stderr)
    const lines = child.stdout.trim().split(/\r?\n/).reverse(); for (const line of lines) { try { const v = JSON.parse(line); if (v.type === 'item.completed' && v.item?.type === 'agent_message') { parsed = JSON.parse(v.item.text); break } if (v.type === 'message' && typeof v.message === 'string') parsed = JSON.parse(v.message) } catch {} }
  } catch (e) { childError = e; await writeFile(path.join(stageEvidence, 'codex.stdout.jsonl'), e.stdout ?? ''); await writeFile(path.join(stageEvidence, 'codex.stderr.log'), e.stderr ?? String(e)); await record({ type: 'child-failed', stage: stageId, error: String(e) }) }
  if (!parsed) parsed = { summary: childError ? `child failed: ${childError.message}` : 'child returned no structured result', outputs: [], consumed: [], status: 'blocked' }
  await writeFile(path.join(stageEvidence, 'result.json'), JSON.stringify(parsed, null, 2))
  const declared = Array.isArray(parsed.outputs) ? parsed.outputs : []; const validOutputs = []
  for (const ref of declared) { if (typeof ref !== 'string' || !ref || path.isAbsolute(ref) || ref.includes('..')) continue; const full = path.resolve(changeDir, ref); if (!full.startsWith(`${changeDir}${path.sep}`)) continue; try { const st = await stat(full); if (st.isFile() && st.size > 0) validOutputs.push(ref) } catch {} }
  let externalValidation
  // The Codex child is sandboxed and cannot bind TCP sockets on this host. Run
  // the independent acceptance harness in the parent process so the workflow
  // can distinguish an environment restriction from a product failure.
  if (stageId === 'verify' && parsed.status !== 'completed') {
    const acceptance = await runLocal(process.execPath, [path.join(repo, '.trellis/tasks/09-12-backend-full-workflow-e2e/acceptance.mjs'), changeDir], { cwd: project })
    externalValidation = { command: 'acceptance.mjs source', code: acceptance.code, stdout: acceptance.stdout, stderr: acceptance.stderr }
    await writeFile(path.join(stageEvidence, 'external-acceptance.json'), JSON.stringify(externalValidation, null, 2))
    if (acceptance.code === 0) parsed.status = 'completed'
  }
  if (stageId === 'acceptance' && parsed.status !== 'completed') {
    const acceptance = await runLocal(process.execPath, [path.join(repo, '.trellis/tasks/09-12-backend-full-workflow-e2e/acceptance.mjs'), changeDir, '--package'], { cwd: project })
    externalValidation = { command: 'acceptance.mjs package', code: acceptance.code, stdout: acceptance.stdout, stderr: acceptance.stderr }
    await writeFile(path.join(stageEvidence, 'external-acceptance.json'), JSON.stringify(externalValidation, null, 2))
    if (acceptance.code === 0) parsed.status = 'completed'
  }
  const externalPassed = externalValidation?.code === 0
  const validation = { declared_outputs: declared, valid_outputs: validOutputs, status: parsed.status === 'completed' && (validOutputs.length === declared.length || externalPassed) ? 'pass' : 'fail', ...(externalValidation ? { external: externalValidation } : {}) }
  await writeFile(path.join(stageEvidence, 'validation.json'), JSON.stringify(validation, null, 2))
  const changes = await runtime.reconcile(); const published = []; for (const ref of validOutputs) { try { published.push(await runtime.publish(ref, 'deliverable')) } catch (e) { await record({ type: 'publish-failed', stage: stageId, ref, error: String(e) }) } }
  await runtime.end(validation.status === 'pass' ? 'completed' : 'failed'); const catalogView = await service.catalog(attemptId, { includeHistory: true, includeCandidates: true }); await writeFile(path.join(stageEvidence, 'artifact-catalog.json'), JSON.stringify(catalogView, null, 2))
  await record({ type: 'stage-end', stage: stageId, status: validation.status, changes, published: published.map(v => ({ artifactId: v.artifactId, version: v.version, path: v.source?.path, digest: v.contentDigest })) })
  results.push({ id: stageId, skill_id: skillId, status: validation.status, attempt_id: attemptId, outputs: validOutputs, published: published.map(v => ({ artifactId: v.artifactId, version: v.version, digest: v.contentDigest })) })
  if (validation.status !== 'pass') break
}
const outcome = { schema_version: 'live-workflow-evidence/v1', started_at: started, finished_at: now(), project, change_dir: changeDir, stage_count: stages.length, start_index: startIndex, completed_stages: results.filter(r => r.status === 'pass').length, status: results.length === (stages.length - startIndex) && results.every(r => r.status === 'pass') ? 'completed' : 'blocked', stages: results }
await writeFile(outcomePath, JSON.stringify(outcome, null, 2)); console.log(JSON.stringify(outcome, null, 2))
process.exit(outcome.status === 'completed' ? 0 : 1)
