import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const { version: CURRENT_RELEASE_VERSION } = JSON.parse(
  await readFile(join(root, 'package.json'), 'utf8'),
)
const CURRENT_RELEASE_TAG = `v${CURRENT_RELEASE_VERSION}`
const CURRENT_RELEASE_VERSION_PATTERN = CURRENT_RELEASE_VERSION.replaceAll('.', '\\.')
const CURRENT_RELEASE_TAG_PATTERN = CURRENT_RELEASE_TAG.replaceAll('.', '\\.')
// Neighbouring stable versions for WAL fixtures. A patch underflow borrows from the minor (and
// then the major) version so `1.1.0` yields `1.0.99`/`1.0.98` instead of an invalid `1.1.-1`.
function offsetReleaseVersion(version, delta) {
  let [major, minor, patch] = version.split('.').map(Number)
  patch += delta
  while (patch < 0) {
    if (minor > 0) minor -= 1
    else { major -= 1; minor = 99 }
    patch += 100
  }
  if (major < 0) throw new Error(`no stable version precedes ${version} by ${-delta}`)
  return `${major}.${minor}.${patch}`
}
const PRIOR_RELEASE_VERSION = offsetReleaseVersion(CURRENT_RELEASE_VERSION, -1)
const PRIOR_RELEASE_TAG = `v${PRIOR_RELEASE_VERSION}`
const TWO_BACK_RELEASE_VERSION = offsetReleaseVersion(CURRENT_RELEASE_VERSION, -2)
const TWO_BACK_RELEASE_TAG = `v${TWO_BACK_RELEASE_VERSION}`
const NEXT_RELEASE_VERSION = offsetReleaseVersion(CURRENT_RELEASE_VERSION, 1)
const NEXT_RELEASE_TAG = `v${NEXT_RELEASE_VERSION}`
const AUTH_COMMANDS = [
  'codex login',
  'codex login --device-auth',
  'https://platform.openai.com/api-keys',
  'printenv OPENAI_API_KEY | codex login --with-api-key',
  'codex login status',
]

async function waitForFile(path, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try { await readFile(path); return } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 20))
  }
  throw new Error(`timed out waiting for ${path}`)
}

function childCompletion(child) {
  let stdout = ''
  let stderr = ''
  child.stdout?.setEncoding('utf8')
  child.stderr?.setEncoding('utf8')
  child.stdout?.on('data', (chunk) => { stdout += chunk })
  child.stderr?.on('data', (chunk) => { stderr += chunk })
  return new Promise((resolveChild, rejectChild) => {
    child.once('error', rejectChild)
    child.once('exit', (code, signal) => resolveChild({ code, signal, stdout, stderr }))
  })
}

function hasExactCommand(document, command) {
  return document.split(/\r?\n/u).some((line) => {
    const trimmed = line.trim()
    return trimmed === command || trimmed.includes(`\`${command}\``)
  })
}

