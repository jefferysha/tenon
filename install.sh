#!/bin/bash
# install.sh — bootstrap the complete Tenon plugin for one selected host.
#
# This script is part of the same repository release, not a second package manager.  Once the
# native plugin is installed, all routine setup is the normal `tenon setup --<host>` interface.
set -euo pipefail

MARKETPLACE_SOURCE="jefferysha/tenon"
MARKETPLACE_NAME="tenon"
TENON_RELEASE_VERSION="0.1.6"
GITHUB_API_TIMEOUT_SECONDS=30
GITHUB_API_SPEED_LIMIT_BYTES=1024
HOST=""
AUTO_UPDATE=0
DRY_RUN=0
REF_EXPLICIT=0
MARKETPLACE_REF="v${TENON_RELEASE_VERSION}"

usage() {
  cat <<'USAGE'
Usage: install.sh --codex|--claude [--ref <vX.Y.Z>] [--auto-update] [--dry-run]

Installs the complete Tenon plugin into the selected native marketplace, then runs the packaged
`tenon setup --<host>`. Other hosts are adapters and should be deployed from an
already installed Codex or Claude package with `tenon setup --cursor` (and similar flags).
`--dry-run` prints the complete host and packaged setup plan without invoking either host.
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --codex|--claude)
      [ -z "$HOST" ] || { echo "install.sh: choose exactly one host" >&2; exit 2; }
      HOST="${1#--}"
      ;;
    --auto-update) AUTO_UPDATE=1 ;;
    --ref)
      [ $# -ge 2 ] || { echo "install.sh: --ref requires a value" >&2; exit 2; }
      MARKETPLACE_REF="$2"
      REF_EXPLICIT=1
      shift
      ;;
    --dry-run) DRY_RUN=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "install.sh: unsupported argument $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done
[ -n "$HOST" ] || { usage >&2; exit 2; }
[[ "$MARKETPLACE_REF" =~ ^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]] || {
  echo "install.sh: --ref must be a complete stable tag vX.Y.Z; got $MARKETPLACE_REF" >&2
  exit 2
}
[ "$HOST" = codex ] || [ "$REF_EXPLICIT" = 0 ] || {
  echo "install.sh: --ref is supported only for Codex Marketplace installs" >&2
  exit 2
}
[ "$MARKETPLACE_REF" = "v${TENON_RELEASE_VERSION}" ] || {
  echo "install.sh: this v${TENON_RELEASE_VERSION} installer can only install v${TENON_RELEASE_VERSION}; fetch the installer from the requested release tag." >&2
  exit 2
}

if [ "$DRY_RUN" = 1 ]; then
  echo "[dry-run] Tenon --${HOST} 一步安装计划："
  case "$HOST" in
    codex)
      echo "  preflight: require codex CLI in PATH (missing: npm install -g @openai/codex; verify: codex --version)"
      echo "  inspect and remove any existing tenon plugin/marketplace registration"
      echo "  codex plugin marketplace add ${MARKETPLACE_SOURCE} --ref ${MARKETPLACE_REF}"
      echo "  codex plugin add tenon@${MARKETPLACE_NAME} --json"
      echo "  codex plugin list --json"
      echo "  packaged setup: read-only codex login status; if needed, print ChatGPT/device/API-key guidance"
      ;;
    claude)
      echo "  inspect and remove any existing tenon plugin/marketplace registration"
      echo "  claude plugin marketplace add ${MARKETPLACE_SOURCE}@${MARKETPLACE_REF}"
      echo "  claude plugin install tenon@${MARKETPLACE_NAME}"
      echo "  claude plugin list --json"
      ;;
  esac
  SETUP_PLAN="tenon setup --${HOST} --yes --dry-run"
  [ "$AUTO_UPDATE" = 1 ] && SETUP_PLAN="${SETUP_PLAN} --auto-update"
  echo "  ${SETUP_PLAN}"
  echo "  verify: exact ${MARKETPLACE_REF} ref + commit, clean checkout, versioned inventory/manifests, packaged assets, managed runtime, and Dashboard readiness"
  echo "[dry-run] 未调用宿主命令，未写入 Tenon 或项目状态。"
  exit 0
fi

resolve_trusted_path_command() {
  local command_name="$1" path_entry
  local -a path_entries=()
  IFS=: read -r -a path_entries <<< "${PATH:-}"
  for path_entry in "${path_entries[@]}"; do
    [ -n "$path_entry" ] || continue
    case "$path_entry" in
      /*) ;;
      *) continue ;;
    esac
    if [ -f "$path_entry/$command_name" ] && [ -x "$path_entry/$command_name" ]; then
      printf '%s\n' "$path_entry/$command_name"
      return 0
    fi
  done
  return 1
}

trusted_absolute_path() {
  local path_entry joined=""
  local -a path_entries=()
  IFS=: read -r -a path_entries <<< "${PATH:-}"
  for path_entry in "${path_entries[@]}"; do
    case "$path_entry" in
      /*) joined="${joined:+${joined}:}${path_entry}" ;;
    esac
  done
  printf '%s\n' "$joined"
}

HOST_BIN="$(resolve_trusted_path_command "$HOST" || true)"
NODE_BIN="$(resolve_trusted_path_command node || true)"
GIT_BIN="$(resolve_trusted_path_command git || true)"
BASH_BIN="$(resolve_trusted_path_command bash || true)"
CURL_BIN="$(resolve_trusted_path_command curl || true)"

if [ -z "$HOST_BIN" ]; then
  echo "install.sh: ${HOST} CLI was not found in a trusted absolute PATH entry; no plugin or Tenon state was changed." >&2
  if [ "$HOST" = codex ]; then
    echo "Install it first: npm install -g @openai/codex" >&2
  else
    echo "Install it first: npm install -g @anthropic-ai/claude-code" >&2
  fi
  echo "Then verify it is available: ${HOST} --version" >&2
  exit 1
fi
[ -n "$NODE_BIN" ] || { echo "install.sh: node is required before any plugin mutation." >&2; exit 1; }
[ -n "$GIT_BIN" ] || { echo "install.sh: git is required before any plugin mutation." >&2; exit 1; }
[ -n "$BASH_BIN" ] || { echo "install.sh: bash is required before any plugin mutation." >&2; exit 1; }
[ -n "$CURL_BIN" ] || { echo "install.sh: curl is required before any plugin mutation." >&2; exit 1; }

physical_path() {
  local requested="$1" candidate target dir base
  candidate="$requested"
  while [ -L "$candidate" ]; do
    target="$(/usr/bin/readlink "$candidate")" || return 1
    case "$target" in
      /*) candidate="$target" ;;
      *) candidate="${candidate%/*}/$target" ;;
    esac
  done
  [ -f "$candidate" ] && [ -x "$candidate" ] || return 1
  dir="$(cd -P "${candidate%/*}" 2>/dev/null && pwd -P)" || return 1
  base="${candidate##*/}"
  printf '%s/%s\n' "$dir" "$base"
}

stat_identity() {
  if /usr/bin/stat -f '%d:%i:%p:%u' "$1" >/dev/null 2>&1; then
    /usr/bin/stat -f '%d:%i:%p:%u' "$1"
  else
    /usr/bin/stat -Lc '%d:%i:%f:%u' "$1"
  fi
}

