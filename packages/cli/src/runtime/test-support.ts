import { join } from 'node:path'
import { serializeProductRootContract } from '@tenon/kernel'
import type { RuntimePaths, TrustedExecutableProof, TrustedPathProof } from './types.js'

/**
 * The stable launcher text exactly as v0.2.0 wrote it, kept to exercise the repair of installs that are
 * still in that format. It pins the device number (st_dev) of the Node binary and of every parent
 * directory. This is a fixture of a released format and is never used to write a real launcher.
 */

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`
}

function statValue(proof: TrustedPathProof, platform: NodeJS.Platform, includeSize: boolean): string {
  const mode = platform === 'darwin' ? proof.mode.toString(8) : proof.mode.toString(16)
  return [proof.dev, proof.ino, mode, proof.uid, ...(includeSize ? [proof.size] : [])].join(':')
}

function legacyNodeIdentityGuard(proof: TrustedExecutableProof): string {
  const statArgs = proof.platform === 'darwin' ? "-f '%d:%i:%p:%u:%z'" : "-c '%d:%i:%f:%u:%s'"
  const dirStatArgs = proof.platform === 'darwin' ? "-f '%d:%i:%p:%u'" : "-c '%d:%i:%f:%u'"
  const followArgs = proof.platform === 'darwin' ? "-L -f '%d:%i'" : "-L -c '%d:%i'"
  const hash = proof.platform === 'darwin'
    ? `/usr/bin/shasum -a 256 ${shellQuote(proof.executable.path)}`
    : `/usr/bin/sha256sum ${shellQuote(proof.executable.path)}`
  const parentChecks = proof.parents.map((parent) => `
[ ! -L ${shellQuote(parent.path)} ] || tenon_node_identity_changed
[ "$(/usr/bin/stat ${dirStatArgs} ${shellQuote(parent.path)} 2>/dev/null)" = ${shellQuote(statValue(parent, proof.platform, false))} ] || tenon_node_identity_changed`).join('')
  return `
tenon_node_identity_changed() {
  printf 'tenon runtime Node identity changed; rerun tenon setup --codex or tenon setup --claude\\n' >&2
  exit 126
}
[ ! -L ${shellQuote(proof.executable.path)} ] || tenon_node_identity_changed
[ "$(/usr/bin/stat ${statArgs} ${shellQuote(proof.executable.path)} 2>/dev/null)" = ${shellQuote(statValue(proof.executable, proof.platform, true))} ] || tenon_node_identity_changed
[ "$(/usr/bin/stat ${followArgs} ${shellQuote(proof.requestedPath)} 2>/dev/null)" = ${shellQuote(`${proof.executable.dev}:${proof.executable.ino}`)} ] || tenon_node_identity_changed${parentChecks}
tenon_node_digest_output="$(${hash} 2>/dev/null)" || tenon_node_identity_changed
tenon_node_digest="${'${tenon_node_digest_output%% *}'}"
[ "$tenon_node_digest" = ${shellQuote(proof.sha256)} ] || tenon_node_identity_changed
`
}

export function legacyV020LauncherText(
  paths: RuntimePaths,
  mode: 'cli' | 'hook',
  nodeExecutable: string,
  nodeProof: TrustedExecutableProof,
): string {
  const bootstrap = join(paths.bootstrapRoot, 'active.mjs')
  const rootContract = serializeProductRootContract(paths)
  const missing = mode === 'hook'
    ? 'exit 0'
    : 'printf "tenon runtime bootstrap unavailable; run tenon setup --codex or tenon setup --claude\\n" >&2\n  exit 1'
  return `#!/bin/sh
set -eu
export TENON_RUNTIME_ROOTS=${shellQuote(rootContract)}
# N-1 bootstrap ABI: previous verified releases read these exact roots during rollback.
export TENON_RUNTIME_DATA_ROOT=${shellQuote(paths.dataRoot)}
export TENON_RUNTIME_STATE_ROOT=${shellQuote(paths.stateRoot)}
export TENON_RUNTIME_CONFIG_ROOT=${shellQuote(paths.configRoot)}
export TENON_NODE_PATH=${shellQuote(nodeExecutable)}
[ -f ${shellQuote(bootstrap)} ] || { ${missing}; }
${legacyNodeIdentityGuard(nodeProof)}
exec ${shellQuote(nodeExecutable)} ${shellQuote(bootstrap)} ${mode} "$@"
`
}