async function prepareReleasedBootstrapFixture(
  fixture,
  host,
  {
    initiallyInstalled = false,
    initialMarketplaceKind = 'exact',
    reportedVersion = CURRENT_RELEASE_VERSION,
    reportedVersionAfterInstall = reportedVersion,
    reportedEnabled = true,
    remoteTagProofFails = false,
    releaseState = 'published',
    tagObjectType = 'commit',
  } = {},
) {
  const bin = join(fixture, 'bin')
  const plugin = join(fixture, 'plugin')
  const log = join(fixture, 'host.log')
  const setupArgs = join(fixture, 'setup-args.json')
  const pluginState = join(fixture, 'plugin-present')
  const pluginEnabledState = join(fixture, 'plugin-enabled')
  const pluginVersionState = join(fixture, 'plugin-version')
  const marketplaceState = join(fixture, 'marketplace-present')
  const legacyMarketplaceState = join(fixture, 'marketplace-legacy')
  const home = join(fixture, 'home')
  const runtimeHome = join(fixture, 'runtime-home')
  await mkdir(bin, { recursive: true })
  await mkdir(home, { recursive: true })
  await mkdir(runtimeHome, { recursive: true })
  for (const directory of [
    '.claude-plugin',
    '.codex-plugin',
    'adapters',
    'hooks',
    'packages/cli/dist',
    'packages/dashboard-app/dist',
    'packages/server/dist',
    'runtime',
    'skills',
    'templates',
    'tools',
  ]) await mkdir(join(plugin, directory), { recursive: true })
  const manifest = `${JSON.stringify({ name: 'tenon', version: CURRENT_RELEASE_VERSION })}\n`
  await writeFile(join(plugin, '.claude-plugin', 'plugin.json'), manifest)
  await writeFile(join(plugin, '.codex-plugin', 'plugin.json'), manifest)
  await writeFile(join(plugin, 'packages', 'server', 'dist', 'dashboard.mjs'), 'export {}\n')
  await writeFile(join(plugin, 'packages', 'dashboard-app', 'dist', 'index.html'), '<!doctype html>\n')
  await writeFile(join(plugin, 'runtime', 'tenon-bootstrap.mjs'), 'export {}\n')
  await writeFile(join(plugin, 'packages', 'cli', 'dist', 'tenon.mjs'), `#!/usr/bin/env node
import { writeFileSync } from 'node:fs'
writeFileSync(process.env.TENON_TEST_SETUP_ARGS, JSON.stringify(process.argv.slice(2)))
`)
  await writeFile(join(plugin, 'tools', 'verify-skills.sh'), '#!/usr/bin/env bash\nexit 0\n')
  await chmod(join(plugin, 'tools', 'verify-skills.sh'), 0o755)

  await exec('/usr/bin/git', ['-C', plugin, 'init', '--quiet'])
  await exec('/usr/bin/git', ['-C', plugin, 'config', 'user.email', 'tenon-test@example.com'])
  await exec('/usr/bin/git', ['-C', plugin, 'config', 'user.name', 'Tenon Test'])
  await exec('/usr/bin/git', ['-C', plugin, 'add', '.'])
  await exec('/usr/bin/git', ['-C', plugin, 'commit', '--quiet', '-m', 'release'])
  await exec('/usr/bin/git', ['-C', plugin, 'tag', CURRENT_RELEASE_TAG])
  await exec('/usr/bin/git', ['-C', plugin, 'remote', 'add', 'origin', 'https://github.com/jefferysha/tenon.git'])
  await exec('/usr/bin/git', ['-C', plugin, 'checkout', '--quiet', '--detach', CURRENT_RELEASE_TAG])
  const { stdout: commitOut } = await exec('/usr/bin/git', ['-C', plugin, 'rev-parse', 'HEAD'])
  const commit = commitOut.trim()
  if (host === 'codex') {
    await writeFile(
      join(plugin, '.codex-marketplace-install.json'),
      `${JSON.stringify({ ref_name: CURRENT_RELEASE_TAG })}\n`,
    )
  }
  if (initialMarketplaceKind === 'main' || initialMarketplaceKind === 'local') {
    await exec('/usr/bin/git', ['-C', plugin, 'checkout', '--quiet', '-B', 'main'])
    if (host === 'codex') {
      await writeFile(
        join(plugin, '.codex-marketplace-install.json'),
        `${JSON.stringify({ ref_name: 'main' })}\n`,
      )
    }
  }

  await writeFile(join(bin, 'git'), `#!/usr/bin/env bash
set -eu
if [ "${'$'}{1:-}" = "ls-remote" ]; then
  ${remoteTagProofFails
    ? 'echo "injected stable tag proof failure" >&2; exit 73'
    : `printf '%s\\trefs/tags/${CURRENT_RELEASE_TAG}\\n' "${commit}"`}
  exit 0
fi
exec /usr/bin/git "${'$'}@"
`)
  await chmod(join(bin, 'git'), 0o755)

  const releaseMetadata = {
    tag_name: CURRENT_RELEASE_TAG,
    draft: releaseState === 'draft',
    prerelease: releaseState === 'prerelease',
    html_url: `https://github.com/jefferysha/tenon/releases/tag/${CURRENT_RELEASE_TAG}`,
    published_at: '2026-08-09T00:00:00Z',
  }
  await writeFile(join(bin, 'curl'), `#!/usr/bin/env bash
set -eu
url="${'$'}{@:${'$'}#}"
${remoteTagProofFails ? 'echo "injected stable tag proof failure" >&2; exit 73' : ':'}
case "${'$'}url" in
  */releases/tags/${CURRENT_RELEASE_TAG}) printf '%s\\n' '${JSON.stringify(releaseMetadata)}' ;;
  */git/ref/tags/${CURRENT_RELEASE_TAG}) printf '%s\\n' '${JSON.stringify({
    ref: `refs/tags/${CURRENT_RELEASE_TAG}`,
    object: { type: tagObjectType, sha: commit },
  })}' ;;
  *) echo "unexpected GitHub API URL: ${'$'}url" >&2; exit 74 ;;
esac
`)
  await chmod(join(bin, 'curl'), 0o755)
  // Keep installer tests independent from the ambient package-manager/toolcache Node. GitHub's
  // hosted toolcache is intentionally writable by a different owner and therefore correctly
  // fails the production trust proof; the fixture needs its own owner-controlled executable.
  await writeFile(join(bin, 'node'), `#!/bin/sh
exec '${process.execPath.replaceAll("'", "'\\''")}' "${'$'}@"
`)
  await chmod(join(bin, 'node'), 0o755)

  const hostScript = host === 'codex'
    ? `#!/usr/bin/env bash
set -eu
printf '%s\\n' "${'$'}*" >> "${'$'}TENON_TEST_HOST_LOG"
if [ -n "${'$'}{TENON_TEST_SWAP_NODE:-}" ] && [ ! -f "${'$'}TENON_TEST_SWAP_NODE.swapped" ]; then
  /bin/mv "${'$'}TENON_TEST_SWAP_NODE.replacement" "${'$'}TENON_TEST_SWAP_NODE"
  : > "${'$'}TENON_TEST_SWAP_NODE.swapped"
fi
if [ -n "${'$'}{TENON_TEST_REWRITE_NODE:-}" ] && [ ! -f "${'$'}TENON_TEST_REWRITE_NODE.rewritten" ]; then
  printf '#!/bin/sh\nprintf executed\\n >> "${'$'}TENON_TEST_MALICIOUS_NODE_LOG"\nexit 97\n' > "${'$'}TENON_TEST_REWRITE_NODE"
  /bin/chmod 755 "${'$'}TENON_TEST_REWRITE_NODE"
  : > "${'$'}TENON_TEST_REWRITE_NODE.rewritten"
fi
if [ -n "${'$'}{TENON_TEST_HOST_BARRIER_ENTERED:-}" ] \
  && [ "${'$'}*" = "${'$'}{TENON_TEST_HOST_BARRIER_COMMAND:-plugin list --json}" ]; then
  barrier_count=0
  [ ! -f "${'$'}TENON_TEST_HOST_BARRIER_ENTERED.count" ] \
    || barrier_count="${'$'}(/bin/cat "${'$'}TENON_TEST_HOST_BARRIER_ENTERED.count")"
  barrier_count=$((barrier_count + 1))
  printf '%s\\n' "${'$'}barrier_count" > "${'$'}TENON_TEST_HOST_BARRIER_ENTERED.count"
  if [ "${'$'}barrier_count" = "${'$'}{TENON_TEST_HOST_BARRIER_AT:-1}" ]; then
    : > "${'$'}TENON_TEST_HOST_BARRIER_ENTERED"
    while [ ! -f "${'$'}TENON_TEST_HOST_BARRIER_RELEASE" ]; do /bin/sleep 0.02; done
  fi
fi
case "${'$'}*" in
  "plugin list --json")
    if [ -f "${'$'}TENON_TEST_PLUGIN_STATE" ]; then
      if [ -f "${'$'}TENON_TEST_PLUGIN_ENABLED_STATE" ]; then enabled=true; else enabled=false; fi
      reported_version="${reportedVersion}"
      [ ! -f "${'$'}TENON_TEST_PLUGIN_VERSION_STATE" ] || reported_version="${'$'}(/bin/cat "${'$'}TENON_TEST_PLUGIN_VERSION_STATE")"
      reported_root="${'$'}TENON_TEST_PLUGIN_ROOT"
      [ -z "${'$'}{TENON_TEST_PLUGIN_REPORTED_ROOT:-}" ] || reported_root="${'$'}TENON_TEST_PLUGIN_REPORTED_ROOT"
      printf '{"installed":[{"pluginId":"tenon@tenon","name":"tenon","marketplaceName":"tenon","version":"%s","enabled":%s,"source":{"path":"%s"}}]}\\n' "${'$'}reported_version" "${'$'}enabled" "${'$'}reported_root"
    else
      printf '{"installed":[]}\\n'
    fi ;;
  "plugin marketplace list --json")
    if [ -f "${'$'}TENON_TEST_MARKETPLACE_STATE" ]; then
      if [ -f "${'$'}TENON_TEST_LEGACY_MARKETPLACE_STATE" ]; then
        printf '{"marketplaces":[{"name":"tenon","root":"%s","marketplaceSource":{"sourceType":"local","source":"/legacy/local/tenon"}}]}\\n' "${'$'}TENON_TEST_PLUGIN_ROOT"
      else
        printf '{"marketplaces":[{"name":"tenon","root":"%s","marketplaceSource":{"sourceType":"git","source":"jefferysha/tenon"}}]}\\n' "${'$'}TENON_TEST_PLUGIN_ROOT"
      fi
    else
      printf '{"marketplaces":[]}\\n'
    fi ;;
  "plugin remove tenon@tenon --json") rm -f "${'$'}TENON_TEST_PLUGIN_STATE" "${'$'}TENON_TEST_PLUGIN_ENABLED_STATE" "${'$'}TENON_TEST_PLUGIN_VERSION_STATE" ;;
  "plugin marketplace remove tenon --json") rm -f "${'$'}TENON_TEST_MARKETPLACE_STATE" "${'$'}TENON_TEST_LEGACY_MARKETPLACE_STATE" ;;
  "plugin marketplace add jefferysha/tenon --ref ${CURRENT_RELEASE_TAG} --json")
    /usr/bin/git -C "${'$'}TENON_TEST_PLUGIN_ROOT" checkout --quiet --detach ${CURRENT_RELEASE_TAG}
    printf '{"ref_name":"${CURRENT_RELEASE_TAG}"}\\n' > "${'$'}TENON_TEST_PLUGIN_ROOT/.codex-marketplace-install.json"
    : > "${'$'}TENON_TEST_MARKETPLACE_STATE" ;;
  "plugin add tenon@tenon --json")
    : > "${'$'}TENON_TEST_PLUGIN_STATE"
    printf '%s\\n' "${'$'}TENON_TEST_PLUGIN_VERSION_AFTER_INSTALL" > "${'$'}TENON_TEST_PLUGIN_VERSION_STATE"
    [ "${'$'}{TENON_TEST_KEEP_DISABLED_AFTER_ADD:-0}" = 1 ] || : > "${'$'}TENON_TEST_PLUGIN_ENABLED_STATE" ;;
  *) echo "unexpected codex command: ${'$'}*" >&2; exit 90 ;;
esac
if [ -n "${'$'}{TENON_TEST_FAIL_AFTER_COMMAND:-}" ] \
  && [ "${'$'}*" = "${'$'}TENON_TEST_FAIL_AFTER_COMMAND" ] \
  && [ ! -f "${'$'}TENON_TEST_FAIL_AFTER_COMMAND_MARKER" ]; then
  : > "${'$'}TENON_TEST_FAIL_AFTER_COMMAND_MARKER"
  exit 77
fi
`
    : `#!/usr/bin/env bash
set -eu
printf '%s\\n' "${'$'}*" >> "${'$'}TENON_TEST_HOST_LOG"
case "${'$'}*" in
  "plugin list --json")
    if [ -f "${'$'}TENON_TEST_PLUGIN_STATE" ]; then
      if [ -f "${'$'}TENON_TEST_PLUGIN_ENABLED_STATE" ]; then enabled=true; else enabled=false; fi
      reported_version="${reportedVersion}"
      [ ! -f "${'$'}TENON_TEST_PLUGIN_VERSION_STATE" ] || reported_version="${'$'}(/bin/cat "${'$'}TENON_TEST_PLUGIN_VERSION_STATE")"
      reported_root="${'$'}TENON_TEST_PLUGIN_ROOT"
      [ -z "${'$'}{TENON_TEST_PLUGIN_REPORTED_ROOT:-}" ] || reported_root="${'$'}TENON_TEST_PLUGIN_REPORTED_ROOT"
      printf '[{"id":"tenon@tenon","version":"%s","enabled":%s,"scope":"user","installPath":"%s"}]\\n' "${'$'}reported_version" "${'$'}enabled" "${'$'}reported_root"
    else
      printf '[]\\n'
    fi ;;
  "plugin marketplace list --json")
    if [ -f "${'$'}TENON_TEST_MARKETPLACE_STATE" ]; then
      printf '[{"name":"tenon","installLocation":"%s","repo":"jefferysha/tenon","source":"github"}]\\n' "${'$'}TENON_TEST_PLUGIN_ROOT"
    else
      printf '[]\\n'
    fi ;;
  "plugin uninstall tenon@tenon --scope user") rm -f "${'$'}TENON_TEST_PLUGIN_STATE" "${'$'}TENON_TEST_PLUGIN_ENABLED_STATE" "${'$'}TENON_TEST_PLUGIN_VERSION_STATE" ;;
  "plugin marketplace remove tenon") rm -f "${'$'}TENON_TEST_MARKETPLACE_STATE" "${'$'}TENON_TEST_LEGACY_MARKETPLACE_STATE" ;;
  "plugin marketplace add jefferysha/tenon@${CURRENT_RELEASE_TAG}")
    /usr/bin/git -C "${'$'}TENON_TEST_PLUGIN_ROOT" checkout --quiet --detach ${CURRENT_RELEASE_TAG}
    : > "${'$'}TENON_TEST_MARKETPLACE_STATE" ;;
  "plugin install tenon@tenon")
    : > "${'$'}TENON_TEST_PLUGIN_STATE"
    printf '%s\\n' "${'$'}TENON_TEST_PLUGIN_VERSION_AFTER_INSTALL" > "${'$'}TENON_TEST_PLUGIN_VERSION_STATE"
    [ "${'$'}{TENON_TEST_KEEP_DISABLED_AFTER_ADD:-0}" = 1 ] || : > "${'$'}TENON_TEST_PLUGIN_ENABLED_STATE" ;;
  *) echo "unexpected claude command: ${'$'}*" >&2; exit 90 ;;
esac
`
  await writeFile(join(bin, host), hostScript)
  await chmod(join(bin, host), 0o755)
  if (initiallyInstalled) {
    await writeFile(pluginState, '')
    await writeFile(pluginVersionState, `${reportedVersion}\n`)
    await writeFile(marketplaceState, '')
  }
  if (initiallyInstalled && reportedEnabled) await writeFile(pluginEnabledState, '')
  if (initialMarketplaceKind === 'local') await writeFile(legacyMarketplaceState, '')
  return {
    bin,
    plugin,
    log,
    setupArgs,
    host,
    env: {
      ...process.env,
      HOME: home,
      TENON_RUNTIME_HOME: runtimeHome,
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      TENON_TEST_HOST_LOG: log,
      TENON_TEST_PLUGIN_ROOT: plugin,
      TENON_TEST_PLUGIN_STATE: pluginState,
      TENON_TEST_PLUGIN_ENABLED_STATE: pluginEnabledState,
      TENON_TEST_PLUGIN_VERSION_STATE: pluginVersionState,
      TENON_TEST_PLUGIN_VERSION_AFTER_INSTALL: reportedVersionAfterInstall,
      TENON_TEST_MARKETPLACE_STATE: marketplaceState,
      TENON_TEST_LEGACY_MARKETPLACE_STATE: legacyMarketplaceState,
      TENON_TEST_SETUP_ARGS: setupArgs,
    },
  }
}

