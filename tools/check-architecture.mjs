#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { extname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  analyzeImportGraph,
  assertNoRuntimeCycles,
  formatImportGraphReport,
} from './kernel-runtime-import-graph.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const failures = []

const SIZE_EXCEPTIONS = new Map([
  ['packages/dashboard-app/src/i18n/translations.ts', 'FRONTEND config resource'],
  ['packages/kernel/src/flow/manifest.ts', 'BACKEND workflow manifest config codec'],
  ['packages/kernel/src/tracks/parse.ts', 'BACKEND track registry config codec'],
  ['packages/kernel/src/triage/validate.ts', 'BACKEND triage protocol validator'],
  ['packages/kernel/src/verification/validate.ts', 'BACKEND verification protocol validator'],
])

// A cross-workspace subpath is allowed only when the providing package declares
// that exact key in its public `exports` map. This keeps the rule strict without
// maintaining a second, drifting allowlist in the architecture checker.
const packageExportsCache = new Map()
function isPublicPackageExport(specifier) {
  const match = specifier.match(/^(@[^/]+\/[^/]+)(\/.*)$/)
  if (!match) return false
  const packageName = match[1]
  let exportsMap = packageExportsCache.get(packageName)
  if (exportsMap === undefined) {
    const packageJson = join(root, 'packages', packageName.slice('@tenon/'.length), 'package.json')
    if (!existsSync(packageJson)) {
      packageExportsCache.set(packageName, null)
      return false
    }
    try {
      exportsMap = JSON.parse(readFileSync(packageJson, 'utf8')).exports
    } catch {
      exportsMap = null
    }
    packageExportsCache.set(packageName, exportsMap ?? null)
  }
  if (!exportsMap || typeof exportsMap !== 'object') return false
  return Object.hasOwn(exportsMap, `.${match[2]}`)
}

