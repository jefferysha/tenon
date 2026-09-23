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
#
# The key is located on a `"`-split of the buffer, not with `${input#*\"$key\"}`: on bash 3.2 that
# expansion is quadratic in the distance to the key (a `cwd` after a 1 MB prompt took ~140 s), while
# `read -a` is one linear pass and the scan below stops at the first piece equal to the key — the
# same first `"key"` occurrence the pattern would find.
_pipeline_json_seek_value() { # $1=input JSON, $2=key
  local input="${1:-}" key="${2:-}" rest IFS index count offset=0 found=0 piece head
  local -a pieces
  _PIPELINE_JSON_REST=''
  [ -n "$key" ] || return 1
  case "$input" in *"\"$key\""*) ;; *) return 1 ;; esac
  # Fast path: the key sits in the first 4 KiB (every small payload, and keys before a big value).
  head="${input:0:4096}"
  case "$head" in
    *"\"$key\""*)
      piece="${head#*\"$key\"}"
      offset=$(( ${#head} - ${#piece} ))
      found=1
      ;;
  esac
  if [ "$found" -eq 1 ]; then
    rest="${input:$offset}"
  else
    IFS='"'
    read -r -d '' -a pieces <<< "$input" || true
    IFS=$' \t\n'
    count=${#pieces[@]}
    index=0
    # A piece equal to the key with a quote on both sides: never the first piece (no quote before
    # it) nor the last one (the here-string newline, no quote after it). Walked with `for … in`:
    # indexed access is linear per element on bash 3.2.
    for piece in "${pieces[@]}"; do
      [ "$index" -lt "$((count - 1))" ] || break
      if [ "$index" -gt 0 ] && [ "$piece" = "$key" ]; then found=1; break; fi
      offset=$((offset + ${#piece} + 1))
      index=$((index + 1))
    done
    [ "$found" -eq 1 ] || return 1
    rest="${input:$((offset + ${#key} + 1))}"
  fi
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
#
# Linear by construction.  A per-character loop (`${rest:1}` per step) copies the remaining buffer
# on every character, and bash 3.2 (macOS /bin/bash, which runs these hooks) also makes every
# `${var//pattern/replacement}` quadratic in the number of matches: a 40 KB heredoc command took
# ~35 s, far beyond the 5 s host hook timeout, so every PostToolUse hook was cancelled.  Instead the
# buffer is split with `read -a` — one linear pass per delimiter — first on `"` (a piece that ends
# in an odd number of backslashes hides an escaped quote; the first even one closes the string),
# then the value on `\` to decode each escape.  Pieces are collected in arrays and joined once,
# because repeated `+=` on a growing string is quadratic as well.
#
# PIPELINE_JSON_MAX_STRING (unset = unlimited) bounds the encoded length of one value: a longer
# value is treated like a malformed one (failure), and the escape scan never looks past the bound.
# Set it with pipeline_json_get_command_bounded, never globally.
_pipeline_json_read_string() { # $1=buffer starting at '"'
  local rest="${1:-}" IFS raw part tail count index last close=-1 slashes length=0 scan plain
  local max="${PIPELINE_JSON_MAX_STRING:-}"
  local -a pieces decoded
  _PIPELINE_JSON_VALUE=''
  case "$max" in *[!0-9]*) max='' ;; esac
  case "$rest" in
    '"'*) rest="${rest#\"}" ;;
    *) return 1 ;;
  esac
  case "$rest" in *'"'*) ;; *) return 1 ;; esac

  # Fast path: most values (tool names, paths, short commands) carry no escape at all.  Cutting at
  # the first quote costs one pass over the prefix, instead of splitting the whole remaining
  # payload (PostToolUse carries the full tool output after the input).
  # `read -d '"'` stops at the first quote in one pass; `${rest%%\"*}` is quadratic on bash 3.2 when
  # that quote is far away (a quote-free 1 MB prompt).
  IFS= read -r -d '"' raw <<< "$rest" || true
  case "$raw" in
    *'\'*) ;;
    *)
      [ -z "$max" ] || [ "${#raw}" -le "$max" ] || return 1
      _PIPELINE_JSON_VALUE="$raw"
      _PIPELINE_JSON_REST="${rest:$((${#raw} + 1))}"
      return 0
      ;;
  esac

  # Only the lengths of the pieces are used here: joining an array that holds empty strings leaks
  # bash 3.2's internal \177 null marker into the result.  The here-string's trailing newline lands
  # in the last piece, which never belongs to the value.  Under a bound, a value that fits closes
  # within the first max+1 characters, so only that prefix is split.
  scan="$rest"
  [ -z "$max" ] || scan="${rest:0:$((max + 1))}"
  IFS='"'
  read -r -d '' -a pieces <<< "$scan" || true
  count=${#pieces[@]}
  index=0
  # `for … in "${pieces[@]}"` walks the array once. `${pieces[$index]}` does not: bash 3.2 finds an
  # element by walking its list from the head, so an indexed loop is quadratic in the piece count
  # (a pasted log with thousands of `\"` took seconds).
  for tail in "${pieces[@]}"; do
    [ "$index" -lt "$((count - 1))" ] || break
    length=$((length + ${#tail}))
    slashes=0
    while [[ "$tail" == *'\' ]]; do tail="${tail%?}"; slashes=$((slashes + 1)); done
    if [ "$((slashes % 2))" -eq 0 ]; then close=$index; break; fi
    length=$((length + 1))
    index=$((index + 1))
  done
  [ "$close" -ge 0 ] || return 1
  raw="${rest:0:$length}"
  rest="${rest:$((length + 1))}"

  case "$raw" in
    *'\'*) ;;
    *) _PIPELINE_JSON_VALUE="$raw"; _PIPELINE_JSON_REST="$rest"; return 0 ;;
  esac
  IFS='\'
  read -r -d '' -a pieces <<< "$raw" || true
  last=$((${#pieces[@]} - 1))
  pieces[$last]="${pieces[$last]%$'\n'}"
  # Empty strings are never appended to `decoded` (see the \177 note above). Appends are written
  # `decoded[${#decoded[@]}]=…`: on bash 3.2 each `decoded+=(…)` costs time linear in the array size.
  # Walked with `for … in` for the same reason as the quote scan above; `plain` marks the piece
  # after an escaped backslash (and the first piece), which is copied without decoding.
  decoded=()
  index=0
  plain=1
  for part in "${pieces[@]}"; do
    if [ "$plain" -eq 1 ]; then
      plain=0
      [ -z "$part" ] || decoded[${#decoded[@]}]="$part"
      index=$((index + 1))
      continue
    fi
    if [ -z "$part" ]; then
      # An empty piece sits between the two backslashes of `\\`; the piece after it is plain text.
      [ "$index" -lt "$last" ] || return 1
      decoded[${#decoded[@]}]='\'
      plain=1
      index=$((index + 1))
      continue
    fi
    case "${part:0:1}" in
      '"') decoded[${#decoded[@]}]='"' ;;
      /) decoded[${#decoded[@]}]='/' ;;
      b) decoded[${#decoded[@]}]=$'\b' ;;
      f) decoded[${#decoded[@]}]=$'\f' ;;
      n) decoded[${#decoded[@]}]=$'\n' ;;
      r) decoded[${#decoded[@]}]=$'\r' ;;
      t) decoded[${#decoded[@]}]=$'\t' ;;
      # Hook routing keys and packaged paths are ASCII. Preserve a Unicode escape literally
      # instead of spawning an interpreter merely to decode it.
      u) decoded[${#decoded[@]}]='\\u' ;;
      *) return 1 ;;
    esac
    part="${part#?}"
    [ -z "$part" ] || decoded[${#decoded[@]}]="$part"
    index=$((index + 1))
  done
  IFS=''
  [ "${#decoded[@]}" -eq 0 ] || _PIPELINE_JSON_VALUE="${decoded[*]}"
  _PIPELINE_JSON_REST="$rest"
  return 0
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

# Same as pipeline_json_get_command, but a command whose encoded form exceeds $2 characters fails
# like a missing one.  For consumers that only ever act on short commands (test commands, read-only
# allowlists, review control), so a huge heredoc costs one bounded scan instead of a full decode.
pipeline_json_get_command_bounded() { # $1=input JSON, $2=max encoded length
  local PIPELINE_JSON_MAX_STRING="${2:-}"
  pipeline_json_get_command "${1:-}"
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