async function writeInstallerBridgeJournal(prepared, {
  host = prepared.host,
  version,
  tag = `v${version}`,
  commit,
  phase = 'plugin-installed',
  transactionId = '11111111-1111-4111-8111-111111111111',
  beforePlugin = 'absent',
  beforeMarketplace = 'absent',
  extra = {},
} = {}) {
  const journal = join(
    prepared.env.TENON_RUNTIME_HOME,
    'state',
    'installer-bridge',
    `${host}.json`,
  )
  await mkdir(dirname(journal), { recursive: true })
  await writeFile(journal, `${JSON.stringify({
    version: 1,
    transactionId,
    host,
    target: { version, tag, commit },
    phase,
    before: { plugin: beforePlugin, marketplace: beforeMarketplace },
    ...extra,
  })}\n`)
  return journal
}

async function preparePriorStableBridgeFixture(fixture, {
  host = 'codex',
  phase = 'plugin-installed',
  targetVersion = PRIOR_RELEASE_VERSION,
  reportedVersion = targetVersion,
  reportedEnabled = true,
  initialMarketplaceKind = 'exact',
  marketplaceMutation = 'none',
  extra = {},
} = {}) {
  const prepared = await prepareReleasedBootstrapFixture(fixture, host, {
    initiallyInstalled: true,
    initialMarketplaceKind,
    reportedVersion,
    reportedVersionAfterInstall: CURRENT_RELEASE_VERSION,
    reportedEnabled,
  })
  const targetTag = `v${targetVersion}`
  await writeFile(join(prepared.plugin, 'prior-release-marker'), 'prior stable release\n')
  await exec('/usr/bin/git', ['-C', prepared.plugin, 'add', 'prior-release-marker'])
  await exec('/usr/bin/git', ['-C', prepared.plugin, 'commit', '--quiet', '-m', 'prior release'])
  await exec('/usr/bin/git', ['-C', prepared.plugin, 'tag', '--force', targetTag])
  await exec('/usr/bin/git', ['-C', prepared.plugin, 'checkout', '--quiet', '--detach', targetTag])
  if (host === 'codex') {
    await writeFile(
      join(prepared.plugin, '.codex-marketplace-install.json'),
      `${JSON.stringify({ ref_name: targetTag })}\n`,
    )
  }
  const { stdout: oldCommitOutput } = await exec('/usr/bin/git', ['-C', prepared.plugin, 'rev-parse', 'HEAD'])
  const oldCommit = oldCommitOutput.trim()
  switch (marketplaceMutation) {
    case 'head':
      await writeFile(join(prepared.plugin, 'head-drift-marker'), 'head drift\n')
      await exec('/usr/bin/git', ['-C', prepared.plugin, 'add', 'head-drift-marker'])
      await exec('/usr/bin/git', ['-C', prepared.plugin, 'commit', '--quiet', '-m', 'head drift'])
      break
    case 'ref':
      await writeFile(
        join(prepared.plugin, '.codex-marketplace-install.json'),
        `${JSON.stringify({ ref_name: 'main' })}\n`,
      )
      break
    case 'origin':
      await exec('/usr/bin/git', ['-C', prepared.plugin, 'remote', 'set-url', 'origin', 'https://example.invalid/tenon.git'])
      break
    case 'dirty':
      await writeFile(join(prepared.plugin, 'prior-release-marker'), 'dirty\n')
      break
    default:
      break
  }
  const journal = await writeInstallerBridgeJournal(prepared, {
    host,
    version: targetVersion,
    tag: targetTag,
    commit: oldCommit,
    phase,
    extra,
  })
  return { prepared, journal, oldCommit }
}

async function assertNoHostMutation(prepared) {
  const commands = await readFile(prepared.log, 'utf8').catch(() => '')
  assert.doesNotMatch(commands, /plugin remove|plugin uninstall|marketplace remove|marketplace add|plugin add|plugin install/u)
}

test('Codex auth commands stay consistent across Chinese, English, troubleshooting, and npm bootstrap docs', async () => {
  const documents = [
    'README.md',
    'docs/usage/installation.md',
    'docs/usage/zh-CN/installation.md',
    'docs/usage/troubleshooting.md',
    'docs/usage/zh-CN/troubleshooting.md',
    'packages/npm-bootstrap/README.md',
  ]
  for (const document of documents) {
    const content = await readFile(join(root, document), 'utf8')
    for (const command of AUTH_COMMANDS) {
      const present = command.startsWith('https://')
        ? content.includes(command)
        : hasExactCommand(content, command)
      assert.ok(present, `${document} is missing exact command ${command}`)
    }
    assert.match(
      content,
      /(?:plan that includes Codex|方案包含 Codex)/u,
      `${document} is missing the conditional ChatGPT plan wording`,
    )
    assert.match(
      content,
      /(?:usage-based billing|按(?:独立的)?(?:用量|量)计费)/u,
      `${document} is missing Platform usage-based billing`,
    )
  }
})

test('public Release API requests use one bounded 30 second network budget', async () => {
  const installer = await readFile(join(root, 'install.sh'), 'utf8')
  const start = installer.indexOf('github_api_get()')
  assert.notEqual(start, -1)
  const end = installer.indexOf('\n}', start)
  assert.notEqual(end, -1)
  const helper = installer.slice(start, end)
  assert.match(installer, /GITHUB_API_TIMEOUT_SECONDS=30\b/u)
  assert.match(helper, /--connect-timeout\s+"\$GITHUB_API_TIMEOUT_SECONDS"/u)
  assert.match(helper, /--max-time\s+"\$GITHUB_API_TIMEOUT_SECONDS"/u)
  assert.match(helper, /--speed-time\s+"\$GITHUB_API_TIMEOUT_SECONDS"/u)
  assert.match(helper, /--speed-limit\s+"\$GITHUB_API_SPEED_LIMIT_BYTES"/u)
  assert.doesNotMatch(helper, /--(?:connect-timeout|max-time|speed-time)\s+(?:5|10)\b/u)
})

test('installer journal adoption ranks the retired 1.x release line below every other stable version', async () => {
  const installer = await readFile(join(root, 'install.sh'), 'utf8')
  const start = installer.indexOf('stable_version_is_less() {')
  assert.notEqual(start, -1)
  const end = installer.indexOf('\n}\n', start)
  assert.notEqual(end, -1)
  const script = `run_node() { node "$@"; }\n${installer.slice(start, end + 3)}stable_version_is_less "$1" "$2"\n`
  const isLess = async (left, right) => {
    try {
      await exec('bash', ['-c', script, 'stable-order', left, right])
      return true
    } catch (error) {
      if (error.code === 1) return false
      throw error
    }
  }
  for (const [left, right, order] of [
    ['0.1.0', '1.1.5', 1],
    ['1.0.0', '0.0.1', -1],
    ['1.1.5', '1.0.9', 1],
    ['0.1.1', '0.1.0', 1],
    ['0.2.0', '0.1.9', 1],
    ['0.1.0', '0.1.0', 0],
    ['1.2.0', '0.9.9', 1],
    ['2.0.0', '1.2.3', 1],
    ['1.0.10', '0.9.9', 1],
    ['1.1.6', '1.1.5', 1],
  ]) {
    assert.equal(await isLess(left, right), order < 0, `${left} < ${right}`)
    assert.equal(await isLess(right, left), order > 0, `${right} < ${left}`)
  }
  for (const [left, right] of [['1.1', '0.1.0'], ['v1.1.5', '0.1.0'], ['0.1.0', '01.1.5']]) {
    assert.equal(await isLess(left, right), false, `${left} < ${right} must reject invalid input`)
  }
})