const WORKFLOW_IDENTITY_COMPAT = new Map([
  ['hooks/router-gen.mjs', [
    { code: "if (id === 'default') return true", reason: 'router-data generation treats the packaged built-in workflow as present' },
  ]],
  ['hooks/router.sh', [
    { code: '[ "${ROUTER_WORKFLOWS[$i]}" != "default" ]', reason: 'hot router distinguishes project selection from the packaged built-in route' },
    { code: '[ "$CHANGE_WORKFLOW" != "default" ]', reason: 'hot router suppresses the default breadcrumb matrix for a bound custom workflow' },
    { code: '[ "$BEST_WORKFLOW" != "default" ]', reason: 'hot router suppresses the default breadcrumb matrix for a newly selected custom workflow' },
  ]],
  ['packages/kernel/src/workflow/effective-plan.ts', [
    { code: "if (id === 'default')", reason: 'central compatibility compiler dispatch' },
    { code: "const definition = id === 'default' ? undefined", reason: 'central compatibility loader dispatch' },
    { code: "if (id === 'default') return compileEffectiveWorkflowPlan(id, undefined, track)", reason: 'central compatibility resolver dispatch' },
  ]],
  ['packages/kernel/src/workflow/migrations/pre-tenon-v1-document-policy.ts', [
    { code: "workflowId !== 'default'", reason: 'exact immutable v1 persistence compatibility fingerprint reader' },
  ]],
  ['packages/kernel/src/tracks/validate.ts', [
    { code: "workflowName === 'default'", reason: 'track registry permits the built-in workflow without a project file' },
    { code: "id === 'default'", reason: 'track registry permits the built-in workflow without a project file' },
  ]],
  ['packages/cli/src/executionCoordinatePort.ts', [
    { code: "if (workflowName === 'default')", reason: 'legacy runtime execution-coordinate adapter' },
  ]],
  ['packages/dashboard-app/src/model/progressModel.ts', [
    { code: "workflow === 'default'", reason: 'reader-facing built-in workflow label projection' },
    { code: "b.workflow === 'default'", reason: 'reader-facing built-in workflow sort projection' },
  ]],
  ['packages/dashboard-app/src/shell/projectsModel.ts', [
    { code: "workflow === 'default'", reason: 'reader-facing built-in workflow label projection' },
    { code: "workflow === 'default' || workflow < best", reason: 'reader-facing built-in workflow tie-break projection' },
  ]],
  ['packages/dashboard-app/src/workbench/WorkbenchView.tsx', [
    { code: "workflowName === 'default'", reason: 'reserved built-in workflow name validation' },
    { code: "wfName === 'default'", reason: 'reserved built-in workflow editor projection' },
    { code: "wfName === 'default'", reason: 'reserved built-in workflow editor projection' },
    { code: "name === 'default'", reason: 'reserved built-in workflow editor projection' },
    { code: "wfName === 'default'", reason: 'reserved built-in workflow editor projection' },
    { code: "wfName === 'default'", reason: 'reserved built-in workflow editor projection' },
    { code: "name === 'default'", reason: 'reserved built-in workflow editor projection' },
    { code: "wfName === 'default'", reason: 'reserved built-in workflow editor projection' },
    { code: "wfName === 'default'", reason: 'reserved built-in workflow editor projection' },
    { code: "name === 'default'", reason: 'reserved built-in workflow editor projection' },
  ]],
  ['packages/dashboard-app/src/model/changeModel.ts', [
    { code: "changeWorkflow(change) !== 'default'", reason: 'reader-facing built-in workflow category projection' },
  ]],
  ['packages/dashboard-app/src/model/workflowModel.ts', [
    { code: "name === 'default'", reason: 'central reader-facing built-in workflow identity predicate' },
    { code: "n !== 'default'", reason: 'built-in workflow rules are packaged rather than project-fetched' },
    { code: "name === 'default'", reason: 'built-in workflow rules are packaged rather than project-fetched' },
    { code: "name !== 'default'", reason: 'built-in workflow rules are packaged rather than project-fetched' },
    { code: "name === 'default'", reason: 'built-in workflow rules are packaged rather than project-fetched' },
  ]],
  ['packages/automation/src/skills/wiring.ts', [
    { code: "workflowId !== 'default'", reason: 'compatibility validation for externally supplied resolution coordinates' },
    { code: "workflowId === 'default' ? 'default' : 'custom'", reason: 'compatibility validation for externally supplied resolution coordinates' },
    { code: "resolutionInput.kind === 'default'", reason: 'closed resolution-coordinate variant dispatch' },
    { code: "resolutionInput.kind === 'default'", reason: 'closed resolution-coordinate variant dispatch' },
  ]],
  ['packages/automation/src/admission/execution-preparation.ts', [
    { code: "coordinate.resolution.kind === 'default'", reason: 'closed resolution-coordinate variant dispatch' },
    { code: "coordinate.resolution.kind === 'default'", reason: 'closed resolution-coordinate variant dispatch' },
  ]],
  ['packages/automation/src/lifecycle/ports.ts', [
    { code: "provenance.resolution_source !== 'default'", reason: 'closed persisted provenance enum validation' },
  ]],
  ['packages/automation/src/sdk/dockerRunChange.ts', [
    { code: "resolveWorkflowName(state) === 'default'", reason: 'compatibility adapter emits a closed resolution-coordinate variant' },
  ]],
  ['packages/automation/src/starters/wiring.ts', [
    { code: "if (workflowId === 'default')", reason: 'starter compatibility adapter creates legacy or graph skill coordinates' },
    { code: "workflowId === 'default' || deps.customWorkflowRuntimeWired !== false", reason: 'legacy starter runtime wiring compatibility signal' },
  ]],
  ['packages/cli/src/commands/init.ts', [
    { code: "if (workflowId !== 'default')", reason: 'change initialization compatibility adapter resolves graph start step' },
  ]],
  ['packages/cli/src/commands/migrateWorkflow.ts', [
    { code: "current !== 'default'", reason: 'explicit legacy workflow-field migration compatibility' },
  ]],
  ['packages/cli/src/integration-harness.ts', [
    { code: "id === 'default'", reason: 'test harness built-in workflow existence adapter' },
  ]],
  ['packages/cli/src/main.ts', [
    { code: "id === 'default'", reason: 'CLI composition built-in workflow existence adapter' },
  ]],
  ['packages/dashboard-app/src/api/automationDecoders.ts', [
    { code: "template.recommendedWorkflow !== 'default'", reason: 'v1 automation template protocol currently has a literal closed value' },
  ]],
  ['packages/dashboard-app/src/progress/CreateChangeDialog.tsx', [
    { code: "if (selectedWorkflow === 'default')", reason: 'create form compatibility projection before a change exists' },
  ]],
  ['packages/kernel/src/loops/policy-template.ts', [
    { code: "if (recommendedWorkflow !== 'default')", reason: 'v1 automation template protocol currently has a literal closed value' },
  ]],
  ['packages/kernel/src/workflow/skill-bundle-resolver.ts', [
    { code: "input.kind === 'default'", reason: 'closed resolution-coordinate variant dispatch' },
  ]],
  ['packages/kernel/src/workflow/validate.ts', [
    { code: "options.origin === 'default'", reason: 'explicit compiler-origin validation mode' },
  ]],
  ['packages/kernel/src/workflow/identifier.ts', [
    { code: "return value === 'default'", reason: 'central reserved built-in workflow identity helper' },
  ]],
  ['packages/server/src/serverPostChangesRoutes.ts', [
    { code: "if (workflowId !== 'default')", reason: 'change creation compatibility adapter resolves graph start step' },
  ]],
  ['packages/server/src/serverPostExecutionRoutes.ts', [
    { code: "if (workflowId === 'default') return true", reason: 'track registry existence callback treats built-in workflow as present' },
    { code: "if (id === 'default') return true", reason: 'workflow existence callback treats built-in workflow as present' },
    { code: "if (workflowId === 'default') return true", reason: 'workflow existence callback treats built-in workflow as present' },
  ]],
  ['packages/server/src/serverGovernance.ts', [
    { code: "if (id === 'default') return true", reason: 'workflow existence callback treats built-in workflow as present' },
  ]],
  ['packages/server/src/serverMutationRoutes.ts', [
    { code: "if (wfName === 'default')", reason: 'reserved built-in workflow mutation protection' },
  ]],
  ['packages/server/src/serverPostGovernanceRoutes.ts', [
    { code: "if (wfName === 'default')", reason: 'reserved built-in workflow mutation protection' },
  ]],
  ['packages/server/src/workflowReferenceScan.ts', [
    { code: "workflow !== 'default' && !isWorkflowName(workflow)", reason: 'persisted identifier validation preserves the reserved built-in name' },
    { code: "observed !== 'default'", reason: 'persisted identifier validation preserves the reserved built-in name' },
  ]],
])

