#!/usr/bin/env bash
# pending-marker.sh — source-only v2 `.pipeline-pending-interaction` marker.
#
# 并行会话共用一个项目根，各自加载交互技能、各自提问。交互标记因此按会话分文件，并记录归属，
# 门禁只拦归属方，AskUserQuestion / 放行语也只解归属本会话的标记：
#
#   宿主给了合法 session_id → `.pipeline-pending-interaction.<session_id>`（每个会话一份，互不覆盖）
#   宿主没给会话 id        → `.pipeline-pending-interaction`（项目根上的单文件，旧行为）
#
#   pipeline-interaction-v2
#   change=<加载技能时本会话任务的 Change，可空>
#   session=<宿主 session_id，可空>
#   skills=<技能显示名，以 、 连接>
#   requested_at=<UTC ISO>
#
# 本会话要看的是两处：自己的分文件，以及没有会话的单文件（后者按下面的归属规则判）。别的会话的分文件永远不看。
# 归属：session 非空 → 只属于该会话（分文件里的 session= 必须与文件名一致，否则无效）；session 为空而 change 非空 →
# 属于「本会话任务为该 Change」的会话；两者皆空 → 属于全部会话（宿主不给 session_id 时的旧行为）。
# 旧格式（首行不是协议名，含空文件）见到即删除、不拦截，分文件同样。过期（30 分钟）由 gate.sh 的 fresh 统一判，分文件同样适用。
# 同一会话再次加载交互技能只整份替换它自己的分文件；没有会话的单文件仍是后写者整份替换先写者
# （fail-open，canonical 回执仍保护 transition）。
# 纯 bash：不 spawn 解释器；`.pipeline-pending-confirm` 没有写入方，不在本模块内。
# 本文件是交互标记唯一的读写 / 归属 / 认领入口，其余 hook 只调这里的函数。

TENON_INTERACTION_MARKER_PROTOCOL='pipeline-interaction-v2'
TENON_INTERACTION_MARKER_NAME='.pipeline-pending-interaction'

if ! declare -F pipeline_session_change_dir >/dev/null 2>&1; then
  _TENON_MARKER_ACTIVE_HELPER="$(dirname "${BASH_SOURCE[0]:-$0}")/active-change.sh"
  # shellcheck source=active-change.sh
  [ -r "$_TENON_MARKER_ACTIVE_HELPER" ] && . "$_TENON_MARKER_ACTIVE_HELPER"
fi

# 标记文件路径：会话 id 合法 → 本会话的分文件；为空或不合法 → 项目根上的单文件。
pipeline_interaction_marker_path() { # $1=project root $2=session id
  if pipeline_valid_session_id "${2:-}"; then
    printf '%s/%s.%s' "$1" "$TENON_INTERACTION_MARKER_NAME" "$2"
  else
    printf '%s/%s' "$1" "$TENON_INTERACTION_MARKER_NAME"
  fi
}

# 同目录临时文件 + 原子 rename：读者只会看到完整的一份，并发写后写者胜出。
pipeline_write_interaction_marker() { # $1=project root $2=change(可空) $3=session id(可空) $4=skills display names
  local root="${1:-}" change="${2:-}" session="${3:-}" skills="${4:-}" marker tmp stamp
  [ -n "$root" ] && [ -d "$root" ] || return 1
  case "$change" in *[!A-Za-z0-9_-]*) change='' ;; esac
  pipeline_valid_session_id "$session" || session=''
  skills="${skills//$'\r'/}"
  skills="${skills//$'\n'/、}"
  marker="$(pipeline_interaction_marker_path "$root" "$session")"
  tmp="$marker.tmp.$$"
  stamp="$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo unknown)"
  printf '%s\nchange=%s\nsession=%s\nskills=%s\nrequested_at=%s\n' \
    "$TENON_INTERACTION_MARKER_PROTOCOL" "$change" "$session" "$skills" "$stamp" > "$tmp" 2>/dev/null \
    || { rm -f "$tmp" 2>/dev/null; return 1; }
  mv -f "$tmp" "$marker" 2>/dev/null || { rm -f "$tmp" 2>/dev/null; return 1; }
}