test('one-line dry-run prints the complete host and packaged setup plan without invoking the host or writing HOME', async () => {
  const fixture = await mkdtemp(join(tmpdir(), 'tenon-install-bootstrap-dry-run-'))
  try {
    const bin = join(fixture, 'bin')
    const home = join(fixture, 'home')
    const hostLog = join(fixture, 'host.log')
    await mkdir(bin, { recursive: true })
    await mkdir(home, { recursive: true })
    await writeFile(join(bin, 'codex'), `#!/usr/bin/env bash
printf 'unexpected host invocation\\n' >> "$TENON_TEST_HOST_LOG"
exit 97
`)
    await chmod(join(bin, 'codex'), 0o755)

    const result = await exec('bash', [join(root, 'install.sh'), '--codex', '--dry-run'], {
      cwd: fixture,
      env: {
        ...process.env,
        HOME: home,
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        TENON_TEST_HOST_LOG: hostLog,
      },
    })

    assert.match(
      result.stdout,
      new RegExp(`codex plugin marketplace add jefferysha/tenon --ref ${CURRENT_RELEASE_TAG_PATTERN}`),
    )
    assert.match(result.stdout, /codex plugin add tenon@tenon --json/)
    assert.match(result.stdout, /npm install -g @openai\/codex/)
    assert.match(result.stdout, /codex login status/)
    assert.match(result.stdout, /tenon setup --codex --yes --dry-run/)
    await assert.rejects(readFile(hostLog, 'utf8'), /ENOENT/)
    assert.deepEqual(await readdir(home), [])
  } finally {
    await rm(fixture, { recursive: true, force: true })
  }
})

test('Codex bootstrap accepts only an explicit complete stable SemVer Marketplace tag', async () => {
  const result = await exec(
    'bash',
    [
      join(root, 'install.sh'),
      '--codex',
      '--ref',
      CURRENT_RELEASE_TAG,
      '--dry-run',
    ],
  )
  assert.match(
    result.stdout,
    new RegExp(`codex plugin marketplace add jefferysha/tenon --ref ${CURRENT_RELEASE_TAG_PATTERN}`),
  )
})

test('a versioned installer rejects a different stable release tag', async () => {
  await assert.rejects(
    exec('bash', [join(root, 'install.sh'), '--codex', '--ref', 'v1.2.3', '--dry-run']),
    (error) => {
      assert.match(error.stderr, new RegExp(`can only install ${CURRENT_RELEASE_TAG_PATTERN}`))
      return true
    },
  )
})

for (const forbiddenRef of ['main', '0123456789abcdef0123456789abcdef01234567', 'v1.2.3-rc.1']) {
  test(`Codex bootstrap rejects non-stable release ref ${forbiddenRef}`, async () => {
    await assert.rejects(
      exec('bash', [join(root, 'install.sh'), '--codex', '--ref', forbiddenRef, '--dry-run']),
      (error) => {
        assert.match(error.stderr, /complete stable tag vX\.Y\.Z/)
        return true
      },
    )
  })
}

test('Codex bootstrap fails before mutations when the host CLI is missing and prints the install command', async () => {
  const fixture = await mkdtemp(join(tmpdir(), 'tenon-install-bootstrap-no-codex-'))
  try {
    await assert.rejects(
      exec('bash', [join(root, 'install.sh'), '--codex'], {
        cwd: fixture,
        env: { ...process.env, PATH: '/usr/bin:/bin' },
      }),
      (error) => {
        assert.match(error.stderr, /npm install -g @openai\/codex/)
        assert.match(error.stderr, /codex --version/)
        return true
      },
    )
  } finally {
    await rm(fixture, { recursive: true, force: true })
  }
})

test('Codex bootstrap ignores a malicious current-directory executable and binds every host call to the trusted absolute PATH entry', async () => {
  const fixture = await mkdtemp(join(tmpdir(), 'tenon-install-bootstrap-trusted-path-'))
  try {
    const prepared = await prepareReleasedBootstrapFixture(fixture, 'codex')
    const maliciousLog = join(fixture, 'malicious.log')
    await writeFile(join(fixture, 'codex'), `#!/usr/bin/env bash
printf '%s\n' "$*" >> "$TENON_TEST_MALICIOUS_LOG"
exit 98
`)
    await chmod(join(fixture, 'codex'), 0o755)

    await exec('bash', [join(root, 'install.sh'), '--codex'], {
      cwd: fixture,
      env: {
        ...prepared.env,
        PATH: `:${prepared.bin}:${process.env.PATH ?? ''}`,
        TENON_TEST_MALICIOUS_LOG: maliciousLog,
      },
    })

    await assert.rejects(readFile(maliciousLog, 'utf8'), /ENOENT/)
    const commands = await readFile(prepared.log, 'utf8')
    assert.match(
      commands,
      new RegExp(`plugin marketplace add jefferysha/tenon --ref ${CURRENT_RELEASE_TAG_PATTERN}`),
    )
    assert.match(commands, /plugin add tenon@tenon --json/)
    assert.match(commands, /plugin list --json/)
  } finally {
    await rm(fixture, { recursive: true, force: true })
  }
})

test('the documented one-line installer starts curl and the bootstrap from absolute system paths', async () => {
  const fixture = await mkdtemp(join(tmpdir(), 'tenon-install-documented-bash-'))
  try {
    const maliciousLog = join(fixture, 'malicious-runtime.log')
    const installer = join(fixture, 'installer.sh')
    await writeFile(join(fixture, 'bash'), `#!/bin/sh
printf 'malicious bash invoked\n' >> "$TENON_TEST_MALICIOUS_RUNTIME_LOG"
exit 97
`)
    await chmod(join(fixture, 'bash'), 0o755)
    await writeFile(join(fixture, 'curl'), `#!/bin/sh
printf 'malicious curl invoked\n' >> "$TENON_TEST_MALICIOUS_RUNTIME_LOG"
exit 96
`)
    await chmod(join(fixture, 'curl'), 0o755)
    await writeFile(installer, '#!/bin/bash\nexit 0\n')
    for (const document of ['README.md', 'README.en.md']) {
      const readme = await readFile(join(root, document), 'utf8')
      const documented = readme.split(/\r?\n/u).find((line) =>
        line.includes(`/${CURRENT_RELEASE_TAG}/install.sh`) && line.includes('--codex'))
      assert.equal(typeof documented, 'string', document)
      assert.match(documented, /^\/usr\/bin\/curl .*\| \/bin\/bash -s -- --codex$/u, document)
      const command = documented.replace(
        `https://raw.githubusercontent.com/jefferysha/tenon/${CURRENT_RELEASE_TAG}/install.sh`,
        `file://${installer}`,
      )

      await exec('/bin/sh', ['-c', command], {
        cwd: fixture,
        env: {
          ...process.env,
          PATH: '.:/usr/bin:/bin',
          TENON_TEST_MALICIOUS_RUNTIME_LOG: maliciousLog,
        },
      })
    }
    await assert.rejects(readFile(maliciousLog, 'utf8'), /ENOENT/)
  } finally {
    await rm(fixture, { recursive: true, force: true })
  }
})

test('bootstrap freezes absolute bash and node paths before plugin mutation', async () => {
  const fixture = await mkdtemp(join(tmpdir(), 'tenon-install-bootstrap-trusted-runtimes-'))
  try {
    const prepared = await prepareReleasedBootstrapFixture(fixture, 'codex')
    const maliciousLog = join(fixture, 'malicious-runtime.log')
    await writeFile(join(fixture, 'bash'), `#!/bin/sh
printf 'bash:%s\\n' "$*" >> "$TENON_TEST_MALICIOUS_RUNTIME_LOG"
exec /bin/bash "$@"
`)
    await writeFile(join(fixture, 'node'), `#!/bin/sh
printf 'node:%s\\n' "$*" >> "$TENON_TEST_MALICIOUS_RUNTIME_LOG"
exec '${process.execPath}' "$@"
`)
    await chmod(join(fixture, 'bash'), 0o755)
    await chmod(join(fixture, 'node'), 0o755)

    await exec('/bin/bash', [join(root, 'install.sh'), '--codex'], {
      cwd: fixture,
      env: {
        ...prepared.env,
        PATH: `:relative-bin:${prepared.bin}:${process.env.PATH ?? ''}`,
        TENON_TEST_MALICIOUS_RUNTIME_LOG: maliciousLog,
      },
    })

    await assert.rejects(readFile(maliciousLog, 'utf8'), /ENOENT/)
    assert.deepEqual(JSON.parse(await readFile(prepared.setupArgs, 'utf8')), [
      'setup', '--codex', '--yes',
    ])
  } finally {
    await rm(fixture, { recursive: true, force: true })
  }
})

test('bootstrap rejects a frozen node inode replacement before the next decoder spawn', async () => {
  const fixture = await mkdtemp(join(tmpdir(), 'tenon-install-bootstrap-node-swap-'))
  try {
    const prepared = await prepareReleasedBootstrapFixture(fixture, 'codex')
    const node = join(prepared.bin, 'node')
    const maliciousLog = join(fixture, 'malicious-node.log')
    await writeFile(node, `#!/bin/sh\nexec '${process.execPath}' "${'$'}@"\n`)
    await writeFile(`${node}.replacement`, `#!/bin/sh\nprintf 'executed\\n' >> "${'$'}TENON_TEST_MALICIOUS_NODE_LOG"\nexit 97\n`)
    await chmod(node, 0o755)
    await chmod(`${node}.replacement`, 0o755)

    await assert.rejects(
      exec('/bin/bash', [join(root, 'install.sh'), '--codex'], {
        cwd: fixture,
        env: {
          ...prepared.env,
          TENON_TEST_SWAP_NODE: node,
          TENON_TEST_MALICIOUS_NODE_LOG: maliciousLog,
        },
      }),
      (error) => {
        assert.match(error.stderr, /trusted node executable identity changed/i)
        return true
      },
    )
    await assert.rejects(readFile(maliciousLog, 'utf8'), /ENOENT/)
    const commands = await readFile(prepared.log, 'utf8')
    assert.equal(commands.trim(), 'plugin list --json')
  } finally {
    await rm(fixture, { recursive: true, force: true })
  }
})