const RULE_EXCEPTIONS = new Map([
  ['packages/kernel/src/flow/manifest.ts', new Map([
    ['non-null', 'bounded YAML parser narrows regex captures and array indices before access'],
  ])],
  ['packages/kernel/src/tracks/parse.ts', new Map([
    ['non-null', 'bounded YAML tokenizer narrows token kinds and array indices before access'],
  ])],
  ['packages/kernel/src/verification/validate.ts', new Map([
    ['double-assertion', 'runtime object decoder narrows object shape immediately before typed field validation'],
  ])],
])

function hasRuleException(rel, rule) {
  const reason = RULE_EXCEPTIONS.get(rel)?.get(rule)
  return typeof reason === 'string' && reason.length > 0
}

// Treat every production comparison with the reserved `default` literal as an identity decision.
// Aliases such as `id` and `wfName` are intentionally indistinguishable from `workflowName`
// without whole-program data flow, so each legitimate occurrence must be reviewed exactly once.
const WORKFLOW_IDENTITY_COMPARISON =
  /(?:(?:===|!==|==|!=)\s*['"]default['"]|['"]default['"]\s*(?:===|!==|==|!=))/gu

for (const mutation of [
  "workflowName === 'default'",
  "workflowName !== 'default'",
  "'default' === workflowName",
  "'default' != workflow",
  "wfName === 'default'",
  "id !== 'default'",
]) {
  WORKFLOW_IDENTITY_COMPARISON.lastIndex = 0
  if (!WORKFLOW_IDENTITY_COMPARISON.test(mutation)) {
    throw new Error(`architecture checker self-test failed to detect workflow identity comparison: ${mutation}`)
  }
}

function unapprovedIdentityComparisons(lines, allowedSites) {
  const consumed = new Set()
  const unapproved = []
  for (const [index, line] of lines.entries()) {
    WORKFLOW_IDENTITY_COMPARISON.lastIndex = 0
    for (const _comparison of line.matchAll(WORKFLOW_IDENTITY_COMPARISON)) {
      const allowedIndex = allowedSites.findIndex(
        (site, siteIndex) =>
          !consumed.has(siteIndex)
          && line.includes(site.code)
          && site.reason !== '',
      )
      if (allowedIndex >= 0) consumed.add(allowedIndex)
      else unapproved.push(index + 1)
    }
  }
  return unapproved
}

function hasInteractionReverseDependency(code) {
  return /from\s+['"](?:@tenon\/(?:cli|server|channel)|(?:\.\.\/)+(?:cli|server|channel)(?:\/|['"]))/u.test(code)
}

if (!hasInteractionReverseDependency("import { cmd } from '@tenon/cli';")) {
  throw new Error('architecture checker self-test failed to detect interaction reverse dependency')
}
if (hasInteractionReverseDependency("import { codec } from '../workflow/codec.js';")) {
  throw new Error('architecture checker self-test falsely rejected kernel workflow dependency')
}

const allowanceSelfTest = unapprovedIdentityComparisons(
  ["if (id === 'default') return true", "if (id === 'default') return true"],
  [{ code: "id === 'default'", reason: 'one reviewed occurrence' }],
)
if (allowanceSelfTest.length !== 1 || allowanceSelfTest[0] !== 2) {
  throw new Error('architecture checker self-test failed to enforce one reviewed occurrence per allowance')
}

const DOMAIN_DIRS = [
  'packages/kernel/src/workflow/',
  'packages/kernel/src/flow/',
  'packages/kernel/src/loops/',
  'packages/kernel/src/tracks/',
  'packages/kernel/src/triage/',
  'packages/kernel/src/verification/',
  'packages/kernel/src/interaction/',
]

const DOMAIN_INFRASTRUCTURE = new Set([
  'packages/kernel/src/flow/manifest.ts',
  'packages/kernel/src/loops/drafts.ts',
  'packages/kernel/src/loops/governance.ts',
  'packages/kernel/src/loops/ledger-store.ts',
  'packages/kernel/src/loops/reconciliation-store.ts',
  'packages/kernel/src/loops/registry.ts',
  'packages/kernel/src/tracks/registry.ts',
  'packages/kernel/src/workflow/loadWorkflow.ts',
  'packages/kernel/src/workflow/stepGuard.ts',
])

const PRODUCT_PATH_OWNER = 'packages/kernel/src/product-paths.ts'
const PRODUCT_ROOT_CONTRACT_SITES = new Set([
  PRODUCT_PATH_OWNER,
  'packages/cli/src/runtime/launchers.ts',
  'runtime/tenon-bootstrap.mjs',
])
const LEGACY_ROOT_PROJECTION_SITES = new Set([
  'packages/cli/src/runtime/launchers.ts',
  'runtime/tenon-bootstrap.mjs',
  'packages/cli/src/codexSkillTrust.ts',
  'hooks/auto-update.sh',
  'hooks/session-start.sh',
])

function walk(dir) {
  const files = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'dist' || entry.name === 'node_modules') continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) files.push(...walk(path))
    else if (['.ts', '.tsx', '.js', '.mjs', '.sh'].includes(extname(entry.name))) files.push(path)
  }
  return files
}

