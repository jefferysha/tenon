#!/usr/bin/env bash
# json-input.sh — source-only minimal JSON string helpers for hot-path hook shims.
#
# The hosts provide small JSON event payloads. These helpers deliberately implement only the
# string-key/string-value subset that the hooks consume, but they correctly walk escaped quotes so
# a real Codex command such as `/bin/zsh -lc \"sed …\"` is not truncated. Keeping this code in one
# place prevents individual hooks from drifting into subtly different event parsing behaviour.
#
# Shape normalisation lives here too (command / cwd): hosts disagree about both the key spelling
# and the value shape (scalar vs array), and a hook that reads only the Claude Code spelling
# silently degrades into "no value" — which for the gate means "no marker found" and therefore a
# silent allow.  One shared normaliser is the only way to keep every hook on the same payload
# surface.
#
# No interpreter, jq, grep, or eval is used here. A malformed payload returns failure; callers are
# responsible for their existing fail-open policy.

# Position the buffer at the first character of the value of `"$2"`.  Split out of
# pipeline_json_get_string so the scalar and the array reader share one key lookup instead of
# drifting into two subtly different scanners.  Result is published in _PIPELINE_JSON_REST because
# bash 3.2 (macOS system bash) has no namerefs.
_pipeline_json_seek_value() { # $1=input JSON, $2=key
  local input="${1:-}" key="${2:-}" rest
  _PIPELINE_JSON_REST=''
  [ -n "$key" ] || return 1
  case "$input" in *"\"$key\""*) ;; *) return 1 ;; esac
  rest="${input#*\"$key\"}"
  while true; do
    case "$rest" in
      [$' \t\r\n']*) rest="${rest#?}" ;;
      ':'*) rest="${rest#:}"; break ;;
      *) return 1 ;;
    esac
  done
  while true; do
    case "$rest" in
      [$' \t\r\n']*) rest="${rest#?}" ;;
      *) break ;;
    esac
  done
  _PIPELINE_JSON_REST="$rest"
  return 0
}

# Decode one JSON string that starts at the opening quote of "$1".  Publishes the decoded value in
# _PIPELINE_JSON_VALUE and the remainder after the closing quote in _PIPELINE_JSON_REST, so an
# array reader can continue scanning without re-implementing escape handling.
_pipeline_json_read_string() { # $1=buffer starting at '"'
  local rest="${1:-}" value='' character escaped=0
  _PIPELINE_JSON_VALUE=''
  case "$rest" in
    '"'*) rest="${rest#\"}" ;;
    *) return 1 ;;
  esac

  while [ -n "$rest" ]; do
    character="${rest:0:1}"
    rest="${rest:1}"
    if [ "$escaped" -eq 1 ]; then
      case "$character" in
        '"'|\\|/) value+="$character" ;;
        b) value+=$'\b' ;;
        f) value+=$'\f' ;;
        n) value+=$'\n' ;;
        r) value+=$'\r' ;;
        t) value+=$'\t' ;;
        # Hook routing keys and packaged paths are ASCII. Preserve a Unicode escape literally
        # instead of spawning an interpreter merely to decode it.
        u) value+='\\u' ;;
        *) return 1 ;;
      esac
      escaped=0
    else
      case "$character" in
        \\) escaped=1 ;;
        '"') _PIPELINE_JSON_VALUE="$value"; _PIPELINE_JSON_REST="$rest"; return 0 ;;
        *) value+="$character" ;;
      esac
    fi
  done
  return 1
}

pipeline_json_get_string() { # $1=input JSON, $2=key
  _pipeline_json_seek_value "${1:-}" "${2:-}" || return 1
  _pipeline_json_read_string "$_PIPELINE_JSON_REST" || return 1
  printf '%s' "$_PIPELINE_JSON_VALUE"
}

