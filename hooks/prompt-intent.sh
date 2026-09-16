#!/usr/bin/env bash
# prompt-intent.sh — UserPromptSubmit 的跨会话绑定判定。
#
# 用户的 `active-change` 是恢复候选，不是任意新会话的隐式绑定。只有用户明确要求
# 继续（或点名 change）时，调用方才可把该候选注入为当前任务。这里仅做 shell
# pattern 判定；用户文本始终保持数据，绝不 eval/source。

HOOKS_CONFIG_HELPER="$(dirname "${BASH_SOURCE[0]:-$0}")/hooks-config.sh"
[ -r "$HOOKS_CONFIG_HELPER" ] || return 0 2>/dev/null || exit 0
# shellcheck source=hooks-config.sh
. "$HOOKS_CONFIG_HELPER"

pipeline_prompt_skip_keyword_from_snapshot() { # stdout=有效 keyword（空表示显式禁用）
  local line trimmed raw value keyword='no-tenon'
  {
  IFS= read -r line || {
    printf 'no-tenon'
    return 0
  }
  trimmed="${line#"${line%%[![:space:]]*}"}"
  trimmed="${trimmed%"${trimmed##*[![:space:]]}"}"
  [ "$trimmed" = '{' ] || {
    printf 'no-tenon'
    return 0
  }
  IFS= read -r line || {
    printf 'no-tenon'
    return 0
  }
  trimmed="${line#"${line%%[![:space:]]*}"}"
  trimmed="${trimmed%"${trimmed##*[![:space:]]}"}"
  [ "$trimmed" = '"version": 1,' ] || {
    printf 'no-tenon'
    return 0
  }
  IFS= read -r line || {
    printf 'no-tenon'
    return 0
  }
  trimmed="${line#"${line%%[![:space:]]*}"}"
  trimmed="${trimmed%"${trimmed##*[![:space:]]}"}"
  case "$trimmed" in
    '"prompt_skip_keyword": '*',') raw="${trimmed#'"prompt_skip_keyword": '}"; raw="${raw%,}" ;;
    *)
      printf 'no-tenon'
      return 0
      ;;
  esac
  case "$raw" in
    '""') keyword='' ;;
    \"*\")
      value="${raw#\"}"
      value="${value%\"}"
      [ "$raw" = "\"$value\"" ] || {
        printf 'no-tenon'
        return 0
      }
      case "$value" in
        [A-Za-z0-9]*)
          case "$value" in *[!A-Za-z0-9_-]*) value='' ;; esac
          ;;
        *) value='' ;;
      esac
      [ -n "$value" ] && [ "${#value}" -le 32 ] || {
        printf 'no-tenon'
        return 0
      }
      keyword="$value"
      ;;
    *)
      printf 'no-tenon'
      return 0
      ;;
  esac

  while IFS= read -r line || [ -n "$line" ]; do
    trimmed="${line#"${line%%[![:space:]]*}"}"
    case "$trimmed" in
      '"prompt_skip_keyword": '*)
        printf 'no-tenon'
        return 0
        ;;
    esac
  done
  printf '%s' "$keyword"
  } <<< "$PIPELINE_HOOKS_CONFIG_SNAPSHOT"
}

pipeline_prompt_skip_keyword() { # $1=项目根；stdout=有效 keyword（空表示显式禁用）
  pipeline_hooks_config_snapshot "${1:-}" || {
    printf 'no-tenon'
    return 0
  }
  pipeline_prompt_skip_keyword_from_snapshot
}

pipeline_prompt_should_skip_routing() { # $1=项目根 $2=prompt；0=只抑制本轮 router/breadcrumb
  local root="${1:-}" prompt="${2:-}" keyword regex matched=1 restore_nocasematch=0
  pipeline_hooks_config_snapshot "$root" || true
  keyword="$(pipeline_prompt_skip_keyword_from_snapshot)"
  [ -n "$keyword" ] || return 1
  local LC_ALL=C
  regex="(^|[^A-Za-z0-9_-])${keyword}($|[^A-Za-z0-9_-])"
  if ! shopt -q nocasematch; then
    shopt -s nocasematch
    restore_nocasematch=1
  fi
  [[ "$prompt" =~ $regex ]] && matched=0
  [ "$restore_nocasematch" -eq 0 ] || shopt -u nocasematch
  return "$matched"
}

