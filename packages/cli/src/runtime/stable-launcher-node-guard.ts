import type { TrustedExecutableProof, TrustedPathProof } from './types.js'

/** How long a hook launcher stays quiet after it printed one Node identity notice. */
const HOOK_NOTICE_QUIET_MINUTES = 30
const HOOK_NOTICE_MARKER = 'launcher-node-identity.notice'
/** Subcommands that may still run on a Node whose bytes are the pinned bytes; setup and update re-pin it. */
const REPAIR_COMMANDS = 'setup|update|doctor|runtime'

export interface NodeIdentityGuardContext {
  readonly mode: 'cli' | 'hook'
  /** Bootstrap entry the launcher execs; the manual repair command runs it with the Node on PATH. */
  readonly bootstrap: string
  /** Shell-ready `NAME='value'` assignment of the root contract; the bootstrap refuses to start without it. */
  readonly rootAssignment: string
  /** Hook launchers keep their rate-limit marker here. */
  readonly stateRoot: string
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`
}

/**
 * Only fields that survive a reboot are persisted. The device number (st_dev) is assigned per mount
 * and macOS APFS hands out a new one after every restart, so pinning it made every command fail
 * once the machine rebooted. Inode, mode, owner and size plus the content digest still identify
 * the binary.
 */
function statValue(proof: TrustedPathProof, platform: NodeJS.Platform, includeSize: boolean): string {
  const mode = platform === 'darwin' ? proof.mode.toString(8) : proof.mode.toString(16)
  return [proof.ino, mode, proof.uid, ...(includeSize ? [proof.size] : [])].join(':')
}

export function nodeIdentityGuard(
  proof: TrustedExecutableProof | undefined,
  context: NodeIdentityGuardContext,
): string {
  if (proof === undefined) return ''
  if (proof.platform !== 'darwin' && proof.platform !== 'linux') {
    throw new Error(`stable launcher 不支持持久化 ${proof.platform} Node identity`)
  }
  const exe = shellQuote(proof.executable.path)
  const statArgs = proof.platform === 'darwin' ? "-f '%i:%p:%u:%z'" : "-c '%i:%f:%u:%s'"
  const dirStatArgs = proof.platform === 'darwin' ? "-f '%i:%p:%u'" : "-c '%i:%f:%u'"
  const followArgs = proof.platform === 'darwin' ? "-L -f '%i'" : "-L -c '%i'"
  const hash = proof.platform === 'darwin'
    ? `/usr/bin/shasum -a 256 ${exe}`
    : `/usr/bin/sha256sum ${exe}`
  const plainChecks = [proof.executable, ...proof.parents]
    .map((entry) => `[ ! -L ${shellQuote(entry.path)} ]`)
  const pinChecks = [
    `[ "$(/usr/bin/stat ${statArgs} ${exe} 2>/dev/null)" = ${shellQuote(statValue(proof.executable, proof.platform, true))} ]`,
    `[ "$(/usr/bin/stat ${followArgs} ${shellQuote(proof.requestedPath)} 2>/dev/null)" = ${shellQuote(String(proof.executable.ino))} ]`,
    ...proof.parents.map((parent) =>
      `[ "$(/usr/bin/stat ${dirStatArgs} ${shellQuote(parent.path)} 2>/dev/null)" = ${shellQuote(statValue(parent, proof.platform, false))} ]`),
  ]
  const moved = 'tenon runtime Node identity changed (the pinned Node binary itself is unchanged); '
    + 'repair with: tenon setup --claude   (Codex: tenon setup --codex)'
  const changed = 'tenon runtime Node identity changed (the pinned Node binary was replaced or removed); '
    + 'trust the Node on your PATH and repair with: '
    + `env ${context.rootAssignment} node ${shellQuote(context.bootstrap)} `
    + 'cli setup --claude   (Codex: use --codex)'
  const marker = shellQuote(`${context.stateRoot}/${HOOK_NOTICE_MARKER}`)
  const outcome = context.mode === 'cli'
    ? `case "$tenon_node_state" in
  ok) ;;
  moved)
    # The bytes are the pinned bytes, so setup/update (which re-pin) and the diagnostics may run.
    case "\${1:-}" in
      ${REPAIR_COMMANDS}) ;;
      *) printf '%s\\n' ${shellQuote(moved)} >&2; exit 126 ;;
    esac ;;
  *) printf '%s\\n' ${shellQuote(changed)} >&2; exit 126 ;;
esac`
    : `# A hook must never block or spam the host: print one notice per quiet window, then fail open.
tenon_node_notice() {
  tenon_notice_marker=${marker}
  if [ -f "$tenon_notice_marker" ] && [ ! -L "$tenon_notice_marker" ] \\
    && [ -n "$(/usr/bin/find "$tenon_notice_marker" -mmin -${HOOK_NOTICE_QUIET_MINUTES} 2>/dev/null)" ]; then
    exit 0
  fi
  /bin/mkdir -p ${shellQuote(context.stateRoot)} 2>/dev/null || exit 0
  /bin/rm -f "$tenon_notice_marker" 2>/dev/null || exit 0
  ( set -C; : > "$tenon_notice_marker" ) 2>/dev/null || exit 0
  printf '%s\\n' "$1" >&2
  exit 126
}
case "$tenon_node_state" in
  ok) ;;
  moved) tenon_node_notice ${shellQuote(moved)} ;;
  *) tenon_node_notice ${shellQuote(changed)} ;;
esac`
  return `
tenon_node_state=changed
if ${plainChecks.join(' \\\n  && ')}; then
  tenon_node_digest_output="$(${hash} 2>/dev/null)" || tenon_node_digest_output=''
  if [ "\${tenon_node_digest_output%% *}" = ${shellQuote(proof.sha256)} ]; then
    tenon_node_state=moved
    if ${pinChecks.join(' \\\n      && ')}; then
      tenon_node_state=ok
    fi
  fi
fi
${outcome}
`
}
