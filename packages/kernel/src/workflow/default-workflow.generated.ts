/**
 * DO NOT EDIT —— 生成文件。
 * 由 tools/generate-default-workflow.mjs 从 templates/workflows/default.yaml 生成。
 * 重新生成：npm run generate:default-workflow
 * 来源：templates/workflows/default.yaml
 *
 * 含稳定排序的 default step 元数据（通用分支）与按分支（_base + tracks.<id>）的 artifact declaration 纯数据；查询在
 * 手写层 default-artifacts.ts / todo-projection.ts。改 default.yaml 后须重跑生成（CI freshness
 * 门禁逐字节校验）。
 */
import type { DefaultArtifactDeclaration } from './default-artifacts.js'

export const DEFAULT_WORKFLOW_SOURCE = "name: default\nreview_budget:\n  version: v1\n  max_attempts: 2\ntracks:\n  chat:\n    label: 对话\n    steps:\n      - id: open\n        label: 立项\n        gate: null\n        skills:\n          - id: tenon-open\n        inputs: []\n        outputs: []\n        guards: []\n        transitions:\n          - event: open-complete\n            to: explore\n      - id: explore\n        label: 调研\n        gate: review\n        skills:\n          - id: tenon-explore\n        inputs: []\n        outputs:\n          - field: design_doc\n            type: file_path\n        artifacts:\n          - field: design_doc\n            type: file_path\n            producer_policy: effective-phase-skills\n        guards: []\n        transitions:\n          - event: explore-complete\n            to: spec\n      - id: spec\n        label: 规格\n        gate: review\n        skills:\n          - id: tenon-spec\n        inputs:\n          - field: design_doc\n            type: file_path\n        outputs:\n          - field: plan\n            type: file_path\n        artifacts:\n          - field: plan\n            type: file_path\n            producer_policy: effective-phase-skills\n        guards:\n          - type: tasks-at-least\n            n: 3\n        transitions:\n          - event: spec-complete\n            to: build\n            actions:\n              - type: reset-pre-verify-review\n      - id: build\n        label: 实现\n        gate: null\n        skills:\n          - id: tenon-build\n        inputs:\n          - field: design_doc\n            type: file_path\n          - field: plan\n            type: file_path\n        outputs:\n          - field: build_sha\n            type: string\n        guards:\n          - type: field-equals\n            field: pre_verify_review_result\n            value: pass\n        transitions:\n          - event: build-complete\n            to: verify\n          - event: requirements-changed\n            to: spec\n            actions:\n              - type: reset-pre-verify-review\n      - id: verify\n        label: 验证\n        gate: review\n        review_lanes: [standards, spec, e2e]\n        skills:\n          - id: tenon-verify\n        inputs:\n          - field: build_sha\n            type: string\n        outputs:\n          - field: verification_report\n            type: file_path\n        artifacts:\n          - field: verification_report\n            type: file_path\n            producer_policy: effective-phase-skills\n        guards: []\n        transitions:\n          - event: verify-pass\n            to: ship\n          - event: verify-fail\n            to: build\n            actions:\n              - type: mark-verification-failed\n              - type: reset-pre-verify-review\n      - id: ship\n        label: 交付\n        gate: null\n        skills:\n          - id: tenon-ship\n        inputs:\n          - field: verification_report\n            type: file_path\n        outputs:\n          - field: pr_url\n            type: string\n        guards:\n          - type: spec-migration-applied\n        transitions:\n          - event: ship-complete\n            to: archive\n      - id: archive\n        label: 归档\n        gate: null\n        skills:\n          - id: tenon-archive\n        inputs:\n          - field: pr_url\n            type: string\n        outputs:\n          - field: archived\n            type: boolean\n        guards: []\n        transitions: []\n  pm:\n    label: 产品\n    steps:\n      - id: open\n        label: 立项\n        gate: null\n        skills:\n          - id: tenon-open\n          - id: openspec-propose\n        inputs: []\n        outputs: []\n        guards: []\n        transitions:\n          - event: open-complete\n            to: explore\n      - id: explore\n        label: 调研\n        gate: review\n        skills:\n          - id: tenon-explore\n          - id: brainstorming\n          - id: grill-with-docs\n        inputs: []\n        outputs:\n          - field: design_doc\n            type: file_path\n        artifacts:\n          - field: design_doc\n            type: file_path\n            producer_policy: effective-phase-skills\n        guards: []\n        transitions:\n          - event: explore-complete\n            to: spec\n      - id: spec\n        label: 规格\n        gate: review\n        skills:\n          - id: tenon-spec\n          - id: openspec-propose\n          - id: brainstorming\n          - id: writing-plans\n          - id: grill-with-docs\n        inputs:\n          - field: design_doc\n            type: file_path\n        outputs:\n          - field: plan\n            type: file_path\n        artifacts: []\n        guards:\n          - type: tasks-at-least\n            n: 3\n        transitions:\n          - event: spec-complete\n            to: build\n            actions:\n              - type: reset-pre-verify-review\n      - id: build\n        label: 实现\n        gate: null\n        skills:\n          - id: tenon-build\n          - id: prototype\n          - id: frontend-design\n        inputs:\n          - field: design_doc\n            type: file_path\n          - field: plan\n            type: file_path\n        outputs:\n          - field: build_sha\n            type: string\n        guards:\n          - type: field-equals\n            field: pre_verify_review_result\n            value: pass\n        transitions:\n          - event: build-complete\n            to: verify\n          - event: requirements-changed\n            to: spec\n            actions:\n              - type: reset-pre-verify-review\n      - id: verify\n        label: 验证\n        gate: review\n        review_lanes: [standards, spec, e2e]\n        skills:\n          - id: tenon-verify\n          - id: browser-qa\n          - id: web-design-guidelines\n          - id: design-taste-frontend\n          - id: verification-before-completion\n          - id: handoff\n        inputs:\n          - field: build_sha\n            type: string\n        outputs:\n          - field: verification_report\n            type: file_path\n        artifacts:\n          - field: verification_report\n            type: file_path\n            producer_policy: effective-phase-skills\n        guards: []\n        transitions:\n          - event: verify-pass\n            to: ship\n          - event: verify-fail\n            to: build\n            actions:\n              - type: mark-verification-failed\n              - type: reset-pre-verify-review\n      - id: ship\n        label: 交付\n        gate: null\n        skills:\n          - id: tenon-ship\n          - id: openspec-apply-change\n          - id: to-spec\n          - id: to-tickets\n        inputs:\n          - field: verification_report\n            type: file_path\n        outputs:\n          - field: pr_url\n            type: string\n        guards:\n          - type: spec-migration-applied\n        transitions:\n          - event: ship-complete\n            to: archive\n      - id: archive\n        label: 归档\n        gate: null\n        skills:\n          - id: tenon-archive\n        inputs:\n          - field: pr_url\n            type: string\n        outputs:\n          - field: archived\n            type: boolean\n        guards: []\n        transitions: []\n  frontend:\n    label: 前端\n    steps:\n      - id: open\n        label: 立项\n        gate: null\n        skills:\n          - id: tenon-open\n          - id: openspec-propose\n        inputs: []\n        outputs: []\n        guards: []\n        transitions:\n          - event: open-complete\n            to: explore\n      - id: explore\n        label: 调研\n        gate: review\n        skills:\n          - id: tenon-explore\n          - id: openspec-explore\n          - id: brainstorming\n          - id: grill-with-docs\n        inputs: []\n        outputs:\n          - field: design_doc\n            type: file_path\n        artifacts:\n          - field: design_doc\n            type: file_path\n            producer_policy: effective-phase-skills\n        guards: []\n        transitions:\n          - event: explore-complete\n            to: spec\n      - id: spec\n        label: 规格\n        gate: review\n        skills:\n          - id: tenon-spec\n          - id: openspec-propose\n          - id: writing-plans\n        inputs:\n          - field: design_doc\n            type: file_path\n        outputs:\n          - field: plan\n            type: file_path\n        artifacts:\n          - field: plan\n            type: file_path\n            producer_policy: effective-phase-skills\n        guards:\n          - type: tasks-at-least\n            n: 3\n        transitions:\n          - event: spec-complete\n            to: build\n            actions:\n              - type: reset-pre-verify-review\n      - id: build\n        label: 实现\n        gate: null\n        skills:\n          - id: tenon-build\n          - id: frontend-design\n          - id: test-driven-development\n        inputs:\n          - field: design_doc\n            type: file_path\n          - field: plan\n            type: file_path\n        outputs:\n          - field: build_sha\n            type: string\n        guards:\n          - type: field-equals\n            field: pre_verify_review_result\n            value: pass\n        transitions:\n          - event: build-complete\n            to: verify\n          - event: requirements-changed\n            to: spec\n            actions:\n              - type: reset-pre-verify-review\n      - id: verify\n        label: 验证\n        gate: review\n        review_lanes: [standards, spec, e2e]\n        skills:\n          - id: tenon-verify\n          - id: browser-qa\n          - id: web-design-guidelines\n          - id: design-taste-frontend\n          - id: verification-before-completion\n          - id: e2e-testing\n        inputs:\n          - field: build_sha\n            type: string\n        outputs:\n          - field: verification_report\n            type: file_path\n        artifacts:\n          - field: verification_report\n            type: file_path\n            producer_policy: effective-phase-skills\n        guards: []\n        transitions:\n          - event: verify-pass\n            to: ship\n          - event: verify-fail\n            to: build\n            actions:\n              - type: mark-verification-failed\n              - type: reset-pre-verify-review\n      - id: ship\n        label: 交付\n        gate: null\n        skills:\n          - id: tenon-ship\n          - id: openspec-apply-change\n          - id: openspec-archive-change\n          - id: finishing-a-development-branch\n        inputs:\n          - field: verification_report\n            type: file_path\n        outputs:\n          - field: pr_url\n            type: string\n        guards:\n          - type: spec-migration-applied\n        transitions:\n          - event: ship-complete\n            to: archive\n      - id: archive\n        label: 归档\n        gate: null\n        skills:\n          - id: tenon-archive\n        inputs:\n          - field: pr_url\n            type: string\n        outputs:\n          - field: archived\n            type: boolean\n        guards: []\n        transitions: []\n  backend:\n    label: 后端\n    steps:\n      - id: open\n        label: 立项\n        gate: null\n        skills:\n          - id: tenon-open\n          - id: openspec-propose\n        inputs: []\n        outputs: []\n        guards: []\n        transitions:\n          - event: open-complete\n            to: explore\n      - id: explore\n        label: 调研\n        gate: review\n        skills:\n          - id: tenon-explore\n          - id: openspec-explore\n          - id: brainstorming\n          - id: grill-with-docs\n          - id: improve-codebase-architecture\n        inputs: []\n        outputs:\n          - field: design_doc\n            type: file_path\n        artifacts:\n          - field: design_doc\n            type: file_path\n            producer_policy: effective-phase-skills\n        guards: []\n        transitions:\n          - event: explore-complete\n            to: spec\n      - id: spec\n        label: 规格\n        gate: review\n        skills:\n          - id: tenon-spec\n          - id: openspec-propose\n          - id: writing-plans\n        inputs:\n          - field: design_doc\n            type: file_path\n        outputs:\n          - field: plan\n            type: file_path\n        artifacts:\n          - field: plan\n            type: file_path\n            producer_policy: effective-phase-skills\n        guards:\n          - type: tasks-at-least\n            n: 3\n        transitions:\n          - event: spec-complete\n            to: build\n            actions:\n              - type: reset-pre-verify-review\n      - id: build\n        label: 实现\n        gate: null\n        skills:\n          - id: tenon-build\n          - id: test-driven-development\n          - id: writing-plans\n        inputs:\n          - field: design_doc\n            type: file_path\n          - field: plan\n            type: file_path\n        outputs:\n          - field: build_sha\n            type: string\n        guards:\n          - type: field-equals\n            field: pre_verify_review_result\n            value: pass\n        transitions:\n          - event: build-complete\n            to: verify\n          - event: requirements-changed\n            to: spec\n            actions:\n              - type: reset-pre-verify-review\n      - id: verify\n        label: 验证\n        gate: review\n        review_lanes: [standards, spec, e2e]\n        skills:\n          - id: tenon-verify\n          - id: verification-before-completion\n        inputs:\n          - field: build_sha\n            type: string\n        outputs:\n          - field: verification_report\n            type: file_path\n        artifacts:\n          - field: verification_report\n            type: file_path\n            producer_policy: effective-phase-skills\n        guards: []\n        transitions:\n          - event: verify-pass\n            to: ship\n          - event: verify-fail\n            to: build\n            actions:\n              - type: mark-verification-failed\n              - type: reset-pre-verify-review\n      - id: ship\n        label: 交付\n        gate: null\n        skills:\n          - id: tenon-ship\n          - id: openspec-apply-change\n          - id: finishing-a-development-branch\n        inputs:\n          - field: verification_report\n            type: file_path\n        outputs:\n          - field: pr_url\n            type: string\n        guards:\n          - type: spec-migration-applied\n        transitions:\n          - event: ship-complete\n            to: archive\n      - id: archive\n        label: 归档\n        gate: null\n        skills:\n          - id: tenon-archive\n        inputs:\n          - field: pr_url\n            type: string\n        outputs:\n          - field: archived\n            type: boolean\n        guards: []\n        transitions: []\n  free:\n    label: 自由\n    steps:\n      - id: open\n        label: 立项\n        gate: null\n        skills:\n          - id: tenon-open\n          - id: openspec-propose\n        inputs: []\n        outputs: []\n        guards: []\n        transitions:\n          - event: open-complete\n            to: explore\n      - id: explore\n        label: 调研\n        gate: review\n        skills:\n          - id: tenon-explore\n          - id: brainstorming\n        inputs: []\n        outputs:\n          - field: design_doc\n            type: file_path\n        artifacts:\n          - field: design_doc\n            type: file_path\n            producer_policy: effective-phase-skills\n        guards: []\n        transitions:\n          - event: explore-complete\n            to: spec\n      - id: spec\n        label: 规格\n        gate: review\n        skills:\n          - id: tenon-spec\n          - id: openspec-propose\n          - id: writing-plans\n        inputs:\n          - field: design_doc\n            type: file_path\n        outputs:\n          - field: plan\n            type: file_path\n        artifacts:\n          - field: plan\n            type: file_path\n            producer_policy: effective-phase-skills\n        guards:\n          - type: tasks-at-least\n            n: 3\n        transitions:\n          - event: spec-complete\n            to: build\n            actions:\n              - type: reset-pre-verify-review\n      - id: build\n        label: 实现\n        gate: null\n        skills:\n          - id: tenon-build\n          - id: test-driven-development\n          - id: writing-plans\n        inputs:\n          - field: design_doc\n            type: file_path\n          - field: plan\n            type: file_path\n        outputs:\n          - field: build_sha\n            type: string\n        guards:\n          - type: field-equals\n            field: pre_verify_review_result\n            value: pass\n        transitions:\n          - event: build-complete\n            to: verify\n          - event: requirements-changed\n            to: spec\n            actions:\n              - type: reset-pre-verify-review\n      - id: verify\n        label: 验证\n        gate: review\n        review_lanes: [standards, spec, e2e]\n        skills:\n          - id: tenon-verify\n          - id: verification-before-completion\n        inputs:\n          - field: build_sha\n            type: string\n        outputs:\n          - field: verification_report\n            type: file_path\n        artifacts:\n          - field: verification_report\n            type: file_path\n            producer_policy: effective-phase-skills\n        guards: []\n        transitions:\n          - event: verify-pass\n            to: ship\n          - event: verify-fail\n            to: build\n            actions:\n              - type: mark-verification-failed\n              - type: reset-pre-verify-review\n      - id: ship\n        label: 交付\n        gate: null\n        skills:\n          - id: tenon-ship\n          - id: openspec-apply-change\n          - id: finishing-a-development-branch\n        inputs:\n          - field: verification_report\n            type: file_path\n        outputs:\n          - field: pr_url\n            type: string\n        guards:\n          - type: spec-migration-applied\n        transitions:\n          - event: ship-complete\n            to: archive\n      - id: archive\n        label: 归档\n        gate: null\n        skills:\n          - id: tenon-archive\n        inputs:\n          - field: pr_url\n            type: string\n        outputs:\n          - field: archived\n            type: boolean\n        guards: []\n        transitions: []\n"