stat_file_identity() {
  if /usr/bin/stat -f '%d:%i:%p:%z:%m:%c:%u' "$1" >/dev/null 2>&1; then
    /usr/bin/stat -f '%d:%i:%p:%z:%m:%c:%u' "$1"
  else
    /usr/bin/stat -Lc '%d:%i:%f:%s:%Y:%Z:%u' "$1"
  fi
}

file_digest() {
  local output
  if [ -x /usr/bin/shasum ]; then
    output="$(/usr/bin/shasum -a 256 "$1")" || return 1
  elif [ -x /usr/bin/sha256sum ]; then
    output="$(/usr/bin/sha256sum "$1")" || return 1
  elif [ -x /bin/sha256sum ]; then
    output="$(/bin/sha256sum "$1")" || return 1
  else
    return 1
  fi
  printf '%s\n' "${output%% *}"
}

stat_permissions() {
  if /usr/bin/stat -f '%Lp' "$1" >/dev/null 2>&1; then
    /usr/bin/stat -f '%Lp' "$1"
  else
    /usr/bin/stat -Lc '%a' "$1"
  fi
}

tool_identity() {
  local requested="$1" physical dir info owner digest dir_info dir_owner permissions numeric chain=""
  physical="$(physical_path "$requested")" || return 1
  [ ! -L "$physical" ] || return 1
  info="$(stat_file_identity "$physical")" || return 1
  owner="${info##*:}"
  permissions="$(stat_permissions "$physical")" || return 1
  numeric=$((8#$permissions))
  (( (numeric & 0022) == 0 )) || return 1
  [ "$owner" = 0 ] || [ "$owner" = "$UID" ] || return 1
  digest="$(file_digest "$physical")" || return 1
  dir="${physical%/*}"
  while :; do
    [ -d "$dir" ] && [ ! -L "$dir" ] || return 1
    permissions="$(stat_permissions "$dir")" || return 1
    dir_info="$(stat_identity "$dir")" || return 1
    dir_owner="${dir_info##*:}"
    numeric=$((8#$permissions))
    # Sticky temp roots protect owned children. Owner-controlled package-manager roots (for
    # example Homebrew's 0775 Cellar) are also accepted, but another owner or world-writable
    # non-sticky ancestor remains an executable substitution boundary.
    if (( (numeric & 0002) != 0 && (numeric & 01000) == 0 )); then return 1; fi
    if (( (numeric & 0020) != 0 && (numeric & 01000) == 0 )) && [ "$dir_owner" != "$owner" ]; then return 1; fi
    chain="${chain}|${dir}:${dir_info}"
    [ "$dir" = / ] && break
    dir="${dir%/*}"
    [ -n "$dir" ] || dir=/
  done
  printf '%s|%s|sha256:%s%s\n' "$physical" "$info" "$digest" "$chain"
}

freeze_tool() {
  local name="$1" requested="$2" frozen physical
  frozen="$(tool_identity "$requested")" || return 1
  physical="${frozen%%|*}"
  printf -v "${name}_BIN" '%s' "$physical"
  printf -v "${name}_REQUESTED" '%s' "$requested"
  printf -v "${name}_IDENTITY" '%s' "$frozen"
}

verify_tool() {
  local name="$1" requested_var="${1}_REQUESTED" identity_var="${1}_IDENTITY"
  local requested="${!requested_var}" expected="${!identity_var}" current
  current="$(tool_identity "$requested")" || return 1
  [ "$current" = "$expected" ]
}

run_host() { verify_tool HOST || { echo "install.sh: trusted ${HOST} executable identity changed; refusing spawn." >&2; return 126; }; "$HOST_BIN" "$@"; }
run_node() { verify_tool NODE || { echo "install.sh: trusted node executable identity changed; refusing spawn." >&2; return 126; }; "$NODE_BIN" "$@"; }
run_git() { verify_tool GIT || { echo "install.sh: trusted git executable identity changed; refusing spawn." >&2; return 126; }; "$GIT_BIN" "$@"; }
run_bash() { verify_tool BASH || { echo "install.sh: trusted bash executable identity changed; refusing spawn." >&2; return 126; }; "$BASH_BIN" "$@"; }
run_curl() { verify_tool CURL || { echo "install.sh: trusted curl executable identity changed; refusing spawn." >&2; return 126; }; "$CURL_BIN" "$@"; }

freeze_tool HOST "$HOST_BIN" || { echo "install.sh: ${HOST} executable or parent path is not physically trustworthy." >&2; exit 1; }
freeze_tool NODE "$NODE_BIN" || { echo "install.sh: node executable or parent path is not physically trustworthy." >&2; exit 1; }
freeze_tool GIT "$GIT_BIN" || { echo "install.sh: git executable or parent path is not physically trustworthy." >&2; exit 1; }
freeze_tool BASH "$BASH_BIN" || { echo "install.sh: bash executable or parent path is not physically trustworthy." >&2; exit 1; }
freeze_tool CURL "$CURL_BIN" || { echo "install.sh: curl executable or parent path is not physically trustworthy." >&2; exit 1; }
TRUSTED_PATH="$(trusted_absolute_path)"
[ -n "$TRUSTED_PATH" ] || { echo "install.sh: no trusted absolute PATH entries remain." >&2; exit 1; }
export PATH="$TRUSTED_PATH"

host_plugin_list() {
  run_host plugin list --json
}

host_marketplace_list() {
  run_host plugin marketplace list --json
}

decode_plugin_state() {
  run_node -e '
    const host = process.argv[1];
    let text = "";
    process.stdin.on("data", c => { text += c });
    process.stdin.on("end", () => {
      let value;
      try { value = JSON.parse(text); } catch { process.exit(10); }
      const entries = host === "codex" ? value?.installed : value;
      if (!Array.isArray(entries)) process.exit(11);
      const matches = entries.filter((item) => item && typeof item === "object" && (
        host === "codex"
          ? item.pluginId === "tenon@tenon" || (item.name === "tenon" && item.marketplaceName === "tenon")
          : item.id === "tenon@tenon"
      ));
      if (matches.length === 0) { process.stdout.write("absent"); return; }
      if (matches.length !== 1) process.exit(12);
      const item = matches[0];
      if (typeof item.enabled !== "boolean") process.exit(13);
      const root = host === "codex" ? item.source?.path : item.installPath;
      const scope = host === "claude" ? (item.scope ?? "user") : "user";
      if (typeof root !== "string" || !root.startsWith("/") || /[\r\n\t]/u.test(root)
        || typeof item.version !== "string" || /[\r\n\t]/u.test(item.version)
        || typeof scope !== "string" || /[\r\n\t]/u.test(scope)) process.exit(14);
      process.stdout.write(`present\t${root}\t${item.version}\t${scope}\t${item.enabled ? "enabled" : "disabled"}`);
    });
  ' "$HOST"
}

decode_marketplace_state() {
  run_node -e '
    const host = process.argv[1];
    let text = "";
    process.stdin.on("data", c => { text += c });
    process.stdin.on("end", () => {
      let value;
      try { value = JSON.parse(text); } catch { process.exit(20); }
      const entries = host === "codex" ? value?.marketplaces : value;
      if (!Array.isArray(entries)) process.exit(21);
      const matches = entries.filter((item) => item && typeof item === "object" && item.name === "tenon");
      if (matches.length === 0) { process.stdout.write("absent"); return; }
      if (matches.length !== 1) process.exit(22);
      const item = matches[0];
      const root = host === "codex" ? item.root : item.installLocation;
      const source = host === "codex" ? item.marketplaceSource?.source : item.repo;
      const sourceType = host === "codex" ? item.marketplaceSource?.sourceType : item.source;
      if (![root, source, sourceType].every(x => typeof x === "string" && x !== "" && !/[\r\n\t]/u.test(x))
        || !root.startsWith("/")) process.exit(23);
      process.stdout.write(`present\t${root}\t${source}\t${sourceType}`);
    });
  ' "$HOST"
}

read_plugin_state() {
  local inventory
  if ! inventory="$(host_plugin_list)"; then
    echo "install.sh: ${HOST} plugin inventory could not be read; no new mutation was started." >&2
    return 1
  fi
  if ! printf '%s' "$inventory" | decode_plugin_state; then
    echo "install.sh: ${HOST} plugin inventory was malformed or ambiguous." >&2
    return 1
  fi
}

codex_marketplace_ref() {
  local root="$1" config_home
  config_home="${CODEX_HOME:-$HOME/.codex}"
  run_node -e '
    const fs = require("node:fs");
    const [configPath, legacyPath] = process.argv.slice(1);
    const read = path => { try { return fs.readFileSync(path, "utf8"); } catch (error) {
      if (error?.code === "ENOENT") return null; process.exit(50);
    } };
    const config = read(configPath);
    if (config !== null) {
      let inside = false, sections = 0, seen = false, ref = null;
      for (const line of config.split(/\r?\n/u)) {
        const section = /^\s*\[([^\]]+)\]\s*(?:#.*)?$/u.exec(line);
        if (section) { inside = section[1].trim() === "marketplaces.tenon"; if (inside && ++sections > 1) process.exit(51); continue; }
        if (!inside || /^\s*(?:#.*)?$/u.test(line) || !/^\s*ref\s*=/u.test(line)) continue;
        if (seen) process.exit(52); seen = true;
        const assignment = /^\s*ref\s*=\s*(?:"([^"\\\r\n]+)"|\x27([^\x27\r\n]+)\x27)\s*(?:#.*)?$/u.exec(line);
        ref = assignment?.[1] ?? assignment?.[2] ?? null; if (ref === null) process.exit(53);
      }
      if (ref !== null) { process.stdout.write(ref); process.exit(0); }
    }
    const legacy = read(legacyPath); if (legacy === null) process.exit(54);
    let value; try { value = JSON.parse(legacy); } catch { process.exit(55); }
    if (typeof value?.ref_name !== "string" || value.ref_name === "" || /[\r\n\t]/u.test(value.ref_name)) process.exit(56);
    process.stdout.write(value.ref_name);
  ' "$config_home/config.toml" "$root/.codex-marketplace-install.json"
}

read_marketplace_state() {
  local inventory basic presence root source source_type head ref clean origin untracked
  if ! inventory="$(host_marketplace_list)"; then
    echo "install.sh: ${HOST} marketplace inventory could not be read; no new mutation was started." >&2
    return 1
  fi
  if ! basic="$(printf '%s' "$inventory" | decode_marketplace_state)"; then
    echo "install.sh: ${HOST} marketplace inventory was malformed or ambiguous." >&2
    return 1
  fi
  [ "$basic" != absent ] || { printf 'absent\n'; return 0; }
  IFS=$'\t' read -r presence root source source_type <<< "$basic"
  head="$(run_git -C "$root" rev-parse HEAD)" || return 1
  [[ "$head" =~ ^[a-f0-9]{40}$ ]] || return 1
  origin="$(run_git -C "$root" remote get-url origin)" || return 1
  [ -n "$origin" ] && [[ "$origin" != *$'\n'* ]] && [[ "$origin" != *$'\t'* ]] || return 1
  if [ "$HOST" = codex ]; then
    ref="$(codex_marketplace_ref "$root")" || return 1
  else
    ref="$(run_git -C "$root" symbolic-ref --quiet --short HEAD 2>/dev/null \
      || run_git -C "$root" describe --tags --exact-match HEAD)" || return 1
  fi
  [ -n "$ref" ] && [[ "$ref" != *$'\n'* ]] && [[ "$ref" != *$'\t'* ]] || return 1
  clean=clean
  run_git -C "$root" diff --quiet HEAD -- || clean=dirty
  while IFS= read -r untracked; do
    [ -z "$untracked" ] && continue
    [ "$HOST" = codex ] && [ "$untracked" = .codex-marketplace-install.json ] && continue
    clean=dirty
  done < <(run_git -C "$root" ls-files --others --exclude-standard)
  printf 'present\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$root" "$source" "$source_type" "$head" "$ref" "$clean" "$origin"
}

github_api_get() {
  run_curl --proto '=https' --tlsv1.2 --silent --show-error --fail \
    --connect-timeout "$GITHUB_API_TIMEOUT_SECONDS" \
    --max-time "$GITHUB_API_TIMEOUT_SECONDS" \
    --speed-time "$GITHUB_API_TIMEOUT_SECONDS" \
    --speed-limit "$GITHUB_API_SPEED_LIMIT_BYTES" \
    -H 'Accept: application/vnd.github+json' \
    -H 'X-GitHub-Api-Version: 2022-11-28' \
    -H 'User-Agent: tenon-release-installer' "$1"
}

RELEASE_METADATA="$(github_api_get \
  "https://api.github.com/repos/${MARKETPLACE_SOURCE}/releases/tags/${MARKETPLACE_REF}")" || {
  echo "install.sh: exact stable Release is unavailable or timed out; existing installation was not changed." >&2
  exit 1
}
printf '%s' "$RELEASE_METADATA" | run_node -e '
  const [tag, repository] = process.argv.slice(1); let text = "";
  process.stdin.on("data", chunk => { text += chunk }); process.stdin.on("end", () => {
    let value; try { value = JSON.parse(text); } catch { process.exit(41); }
    const expectedUrl = `https://github.com/${repository}/releases/tag/${tag}`;
    if (!value || typeof value !== "object" || value.tag_name !== tag
      || value.draft !== false || value.prerelease !== false
      || value.html_url !== expectedUrl || typeof value.published_at !== "string"
      || !/^\d{4}-\d{2}-\d{2}T/u.test(value.published_at)) process.exit(42);
  });
' "$MARKETPLACE_REF" "$MARKETPLACE_SOURCE" || {
  echo "install.sh: exact Release is not an official published stable release; existing installation was not changed." >&2
  exit 1
}

TAG_OBJECT="$(github_api_get \
  "https://api.github.com/repos/${MARKETPLACE_SOURCE}/git/ref/tags/${MARKETPLACE_REF}")" || {
  echo "install.sh: stable tag object proof is unavailable or timed out; existing installation was not changed." >&2
  exit 1
}
TAG_DEPTH=0
while :; do
  if [ "$TAG_DEPTH" = 0 ]; then OBJECT_KIND=ref; else OBJECT_KIND=tag; fi
  OBJECT_IDENTITY="$(printf '%s' "$TAG_OBJECT" | run_node -e '
    const [kind, expectedTag] = process.argv.slice(1); let text = "";
    process.stdin.on("data", chunk => { text += chunk }); process.stdin.on("end", () => {
      let value; try { value = JSON.parse(text); } catch { process.exit(43); }
      const object = value?.object;
      if (!object || typeof object !== "object" || !/^[a-f0-9]{40}$/u.test(object.sha)
        || !["tag", "commit", "tree", "blob"].includes(object.type)) process.exit(44);
      if (kind === "ref" && value.ref !== `refs/tags/${expectedTag}`) process.exit(45);
      if (kind === "tag" && value.tag !== expectedTag) process.exit(46);
      process.stdout.write(`${object.type}\t${object.sha}`);
    });
  ' "$OBJECT_KIND" "$MARKETPLACE_REF")" || {
    echo "install.sh: stable tag object proof is malformed; existing installation was not changed." >&2
    exit 1
  }
  IFS=$'\t' read -r OBJECT_TYPE OBJECT_SHA <<< "$OBJECT_IDENTITY"
  case "$OBJECT_TYPE" in
    commit) TARGET_COMMIT="$OBJECT_SHA"; break ;;
    tag)
      TAG_DEPTH=$((TAG_DEPTH + 1))
      [ "$TAG_DEPTH" -le 8 ] || {
        echo "install.sh: stable tag object chain is too deep; existing installation was not changed." >&2
        exit 1
      }
      TAG_OBJECT="$(github_api_get \
        "https://api.github.com/repos/${MARKETPLACE_SOURCE}/git/tags/${OBJECT_SHA}")" || {
        echo "install.sh: annotated tag object proof is unavailable or timed out; existing installation was not changed." >&2
        exit 1
      }
      ;;
    *)
      echo "install.sh: stable tag final object is not a commit; existing installation was not changed." >&2
      exit 1
      ;;
  esac