# 本会话该看的标记文件（存在的），每行一个：先自己的分文件，再没有会话的单文件。别的会话的分文件不在其内。
pipeline_interaction_marker_candidates() { # $1=verified project root $2=this conversation's session id
  local root="${1:-}" session="${2:-}" path
  if pipeline_valid_session_id "$session"; then
    path="$(pipeline_interaction_marker_path "$root" "$session")"
    [ -f "$path" ] && printf '%s\n' "$path"
  fi
  path="$(pipeline_interaction_marker_path "$root" '')"
  [ -f "$path" ] && printf '%s\n' "$path"
  return 0
}

# 0 = 归本会话；1 = 不归（旧格式：删除标记后返回 1）。读取上限 4096 字符。
pipeline_interaction_marker_owned() { # $1=marker path $2=verified project root $3=this conversation's session id
  local marker="${1:-}" root="${2:-}" session="${3:-}" body='' first line mchange='' msession='' mine
  if [ -f "$marker" ] && [ ! -L "$marker" ] && [ -r "$marker" ]; then
    IFS= read -r -d '' -n 4096 body < "$marker" 2>/dev/null || true
  fi
  first="${body%%$'\n'*}"
  if [ "$first" != "$TENON_INTERACTION_MARKER_PROTOCOL" ]; then
    rm -f "$marker" 2>/dev/null || true
    return 1
  fi
  while IFS= read -r line; do
    case "$line" in
      change=*) mchange="${line#change=}" ;;
      session=*) msession="${line#session=}" ;;
    esac
  done <<< "$body"
  if [ -n "$msession" ]; then
    [ "$msession" = "$session" ]
    return
  fi
  if [ -n "$mchange" ]; then
    mine="$(pipeline_session_change_dir "$root" "$session" || true)"
    [ "${mine##*/}" = "$mchange" ]
    return
  fi
  return 0
}

# 0 = 本会话有待处理的交互标记（自己的分文件，或归属本会话的单文件）。
pipeline_interaction_marker_pending() { # $1=verified project root $2=this conversation's session id
  local path
  while IFS= read -r path; do
    [ -n "$path" ] || continue
    pipeline_interaction_marker_owned "$path" "$1" "$2" && return 0
  done <<< "$(pipeline_interaction_marker_candidates "$1" "$2")"
  return 1
}

pipeline_interaction_marker_skills() { # $1=v2 marker path → skills= 的值（技能显示名以 、 连接）
  local line
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in skills=*) printf '%s' "${line#skills=}"; return 0 ;; esac
  done < "$1"
  return 1
}

# 认领一份标记：先看归属（不归就原样不动），再用原子 mv 占有；占有后复核刚移走的内容仍归本会话，
# 不归（检查与认领之间被别的会话替换）就放回。多份 hook 并发运行时只有 mv 成功的那一份认领到。
_pipeline_claim_marker_file() { # $1=marker path $2=verified project root $3=session id $4=claim path → 0 = claimed
  [ -f "$1" ] || return 1
  pipeline_interaction_marker_owned "$1" "$2" "$3" || return 1
  mv "$1" "$4" 2>/dev/null || return 1
  pipeline_interaction_marker_owned "$4" "$2" "$3" && return 0
  mv -n "$4" "$1" 2>/dev/null || true
  rm -f "$4" 2>/dev/null || true
  return 1
}

# 认领本会话所有归属它的标记（自己的分文件 + 归属它的单文件），合并成一个认领文件 $3
# （skills= 为各份技能的并集），调用方照旧用 pipeline_interaction_marker_skills 读它、用完删它。
# 别的会话的分文件不碰。0 = 至少认领到一份。
pipeline_claim_interaction_marker() { # $1=verified project root $2=session id $3=claim path
  local root="${1:-}" session="${2:-}" claim="${3:-}" path part skills='' one count=0
  while IFS= read -r path; do
    [ -n "$path" ] || continue
    part="$claim.$count"
    _pipeline_claim_marker_file "$path" "$root" "$session" "$part" || continue
    count=$((count + 1))
    one="$(pipeline_interaction_marker_skills "$part" || true)"
    [ -z "$one" ] || skills="${skills:+${skills}、}${one}"
    rm -f "$part" 2>/dev/null || true
  done <<< "$(pipeline_interaction_marker_candidates "$root" "$session")"
  [ "$count" -gt 0 ] || return 1
  printf '%s\nchange=\nsession=\nskills=%s\nrequested_at=claimed\n' "$TENON_INTERACTION_MARKER_PROTOCOL" "$skills" > "$claim" 2>/dev/null || true
  return 0
}
