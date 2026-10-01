import type { CliLocale } from './i18n/locale.js'

export const LOOPS_HELP = `
子命令:
  init [flags]              起草一个 paused 草稿 loop（TTY 下无 flags → 交互向导；非交互见下）
  list [--json]             登记表
  status [--json]           各 loop 分级放权状态（L1 报告 / L2 辅助 / L3 无人值守）
  enforce [--loop <id>]     跑 R1-R11 裁决出 verdict
  budget|cost [loop]        token 预算 / 成本估算
  graduate [loop]           升降档裁决（毕业制）
  level <loop> [set <L1|L2|L3>] [--confirm]   查看/改档（升档须准入 + --confirm）
  run <loop-id|pattern> [--dry-run] [--level L1|L2|L3] [--commit] [--json]   定向真跑
  sync <loop-id> <--dry-run|--apply> [--expected-registry-sha <sha>] [--expected-workflow-sha <sha>] [--json]
                              --dry-run / --apply 必须显式二选一

loops init 非交互 flags:
  --id <id> · --goal <text> · --template <id> · --workflow <id> · --skill-bundle <profile>
  --runner <claude-code|codex>（缺省 codex）· --kind <orchestrator|executor> · --prefix <change 前缀>
  --cadence <4h> · --risk <low|medium|high> · --yes

starter:
  pr-babysitter | daily-triage | ci-sweeper | post-merge-cleanup |
  dependency-sweeper | changelog-drafter | issue-triage

示例:
  tenon loops init
  tenon loops init --id nightly-fix --goal "夜间修 flaky 测试" --runner codex --yes
  tenon loops init --id ci-loop --template ci-sweeper --skill-bundle backend --yes`


const LOOPS_HELP_EN = `
Subcommands:
  init [flags]              draft a paused loop (no flags on a TTY starts the wizard; non-interactive flags below)
  list [--json]             registry table
  status [--json]           graded autonomy status of each loop (L1 report / L2 assist / L3 unattended)
  enforce [--loop <id>]     run the R1-R11 rules and produce a verdict
  budget|cost [loop]        token budget / cost estimate
  graduate [loop]           level promotion / demotion verdict
  level <loop> [set <L1|L2|L3>] [--confirm]   show or change the level (a promotion needs admission + --confirm)
  run <loop-id|pattern> [--dry-run] [--level L1|L2|L3] [--commit] [--json]   targeted real run
  sync <loop-id> <--dry-run|--apply> [--expected-registry-sha <sha>] [--expected-workflow-sha <sha>] [--json]
                              exactly one of --dry-run / --apply is required

loops init non-interactive flags:
  --id <id> · --goal <text> · --template <id> · --workflow <id> · --skill-bundle <profile>
  --runner <claude-code|codex> (default codex) · --kind <orchestrator|executor> · --prefix <change prefix>
  --cadence <4h> · --risk <low|medium|high> · --yes

starter:
  pr-babysitter | daily-triage | ci-sweeper | post-merge-cleanup |
  dependency-sweeper | changelog-drafter | issue-triage

Examples:
  tenon loops init
  tenon loops init --id nightly-fix --goal "fix flaky tests overnight" --runner codex --yes
  tenon loops init --id ci-loop --template ci-sweeper --skill-bundle backend --yes`

export function loopsHelp(locale: CliLocale): string {
  return locale === 'en' ? LOOPS_HELP_EN : LOOPS_HELP
}

export function triageSourceHelp(locale: CliLocale): string {
  return locale === 'en'
    ? '\nsource: git-commits (HEAD of this repo) | loop-run-terminals (this repo\'s durable loop ledger)'
    : '\nsource: git-commits（当前仓 HEAD）| loop-run-terminals（当前仓 durable loop ledger）'
}