export const DEFAULT_WORKFLOW_STEPS = [
  { id: "open", label: "立项" },
  { id: "explore", label: "调研" },
  { id: "spec", label: "规格" },
  { id: "build", label: "实现" },
  { id: "verify", label: "验证" },
  { id: "ship", label: "交付" },
  { id: "archive", label: "归档" },
] as const

export const DEFAULT_ARTIFACT_DECLARATIONS = {
  chat: {
    explore: [
      {
        kind: 'file',
        field: 'design_doc',
        type: 'file_path',
        producerPolicy: 'effective-phase-skills',
      },
    ],
    spec: [
      {
        kind: 'file',
        field: 'plan',
        type: 'file_path',
        producerPolicy: 'effective-phase-skills',
      },
    ],
    verify: [
      {
        kind: 'file',
        field: 'verification_report',
        type: 'file_path',
        producerPolicy: 'effective-phase-skills',
      },
    ],
  },
  pm: {
    explore: [
      {
        kind: 'file',
        field: 'design_doc',
        type: 'file_path',
        producerPolicy: 'effective-phase-skills',
      },
    ],
    verify: [
      {
        kind: 'file',
        field: 'verification_report',
        type: 'file_path',
        producerPolicy: 'effective-phase-skills',
      },
    ],
  },
  frontend: {
    explore: [
      {
        kind: 'file',
        field: 'design_doc',
        type: 'file_path',
        producerPolicy: 'effective-phase-skills',
      },
    ],
    spec: [
      {
        kind: 'file',
        field: 'plan',
        type: 'file_path',
        producerPolicy: 'effective-phase-skills',
      },
    ],
    verify: [
      {
        kind: 'file',
        field: 'verification_report',
        type: 'file_path',
        producerPolicy: 'effective-phase-skills',
      },
    ],
  },
  backend: {
    explore: [
      {
        kind: 'file',
        field: 'design_doc',
        type: 'file_path',
        producerPolicy: 'effective-phase-skills',
      },
    ],
    spec: [
      {
        kind: 'file',
        field: 'plan',
        type: 'file_path',
        producerPolicy: 'effective-phase-skills',
      },
    ],
    verify: [
      {
        kind: 'file',
        field: 'verification_report',
        type: 'file_path',
        producerPolicy: 'effective-phase-skills',
      },
    ],
  },
  free: {
    explore: [
      {
        kind: 'file',
        field: 'design_doc',
        type: 'file_path',
        producerPolicy: 'effective-phase-skills',
      },
    ],
    spec: [
      {
        kind: 'file',
        field: 'plan',
        type: 'file_path',
        producerPolicy: 'effective-phase-skills',
      },
    ],
    verify: [
      {
        kind: 'file',
        field: 'verification_report',
        type: 'file_path',
        producerPolicy: 'effective-phase-skills',
      },
    ],
  },
} as const satisfies Readonly<Record<string, Readonly<Record<string, readonly DefaultArtifactDeclaration[]>>>>
