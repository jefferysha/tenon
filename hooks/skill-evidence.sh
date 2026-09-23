#!/usr/bin/env bash
# skill-evidence.sh — source-only helpers shared by the generic hook shims.
#
# Claude reports a first-class `Skill` tool invocation. Codex currently loads a bundled skill by
# executing a read-only command against `<plugin-root>/skills/<id>/SKILL.md` instead. We must not
# claim the latter is a `Skill` event, but it is still host-observed evidence that the packaged
# skill asset was loaded. Stable runtime hooks execute from a verified payload, while Codex reads
# the asset from its host plugin cache; `TENON_HOST_PLUGIN_ROOT` is provenance captured by the
# stable bootstrap before it pins the executable roots to that payload, and
# `TENON_CODEX_PLUGIN_ROOT` is the active payload's verified Codex cache identity. These helpers
# deliberately accept only a readable SKILL.md below one of those process-provided roots, never an
# arbitrary project path or a caller-supplied skill id.
#
# This file is sourced by hot-path hooks. Keep it Bash-only: no node, python, jq, grep, or external
# JSON parser is introduced here.

pipeline_plugin_roots() {
  local root fallback
  # First choice is the host cache captured by the bootstrap. The remaining roots are the
  # executable managed payload / direct-development hook roots. Each candidate must really
  # contain the packaged skills tree; no command payload path participates in this decision.
  for root in "${TENON_HOST_PLUGIN_ROOT:-}" "${TENON_CODEX_PLUGIN_ROOT:-}" "${PLUGIN_ROOT:-}" "${CLAUDE_PLUGIN_ROOT:-}"; do
    [ -n "$root" ] && [ -d "$root/skills" ] && printf '%s\n' "$root"
  done

  fallback="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." 2>/dev/null && pwd -P)" || return 0
  [ -d "$fallback/skills" ] && printf '%s\n' "$fallback"
}

# Compatibility helper for callers that only need one executable/plugin root. Evidence matching
# below uses pipeline_plugin_roots so a host cache cannot be mistaken for the managed payload.
pipeline_plugin_root() {
  local root
  while IFS= read -r root; do
    printf '%s' "$root"
    return 0
  done < <(pipeline_plugin_roots)
  return 1
}

pipeline_safe_skill_id() {
  case "${1:-}" in
    ''|*[!A-Za-z0-9_-]*) return 1 ;;
    *) return 0 ;;
  esac
}

# Return the actual read command from a Codex command payload.
#
# Codex reports a direct `sed …` command in some hosts, but its current macOS host reports the
# same completed command as `/bin/zsh -lc "sed …"`.  We never evaluate either string: unwrapping
# is purely structural so the caller can apply the same strict bundled-SKILL.md matcher below.
# Requiring the wrapped payload to end at its closing quote prevents accepting a read followed by
# a second outer-shell command.
pipeline_codex_read_command() {
  local command="${1:-}" prefix inner

  case "$command" in
    cat\ *|sed\ *|head\ *|tail\ *)
      printf '%s' "$command"
      return 0
      ;;
  esac

  for prefix in '/bin/zsh -lc "' '/bin/zsh -c "' 'zsh -lc "' 'zsh -c "'; do
    case "$command" in
      "$prefix"*)
        inner="${command#"$prefix"}"
        case "$inner" in
          *'"')
            printf '%s' "${inner%\"}"
            return 0
            ;;
          *) return 1 ;;
        esac
        ;;
    esac
  done

  return 1
}

# Return one simple read-command segment per line.  A Codex `exec` frequently batches several
# SKILL.md reads with `&&`; splitting at command separators lets every physical final read argument
# be checked independently.  Semicolons embedded in an exotic sed expression deliberately fail
# closed instead of turning arbitrary shell text into evidence.
pipeline_codex_read_segments() {
  local command="${1:-}"
  [ -n "$command" ] || return 1

  command="$(pipeline_codex_read_command "$command" || true)"
  [ -n "$command" ] || return 1
  command="${command//&&/$'\n'}"
  command="${command//||/$'\n'}"
  command="${command//;/$'\n'}"
  printf '%s\n' "$command"
}