pipeline_prompt_rejects_resume() { # $1=prompt；0=明确要求新主题，不得恢复任何旧 change
  local prompt="${1:-}"
  [ -n "$prompt" ] || return 1

  # 明确的新主题/拒绝继续优先于宽泛的“继续”词，避免“不要继续，调研新项目”被误绑。
  case "$prompt" in
    *"不要继续"*|*"不继续"*|*"别继续"*|*"新任务"*|*"新项目"*|*"另一个"*|*"另外一个"*|*"重新开始"*|*"新建"*) return 0 ;;
  esac
  return 1
}

# 仅当用户把一个安全的 change 名作为完整 token 点名时返回成功。这里不用简单的
# `*"$change"*` 子串匹配：`catalog` 不能误命中 `catalog-flow-page`，而中文标点和
# 空白仍然可以作为名称边界。所有调用方借此在多 change 项目中复用同一选择语义。
pipeline_prompt_names_change() { # $1=prompt $2=候选 change 名；0=明确点名且允许恢复
  local prompt="${1:-}" change="${2:-}" regex
  [ -n "$prompt" ] || return 1
  pipeline_prompt_rejects_resume "$prompt" && return 1

  # 只有安全的 change 名才可作为 shell pattern 的一部分；hook 也会做同样的
  # 路径校验，但这里保持独立防线，避免异常目录名改变正则匹配语义。
  case "$change" in
    ''|*[!A-Za-z0-9_-]*) return 1 ;;
  esac

  # Bash 3.2 的 `=~` 支持变量正则。change 已经被限制为 ASCII 字母、数字、`_`、`-`，
  # 因此不能改变表达式结构；钉 C locale 避免字符范围随宿主 locale 漂移。
  local LC_ALL=C
  regex="(^|[^A-Za-z0-9_-])${change}($|[^A-Za-z0-9_-])"
  [[ "$prompt" =~ $regex ]]
}

# 这是 router 上一轮向用户展示的 `track / workflow` 选择回复，不是对 repo 级
# `active-change` 的恢复请求。选择文本常常同时含“上一步/继续”；若把它交给下面的
# 宽泛恢复判定，两个 UserPromptSubmit hook 会把旧 Change 注入到新 workflow 的确认轮。
# 只承认显式选择动词 + 两个安全 id 的成对形式，避免把普通带斜杠的自然语言吞掉。
pipeline_prompt_is_workflow_selection() { # $1=prompt；0=上一轮 workflow 选择答案
  local prompt="${1:-}" regex
  [ -n "$prompt" ] || return 1
  local LC_ALL=C
  regex='(选择|选|[Ss]elect)[[:space:]]+[A-Za-z0-9_-]+[[:space:]]*/[[:space:]]*[A-Za-z0-9_-]+'
  [[ "$prompt" =~ $regex ]]
}

pipeline_prompt_requests_resume() { # $1=prompt $2=候选 change 名；0=允许绑定旧 change
  local prompt="${1:-}" change="${2:-}"
  [ -n "$prompt" ] || return 1
  pipeline_prompt_rejects_resume "$prompt" && return 1

  # 点名 change 是最明确的恢复意图。
  if pipeline_prompt_names_change "$prompt" "$change"; then
    return 0
  fi

  case "$prompt" in
    *"继续"*|*"接着"*|*"恢复"*|*"上一项"*|*"上一步"*|*"按原计划"*|*"continue"*|*"Continue"*|*"resume"*|*"Resume"*) return 0 ;;
  esac
  return 1
}