done

# The public bootstrap must touch the host before the packaged CLI exists. Keep that narrow bridge
# inside a Tenon-owned, crash-resumable transaction instead of treating shell command order as a
# transaction. The owner lease serializes concurrent installers; a dead owner can be atomically
# retired by the next invocation.
INSTALL_STATE_ROOT="$(run_node -e '
  const path = require("node:path");
  const env = process.env;
  const home = env.HOME;
  if (typeof home !== "string" || !path.isAbsolute(home)) process.exit(70);
  let stateRoot;
  if (env.TENON_RUNTIME_ROOTS) {
    let roots; try { roots = JSON.parse(env.TENON_RUNTIME_ROOTS); } catch { process.exit(71); }
    if (roots?.version !== 1 || typeof roots.stateRoot !== "string" || !path.isAbsolute(roots.stateRoot)) process.exit(72);
    stateRoot = roots.stateRoot;
  } else if (env.TENON_RUNTIME_HOME) {
    if (!path.isAbsolute(env.TENON_RUNTIME_HOME)) process.exit(73);
    stateRoot = path.join(env.TENON_RUNTIME_HOME, "state");
  } else if (process.platform === "darwin") {
    stateRoot = path.join(home, "Library", "Application Support", "tenon", "state");
  } else {
    stateRoot = path.join(env.XDG_STATE_HOME && path.isAbsolute(env.XDG_STATE_HOME)
      ? env.XDG_STATE_HOME : path.join(home, ".local", "state"), "tenon");
  }
  process.stdout.write(stateRoot);