# Extract the last positional argument from one simple, supported read command.  Codex loads one
# asset per `cat`/`sed`/`head`/`tail` command, so accepting only that final argument prevents a
# path merely mentioned in a script expression or a later `echo` from becoming fake evidence.
pipeline_codex_read_segment_path() {
  local segment="${1:-}" before path
  [ -n "$segment" ] || return 1
  segment="${segment#"${segment%%[![:space:]]*}"}"
  segment="${segment%"${segment##*[![:space:]]}"}"
  case "$segment" in
    cat[[:space:]]*|sed[[:space:]]*|head[[:space:]]*|tail[[:space:]]*) ;;
    *) return 1 ;;
  esac

  case "$segment" in
    *\")
      before="${segment%\"}"
      case "$before" in *\"*) path="${before##*\"}" ;; *) return 1 ;; esac
      ;;
    *\')
      before="${segment%\'}"
      case "$before" in *\'*) path="${before##*\'}" ;; *) return 1 ;; esac
      ;;
    *) path="${segment##*[[:space:]]}" ;;
  esac
  case "$path" in /*) printf '%s' "$path" ;; *) return 1 ;; esac
}

# Return all absolute final arguments of structurally supported Codex read commands.  This helper
# intentionally knows nothing about plugin roots; callers below bind paths to trusted cache roots
# before recording evidence, while gate.sh can also use it to detect a shadowed same-named skill.
#
# Every consumer keeps only `…/SKILL.md` paths, so a command without that literal cannot yield one;
# returning early keeps a long heredoc (one segment and one subshell per line) off the hot path.  A
# genuine skill read is a one-liner or a short `&&` batch, so a command above
# PIPELINE_SKILL_READ_MAX_BYTES is not treated as a read either: scanning it line by line would
# overrun the 5 s host hook timeout, and a cancelled hook records nothing anyway.
PIPELINE_SKILL_READ_MAX_BYTES=16384
pipeline_codex_read_paths() {
  local command="${1:-}" segment path found=1
  [ -n "$command" ] || return 1
  case "$command" in *SKILL.md*) ;; *) return 1 ;; esac
  [ "${#command}" -le "$PIPELINE_SKILL_READ_MAX_BYTES" ] || return 1
  while IFS= read -r segment; do
    path="$(pipeline_codex_read_segment_path "$segment" || true)"
    [ -n "$path" ] || continue
    printf '%s\n' "$path"
    found=0
  done < <(pipeline_codex_read_segments "$command")
  return "$found"
}

# Return trusted packaged SKILL.md paths from one particular plugin root.  Every returned path is
# both a real readable asset and an exact final argument of an accepted read segment.
pipeline_codex_skill_read_paths_for_root() {
  local command="${1:-}" root="${2:-}" path id seen='|' found=1
  [ -n "$command" ] && [ -n "$root" ] || return 1
  [ -d "$root/skills" ] || return 1

  while IFS= read -r path; do
    case "$path" in "$root"/skills/*/SKILL.md) ;; *) continue ;; esac
    id="${path%/SKILL.md}"
    id="${id##*/}"
    pipeline_safe_skill_id "$id" || continue
    [ "$path" = "$root/skills/$id/SKILL.md" ] || continue
    [ -r "$path" ] || continue
    case "$seen" in *"|$id|"*) continue ;; esac
    seen="${seen}${id}|"
    printf '%s\n' "$path"
    found=0
  done < <(pipeline_codex_read_paths "$command")
  return "$found"
}

# Return every exact trusted packaged SKILL.md path in precedence order.  Dedupe logical ids so a
# deliberately repeated read or a duplicated root cannot create duplicate receipt/history rows.
pipeline_codex_skill_read_paths() {
  local command="${1:-}" root path id seen='|' found=1
  [ -n "$command" ] || return 1
  while IFS= read -r root; do
    while IFS= read -r path; do
      id="${path%/SKILL.md}"
      id="${id##*/}"
      pipeline_safe_skill_id "$id" || continue
      case "$seen" in *"|$id|"*) continue ;; esac
      seen="${seen}${id}|"
      printf '%s\n' "$path"
      found=0
    done < <(pipeline_codex_skill_read_paths_for_root "$command" "$root")
  done < <(pipeline_plugin_roots)
  return "$found"
}

