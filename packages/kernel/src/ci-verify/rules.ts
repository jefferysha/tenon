/**
 * `tenon verify --ci` 的规则目录：每个发现码一条（名称、一句话、说明、默认级别）。SARIF 的 `tool.driver.rules`
 * 与文本报告的图例都读这一份。策略判定产出的阻塞 / 提示码（blockers.ts）也在这里有规则条目，说明沿用测试体系的短标签。
 */
import { TEST_BLOCKER_CODES, TEST_BLOCKER_LABELS, TEST_NOTICE_CODES, TEST_NOTICE_LABELS } from '../test-system/blockers.js'
import type { CiSeverity } from './types.js'

export interface CiRule {
  readonly id: string
  readonly name: string
  readonly short: string
  readonly help: string
  readonly level: CiSeverity
}

const CI_ONLY: readonly CiRule[] = [
  {
    id: 'record-misplaced', name: 'RecordMisplaced', level: 'error',
    short: 'A test run record lives under the wrong change or user directory',
    help: 'A record names a different change than the directory it sits in, or an actor whose slug is not the user directory. Records are copied between tasks or users only by hand; rerun the suite with `tenon test run`.',
  },
  {
    id: 'record-inconsistent', name: 'RecordInconsistent', level: 'error',
    short: 'A test run record contradicts itself',
    help: 'The record result, the suite totals or the retained cases disagree with each other. `tenon test run` never writes such a record; it was edited.',
  },
  {
    id: 'plan-file-missing', name: 'PlanFileMissing', level: 'error',
    short: 'A test file registered in the test plan is not in the pull request tree',
    help: 'The plan registers a test file that no longer exists. Either restore the file or remove it from the plan with `tenon test unregister`.',
  },
  {
    id: 'candidate-mismatch', name: 'CandidateMismatch', level: 'error',
    short: 'The recorded runs were produced on a different tree than the pull request head',
    help: 'The workspace fingerprint bound into the test run records differs from the fingerprint of the checked-out tree. The code changed after the tests ran, or the checkout differs from the tested workspace (ignored build output, executable bits, line endings, or, for records written by Tenon 0.3.0 and earlier, host-local files such as `.claude/settings.local.json` that the fingerprint counted then). Rerun `tenon test run <change> --stage` on the final tree.',
  },
  {
    id: 'protected-unapproved', name: 'ProtectedFileUnapproved', level: 'error',
    short: 'A protected test configuration file changed without a recorded human approval',
    help: 'The test catalog, baselines, known-failures list or project workflows changed in this task, but the task history has no `test:protected-approve` line for the file. A human approves it at the review gate (`tenon review request` then `acknowledge`).',
  },
  {
    id: 'protected-changed-after-approval', name: 'ProtectedFileChangedAfterApproval', level: 'error',
    short: 'A protected test configuration file differs from the content that was approved',
    help: 'The approval line records a content digest and the file no longer matches it. Request a new review.',
  },
  {
    id: 'protected-approval-unbound', name: 'ProtectedApprovalUnbound', level: 'warning',
    short: 'The approval line for a protected file names no content digest',
    help: 'Approval lines written by older Tenon versions only name the path, so CI cannot tell whether the file changed afterwards.',
  },
  {
    id: 'protected-diff-unavailable', name: 'ProtectedDiffUnavailable', level: 'error',
    short: 'The task diff could not be read, so protected-file approvals cannot be checked',
    help: 'Fetch the full history (`fetch-depth: 0` in actions/checkout) so the commit the task started from is reachable.',
  },
  {
    id: 'anchor-mismatch', name: 'AnchorMismatch', level: 'error',
    short: 'The record chain does not contain the head digest anchored in git notes',
    help: 'The anchored chain head is not part of the committed chain: the chain was rewritten after it was anchored.',
  },
  {
    id: 'anchor-behind', name: 'AnchorBehind', level: 'warning',
    short: 'Records were appended after the last anchor',
    help: 'The chain contains the anchored head, followed by newer records. Anchor again (`tenon evidence export <change> --format git-notes --anchor --apply`) or run with --require-anchor to make this an error.',
  },
  {
    id: 'anchor-unverifiable', name: 'AnchorUnverifiable', level: 'warning',
    short: 'The anchored head is not in the chain, but older records were pruned',
    help: 'Retention pruning removes the oldest records, so an old anchor can fall outside the retained chain.',
  },
  {
    id: 'anchor-missing', name: 'AnchorMissing', level: 'error',
    short: 'No anchor note exists for this change',
    help: 'Required by --require-anchor. Fetch the notes ref (`git fetch origin refs/notes/tenon:refs/notes/tenon`) and anchor the delivery commit.',
  },
  {
    id: 'owner-chain-missing', name: 'OwnerChainMissing', level: 'warning',
    short: 'The task owner has no test run records; another user\'s chain was used',
    help: 'Verdicts were computed from the only chain that exists. Run the suites as the owner or take the task over.',
  },
  {
    id: 'change-unreadable', name: 'ChangeUnreadable', level: 'error',
    short: 'The task state or its frozen workflow could not be read',
    help: 'The task state files are corrupt or the frozen workflow plan cannot be resolved from the committed files.',
  },
  {
    id: 'step-unresolved', name: 'StepUnresolved', level: 'error',
    short: 'The requested workflow step does not exist in the task workflow',
    help: 'Pass a step id that exists in the frozen workflow of the task.',
  },
  {
    id: 'candidate-unchecked', name: 'CandidateUnchecked', level: 'note',
    short: 'The workspace fingerprint was not compared (--candidate off)',
    help: 'Recorded runs were not checked against the tree of this checkout.',
  },
  {
    id: 'change-abandoned', name: 'ChangeAbandoned', level: 'note',
    short: 'The task was abandoned through the scope-expanded edge, so its test evidence is not judged',
    help: 'The task left its workflow through the abandon edge (`scope-expanded`) into a terminal step such as `escalated`; no test evidence is required for that edge. CI does not judge its test evidence and judges the task that replaced it. Protected-file approvals are still checked for it, at normal severity, because the abandon edge needs no review. The decision rests on the transition chain the task committed, which is self-consistent but not sealed. A task that only has the terminal step written into its state, without the abandon transition in its record chain, is judged as usual.',
  },
  {
    id: 'finished-judged-at-head', name: 'FinishedJudgedAtHead', level: 'note',
    short: 'A finished task is judged against the checked-out tree, not against the commit it finished on',
    help: 'CI certifies the tree it checked out. A finished task whose evidence no longer matches that tree (the code changed afterwards, a later task added test files or edited the catalog) fails there; judging it at its own delivery commit would let later, ungoverned changes pass unseen. Check out the delivery commit to verify the task as delivered, or select only the tasks the pull request carries.',
  },
  {
    id: 'no-test-policy', name: 'NoTestPolicy', level: 'note',
    short: 'The evaluated step declares no test policy',
    help: 'There is nothing to verify at this step; this is not evidence that tests passed.',
  },
]