')" || { echo "install.sh: managed installer state root is not provable." >&2; exit 1; }
INSTALL_JOURNAL_DIR="$INSTALL_STATE_ROOT/installer-bridge"
INSTALL_JOURNAL="$INSTALL_JOURNAL_DIR/${HOST}.json"
INSTALL_LOCK_ROOT="$INSTALL_STATE_ROOT/host-mutation/${HOST}"
INSTALL_LOCK="$INSTALL_LOCK_ROOT/.pipeline.lock"
INSTALL_OWNER="$(run_node -e 'process.stdout.write(require("node:crypto").randomUUID())')"
run_node -e '
  const fs = require("node:fs");
  fs.mkdirSync(process.argv[1], { recursive: true, mode: 0o700 });
' "$INSTALL_JOURNAL_DIR"

acquire_installer_lock() {
  run_node -e '
    const fs = require("node:fs"); const path = require("node:path");
    const { execFileSync } = require("node:child_process");
    const [root, lock, owner, rawPid] = process.argv.slice(1);
    const pid = Number(rawPid);
    if (!Number.isSafeInteger(pid) || pid <= 0) process.exit(80);
    const processStart = (candidatePid) => {
      try {
        if (process.platform === "linux") {
          const raw = fs.readFileSync(`/proc/${candidatePid}/stat`, "utf8");
          const close = raw.lastIndexOf(")");
          if (close < 0) return null;
          const fields = raw.slice(close + 2).trim().split(/\s+/u);
          const start = fields[19];
          return start && /^[0-9]+$/u.test(start) ? `linux:${start}` : null;
        }
        const ps = process.platform === "darwin" ? "/bin/ps" : "/usr/bin/ps";
        const start = execFileSync(ps, ["-o", "lstart=", "-p", String(candidatePid)], {
          encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
        }).trim();
        return start === "" ? null : `${process.platform}:${start}`;
      } catch { return null; }
    };
    const pidStart = processStart(pid);
    if (pidStart === null) process.exit(80);
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    const claim = `${lock}.claim-${owner}`;
    fs.mkdirSync(claim, { mode: 0o700 });
    const claimOwner = path.join(claim, "owner.json");
    const claimFd = fs.openSync(claimOwner, "wx", 0o600);
    try {
      fs.writeFileSync(claimFd, JSON.stringify({ version: 1, owner, pid, pidStart, createdAt: Date.now() }) + "\n");
      fs.fsyncSync(claimFd);
    } finally { fs.closeSync(claimFd); }
    let acquired = false, exitCode = 82;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      let created = false;
      try {
        // mkdir is the portable no-overwrite claim. The complete private owner record is then
        // hard-linked atomically; observers treat an owner-less crash window as unknown/live.
        fs.mkdirSync(lock, { mode: 0o700 });
        created = true;
        fs.linkSync(claimOwner, path.join(lock, "owner.json"));
        fs.rmSync(claim, { recursive: true, force: true });
        acquired = true;
        break;
      } catch (error) {
        if (created) {
          try { fs.unlinkSync(path.join(lock, "owner.json")); } catch {}
          try { fs.rmdirSync(lock); } catch {}
          throw error;
        }
        if (error?.code !== "EEXIST") throw error;
      }
      let current;
      try {
        const item = fs.lstatSync(lock);
        const ownerPath = path.join(lock, "owner.json");
        const ownerItem = fs.lstatSync(ownerPath);
        current = JSON.parse(fs.readFileSync(ownerPath, "utf8"));
        if (!item.isDirectory() || item.isSymbolicLink()
          || !ownerItem.isFile() || ownerItem.isSymbolicLink()
          || !["createdAt,owner,pid,pidStart,version", "createdAt,owner,pid,version"]
            .includes(Object.keys(current ?? {}).sort().join(","))
          || current.version !== 1 || !/^[0-9a-f-]{36}$/u.test(current.owner)
          || !Number.isSafeInteger(current.pid) || current.pid <= 0
          || (current.pidStart !== undefined && (typeof current.pidStart !== "string" || current.pidStart === ""))
          || !Number.isSafeInteger(current.createdAt) || current.createdAt <= 0) {
          exitCode = 81; break;
        }
        current.heartbeatAge = Date.now() - ownerItem.mtimeMs;
      } catch { exitCode = 81; break; }
      let ownerDead = false;
      try {
        process.kill(current.pid, 0);
        const observedStart = processStart(current.pid);
        if (current.pidStart === undefined || observedStart === null || observedStart === current.pidStart) {
          exitCode = 81; break;
        }
        ownerDead = true;
      } catch (error) {
        if (error?.code !== "ESRCH") { exitCode = 81; break; }
        ownerDead = true;
      }
      if (!ownerDead) { exitCode = 81; break; }
      // The observed dead owner names a permanent no-overwrite tombstone. If another contender
      // already retired it and published a new live lock, this rename cannot replace that lock
      // because the non-empty tombstone destination already exists.
      const stale = `${lock}.stale-${current.owner}`;
      try { fs.renameSync(lock, stale); } catch (error) {
        if (error?.code !== "ENOENT" && error?.code !== "EEXIST" && error?.code !== "ENOTEMPTY") throw error;
      }
    }
    if (!acquired) fs.rmSync(claim, { recursive: true, force: true });
    process.exit(acquired ? 0 : exitCode);
  ' "$INSTALL_LOCK_ROOT" "$INSTALL_LOCK" "$INSTALL_OWNER" "$$"
}

