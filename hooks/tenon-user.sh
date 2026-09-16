#!/usr/bin/env bash
# tenon-user.sh — source-only bash mirror of kernel users/resolve-user.ts (id and slug only).
#
# Order: TENON_USER → <configRoot>/user.json → git config user.email (repo scope, then global).
# A present but invalid higher source makes the identity missing; it never falls through, so a typo
# in TENON_USER cannot silently attribute to the git identity. Hooks only need the slug to find the
# user's own `.tenon/users/<slug>/local/` state; a missing identity means "no selected Change".
# Pure bash 3.2: no node, jq or eval; git is spawned only when env and the config file do not decide.
# The config root follows kernel resolveProductPaths plus the bootstrap's TENON_RUNTIME_CONFIG_ROOT.

if ! declare -F pipeline_json_get_string >/dev/null 2>&1; then
  _TENON_USER_JSON_HELPER="$(dirname "${BASH_SOURCE[0]:-$0}")/json-input.sh"
  # shellcheck source=json-input.sh
  [ -r "$_TENON_USER_JSON_HELPER" ] && . "$_TENON_USER_JSON_HELPER"
fi

_pipeline_user_trim() { # $1=value
  local value="$1"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s' "$value"
}

_pipeline_user_absolute() { # $1=path → success when absolute
  case "$1" in /*) return 0 ;; *) return 1 ;; esac
}

pipeline_user_config_path() {
  local roots="${TENON_RUNTIME_ROOTS:-}" base=''
  if [ -n "$roots" ]; then
    base="$(pipeline_json_get_string "$roots" configRoot 2>/dev/null || true)"
  elif _pipeline_user_absolute "${TENON_RUNTIME_CONFIG_ROOT:-}"; then
    base="$TENON_RUNTIME_CONFIG_ROOT"
  elif _pipeline_user_absolute "${TENON_RUNTIME_HOME:-}"; then
    base="$TENON_RUNTIME_HOME/config"
  elif [ -n "${HOME:-}" ]; then
    case "${OSTYPE:-}" in
      darwin*) base="$HOME/Library/Application Support/tenon/config" ;;
      *)
        if _pipeline_user_absolute "${XDG_CONFIG_HOME:-}"; then base="$XDG_CONFIG_HOME/tenon"
        else base="$HOME/.config/tenon"
        fi
        ;;
    esac
  fi
  _pipeline_user_absolute "$base" || return 1
  printf '%s/user.json' "$base"
}

# Printable ASCII without spaces, exactly one @ with both sides non-empty, 3..200 bytes; <, >, " and \
# are refused anywhere and a leading ' is refused (same rule as validateUserId).
pipeline_user_valid_id() { # $1=trimmed id
  local LC_ALL=C id="$1" rest
  [ "${#id}" -ge 3 ] && [ "${#id}" -le 200 ] || return 1
  case "$id" in *[!\!-~]*) return 1 ;; esac
  case "$id" in *[\<\>\"\\]*|\'*) return 1 ;; esac
  case "$id" in ?*@?*) ;; *) return 1 ;; esac
  rest="${id#*@}"
  case "$rest" in *@*) return 1 ;; esac
  return 0
}

pipeline_user_id() { # $1=project root (may be empty) → prints the id or returns 1
  local root="${1:-}" raw path content='' id
  raw="$(_pipeline_user_trim "${TENON_USER:-}")"
  if [ -n "$raw" ]; then
    pipeline_user_valid_id "$raw" || return 1
    printf '%s' "$raw"
    return 0
  fi
  path="$(pipeline_user_config_path || true)"
  if [ -n "$path" ] && { [ -e "$path" ] || [ -L "$path" ]; }; then
    [ -f "$path" ] && [ ! -L "$path" ] && [ -r "$path" ] || return 1
    IFS= read -r -d '' -n 4097 content < "$path" || true
    [ "${#content}" -le 4096 ] || return 1
    id="$(pipeline_json_get_string "$content" id 2>/dev/null || true)"
    id="$(_pipeline_user_trim "$id")"
    [ -n "$id" ] && pipeline_user_valid_id "$id" || return 1
    printf '%s' "$id"
    return 0
  fi
  if [ -n "$root" ]; then
    id="$(git -C "$root" config --get user.email 2>/dev/null || true)"
  else
    id="$(git config --global --get user.email 2>/dev/null || true)"
  fi
  id="$(_pipeline_user_trim "$id")"
  [ -n "$id" ] && pipeline_user_valid_id "$id" || return 1
  printf '%s' "$id"
}

_pipeline_user_slug_append() { # $1=piece; appends to _PIPELINE_USER_SLUG, never '-' after '-'
  local piece="$1" char index=0
  while [ "$index" -lt "${#piece}" ]; do
    char="${piece:$index:1}"
    index=$((index + 1))
    if [ "$char" = '-' ]; then
      case "$_PIPELINE_USER_SLUG" in *-) continue ;; esac
    fi
    _PIPELINE_USER_SLUG="$_PIPELINE_USER_SLUG$char"
  done
}

# Lowercase, @ → -at-, anything outside [a-z0-9._-] → -, runs of - collapsed (same as userSlug).
pipeline_user_slug_of() { # $1=valid id → prints the slug
  local LC_ALL=C id="$1" char index=0
  _PIPELINE_USER_SLUG=''
  while [ "$index" -lt "${#id}" ]; do
    char="${id:$index:1}"
    index=$((index + 1))
    case "$char" in
      A) char=a ;; B) char=b ;; C) char=c ;; D) char=d ;; E) char=e ;; F) char=f ;; G) char=g ;;
      H) char=h ;; I) char=i ;; J) char=j ;; K) char=k ;; L) char=l ;; M) char=m ;; N) char=n ;;
      O) char=o ;; P) char=p ;; Q) char=q ;; R) char=r ;; S) char=s ;; T) char=t ;; U) char=u ;;
      V) char=v ;; W) char=w ;; X) char=x ;; Y) char=y ;; Z) char=z ;;
    esac
    case "$char" in
      @) _pipeline_user_slug_append '-at-' ;;
      [a-z0-9._-]) _pipeline_user_slug_append "$char" ;;
      *) _pipeline_user_slug_append '-' ;;
    esac
  done
  printf '%s' "$_PIPELINE_USER_SLUG"
}

pipeline_user_slug() { # $1=project root → prints the slug or returns 1
  local id
  id="$(pipeline_user_id "${1:-}")" || return 1
  pipeline_user_slug_of "$id"
}

pipeline_user_local_dir() { # $1=project root → prints <root>/.tenon/users/<slug>/local or returns 1
  local slug
  [ -n "${1:-}" ] || return 1
  slug="$(pipeline_user_slug "$1")" || return 1
  printf '%s/.tenon/users/%s/local' "$1" "$slug"
}

# Creates ordinary directories only (a symlink anywhere on the path fails) and writes .tenon/.gitignore
# once when absent; an existing .gitignore is never rewritten.
pipeline_ensure_user_local_dir() { # $1=project root → prints the local dir or returns 1
  local root="$1" dir user_root
  dir="$(pipeline_user_local_dir "$root")" || return 1
  user_root="${dir%/local}"
  for path in "$root/.tenon" "$root/.tenon/users" "$user_root" "$dir"; do
    [ ! -L "$path" ] || return 1
  done
  mkdir -p "$user_root" 2>/dev/null || return 1
  ( umask 077; mkdir -p "$dir" ) 2>/dev/null || return 1
  [ -d "$dir" ] && [ ! -L "$dir" ] || return 1
  if [ ! -e "$root/.tenon/.gitignore" ] && [ ! -L "$root/.tenon/.gitignore" ]; then
    printf 'users/*/local/\n' > "$root/.tenon/.gitignore" 2>/dev/null || true
  fi
  printf '%s' "$dir"
}