function source(path) {
  return readFileSync(path, 'utf8')
}

function lineCount(text) {
  return text === '' ? 0 : text.split(/\r?\n/).length
}

function sizeRule(rel) {
  if (!/\.(ts|tsx)$/.test(rel) || SIZE_EXCEPTIONS.has(rel)) return undefined
  if (rel.startsWith('packages/dashboard-app/src/')) {
    if (!rel.endsWith('.tsx')) return undefined
    const isPage = /(?:^|\/)(?:App|[^/]*(?:View|Page|Route))\.tsx$/.test(rel)
    return {
      limit: isPage ? 600 : 400,
      citation: `.agent-rules/FRONTEND.md:${isPage ? 62 : 61}`,
      kind: isPage ? 'page/route' : 'component/hook',
    }
  }
  if (rel.startsWith('packages/server/src/')) {
    return { limit: 400, citation: '.agent-rules/BACKEND.md:60', kind: 'HTTP/controller' }
  }
  if (rel.startsWith('packages/cli/src/commands/') || rel === 'packages/cli/src/program.ts') {
    return { limit: 400, citation: '.agent-rules/BACKEND.md:60', kind: 'CLI/controller' }
  }
  if (rel.startsWith('packages/kernel/src/state/')
    || /(?:codec|store|repository)\.ts$/.test(rel)
    || rel.startsWith('packages/tap/src/')) {
    return { limit: 500, citation: '.agent-rules/BACKEND.md:63', kind: 'repository/storage/codec' }
  }
  if (rel.startsWith('packages/kernel/src/')) {
    return { limit: 450, citation: '.agent-rules/BACKEND.md:62', kind: 'domain' }
  }
  if (rel.startsWith('packages/automation/src/') || rel.startsWith('packages/channel/src/')) {
    return { limit: 500, citation: '.agent-rules/BACKEND.md:61', kind: 'service/application' }
  }
  if (rel.startsWith('packages/cli/src/')) {
    return { limit: 500, citation: '.agent-rules/BACKEND.md:61', kind: 'service/application' }
  }
  return undefined
}