# Return all trusted bundled ids, one per line.  Keep the singular helpers below for existing hook
# callers/tests, but new multi-skill consumers must iterate this helper rather than silently taking
# the first read in a chained Codex command.
pipeline_codex_skill_read_ids() {
  local command="${1:-}" path id found=1
  [ -n "$command" ] || return 1
  while IFS= read -r path; do
    id="${path%/SKILL.md}"
    id="${id##*/}"
    pipeline_safe_skill_id "$id" || continue
    printf '%s\n' "$id"
    found=0
  done < <(pipeline_codex_skill_read_paths "$command")
  return "$found"
}

# Return ids from any structurally valid SKILL.md read, regardless of where the skill lives.  This
# deliberately does not create evidence: gate.sh uses it only to catch a host resolving one of our
# bundled ids to a same-named global/project skill.
pipeline_codex_any_skill_read_ids() {
  local command="${1:-}" path parent id seen='|' found=1
  [ -n "$command" ] || return 1
  while IFS= read -r path; do
    case "$path" in */skills/*/SKILL.md) ;; *) continue ;; esac
    parent="${path%/SKILL.md}"
    id="${parent##*/}"
    parent="${parent%/*}"
    case "$parent" in */skills) ;; *) continue ;; esac
    pipeline_safe_skill_id "$id" || continue
    case "$seen" in *"|$id|"*) continue ;; esac
    seen="${seen}${id}|"
    printf '%s\n' "$id"
    found=0
  done < <(pipeline_codex_read_paths "$command")
  return "$found"
}

# Compatibility wrapper for callers that only need the first shadow-check id.
pipeline_codex_any_skill_read_id() {
  local command="${1:-}" id
  [ -n "$command" ] || return 1
  while IFS= read -r id; do
    printf '%s' "$id"
    return 0
  done < <(pipeline_codex_any_skill_read_ids "$command")
  return 1
}

# A same-named global skill is only dangerous when this plugin ships that exact id. Keep custom
# workflows capable of referring to genuinely external skills, while making a bundled pipeline
# skill impossible to silently shadow with ~/.agents, ~/.claude, or a project-local copy.
pipeline_plugin_has_skill_id() {
  local id="${1:-}" root
  pipeline_safe_skill_id "$id" || return 1
  while IFS= read -r root; do
    [ -r "$root/skills/$id/SKILL.md" ] && return 0
  done < <(pipeline_plugin_roots)
  return 1
}

# Compatibility helper for direct-hook callers/tests that need the first accepted id under one
# explicitly selected root.
pipeline_codex_skill_read_id_for_root() {
  local command="${1:-}" root="${2:-}" path id
  [ -n "$command" ] && [ -n "$root" ] || return 1
  while IFS= read -r path; do
    id="${path%/SKILL.md}"
    id="${id##*/}"
    printf '%s' "$id"
    return 0
  done < <(pipeline_codex_skill_read_paths_for_root "$command" "$root")
  return 1
}

# Optional root keeps direct-hook callers/tests compatible. Without it, examine only the
# process-provided host-cache and managed-payload roots in precedence order.
pipeline_codex_skill_read_id() {
  local command="${1:-}" root="${2:-}" path id
  [ -n "$command" ] || return 1
  if [ -n "$root" ]; then
    pipeline_codex_skill_read_id_for_root "$command" "$root"
    return $?
  fi
  while IFS= read -r path; do
    id="${path%/SKILL.md}"
    id="${id##*/}"
    printf '%s' "$id"
    return 0
  done < <(pipeline_codex_skill_read_paths "$command")
  return 1
}

# Return the first exact packaged SKILL.md path for legacy consumers.  Receipt and tracker code
# should use pipeline_codex_skill_read_paths / pipeline_codex_skill_read_ids to preserve all reads.
pipeline_codex_skill_read_path() {
  local command="${1:-}" path
  [ -n "$command" ] || return 1
  while IFS= read -r path; do
    printf '%s' "$path"
    return 0
  done < <(pipeline_codex_skill_read_paths "$command")
  return 1
}