release_installer_lock() {
  run_node -e '
    const fs = require("node:fs"); const path = require("node:path");
    const [lock, owner] = process.argv.slice(1);
    const ownerPath = path.join(lock, "owner.json");
    let current; try { current = JSON.parse(fs.readFileSync(ownerPath, "utf8")); } catch { process.exit(0); }
    if (current?.version !== 1 || current.owner !== owner) process.exit(0);
    // Remove only this immutable owner record, then the now-empty directory. Never recursively
    // delete a same-name path: unexpected/successor contents must survive and fail closed.
    try { fs.unlinkSync(ownerPath); } catch { process.exit(0); }
    try { fs.rmdirSync(lock); } catch { /* preserve non-empty or replaced state */ }
  ' "$INSTALL_LOCK" "$INSTALL_OWNER" >/dev/null 2>&1 || true
}

INSTALL_PROCESS_PID="$$"
INSTALL_HEARTBEAT_PID=""
heartbeat_installer_lock() {
  while kill -0 "$INSTALL_PROCESS_PID" 2>/dev/null; do
    /bin/sleep 5
    run_node -e '
      const fs = require("node:fs"); const path = require("node:path");
      const [lock, owner] = process.argv.slice(1);
      let current;
      try { current = JSON.parse(fs.readFileSync(path.join(lock, "owner.json"), "utf8")); } catch { process.exit(1); }
      if (current?.version !== 1 || current.owner !== owner) process.exit(1);
      const now = new Date(); fs.utimesSync(path.join(lock, "owner.json"), now, now);
    ' "$INSTALL_LOCK" "$INSTALL_OWNER" >/dev/null 2>&1 || {
      kill -TERM "$INSTALL_PROCESS_PID" 2>/dev/null || true
      return 1
    }
  done
}

stop_installer_heartbeat() {
  if [ -n "$INSTALL_HEARTBEAT_PID" ]; then
    kill "$INSTALL_HEARTBEAT_PID" 2>/dev/null || true
    wait "$INSTALL_HEARTBEAT_PID" 2>/dev/null || true
    INSTALL_HEARTBEAT_PID=""
  fi
}

if ! acquire_installer_lock; then
  echo "install.sh: another live Tenon installer owns the --${HOST} bridge transaction; retry after it exits." >&2
  exit 1
fi
heartbeat_installer_lock &
INSTALL_HEARTBEAT_PID="$!"
trap 'stop_installer_heartbeat; release_installer_lock' EXIT
trap 'trap - INT; exit 130' INT
trap 'trap - TERM; exit 143' TERM

read_installer_journal() {
  run_node -e '
    const fs = require("node:fs");
    const [file, host] = process.argv.slice(1);
    let j; try { j = JSON.parse(fs.readFileSync(file, "utf8")); } catch { process.exit(90); }
    const keys = Object.keys(j ?? {}).sort().join(",");
    const targetKeys = Object.keys(j?.target ?? {}).sort().join(",");
    const beforeKeys = Object.keys(j?.before ?? {}).sort().join(",");
    const stableVersion = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u;
    const safePluginState = value => typeof value === "string" && (
      value === "absent"
      || /^present\t\/[^\r\n\t]+\t[^\r\n\t]+\t[^\r\n\t]+\t(?:enabled|disabled)$/u.test(value)
    );
    const safeMarketplaceState = value => typeof value === "string" && (
      value === "absent"
      || /^present\t\/[^\r\n\t]+\t[^\r\n\t]+\t[^\r\n\t]+\t[a-f0-9]{40}\t[^\r\n\t]+\t(?:clean|dirty)\t[^\r\n\t]+$/u.test(value)
    );
    if (keys !== "before,host,phase,target,transactionId,version" || j.version !== 1
      || j.host !== host || targetKeys !== "commit,tag,version" || typeof j.target?.version !== "string"
      || !stableVersion.test(j.target.version) || j.target.tag !== `v${j.target.version}`
      || typeof j.target.commit !== "string" || !/^[a-f0-9]{40}$/u.test(j.target.commit)
      || beforeKeys !== "marketplace,plugin" || !safePluginState(j.before.plugin)
      || !safeMarketplaceState(j.before.marketplace)
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(j.transactionId)
      || !["prepared", "plugin-absent", "marketplace-absent", "marketplace-registered", "plugin-installed"].includes(j.phase)) process.exit(91);
    process.stdout.write([
      j.transactionId, j.phase, j.target.version, j.target.tag, j.target.commit,
    ].join("\t"));
  ' "$INSTALL_JOURNAL" "$HOST"
}

create_installer_journal() {
  local plugin_before="$1" marketplace_before="$2"
  INSTALL_TRANSACTION="$(run_node -e 'process.stdout.write(require("node:crypto").randomUUID())')"
  run_node -e '
    const fs = require("node:fs"); const path = require("node:path");
    const [file, transactionId, host, version, tag, commit, plugin, marketplace, owner] = process.argv.slice(1);
    const value = { version: 1, transactionId, host, target: { version, tag, commit }, phase: "prepared", before: { plugin, marketplace } };
    const temp = `${file}.tmp-${owner}`;
    const fd = fs.openSync(temp, "wx", 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(value) + "\n"); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temp, file);
    try { const dir = fs.openSync(path.dirname(file), "r"); fs.fsyncSync(dir); fs.closeSync(dir); } catch {}
  ' "$INSTALL_JOURNAL" "$INSTALL_TRANSACTION" "$HOST" "$TENON_RELEASE_VERSION" "$MARKETPLACE_REF" "$TARGET_COMMIT" "$plugin_before" "$marketplace_before" "$INSTALL_OWNER"
  INSTALL_PHASE=prepared
}