# Decode a JSON array of strings into one decoded item per line.  An empty array succeeds with no
# output; a non-array or malformed value fails.  Items containing a literal newline are out of
# scope for the payload shapes this handles (argv fragments and workspace roots).
pipeline_json_get_string_array() { # $1=input JSON, $2=key
  local rest
  _pipeline_json_seek_value "${1:-}" "${2:-}" || return 1
  rest="$_PIPELINE_JSON_REST"
  case "$rest" in
    '['*) rest="${rest#[}" ;;
    *) return 1 ;;
  esac
  while true; do
    while true; do
      case "$rest" in
        [$' \t\r\n']*) rest="${rest#?}" ;;
        *) break ;;
      esac
    done
    case "$rest" in
      ']'*) return 0 ;;
      ','*) rest="${rest#,}" ;;
      '"'*)
        _pipeline_json_read_string "$rest" || return 1
        printf '%s\n' "$_PIPELINE_JSON_VALUE"
        rest="$_PIPELINE_JSON_REST"
        ;;
      *) return 1 ;;
    esac
  done
}

# Codex command-like tools have used both `command` and `cmd` in their hook payloads.  Cursor's
# shell events and Cline's tool parameters use `command` too, but some hosts spell it
# `command_line` / `commandLine`, and shell-exec events may carry an argv **array** instead of one
# string.  Keep every fallback here rather than letting each hook grow a subtly different one:
# a hook that cannot read the command text cannot recognise `tenon review acknowledge`, which is
# the contract's only HITL unlock path (adapters/contract.md §2).
# Callers still perform their own strict validation before acting on the value.
pipeline_json_get_command() { # $1=input JSON
  local input="${1:-}" key value item joined found=1
  for key in command cmd command_line commandLine; do
    if value="$(pipeline_json_get_string "$input" "$key")"; then
      [ -n "$value" ] && { printf '%s' "$value"; return 0; }
      found=0
    fi
  done
  # argv arrays are joined with single spaces: the join is structural only, never evaluated, and
  # the consumer matches the resulting text against its own allowlist.
  for key in command cmd argv; do
    if value="$(pipeline_json_get_string_array "$input" "$key")"; then
      joined=''
      while IFS= read -r item; do
        [ -n "$item" ] || continue
        if [ -n "$joined" ]; then joined="$joined $item"; else joined="$item"; fi
      done <<< "$value"
      [ -n "$joined" ] && { printf '%s' "$joined"; return 0; }
      found=0
    fi
  done
  [ "$found" -eq 0 ] || return 1
  return 0
}

# The working directory decides which project root a hook inspects, so a missing value is not a
# cosmetic gap: gate.sh would fall back to the hook process cwd, find no marker there and return a
# normal allow — a hard gate degrading into a silent bypass without any crash for `failClosed` to
# catch.  Cursor sends `workspace_roots`, Cline sends `workspaceRoots` (first element is the
# project root), Amp-style payloads use a scalar `workspaceRoot`; resolve all of them before any
# caller-side fallback.
pipeline_json_get_cwd() { # $1=input JSON
  local input="${1:-}" key value item
  for key in cwd workspaceRoot workspace_root projectRoot project_root; do
    value="$(pipeline_json_get_string "$input" "$key" || true)"
    [ -n "$value" ] && { printf '%s' "$value"; return 0; }
  done
  for key in workspaceRoots workspace_roots; do
    value="$(pipeline_json_get_string_array "$input" "$key" || true)"
    [ -n "$value" ] || continue
    while IFS= read -r item; do
      [ -n "$item" ] || continue
      printf '%s' "$item"
      return 0
    done <<< "$value"
  done
  return 1
}

# Host protocol labels for command-capable tools.  The downstream evidence matcher remains the
# authority for whether a particular command really loaded a packaged SKILL.md.
pipeline_json_is_command_tool() { # $1=tool name
  case "${1:-}" in
    Bash|command_execution|exec) return 0 ;;
    *) return 1 ;;
  esac
}

pipeline_json_escape() { # $1=unescaped string → single-line JSON string body
  local value="${1:-}"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  value="${value//$'\t'/\\t}"
  value="${value//$'\r'/\\r}"
  value="${value//$'\n'/\\n}"
  printf '%s' "$value"
}