test('bootstrap rejects a same-inode frozen node rewrite before the next decoder spawn', async () => {
  const fixture = await mkdtemp(join(tmpdir(), 'tenon-install-bootstrap-node-rewrite-'))
  try {
    const prepared = await prepareReleasedBootstrapFixture(fixture, 'codex')
    const node = join(prepared.bin, 'node')
    const maliciousLog = join(fixture, 'malicious-node.log')
    await writeFile(node, `#!/bin/sh\nexec '${process.execPath}' "${'$'}@"\n`)
    await chmod(node, 0o755)

    await assert.rejects(
      exec('/bin/bash', [join(root, 'install.sh'), '--codex'], {
        cwd: fixture,
        env: {
          ...prepared.env,
          TENON_TEST_REWRITE_NODE: node,
          TENON_TEST_MALICIOUS_NODE_LOG: maliciousLog,
        },
      }),
      (error) => {
        assert.match(error.stderr, /trusted node executable identity changed/i)
        return true
      },
    )
    await assert.rejects(readFile(maliciousLog, 'utf8'), /ENOENT/)
    const commands = await readFile(prepared.log, 'utf8')
    assert.equal(commands.trim(), 'plugin list --json')
  } finally {
    await rm(fixture, { recursive: true, force: true })
  }
})

test('bootstrap rejects a writable trusted executable before any host mutation', async () => {
  const fixture = await mkdtemp(join(tmpdir(), 'tenon-install-bootstrap-writable-node-'))
  try {
    const prepared = await prepareReleasedBootstrapFixture(fixture, 'codex')
    const node = join(prepared.bin, 'node')
    await writeFile(node, `#!/bin/sh\nexec '${process.execPath}' "${'$'}@"\n`)
    await chmod(node, 0o777)

    await assert.rejects(
      exec('/bin/bash', [join(root, 'install.sh'), '--codex'], {
        cwd: fixture,
        env: prepared.env,
      }),
      (error) => {
        assert.match(error.stderr, /node executable or parent path is not physically trustworthy/i)
        return true
      },
    )
    await assert.rejects(readFile(prepared.log, 'utf8'), /ENOENT/)
  } finally {
    await rm(fixture, { recursive: true, force: true })
  }
})

test('Codex one-line bootstrap registers Marketplace and invokes the packaged Tenon setup', async () => {
  const fixture = await mkdtemp(join(tmpdir(), 'tenon-install-bootstrap-'))
  try {
    const prepared = await prepareReleasedBootstrapFixture(fixture, 'codex')

    const result = await exec('bash', [join(root, 'install.sh'), '--codex', '--auto-update'], {
      cwd: fixture,
      env: prepared.env,
    })
    assert.match(result.stdout, /Tenon installed for --codex/)
    const commands = await readFile(prepared.log, 'utf8')
    assert.match(
      commands,
      new RegExp(`plugin marketplace add jefferysha/tenon --ref ${CURRENT_RELEASE_TAG_PATTERN}`),
    )
    assert.match(commands, /plugin add tenon@tenon --json/)
    assert.deepEqual(JSON.parse(await readFile(prepared.setupArgs, 'utf8')), [
      'setup', '--codex', '--yes', '--auto-update',
    ])
  } finally {
    await rm(fixture, { recursive: true, force: true })
  }
})

for (const initialMarketplaceKind of ['exact', 'main', 'local']) {
  test(`Codex bootstrap transactionally replaces an existing ${initialMarketplaceKind} marketplace with ${CURRENT_RELEASE_VERSION}`, async () => {
    const fixture = await mkdtemp(join(tmpdir(), `tenon-install-bootstrap-rebind-${initialMarketplaceKind}-`))
    try {
      const prepared = await prepareReleasedBootstrapFixture(fixture, 'codex', {
        initiallyInstalled: true,
        initialMarketplaceKind,
      })
      await exec('bash', [join(root, 'install.sh'), '--codex'], {
        cwd: fixture,
        env: prepared.env,
      })
      const commands = (await readFile(prepared.log, 'utf8')).trim().split(/\r?\n/u)
      const pluginRemove = commands.indexOf('plugin remove tenon@tenon --json')
      const marketplaceRemove = commands.indexOf('plugin marketplace remove tenon --json')
      const marketplaceAdd = commands.indexOf(
        `plugin marketplace add jefferysha/tenon --ref ${CURRENT_RELEASE_TAG} --json`,
      )
      const pluginAdd = commands.indexOf('plugin add tenon@tenon --json')
      assert.ok(pluginRemove >= 0)
      assert.ok(marketplaceRemove > pluginRemove)
      assert.ok(marketplaceAdd > marketplaceRemove)
      assert.ok(pluginAdd > marketplaceAdd)
      assert.deepEqual(JSON.parse(await readFile(prepared.setupArgs, 'utf8')), [
        'setup', '--codex', '--yes',
      ])
    } finally {
      await rm(fixture, { recursive: true, force: true })
    }
  })
}

test(`Codex bootstrap takes over an exact current-2 ${TWO_BACK_RELEASE_VERSION} plugin-installed WAL before the ${CURRENT_RELEASE_VERSION} upgrade`, async () => {
  const fixture = await mkdtemp(join(tmpdir(), 'tenon-install-bootstrap-cross-version-'))
  try {
    const prepared = await prepareReleasedBootstrapFixture(fixture, 'codex', {
      initiallyInstalled: true,
      reportedVersion: TWO_BACK_RELEASE_VERSION,
      reportedVersionAfterInstall: CURRENT_RELEASE_VERSION,
    })
    await writeFile(join(prepared.plugin, 'prior-release-marker'), 'prior stable release\n')
    await exec('/usr/bin/git', ['-C', prepared.plugin, 'add', 'prior-release-marker'])
    await exec('/usr/bin/git', ['-C', prepared.plugin, 'commit', '--quiet', '-m', 'prior release'])
    await exec('/usr/bin/git', ['-C', prepared.plugin, 'tag', TWO_BACK_RELEASE_TAG])
    await exec('/usr/bin/git', ['-C', prepared.plugin, 'checkout', '--quiet', '--detach', TWO_BACK_RELEASE_TAG])
    await writeFile(
      join(prepared.plugin, '.codex-marketplace-install.json'),
      `${JSON.stringify({ ref_name: TWO_BACK_RELEASE_TAG })}\n`,
    )
    const { stdout: oldCommitOutput } = await exec('/usr/bin/git', ['-C', prepared.plugin, 'rev-parse', 'HEAD'])
    const oldCommit = oldCommitOutput.trim()
    const journal = await writeInstallerBridgeJournal(prepared, {
      version: TWO_BACK_RELEASE_VERSION,
      tag: TWO_BACK_RELEASE_TAG,
      commit: oldCommit,
    })

    const result = await exec('/bin/bash', [join(root, 'install.sh'), '--codex'], {
      cwd: fixture,
      env: prepared.env,
    })
    assert.match(result.stdout, /Tenon installed for --codex/u)
    const commands = (await readFile(prepared.log, 'utf8')).trim().split(/\r?\n/u)
    const pluginRemove = commands.indexOf('plugin remove tenon@tenon --json')
    const marketplaceRemove = commands.indexOf('plugin marketplace remove tenon --json')
    const marketplaceAdd = commands.indexOf(
      `plugin marketplace add jefferysha/tenon --ref ${CURRENT_RELEASE_TAG} --json`,
    )
    const pluginAdd = commands.indexOf('plugin add tenon@tenon --json')
    assert.ok(pluginRemove >= 0)
    assert.ok(marketplaceRemove > pluginRemove)
    assert.ok(marketplaceAdd > marketplaceRemove)
    assert.ok(pluginAdd > marketplaceAdd)
    assert.equal(commands.filter((command) => command === 'plugin remove tenon@tenon --json').length, 1)
    assert.equal(commands.filter((command) => command === 'plugin marketplace remove tenon --json').length, 1)
    assert.equal(commands.filter((command) => command.startsWith('plugin marketplace add ')).length, 1)
    assert.equal(commands.filter((command) => command === 'plugin add tenon@tenon --json').length, 1)
    assert.deepEqual(JSON.parse(await readFile(prepared.setupArgs, 'utf8')), [
      'setup', '--codex', '--yes',
    ])
    await assert.rejects(readFile(journal, 'utf8'), /ENOENT/u)
  } finally {
    await rm(fixture, { recursive: true, force: true })
  }
})