advance_installer_phase() {
  local expected="$1" next="$2"
  run_node -e '
    const fs = require("node:fs"); const path = require("node:path");
    const [file, transactionId, expected, next, owner] = process.argv.slice(1);
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    if (value?.version !== 1 || value.transactionId !== transactionId || value.phase !== expected) process.exit(92);
    value.phase = next;
    const temp = `${file}.tmp-${owner}`;
    const fd = fs.openSync(temp, "wx", 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(value) + "\n"); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temp, file);
    try { const dir = fs.openSync(path.dirname(file), "r"); fs.fsyncSync(dir); fs.closeSync(dir); } catch {}
  ' "$INSTALL_JOURNAL" "$INSTALL_TRANSACTION" "$expected" "$next" "$INSTALL_OWNER"
  INSTALL_PHASE="$next"
}

assert_installer_before() {
  local component="$1" current="$2"
  run_node -e '
    const fs = require("node:fs");
    const [file, transactionId, component, current] = process.argv.slice(1);
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    const expectedPhase = component === "plugin" ? "prepared" : "plugin-absent";
    if (value?.transactionId !== transactionId || value.phase !== expectedPhase
      || value.before?.[component] !== current) process.exit(93);
  ' "$INSTALL_JOURNAL" "$INSTALL_TRANSACTION" "$component" "$current"
}

complete_installer_transaction() {
  run_node -e '
    const fs = require("node:fs");
    const [file, transactionId] = process.argv.slice(1);
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    if (value?.version !== 1 || value.transactionId !== transactionId || value.phase !== "plugin-installed") process.exit(94);
    fs.unlinkSync(file);
  ' "$INSTALL_JOURNAL" "$INSTALL_TRANSACTION"
}

# Release order (same rule as compareReleaseOrder): the retired 1.0.0–1.1.5 line ranks below every other stable version.
stable_version_is_less() {
  run_node -e '
    const [older, current] = process.argv.slice(1);
    const retired = /^1\.(0\.[0-9]|1\.[0-5])$/;
    const parse = value => {
      const match = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u.exec(value);
      return match ? [retired.test(value) ? 0n : 1n, ...match.slice(1).map(BigInt)] : null;
    };
    const left = parse(older); const right = parse(current);
    if (!left || !right) process.exit(1);
    for (let index = 0; index < left.length; index += 1) {
      if (left[index] !== right[index]) process.exit(left[index] < right[index] ? 0 : 1);
    }
    process.exit(1);
  ' "$1" "$2"
}

prove_marketplace_target() {
  local expected_tag="${1:-$MARKETPLACE_REF}" expected_commit="${2:-$TARGET_COMMIT}"
  local state presence root source source_type head ref clean origin
  state="$(read_marketplace_state)" || return 1
  IFS=$'\t' read -r presence root source source_type head ref clean origin <<< "$state"
  [ "$presence" = present ] || return 1
  case "$source" in
    "$MARKETPLACE_SOURCE"|"https://github.com/${MARKETPLACE_SOURCE}"|"https://github.com/${MARKETPLACE_SOURCE}.git") ;;
    *) return 1 ;;
  esac
  if [ "$HOST" = codex ]; then [ "$source_type" = git ] || return 1
  else [ "$source_type" = github ] || return 1
  fi
  [ "$head" = "$expected_commit" ] || return 1
  [ "$ref" = "$expected_tag" ] || return 1
  [ "$clean" = clean ] || return 1
  case "$origin" in
    "$MARKETPLACE_SOURCE"|"https://github.com/${MARKETPLACE_SOURCE}"|"https://github.com/${MARKETPLACE_SOURCE}.git") ;;
    *) return 1 ;;
  esac
}

if [ -f "$INSTALL_JOURNAL" ]; then
  JOURNAL_STATE="$(read_installer_journal)" || {
    echo "install.sh: existing installer bridge journal is invalid or belongs to another target; refusing host mutation." >&2
    exit 1
  }
  IFS=$'\t' read -r INSTALL_TRANSACTION INSTALL_PHASE JOURNAL_TARGET_VERSION JOURNAL_TARGET_TAG \
    JOURNAL_TARGET_COMMIT <<< "$JOURNAL_STATE"
  if [ "$JOURNAL_TARGET_VERSION" = "$TENON_RELEASE_VERSION" ] \
    && [ "$JOURNAL_TARGET_TAG" = "$MARKETPLACE_REF" ] \
    && [ "$JOURNAL_TARGET_COMMIT" = "$TARGET_COMMIT" ]; then
    :
  elif [ "$INSTALL_PHASE" = plugin-installed ] \
    && stable_version_is_less "$JOURNAL_TARGET_VERSION" "$TENON_RELEASE_VERSION"; then
    PLUGIN_STATE="$(read_plugin_state)" || exit 1
    IFS=$'\t' read -r PLUGIN_PRESENCE _PLUGIN_ROOT PLUGIN_VERSION _PLUGIN_SCOPE PLUGIN_ENABLED <<< "$PLUGIN_STATE"
    [ "$PLUGIN_PRESENCE" = present ] \
      && [ "$PLUGIN_VERSION" = "$JOURNAL_TARGET_VERSION" ] \
      && [ "$PLUGIN_ENABLED" = enabled ] || {
        echo "install.sh: completed prior installer journal does not match the installed plugin; refusing host mutation." >&2
        exit 1
      }
    MARKETPLACE_STATE="$(read_marketplace_state)" || exit 1
    IFS=$'\t' read -r _MARKETPLACE_PRESENCE _MARKETPLACE_ROOT _MARKETPLACE_SOURCE _MARKETPLACE_TYPE \
      _MARKETPLACE_HEAD _MARKETPLACE_REF _MARKETPLACE_CLEAN _MARKETPLACE_ORIGIN <<< "$MARKETPLACE_STATE"
    [ "$_PLUGIN_ROOT" = "$_MARKETPLACE_ROOT" ] || {
      echo "install.sh: completed prior installer journal has split plugin and Marketplace roots; refusing host mutation." >&2
      exit 1
    }
    prove_marketplace_target "$JOURNAL_TARGET_TAG" "$JOURNAL_TARGET_COMMIT" || {
      echo "install.sh: completed prior installer journal does not match the official clean Marketplace target; refusing host mutation." >&2
      exit 1
    }
    # Atomically replace the completed prior transaction with a fresh current-target transaction;
    # the verified host state becomes the before-snapshot for normal current-release recovery.
    create_installer_journal "$PLUGIN_STATE" "$MARKETPLACE_STATE"
  else
    echo "install.sh: existing installer bridge journal is not an adoptable completed prior stable target; refusing host mutation." >&2
    exit 1
  fi
else
  PLUGIN_BEFORE="$(read_plugin_state)" || exit 1
  MARKETPLACE_BEFORE="$(read_marketplace_state)" || exit 1
  create_installer_journal "$PLUGIN_BEFORE" "$MARKETPLACE_BEFORE"
fi

