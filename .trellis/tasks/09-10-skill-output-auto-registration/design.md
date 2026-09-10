# Design — 技能产出自动登记与每回合技能状态

## 1. 边界

```
PreToolUse(Skill)  hooks/skill-start.sh   → history: {kind:'tool-start', raw:'Skill: <id>'}
PostToolUse(Skill) hooks/skill-tracker.sh → history: {kind:'tool', raw:'Skill: <id>'}
                                          → node tenon internal-native-skill-receipt（已有：写 StepVisit 确认）
                                             └─ 新增：autoRegisterDocuments（按当前阶段契约 × 该技能 → 规范路径 → 登记台账）
server snapshot → documents（已有）+ skillRuns（新增：当前阶段每个技能 idle | running | done，按波次）
dashboard 工作台 → 阶段面板顶部「技能」区：波次列 × 状态
```

不新增守卫；下一阶段的输入就绪 = 台账 recorded（已有文档策略）。hooks 仍是纯 bash，重活留在既有 node 调用里。

## 2. 契约

### 2.1 规范路径（kernel `documents/document-paths.ts`）

```ts
canonicalDocumentPaths(repoRoot, changeName, kind): Promise<string[]>  // 存在的文件，相对 repoRoot
```
来源 `DOCUMENT_PRESENTATION_REGISTRY.templates[*].path`：`{change}` 直接替换；含 `{capability}` 的（delta-spec）
展开为目录 glob（`openspec/changes/<change>/specs/*/spec.md`）。同 kind 多模板（plan / superpower-plan 同路径）各取其模板。

### 2.2 自动登记（kernel `documents/auto-register.ts`）

```ts
autoRegisterDocuments(input: {
  repoRoot, changeDir, changeName, phase, policy: DocumentGovernancePolicy, producer: string, recordedAt: string
}): Promise<{ recorded: Array<{ kind, path }>; skipped: Array<{ kind, path, reason }> }>
```
- 候选 kind = `outputsByStep[phase]` ∪ `mutableByStep[phase]` 中 `producerCandidates` 含 producer（`aliasesForSkill` 等价）的项。
- 对每个候选 kind 的每条规范路径：文件存在 → 读台账；无记录，或已有记录的 digest ≠ 当前 digest → `recordDocument({kind, path, producer, recordedAt})`；已一致 → skip(reason 'up-to-date')。
- 任一登记失败只记 `skipped(reason=错误文案)`，不抛；调用方 WARN。
- 不做「待确认」队列（prd R3 缩水为：不匹配规范路径的文件不登记、不猜）。

### 2.3 接入点

`packages/cli/src/nativeSkillReceipt.ts`：确认写入成功后，`effectiveWorkflowForState(deps, state)` 取 policy（无 policy = 非治理工作流 → 跳过），调用 autoRegisterDocuments；结果打 stderr 一行 `[auto-register] recorded=… skipped=…`（hook 已 `>/dev/null`，用于测试与手工调试）。

### 2.4 开始标记（hooks/skill-start.sh + hooks.json PreToolUse）

纯 bash：Skill 工具 + 活跃 change → 追加 `{"ts","kind":"tool-start","raw":"Skill: <id>"}`。既有读者只认 `kind==='tool'`，新 kind 不影响完成态判定。

### 2.5 快照 `skillRuns`（server `skillRuns.ts`）

```ts
skillRuns: Array<{ stepId: string; skills: Array<{ id: string; status: 'idle' | 'running' | 'done'; wave: number }> }>
```
- 每步技能集 = `capability.steps[step].requiredSkillIds` ∪ 轨道叠加层：定义内嵌矩阵时 `conditional[]` 经 `skillAppliesToTrack(skill, track)` 过滤；老快照未内嵌时退回 manifest mandatory 表（`skillsFor(table, step, profile)`，server 从已加载 manifest 注入）。wave 由 `declared[].dependsOn` 拓扑深度（条件技能无依赖 → 0）。
- 状态：step 序号 < 当前 → done；> 当前 → idle；当前步：history 自本步进入以来 `tool`(Skill: id) → done；只有 `tool-start` → running；否则 idle。
- 老 server 无该字段：前端可选。

### 2.6 前端

`ChangeSnapshot.skillRuns?`；`workspace/StageSkills.tsx`：所选阶段的技能按 wave 分列，状态用 StatusPill（running 用 pulse 点）；放在 输出 之上。词典：`workspace.skills` / `skill_idle|running|done`。

## 3. 测试

- kernel：document-paths（模板替换 + capability glob）、auto-register（无记录→登记；digest 变→重登；一致→skip；producer 不在候选→不登记；失败→skipped）。
- cli：nativeSkillReceipt 集成——写 proposal.md 后回执 → 台账出现 proposal(producer=openspec-propose)。
- server：skillRuns 投影（done/running/idle 与 wave）。
- hooks：`tools/test-hooks.sh` 加 skill-start 用例。
- web：StageSkills 渲染三态。