function policyRule(id: string, short: string, level: CiSeverity): CiRule {
  return {
    id, name: id.split('-').map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`).join(''), short, level,
    help: 'Reported by the Tenon test policy of the evaluated workflow step; the message names the exact object and the command that fixes it.',
  }
}

const BLOCKER_CODES: ReadonlySet<string> = new Set(TEST_BLOCKER_CODES)

/**
 * 同一个码可以既是阻塞又是提示（`test-integrity`：测试策略 `integrity: block` 时是阻塞，缺省的 notice 时是提示）。
 * 规则只列一条（规则 id 必须唯一），默认级别取阻塞；每条发现的级别由它自己的 severity 决定，不看规则默认值。
 */
const POLICY_RULES: readonly CiRule[] = [
  ...TEST_BLOCKER_CODES.map((code) => policyRule(code, TEST_BLOCKER_LABELS[code].en, 'error')),
  ...TEST_NOTICE_CODES.filter((code) => !BLOCKER_CODES.has(code)).map((code) => policyRule(code, TEST_NOTICE_LABELS[code].en, 'note')),
]

export const CI_RULES: readonly CiRule[] = [...CI_ONLY, ...POLICY_RULES]

const BY_ID: ReadonlyMap<string, CiRule> = new Map(CI_RULES.map((rule) => [rule.id, rule]))

export function ciRule(code: string): CiRule | undefined {
  return BY_ID.get(code)
}