const production = [
  ...walk(join(root, 'packages')),
  ...walk(join(root, 'hooks')),
  ...walk(join(root, 'runtime')),
].filter((path) =>
  !/(\.test|\.integration\.test)\.[^.]+$/.test(path)
  && !/(?:^|\/)test-(?:support|setup)\.[^.]+$/.test(path)
  && !/\.generated\.[^.]+$/.test(path),
)

for (const path of production) {
  const rel = relative(root, path)
  const text = source(path)
  const code = text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
  const size = sizeRule(rel)
  if (size && lineCount(text) > size.limit) {
    failures.push(
      `${rel}: ${size.kind} ${lineCount(text)} lines exceeds ${size.limit} (${size.citation})`,
    )
  }
  const deepImport = code.match(/from ['"](@tenon\/[^/'"]+\/[^/'"]+)['"]/)?.[1]
  if (deepImport && !isPublicPackageExport(deepImport)) {
    failures.push(`${rel}: cross-workspace deep import bypasses public package export (.agent-rules/BACKEND.md)`)
  }
  const privateProducerBridge = /from ['"](?:\.\.\/)+kernel\/dist\/skill-invocation\/producer-internal\.js['"]/.test(code)
  const producerBridgeOwners = new Set([
    'packages/automation/src/skillInvocationAfkInteractionPolicy.ts',
    'packages/automation/src/skillInvocationAfkLifecycle.ts',
    'packages/cli/src/codexSkillReceipt.ts',
    'packages/cli/src/nativeSkillReceipt.ts',
    'packages/cli/src/commands/document.ts',
    'packages/cli/src/commands/hostInteraction.ts',
  ])
  if (privateProducerBridge && !producerBridgeOwners.has(rel)) {
    failures.push(`${rel}: private SkillInvocation producer bridge is restricted to audited host/automation adapters`)
  }

  if (/packages\/dashboard-app\/src\/(model|shared|lib)\//.test(rel)) {
    if (/from ['"]\.\.\/(inbox|workbench|progress|afk|shell)\//.test(code)) {
      failures.push(`${rel}: lower frontend layer reverse-imports a feature/shell (.agent-rules/FRONTEND.md)`)
    }
  }

  if (DOMAIN_DIRS.some((prefix) => rel.startsWith(prefix))
    && !DOMAIN_INFRASTRUCTURE.has(rel)
    && /from ['"]node:/.test(code)) {
    failures.push(`${rel}: configured domain module imports Node infrastructure API (.agent-rules/BACKEND.md)`)
  }

  if (rel.startsWith('packages/kernel/src/interaction/') && hasInteractionReverseDependency(code)) {
    failures.push(`${rel}: interaction domain must not import CLI/server/channel adapters (.agent-rules/BACKEND.md)`)
  }

  if (/\b(?:as\s+any|:\s*any\b|<any>)/.test(code)) {
    failures.push(`${rel}: explicit production any is forbidden (.agent-rules/BACKEND.md)`)
  }
  if (/\bas unknown as\b/.test(code) && !hasRuleException(rel, 'double-assertion')) {
    failures.push(`${rel}: unchecked double assertion is forbidden (.agent-rules/BACKEND.md)`)
  }
  if (/JSON\.parse\([^;\n]+\)\s+as\s+[A-Z{]/.test(code)) {
    failures.push(`${rel}: JSON boundary result must pass a runtime decoder (.agent-rules/BACKEND.md)`)
  }
  if (/(?:\w|\]|\))!(?=[.;,[\]()])/g.test(code) && !hasRuleException(rel, 'non-null')) {
    failures.push(`${rel}: production non-null assertion is forbidden (.agent-rules/BACKEND.md)`)
  }

  if (rel !== 'packages/automation/src/types.ts' && /const AUTOMATION_STATES\s*=/.test(code)) {
    failures.push(`${rel}: AUTOMATION_STATES must come from @tenon/automation`)
  }
  if (rel !== 'packages/automation/src/lifecycle/worktree.ts' && /const CANCEL_MARKER_FILE\s*=/.test(code)) {
    failures.push(`${rel}: CANCEL_MARKER_FILE must come from @tenon/automation`)
  }
  if (/function readTopLevelScalars\s*\(/.test(code)) {
    failures.push(`${rel}: pipeline YAML must be decoded by the kernel codec`)
  }
  if (/as unknown as WorkflowDef/.test(code)) {
    failures.push(`${rel}: workflow request DTO must pass through decodeWorkflowDef`)
  }

  if (rel !== PRODUCT_PATH_OWNER
    && /['"](?:projects|secrets|dashboard-token|dashboard-server)\.json['"]/.test(code)) {
    failures.push(`${rel}: Tenon product file locations must come from kernel resolveProductPaths`)
  }
  if (rel.startsWith('packages/kernel/src/')
    && /['"]pipeline-projects\.json['"]/.test(code)) {
    failures.push(`${rel}: vendor-neutral kernel must not own host-specific migration paths`)
  }
  if (rel !== PRODUCT_PATH_OWNER && /\bTENON_RUNTIME_HOME\b/.test(code)) {
    failures.push(`${rel}: TENON_RUNTIME_HOME may only be interpreted by kernel resolveProductPaths`)
  }
  if (/\bTENON_DASHBOARD_HOME\b/.test(code)) {
    failures.push(`${rel}: Dashboard-only machine home creates a forbidden second product-state root`)
  }
  if (/\bTENON_RUNTIME_ROOTS\b/.test(code) && !PRODUCT_ROOT_CONTRACT_SITES.has(rel)) {
    failures.push(`${rel}: versioned runtime root contract may only be resolved, projected, or consumed at its boundary`)
  }
  if (/\bTENON_RUNTIME_(?:DATA|STATE|CONFIG)_ROOT\b/.test(code)
    && !LEGACY_ROOT_PROJECTION_SITES.has(rel)) {
    failures.push(`${rel}: individual runtime roots are read-only shell/N-1 projections, not path inputs`)
  }

  const allowedIdentitySites = WORKFLOW_IDENTITY_COMPAT.get(rel) ?? []
  const identityCode = text
    .replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ' '))
    .replace(/\/\/.*$/gm, '')
  for (const lineNumber of unapprovedIdentityComparisons(
    identityCode.split(/\r?\n/),
    allowedIdentitySites,
  )) {
    failures.push(`${rel}:${lineNumber}: workflow identity must not reconstruct capabilities outside an exact compiler/compatibility site`)
  }
}

if (/pipeline_codex_host_cache_roots/.test(source(join(root, 'hooks', 'skill-evidence.sh')))) {
  failures.push('hooks/skill-evidence.sh: historical Codex cache enumeration is forbidden')
}

for (const rel of [
  'packages/cli/dist/test-support.js',
  'packages/cli/dist/test-support.d.ts',
  'packages/cli/dist/integration-harness.js',
  'packages/cli/dist/integration-harness.d.ts',
]) {
  if (existsSync(join(root, rel))) {
    failures.push(`${rel}: test-only evidence producer entrypoint must not ship in CLI dist`)
  }
}

const pkg = JSON.parse(source(join(root, 'package.json')))
for (const script of ['check:architecture', 'test:hooks']) {
  if (typeof pkg.scripts?.[script] !== 'string') failures.push(`package.json: missing '${script}' script`)
}
const cliPkg = JSON.parse(source(join(root, 'packages', 'cli', 'package.json')))
if (JSON.stringify(cliPkg.exports) !== '{}') {
  failures.push('packages/cli/package.json: CLI package must export no module subpaths')
}
if (JSON.stringify(cliPkg.files) !== JSON.stringify(['dist/tenon.mjs'])) {
  failures.push('packages/cli/package.json: CLI package must publish only the bundled binary')
}

try {
  const graph = await analyzeImportGraph({ rootDir: root })
  console.log(formatImportGraphReport(graph))
  try {
    assertNoRuntimeCycles(graph)
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error))
  }
} catch (error) {
  failures.push(`kernel runtime import graph could not be analyzed: ${error instanceof Error ? error.message : String(error)}`)
}

if (failures.length > 0) {
  console.error('architecture check failed:')
  for (const failure of failures) console.error(`- ${failure}`)
  process.exit(1)
}
console.log(
  `architecture check passed (${production.length} production files scanned; ${SIZE_EXCEPTIONS.size} size-only exceptions)`,
)