test(`Claude bootstrap takes over an exact current-2 ${TWO_BACK_RELEASE_VERSION} plugin-installed WAL before the ${CURRENT_RELEASE_VERSION} upgrade`, async () => {
  const fixture = await mkdtemp(join(tmpdir(), 'tenon-install-bootstrap-claude-cross-version-'))
  try {
    const { prepared, journal } = await preparePriorStableBridgeFixture(fixture, {
      host: 'claude',
      targetVersion: TWO_BACK_RELEASE_VERSION,
    })
    const result = await exec('/bin/bash', [join(root, 'install.sh'), '--claude'], {
      cwd: fixture,
      env: prepared.env,
    })
    assert.match(result.stdout, /Tenon installed for --claude/u)
    const commands = (await readFile(prepared.log, 'utf8')).trim().split(/\r?\n/u)
    const pluginRemove = commands.indexOf('plugin uninstall tenon@tenon --scope user')
    const marketplaceRemove = commands.indexOf('plugin marketplace remove tenon')
    const marketplaceAdd = commands.indexOf(`plugin marketplace add jefferysha/tenon@${CURRENT_RELEASE_TAG}`)
    const pluginAdd = commands.indexOf('plugin install tenon@tenon')
    assert.ok(pluginRemove >= 0)
    assert.ok(marketplaceRemove > pluginRemove)
    assert.ok(marketplaceAdd > marketplaceRemove)
    assert.ok(pluginAdd > marketplaceAdd)
    assert.equal(commands.filter((command) => command === 'plugin uninstall tenon@tenon --scope user').length, 1)
    assert.equal(commands.filter((command) => command === 'plugin marketplace remove tenon').length, 1)
    assert.equal(commands.filter((command) => command.startsWith('plugin marketplace add ')).length, 1)
    assert.equal(commands.filter((command) => command === 'plugin install tenon@tenon').length, 1)
    assert.deepEqual(JSON.parse(await readFile(prepared.setupArgs, 'utf8')), [
      'setup', '--claude', '--yes',
    ])
    await assert.rejects(readFile(journal, 'utf8'), /ENOENT/u)
  } finally {
    await rm(fixture, { recursive: true, force: true })
  }
})

for (const phase of ['prepared', 'plugin-absent', 'marketplace-absent', 'marketplace-registered']) {
  test(`Codex bootstrap retains a prior WAL in ${phase} phase without host mutation`, async () => {
    const fixture = await mkdtemp(join(tmpdir(), `tenon-install-bootstrap-cross-version-phase-${phase}-`))
    try {
      const { prepared, journal } = await preparePriorStableBridgeFixture(fixture, { phase })
      await assert.rejects(
        exec('/bin/bash', [join(root, 'install.sh'), '--codex'], { cwd: fixture, env: prepared.env }),
        (error) => {
          assert.match(error.stderr, /not an adoptable completed prior stable target/i)
          return true
        },
      )
      await assertNoHostMutation(prepared)
      assert.equal(JSON.parse(await readFile(journal, 'utf8')).phase, phase)
    } finally {
      await rm(fixture, { recursive: true, force: true })
    }
  })
}

test('Codex bootstrap rejects a current-version tag WAL whose commit is not the current proven target', async () => {
  const fixture = await mkdtemp(join(tmpdir(), 'tenon-install-bootstrap-cross-version-current-commit-'))
  try {
    const { prepared, journal } = await preparePriorStableBridgeFixture(fixture, {
      targetVersion: CURRENT_RELEASE_VERSION,
    })
    await assert.rejects(
      exec('/bin/bash', [join(root, 'install.sh'), '--codex'], { cwd: fixture, env: prepared.env }),
      (error) => {
        assert.match(error.stderr, /not an adoptable completed prior stable target/i)
        return true
      },
    )
    await assertNoHostMutation(prepared)
    assert.equal(JSON.parse(await readFile(journal, 'utf8')).target.version, CURRENT_RELEASE_VERSION)
  } finally {
    await rm(fixture, { recursive: true, force: true })
  }
})

test('Codex bootstrap rejects a newer stable target WAL before host mutation', async () => {
  const fixture = await mkdtemp(join(tmpdir(), 'tenon-install-bootstrap-cross-version-newer-'))
  try {
    const { prepared, journal } = await preparePriorStableBridgeFixture(fixture, {
      targetVersion: NEXT_RELEASE_VERSION,
    })
    await assert.rejects(
      exec('/bin/bash', [join(root, 'install.sh'), '--codex'], { cwd: fixture, env: prepared.env }),
      (error) => {
        assert.match(error.stderr, /not an adoptable completed prior stable target/i)
        return true
      },
    )
    await assertNoHostMutation(prepared)
    assert.equal(JSON.parse(await readFile(journal, 'utf8')).target.version, NEXT_RELEASE_VERSION)
  } finally {
    await rm(fixture, { recursive: true, force: true })
  }
})

for (const scenario of [
  { name: 'plugin disabled', reportedEnabled: false },
  { name: 'plugin version drift', reportedVersion: '0.0.1' },
  { name: 'plugin and Marketplace root drift', pluginRootDrift: true },
  { name: 'marketplace source/type drift', initialMarketplaceKind: 'local' },
  { name: 'marketplace HEAD drift', marketplaceMutation: 'head' },
  { name: 'marketplace ref drift', marketplaceMutation: 'ref' },
  { name: 'marketplace origin drift', marketplaceMutation: 'origin' },
  { name: 'marketplace dirty drift', marketplaceMutation: 'dirty' },
]) {
  test(`Codex bootstrap rejects ${scenario.name} while retaining the prior WAL and avoiding host mutation`, async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'tenon-install-bootstrap-cross-version-drift-'))
    try {
      const { prepared, journal } = await preparePriorStableBridgeFixture(fixture, scenario)
      if (scenario.pluginRootDrift) {
        prepared.env.TENON_TEST_PLUGIN_REPORTED_ROOT = join(fixture, 'different-plugin-root')
      }
      await assert.rejects(
        exec('/bin/bash', [join(root, 'install.sh'), '--codex'], { cwd: fixture, env: prepared.env }),
        (error) => {
          assert.match(
            error.stderr,
            scenario.name.startsWith('plugin') && !scenario.pluginRootDrift
              ? /does not match the installed plugin/i
              : scenario.pluginRootDrift
                ? /split plugin and Marketplace roots/i
                : /does not match the official clean Marketplace target/i,
          )
          return true
        },
      )
      await assertNoHostMutation(prepared)
      const retained = JSON.parse(await readFile(journal, 'utf8'))
      assert.equal(retained.phase, 'plugin-installed')
      assert.equal(retained.target.version, PRIOR_RELEASE_VERSION)
    } finally {
      await rm(fixture, { recursive: true, force: true })
    }
  })
}

test('Codex bootstrap rejects malformed and unknown-key prior WALs before host mutation', async () => {
  for (const mode of ['malformed', 'unknown', 'swapped']) {
    const fixture = await mkdtemp(join(tmpdir(), `tenon-install-bootstrap-cross-version-${mode}-`))
    try {
      const { prepared, journal, oldCommit } = await preparePriorStableBridgeFixture(fixture)
      if (mode === 'malformed') {
        await writeFile(journal, '{not-json\n')
      } else if (mode === 'unknown') {
        const value = JSON.parse(await readFile(journal, 'utf8'))
        value.unexpected = true
        await writeFile(journal, `${JSON.stringify(value)}\n`)
      } else {
        const pluginSnapshot = `present\t${prepared.plugin}\t${PRIOR_RELEASE_VERSION}\tuser\tenabled`
        const marketplaceSnapshot = `present\t${prepared.plugin}\tjefferysha/tenon\tgit\t${oldCommit}\t${PRIOR_RELEASE_TAG}\tclean\thttps://github.com/jefferysha/tenon.git`
        const value = JSON.parse(await readFile(journal, 'utf8'))
        value.before = { plugin: marketplaceSnapshot, marketplace: pluginSnapshot }
        await writeFile(journal, `${JSON.stringify(value)}\n`)
      }
      await assert.rejects(
        exec('/bin/bash', [join(root, 'install.sh'), '--codex'], { cwd: fixture, env: prepared.env }),
        (error) => {
          assert.match(error.stderr, /invalid or belongs to another target/i)
          return true
        },
      )
      await assertNoHostMutation(prepared)
      const retained = await readFile(journal, 'utf8')
      assert.match(retained, mode === 'malformed' ? /not-json/u : mode === 'unknown' ? /unexpected/u : /marketplace/u)
    } finally {
      await rm(fixture, { recursive: true, force: true })
    }
  }
})

test('Codex bootstrap resumes a current prepared WAL after takeover crashes during the first host mutation', async () => {
  const fixture = await mkdtemp(join(tmpdir(), 'tenon-install-bootstrap-cross-version-crash-'))
  try {
    const { prepared, journal } = await preparePriorStableBridgeFixture(fixture)
    const env = {
      ...prepared.env,
      TENON_TEST_FAIL_AFTER_COMMAND: 'plugin remove tenon@tenon --json',
      TENON_TEST_FAIL_AFTER_COMMAND_MARKER: join(fixture, 'fail-once'),
    }
    await assert.rejects(exec('/bin/bash', [join(root, 'install.sh'), '--codex'], {
      cwd: fixture,
      env,
    }))
    const interruptedJournal = JSON.parse(await readFile(journal, 'utf8'))
    assert.equal(interruptedJournal.target.version, CURRENT_RELEASE_VERSION)
    assert.equal(interruptedJournal.target.tag, CURRENT_RELEASE_TAG)
    assert.equal(interruptedJournal.phase, 'prepared')

    await exec('/bin/bash', [join(root, 'install.sh'), '--codex'], {
      cwd: fixture,
      env,
    })
    const commands = (await readFile(prepared.log, 'utf8')).trim().split(/\r?\n/u)
    assert.equal(commands.filter((command) => command === 'plugin remove tenon@tenon --json').length, 1)
    assert.equal(commands.filter((command) => command === 'plugin marketplace remove tenon --json').length, 1)
    assert.equal(commands.filter((command) => command.startsWith('plugin marketplace add ')).length, 1)
    assert.equal(commands.filter((command) => command === 'plugin add tenon@tenon --json').length, 1)
    await assert.rejects(readFile(journal, 'utf8'), /ENOENT/u)
  } finally {
    await rm(fixture, { recursive: true, force: true })
  }
})