# Shared approval/authority vocabulary for UserPromptSubmit consumers.  The caller still owns the
# context check: `contextual-confirm` is valid only when the exact project has a pending
# confirm/interaction/review receipt.  Keeping classification here prevents router and unlock hooks
# from accepting different Chinese/English phrases.
pipeline_prompt_contains_authority_phrase() { # $1=prompt; 0=contains an explicit authority phrase
  case "${1:-}" in
    *后续不用问*|*后续无需询问*|*后续不需要确认*|*后续自行执行*|*后续自己执行*|*后续自主执行*|\
    *自主执行完成*|*自己执行完成*|*不用问我*|*不必问我*|*无需问我*|*不要再问*|\
    *所有操作我都批准*|*全部操作我都批准*|*所有操作都批准*|*全部操作都批准*|\
    *全部允许*|*全都允许*|*全部批准*) return 0 ;;
  esac
  return 1
}

pipeline_prompt_has_unsafe_authority_context() { # $1=prompt; 0=authority use is not plainly affirmative
  local remainder="${1:-}" separator

  # Authority is security-sensitive: recognize only a closed affirmative statement.  Normalize
  # harmless separators, then require the entire prompt to be a sequence of approved affirmative
  # tokens.  Substring deletion is deliberately avoided: overlapping phrases such as
  # `后续不用问我` must not leave a suffix, and a hostile prefix/suffix must never disappear.
  # This is intentionally stricter than trying to enumerate every Chinese/English negation,
  # quotation, condition, or meta-expression: `禁止`, `拒绝`, `do not`, `never`, and future unknown
  # wording all fail closed without needing another deny-list entry.
  remainder="${remainder// /}"
  remainder="${remainder//$'\t'/}"
  remainder="${remainder//$'\r'/}"
  remainder="${remainder//$'\n'/}"
  for separator in '，' '。' '！' '；' '：' ',' '.' '!' ';' ':'
  do
    remainder="${remainder//$separator/}"
  done

  if [[ "$remainder" =~ ^(确认|后续不用问我|后续不用问|后续无需询问|后续不需要确认|后续自行执行|后续自己执行|后续自主执行|自主执行完成|自己执行完成|不用问我|不必问我|无需问我|不要再问|所有操作我都批准|全部操作我都批准|所有操作都批准|全部操作都批准|全部允许|全都允许|全部批准)+$ ]]; then
    return 1
  fi
  return 0
}

pipeline_prompt_approval_intent() { # $1=prompt; stdout=intent; 0=matched, 1=unrelated
  local prompt="${1:-}"
  case "$prompt" in
    *恢复逐步确认*|*恢复询问*|*停止自主执行*|*撤回自主执行*|*每步确认*)
      printf 'revoke'; return 0 ;;
    *不可以*|*不同意*|*不批准*|*不要继续*|*别继续*|*不要执行*|*别执行*|*暂停执行*)
      printf 'reject'; return 0 ;;
    *继续*但*|*继续*但是*|*继续*不过*|*继续*先别*|*可以*但*|*可以*但是*|*同意*但*)
      printf 'modify'; return 0 ;;
    *没有说*批准*|*没说*批准*|*不是所有操作*批准*|*并非所有操作*批准*|\
    *不代表*批准*|*不等于*批准*|*这句话*所有操作我都批准*|\
    *\"所有操作我都批准\"*|*“所有操作我都批准”*)
      printf 'reject'; return 0 ;;
  esac
  if pipeline_prompt_contains_authority_phrase "$prompt"; then
    if pipeline_prompt_has_unsafe_authority_context "$prompt"; then
      printf 'reject'
    else
      printf 'authorize'
    fi
    return 0
  fi
  case "$prompt" in
    *确认继续*|*确认执行*|*确认并继续*|*继续执行*|*全部执行*|*可以继续*|*同意继续*|*请继续执行*|*批准继续*|*自行执行*|*自己执行*|*go\ ahead*|*proceed\ with\ it*|*continue\ execution*)
      printf 'confirm'; return 0 ;;
    继续|继续。|继续！|接着|接着。|可以|可以。|可以！|同意|同意。|好|好的|没问题|按推荐|按推荐方案|按你的推荐|按照你的推荐|\
    *继续，按照你的推荐*|*继续，按你的推荐*|*继续按照你的推荐*|*继续按推荐*|continue|Continue)
      printf 'contextual-confirm'; return 0 ;;
  esac
  return 1
}