PLUGIN_STATE="$(read_plugin_state)"
IFS=$'\t' read -r PLUGIN_PRESENCE _PLUGIN_ROOT _PLUGIN_VERSION PLUGIN_SCOPE _PLUGIN_ENABLED <<< "$PLUGIN_STATE"
if [ "$INSTALL_PHASE" = prepared ] && [ "$PLUGIN_PRESENCE" = present ]; then
  assert_installer_before plugin "$PLUGIN_STATE" || {
    echo "install.sh: plugin inventory changed after installer transaction preparation; refusing to delete a third state." >&2
    exit 1
  }
  if [ "$HOST" = claude ] && [ "$PLUGIN_SCOPE" != user ]; then
    echo "install.sh: existing Claude Tenon plugin is in unsupported scope '$PLUGIN_SCOPE'; refusing to remove it implicitly." >&2
    exit 1
  fi
  if [ "$HOST" = codex ]; then
    run_host plugin remove "tenon@${MARKETPLACE_NAME}" --json
  else
    run_host plugin uninstall "tenon@${MARKETPLACE_NAME}" --scope user
  fi
  [ "$(read_plugin_state)" = absent ] || {
    echo "install.sh: ${HOST} reported plugin removal but Tenon is still registered." >&2
    exit 1
  }
fi
if [ "$INSTALL_PHASE" = prepared ]; then
  [ "$(read_plugin_state)" = absent ] || { echo "install.sh: plugin absence postcondition failed." >&2; exit 1; }
  advance_installer_phase prepared plugin-absent
fi
[ "$INSTALL_PHASE" != plugin-absent ] || [ "$(read_plugin_state)" = absent ] || {
  echo "install.sh: plugin reappeared during installer recovery; refusing to delete a third state." >&2
  exit 1
}

MARKETPLACE_STATE="$(read_marketplace_state)"
IFS=$'\t' read -r MARKETPLACE_PRESENCE _MARKETPLACE_ROOT _MARKETPLACE_SOURCE _MARKETPLACE_TYPE \
  _MARKETPLACE_HEAD _MARKETPLACE_REF _MARKETPLACE_CLEAN _MARKETPLACE_ORIGIN <<< "$MARKETPLACE_STATE"
if [ "$INSTALL_PHASE" = plugin-absent ] && [ "$MARKETPLACE_PRESENCE" = present ]; then
  assert_installer_before marketplace "$MARKETPLACE_STATE" || {
    echo "install.sh: marketplace inventory changed after installer transaction preparation; refusing to delete a third state." >&2
    exit 1
  }
  if [ "$HOST" = codex ]; then
    run_host plugin marketplace remove "$MARKETPLACE_NAME" --json
  else
    run_host plugin marketplace remove "$MARKETPLACE_NAME"
  fi
  [ "$(read_marketplace_state)" = absent ] || {
    echo "install.sh: ${HOST} reported marketplace removal but Tenon is still registered." >&2
    exit 1
  }
fi
if [ "$INSTALL_PHASE" = plugin-absent ]; then
  [ "$(read_marketplace_state)" = absent ] || { echo "install.sh: marketplace absence postcondition failed." >&2; exit 1; }
  advance_installer_phase plugin-absent marketplace-absent
fi

if [ "$INSTALL_PHASE" = marketplace-absent ] && [ "$(read_marketplace_state)" = absent ]; then
  case "$HOST" in
    codex) run_host plugin marketplace add "$MARKETPLACE_SOURCE" --ref "$MARKETPLACE_REF" --json ;;
    claude) run_host plugin marketplace add "${MARKETPLACE_SOURCE}@${MARKETPLACE_REF}" ;;
  esac
fi

prove_marketplace_target || {
  echo "install.sh: marketplace state is neither the frozen target nor an adoptable bridge postcondition; refusing further mutation." >&2
  exit 1
}
if [ "$INSTALL_PHASE" = marketplace-absent ]; then
  advance_installer_phase marketplace-absent marketplace-registered
fi

if [ "$INSTALL_PHASE" = marketplace-registered ] && [ "$(read_plugin_state)" = absent ]; then
  case "$HOST" in
    codex) run_host plugin add "tenon@${MARKETPLACE_NAME}" --json ;;
    claude) run_host plugin install "tenon@${MARKETPLACE_NAME}" ;;
  esac
fi

PLUGIN_STATE="$(read_plugin_state)"
IFS=$'\t' read -r PLUGIN_PRESENCE ROOT PLUGIN_VERSION PLUGIN_SCOPE PLUGIN_ENABLED <<< "$PLUGIN_STATE"
[ "$PLUGIN_PRESENCE" = present ] || { echo "install.sh: Tenon plugin is absent after install." >&2; exit 1; }
[ "$PLUGIN_VERSION" = "$TENON_RELEASE_VERSION" ] || {
  echo "install.sh: installed plugin version $PLUGIN_VERSION does not equal release $TENON_RELEASE_VERSION." >&2
  exit 1
}
[ "$PLUGIN_ENABLED" = enabled ] || {
  echo "install.sh: installed Tenon plugin is still disabled after the official remove/add repair." >&2
  exit 1
}

MARKETPLACE_STATE="$(read_marketplace_state)"
IFS=$'\t' read -r MARKETPLACE_PRESENCE MARKETPLACE_ROOT INSTALLED_SOURCE INSTALLED_SOURCE_TYPE \
  INSTALLED_HEAD INSTALLED_REF INSTALLED_CLEAN INSTALLED_ORIGIN <<< "$MARKETPLACE_STATE"
[ "$MARKETPLACE_PRESENCE" = present ] || { echo "install.sh: Tenon marketplace is absent after install." >&2; exit 1; }
case "$INSTALLED_SOURCE" in
  "$MARKETPLACE_SOURCE"|"https://github.com/${MARKETPLACE_SOURCE}"|"https://github.com/${MARKETPLACE_SOURCE}.git") ;;
  *) echo "install.sh: installed marketplace source is not the official ${MARKETPLACE_SOURCE}." >&2; exit 1 ;;
esac
if [ "$HOST" = codex ]; then
  [ "$INSTALLED_SOURCE_TYPE" = git ] || { echo "install.sh: Codex marketplace is not a Git release checkout." >&2; exit 1; }
else
  [ "$INSTALLED_SOURCE_TYPE" = github ] || { echo "install.sh: Claude marketplace is not a GitHub release checkout." >&2; exit 1; }
fi

for required in \
  ".claude-plugin/plugin.json" \
  ".codex-plugin/plugin.json" \
  "packages/cli/dist/tenon.mjs" \
  "packages/server/dist/dashboard.mjs" \
  "runtime/tenon-bootstrap.mjs" \
  "tools/verify-skills.sh"; do
  [ -f "$ROOT/$required" ] || { echo "install.sh: release asset $required is missing." >&2; exit 1; }
done
[ -d "$ROOT/packages/dashboard-app/dist" ] || { echo "install.sh: Dashboard assets are missing." >&2; exit 1; }