test('Codex bootstrap resumes the same durable bridge transaction after marketplace add committed before phase write', async () => {
  const fixture = await mkdtemp(join(tmpdir(), 'tenon-install-bootstrap-resume-'))
  try {
    const prepared = await prepareReleasedBootstrapFixture(fixture, 'codex', {
      initiallyInstalled: true,
      initialMarketplaceKind: 'main',
    })
    const marker = join(fixture, 'fail-once')
    const env = {
      ...prepared.env,
      TENON_TEST_FAIL_AFTER_COMMAND: `plugin marketplace add jefferysha/tenon --ref ${CURRENT_RELEASE_TAG} --json`,
      TENON_TEST_FAIL_AFTER_COMMAND_MARKER: marker,
    }
    await assert.rejects(exec('/bin/bash', [join(root, 'install.sh'), '--codex'], {
      cwd: fixture,
      env,
    }))
    const journal = join(
      prepared.env.TENON_RUNTIME_HOME,
      'state',
      'installer-bridge',
      'codex.json',
    )
    assert.equal(JSON.parse(await readFile(journal, 'utf8')).phase, 'marketplace-absent')

    await exec('/bin/bash', [join(root, 'install.sh'), '--codex'], {
      cwd: fixture,
      env,
    })
    const commands = (await readFile(prepared.log, 'utf8')).trim().split(/\r?\n/u)
    assert.equal(
      commands.filter((command) =>
        command === `plugin marketplace add jefferysha/tenon --ref ${CURRENT_RELEASE_TAG} --json`).length,
      1,
    )
    assert.equal(commands.filter((command) => command === 'plugin add tenon@tenon --json').length, 1)
    await assert.rejects(readFile(journal, 'utf8'), /ENOENT/)
  } finally {
    await rm(fixture, { recursive: true, force: true })
  }
})

test('Codex bootstrap preserves a third marketplace state encountered while resuming its WAL', async () => {
  const fixture = await mkdtemp(join(tmpdir(), 'tenon-install-bootstrap-third-state-'))
  try {
    const prepared = await prepareReleasedBootstrapFixture(fixture, 'codex', {
      initiallyInstalled: true,
      initialMarketplaceKind: 'main',
    })
    const env = {
      ...prepared.env,
      TENON_TEST_FAIL_AFTER_COMMAND: `plugin marketplace add jefferysha/tenon --ref ${CURRENT_RELEASE_TAG} --json`,
      TENON_TEST_FAIL_AFTER_COMMAND_MARKER: join(fixture, 'fail-once'),
    }
    await assert.rejects(exec('/bin/bash', [join(root, 'install.sh'), '--codex'], {
      cwd: fixture,
      env,
    }))
    await exec('/usr/bin/git', ['-C', prepared.plugin, 'checkout', '--quiet', '-B', 'main'])
    await writeFile(
      join(prepared.plugin, '.codex-marketplace-install.json'),
      `${JSON.stringify({ ref_name: 'main' })}\n`,
    )
    const before = (await readFile(prepared.log, 'utf8')).trim().split(/\r?\n/u)
    await assert.rejects(
      exec('/bin/bash', [join(root, 'install.sh'), '--codex'], { cwd: fixture, env }),
      (error) => {
        assert.match(error.stderr, /neither the frozen target nor an adoptable bridge postcondition/i)
        return true
      },
    )
    const after = (await readFile(prepared.log, 'utf8')).trim().split(/\r?\n/u)
    assert.equal(after.filter((line) => /marketplace remove|marketplace add/u.test(line)).length,
      before.filter((line) => /marketplace remove|marketplace add/u.test(line)).length)
    assert.equal((await exec('/usr/bin/git', ['-C', prepared.plugin, 'branch', '--show-current'])).stdout.trim(), 'main')
  } finally {
    await rm(fixture, { recursive: true, force: true })
  }
})

test('Codex bootstrap repairs an exact but disabled Tenon registration through official remove and add', async () => {
  const fixture = await mkdtemp(join(tmpdir(), 'tenon-install-bootstrap-disabled-'))
  try {
    const prepared = await prepareReleasedBootstrapFixture(fixture, 'codex', {
      initiallyInstalled: true,
      reportedEnabled: false,
    })
    await exec('/bin/bash', [join(root, 'install.sh'), '--codex'], {
      cwd: fixture,
      env: prepared.env,
    })
    const commands = (await readFile(prepared.log, 'utf8')).trim().split(/\r?\n/u)
    const pluginRemove = commands.indexOf('plugin remove tenon@tenon --json')
    const pluginAdd = commands.indexOf('plugin add tenon@tenon --json')
    assert.ok(pluginRemove >= 0)
    assert.ok(pluginAdd > pluginRemove)
    assert.deepEqual(JSON.parse(await readFile(prepared.setupArgs, 'utf8')), [
      'setup', '--codex', '--yes',
    ])
  } finally {
    await rm(fixture, { recursive: true, force: true })
  }
})

test('Codex bootstrap preserves its WAL and refuses success when the host keeps the repaired plugin disabled', async () => {
  const fixture = await mkdtemp(join(tmpdir(), 'tenon-install-bootstrap-disabled-postcondition-'))
  try {
    const prepared = await prepareReleasedBootstrapFixture(fixture, 'codex')
    await assert.rejects(
      exec('/bin/bash', [join(root, 'install.sh'), '--codex'], {
        cwd: fixture,
        env: { ...prepared.env, TENON_TEST_KEEP_DISABLED_AFTER_ADD: '1' },
      }),
      (error) => {
        assert.match(error.stderr, /still disabled after the official remove\/add repair/i)
        return true
      },
    )
    await assert.rejects(readFile(prepared.setupArgs, 'utf8'), /ENOENT/)
    const journal = join(
      prepared.env.TENON_RUNTIME_HOME,
      'state',
      'installer-bridge',
      'codex.json',
    )
    assert.equal(JSON.parse(await readFile(journal, 'utf8')).phase, 'marketplace-registered')
  } finally {
    await rm(fixture, { recursive: true, force: true })
  }
})

test('only one concurrent public installer owns the durable host bridge', async () => {
  const fixture = await mkdtemp(join(tmpdir(), 'tenon-install-bootstrap-concurrent-lock-'))
  try {
    const prepared = await prepareReleasedBootstrapFixture(fixture, 'codex')
    const entered = join(fixture, 'host-barrier-entered')
    const release = join(fixture, 'host-barrier-release')
    const env = {
      ...prepared.env,
      TENON_TEST_HOST_BARRIER_ENTERED: entered,
      TENON_TEST_HOST_BARRIER_RELEASE: release,
    }
    const first = spawn('/bin/bash', [join(root, 'install.sh'), '--codex'], {
      cwd: fixture,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const firstDone = childCompletion(first)
    await waitForFile(entered)

    await assert.rejects(
      exec('/bin/bash', [join(root, 'install.sh'), '--codex'], { cwd: fixture, env }),
      (error) => {
        assert.match(error.stderr, /another live Tenon installer owns/i)
        return true
      },
    )
    await writeFile(release, '')
    const result = await firstDone
    assert.equal(result.code, 0, result.stderr)
    assert.deepEqual(JSON.parse(await readFile(prepared.setupArgs, 'utf8')), [
      'setup', '--codex', '--yes',
    ])
  } finally {
    await rm(fixture, { recursive: true, force: true })
  }
})

test('a stale heartbeat is reclaimed even when its PID has been reused by a live process', async () => {
  const fixture = await mkdtemp(join(tmpdir(), 'tenon-install-bootstrap-reused-pid-lock-'))
  try {
    const prepared = await prepareReleasedBootstrapFixture(fixture, 'codex')
    const lock = join(
      prepared.env.TENON_RUNTIME_HOME,
      'state',
      'host-mutation',
      'codex',
      '.pipeline.lock',
    )
    await mkdir(lock, { recursive: true })
    const owner = join(lock, 'owner.json')
    await writeFile(owner, `${JSON.stringify({
      version: 1,
      owner: '22222222-2222-4222-8222-222222222222',
      pid: process.pid,
      pidStart: 'definitely-not-the-current-process-start',
      createdAt: Date.now() - 120_000,
    })}\n`)
    const stale = new Date(Date.now() - 120_000)
    await utimes(owner, stale, stale)

    await exec('/bin/bash', [join(root, 'install.sh'), '--codex'], {
      cwd: fixture,
      env: prepared.env,
    })

    assert.deepEqual(JSON.parse(await readFile(prepared.setupArgs, 'utf8')), [
      'setup', '--codex', '--yes',
    ])
  } finally {
    await rm(fixture, { recursive: true, force: true })
  }
})

test('a live installer owner is never reclaimed merely because its heartbeat is stale', async () => {
  const fixture = await mkdtemp(join(tmpdir(), 'tenon-install-bootstrap-live-stale-lock-'))
  try {
    const prepared = await prepareReleasedBootstrapFixture(fixture, 'codex')
    const lock = join(
      prepared.env.TENON_RUNTIME_HOME,
      'state',
      'host-mutation',
      'codex',
      '.pipeline.lock',
    )
    await mkdir(lock, { recursive: true })
    const owner = join(lock, 'owner.json')
    const original = `${JSON.stringify({
      version: 1,
      owner: '33333333-3333-4333-8333-333333333333',
      pid: process.pid,
      createdAt: Date.now() - 120_000,
    })}\n`
    await writeFile(owner, original)
    const stale = new Date(Date.now() - 120_000)
    await utimes(owner, stale, stale)

    await assert.rejects(
      exec('/bin/bash', [join(root, 'install.sh'), '--codex'], {
        cwd: fixture,
        env: prepared.env,
      }),
      (error) => {
        assert.match(error.stderr, /another live Tenon installer owns/i)
        return true
      },
    )
    assert.equal(await readFile(owner, 'utf8'), original)
    await assert.rejects(readFile(prepared.setupArgs, 'utf8'), /ENOENT/)
  } finally {
    await rm(fixture, { recursive: true, force: true })
  }
})

test('the public bridge refuses the shared host-mutation lock held by a native lifecycle', async () => {
  const fixture = await mkdtemp(join(tmpdir(), 'tenon-install-bootstrap-native-lock-'))
  try {
    const prepared = await prepareReleasedBootstrapFixture(fixture, 'codex')
    const lock = join(
      prepared.env.TENON_RUNTIME_HOME,
      'state',
      'host-mutation',
      'codex',
      '.pipeline.lock',
    )
    await mkdir(lock, { recursive: true })
    const owner = join(lock, 'owner')
    const token = `${process.pid}.0123456789abcdef.${Date.now()}.bmF0aXZlLXRlc3Q`
    await writeFile(owner, `${token}\n`)

    await assert.rejects(
      exec('/bin/bash', [join(root, 'install.sh'), '--codex'], {
        cwd: fixture,
        env: prepared.env,
      }),
      (error) => {
        assert.match(error.stderr, /another live Tenon installer owns/i)
        return true
      },
    )
    assert.equal(await readFile(owner, 'utf8'), `${token}\n`)
    await assert.rejects(readFile(prepared.setupArgs, 'utf8'), /ENOENT/)
  } finally {
    await rm(fixture, { recursive: true, force: true })
  }
})

test('installer refuses a plugin enabled-state change after journaling and before removal', async () => {
  const fixture = await mkdtemp(join(tmpdir(), 'tenon-install-bootstrap-plugin-third-state-'))
  try {
    const prepared = await prepareReleasedBootstrapFixture(fixture, 'codex', { initiallyInstalled: true })
    const entered = join(fixture, 'host-barrier-entered')
    const release = join(fixture, 'host-barrier-release')
    const env = {
      ...prepared.env,
      TENON_TEST_HOST_BARRIER_ENTERED: entered,
      TENON_TEST_HOST_BARRIER_RELEASE: release,
      TENON_TEST_HOST_BARRIER_COMMAND: 'plugin list --json',
      TENON_TEST_HOST_BARRIER_AT: '2',
    }
    const child = spawn('/bin/bash', [join(root, 'install.sh'), '--codex'], {
      cwd: fixture,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const done = childCompletion(child)
    await waitForFile(entered)
    await rm(prepared.env.TENON_TEST_PLUGIN_ENABLED_STATE)
    await writeFile(release, '')
    const result = await done

    assert.notEqual(result.code, 0)
    assert.match(result.stderr, /plugin inventory changed after installer transaction preparation/i)
    const commands = await readFile(prepared.log, 'utf8')
    assert.doesNotMatch(commands, /plugin remove tenon@tenon/u)
  } finally {
    await rm(fixture, { recursive: true, force: true })
  }
})

test('installer refuses a marketplace ref change after journaling and before removal', async () => {
  const fixture = await mkdtemp(join(tmpdir(), 'tenon-install-bootstrap-marketplace-third-state-'))
  try {
    const prepared = await prepareReleasedBootstrapFixture(fixture, 'codex', { initiallyInstalled: true })
    const entered = join(fixture, 'host-barrier-entered')
    const release = join(fixture, 'host-barrier-release')
    const env = {
      ...prepared.env,
      TENON_TEST_HOST_BARRIER_ENTERED: entered,
      TENON_TEST_HOST_BARRIER_RELEASE: release,
      TENON_TEST_HOST_BARRIER_COMMAND: 'plugin marketplace list --json',
      TENON_TEST_HOST_BARRIER_AT: '2',
    }
    const child = spawn('/bin/bash', [join(root, 'install.sh'), '--codex'], {
      cwd: fixture,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const done = childCompletion(child)
    await waitForFile(entered)
    await writeFile(
      join(prepared.plugin, '.codex-marketplace-install.json'),
      `${JSON.stringify({ ref_name: 'main' })}\n`,
    )
    await writeFile(release, '')
    const result = await done

    assert.notEqual(result.code, 0)
    assert.match(result.stderr, /marketplace inventory changed after installer transaction preparation/i)
    const commands = await readFile(prepared.log, 'utf8')
    assert.doesNotMatch(commands, /plugin marketplace remove tenon/u)
  } finally {
    await rm(fixture, { recursive: true, force: true })
  }
})

test('SIGTERM exits the installer before releasing its bridge lock to the next owner', async () => {
  const fixture = await mkdtemp(join(tmpdir(), 'tenon-install-bootstrap-signal-lock-'))
  try {
    const prepared = await prepareReleasedBootstrapFixture(fixture, 'codex')
    const entered = join(fixture, 'host-barrier-entered')
    const release = join(fixture, 'host-barrier-release')
    const env = {
      ...prepared.env,
      TENON_TEST_HOST_BARRIER_ENTERED: entered,
      TENON_TEST_HOST_BARRIER_RELEASE: release,
    }
    const first = spawn('/bin/bash', [join(root, 'install.sh'), '--codex'], {
      cwd: fixture,
      env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const firstDone = childCompletion(first)
    await waitForFile(entered)
    process.kill(-first.pid, 'SIGTERM')
    const interrupted = await firstDone
    assert.notEqual(interrupted.code, 0)
    await assert.rejects(readFile(prepared.setupArgs, 'utf8'), /ENOENT/)

    const resumedEnv = { ...prepared.env }
    const resumed = await exec('/bin/bash', [join(root, 'install.sh'), '--codex'], {
      cwd: fixture,
      env: resumedEnv,
    })
    assert.equal(resumed.stderr, '')
    assert.deepEqual(JSON.parse(await readFile(prepared.setupArgs, 'utf8')), [
      'setup', '--codex', '--yes',
    ])
  } finally {
    await rm(fixture, { recursive: true, force: true })
  }
})

test('Codex bootstrap proves the exact published stable release before changing an existing installation', async () => {
  const fixture = await mkdtemp(join(tmpdir(), 'tenon-install-bootstrap-tag-proof-first-'))
  try {
    const prepared = await prepareReleasedBootstrapFixture(fixture, 'codex', {
      initiallyInstalled: true,
      remoteTagProofFails: true,
    })
    await assert.rejects(
      exec('/bin/bash', [join(root, 'install.sh'), '--codex'], {
        cwd: fixture,
        env: prepared.env,
      }),
      (error) => {
        assert.match(error.stderr, /exact stable Release/i)
        return true
      },
    )
    const commands = await readFile(prepared.log, 'utf8').catch(() => '')
    assert.doesNotMatch(commands, /plugin remove|marketplace remove|marketplace add|plugin add/u)
    await readFile(prepared.env.TENON_TEST_PLUGIN_STATE)
    await readFile(prepared.env.TENON_TEST_MARKETPLACE_STATE)
  } finally {
    await rm(fixture, { recursive: true, force: true })
  }
})


test('Codex bootstrap fails closed when the host reports a different installed version', async () => {
  const fixture = await mkdtemp(join(tmpdir(), 'tenon-install-bootstrap-wrong-version-'))
  try {
    const prepared = await prepareReleasedBootstrapFixture(fixture, 'codex', {
      reportedVersion: '1.0.1',
    })
    await assert.rejects(
      exec('bash', [join(root, 'install.sh'), '--codex'], {
        cwd: fixture,
        env: prepared.env,
      }),
      (error) => {
        assert.match(
          error.stderr,
          new RegExp(`installed plugin version 1\\.0\\.1 does not equal release ${CURRENT_RELEASE_VERSION_PATTERN}`),
        )
        return true
      },
    )
    await assert.rejects(readFile(prepared.setupArgs, 'utf8'), /ENOENT/)
  } finally {
    await rm(fixture, { recursive: true, force: true })
  }
})

test('Claude one-line bootstrap uses the same stable Marketplace channel before packaged setup', async () => {
  const fixture = await mkdtemp(join(tmpdir(), 'tenon-install-bootstrap-claude-'))
  try {
    const prepared = await prepareReleasedBootstrapFixture(fixture, 'claude')

    const result = await exec('bash', [join(root, 'install.sh'), '--claude'], {
      cwd: fixture,
      env: prepared.env,
    })
    assert.match(result.stdout, /Tenon installed for --claude/)
    const commands = await readFile(prepared.log, 'utf8')
    assert.match(
      commands,
      new RegExp(`plugin marketplace add jefferysha/tenon@${CURRENT_RELEASE_TAG_PATTERN}`),
    )
    assert.match(commands, /plugin install tenon@tenon/)
    assert.deepEqual(JSON.parse(await readFile(prepared.setupArgs, 'utf8')), [
      'setup', '--claude', '--yes',
    ])
  } finally {
    await rm(fixture, { recursive: true, force: true })
  }
})