manifest_version() {
  run_node -e '
    const fs = require("node:fs");
    let value;
    try { value = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); } catch { process.exit(30); }
    if (typeof value?.version !== "string") process.exit(31);
    process.stdout.write(value.version);
  ' "$1"
}
for manifest in "$ROOT/.claude-plugin/plugin.json" "$ROOT/.codex-plugin/plugin.json" \
  "$MARKETPLACE_ROOT/.claude-plugin/plugin.json" "$MARKETPLACE_ROOT/.codex-plugin/plugin.json"; do
  [ "$(manifest_version "$manifest")" = "$TENON_RELEASE_VERSION" ] || {
    echo "install.sh: manifest $manifest does not declare release $TENON_RELEASE_VERSION." >&2
    exit 1
  }
done

[ "$(run_git -C "$MARKETPLACE_ROOT" rev-parse HEAD)" = "$TARGET_COMMIT" ] || {
  echo "install.sh: marketplace HEAD does not equal ${MARKETPLACE_REF}." >&2
  exit 1
}
case "$(run_git -C "$MARKETPLACE_ROOT" remote get-url origin)" in
  "$MARKETPLACE_SOURCE"|"https://github.com/${MARKETPLACE_SOURCE}"|"https://github.com/${MARKETPLACE_SOURCE}.git") ;;
  *) echo "install.sh: marketplace Git origin is not official." >&2; exit 1 ;;
esac
run_git -C "$MARKETPLACE_ROOT" diff --quiet HEAD -- || {
  echo "install.sh: marketplace checkout has tracked modifications." >&2
  exit 1
}
while IFS= read -r untracked; do
  [ -z "$untracked" ] && continue
  [ "$HOST" = codex ] && [ "$untracked" = .codex-marketplace-install.json ] && continue
  echo "install.sh: marketplace checkout has unexpected untracked payload: $untracked" >&2
  exit 1
done < <(run_git -C "$MARKETPLACE_ROOT" ls-files --others --exclude-standard)

run_release_verification() {
  verify_tool NODE || { echo "install.sh: trusted node executable identity changed before verify-skills; refusing spawn." >&2; exit 126; }
  run_bash "$ROOT/tools/verify-skills.sh" --quiet --root "$ROOT" --node "$NODE_BIN"
}

if [ "$HOST" = codex ]; then
  CODEX_CONFIG_HOME="${CODEX_HOME:-$HOME/.codex}"
  CODEX_CONFIGURED_REF="$(run_node -e '
    const fs = require("node:fs");
    const [configPath, legacyPath] = process.argv.slice(1);
    const safe = /^[^\u0000-\u001f\u007f"\x27\\]+$/u;
    const read = (path) => { try { return fs.readFileSync(path, "utf8"); } catch (error) {
      if (error?.code === "ENOENT") return null;
      process.exit(50);
    } };
    const config = read(configPath);
    if (config !== null) {
      let inside = false, sections = 0, seen = false, ref = null;
      for (const line of config.split(/\r?\n/u)) {
        const section = /^\s*\[([^\]]+)\]\s*(?:#.*)?$/u.exec(line);
        if (section) {
          inside = section[1].trim() === "marketplaces.tenon";
          if (inside && ++sections > 1) process.exit(51);
          continue;
        }
        if (!inside || /^\s*(?:#.*)?$/u.test(line) || !/^\s*ref\s*=/u.test(line)) continue;
        if (seen) process.exit(52);
        seen = true;
        const assignment = /^\s*ref\s*=\s*(?:"([^"\\\r\n]+)"|\x27([^\x27\r\n]+)\x27)\s*(?:#.*)?$/u.exec(line);
        ref = assignment?.[1] ?? assignment?.[2] ?? null;
        if (ref === null || !safe.test(ref)) process.exit(53);
      }
      if (ref !== null) { process.stdout.write(ref); process.exit(0); }
    }
    const legacy = read(legacyPath);
    if (legacy === null) process.exit(54);
    let value; try { value = JSON.parse(legacy); } catch { process.exit(55); }
    if (typeof value?.ref_name !== "string" || value.ref_name === "" || !safe.test(value.ref_name)) process.exit(56);
    process.stdout.write(value.ref_name);
  ' "$CODEX_CONFIG_HOME/config.toml" "$MARKETPLACE_ROOT/.codex-marketplace-install.json")" || {
    echo "install.sh: Codex marketplace configured ref could not be proven." >&2
    exit 1
  }
  [ "$CODEX_CONFIGURED_REF" = "$MARKETPLACE_REF" ] || {
    echo "install.sh: Codex marketplace configured ref is not ${MARKETPLACE_REF}." >&2
    exit 1
  }
else
  if run_git -C "$MARKETPLACE_ROOT" symbolic-ref --quiet --short HEAD >/dev/null 2>&1; then
    echo "install.sh: Claude marketplace still tracks a moving branch." >&2
    exit 1
  fi
  [ "$(run_git -C "$MARKETPLACE_ROOT" describe --tags --exact-match HEAD)" = "$MARKETPLACE_REF" ] || {
    echo "install.sh: Claude marketplace is not detached at ${MARKETPLACE_REF}." >&2
    exit 1
  }
fi

if [ "$MARKETPLACE_ROOT" != "$ROOT" ]; then
  # Only tracked skills/* children are compared; upstream skills fetched into the plugin root are proven by verify-skills.
  TRACKED_SKILL_ENTRIES="$(run_git -C "$MARKETPLACE_ROOT" ls-tree --name-only HEAD skills/)" || {
    echo "install.sh: tracked skills of the ${MARKETPLACE_REF} marketplace could not be listed." >&2
    exit 1
  }
  # shellcheck disable=SC2086 # tracked skills/* names contain no whitespace
  for entry in ".claude-plugin/plugin.json" ".codex-plugin/plugin.json" "adapters" "hooks" \
    "packages/cli/dist/tenon.mjs" "packages/dashboard-app/dist" "packages/server/dist/dashboard.mjs" \
    "runtime/tenon-bootstrap.mjs" "templates" "tools/verify-skills.sh" $TRACKED_SKILL_ENTRIES; do
    run_git diff --no-index --quiet -- "$MARKETPLACE_ROOT/$entry" "$ROOT/$entry" || {
      echo "install.sh: installed plugin payload differs from the ${MARKETPLACE_REF} marketplace at $entry." >&2
      exit 1
    }
  done
fi
run_release_verification

if [ "$INSTALL_PHASE" = marketplace-registered ]; then
  advance_installer_phase marketplace-registered plugin-installed
fi
[ "$INSTALL_PHASE" = plugin-installed ] || {
  echo "install.sh: installer bridge journal did not reach plugin-installed; packaged setup was not started." >&2
  exit 1
}

ARGS=(setup "--${HOST}" --yes)
[ "$AUTO_UPDATE" = 1 ] && ARGS+=(--auto-update)
# Host rebind is fully proven. Release the shared host-mutation lease before the packaged setup
# enters its own managed transaction; any later native mutation must reacquire the same path.
stop_installer_heartbeat
release_installer_lock
run_node "$ROOT/packages/cli/dist/tenon.mjs" "${ARGS[@]}"
complete_installer_transaction
if [ "$HOST" = "codex" ]; then
  echo "Codex requires one local hook trust: open Codex, run /hooks, and trust tenon to enable normal-chat routing."
fi
echo "Tenon installed for --${HOST}. Open a new host session to load its packaged skills and hooks."
