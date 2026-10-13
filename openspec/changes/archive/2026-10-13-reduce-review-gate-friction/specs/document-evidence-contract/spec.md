# OpenSpec 增量规格

## MODIFIED Requirements

### Requirement: Review confirmation SHALL persist an exact event receipt and never self-lock
The review gate SHALL represent a pending review as a canonical, project-scoped receipt containing the exact current phase and requested transition event. After the user has seen the artifacts and explicitly confirms, `tenon review acknowledge` SHALL persist an approval receipt and clear only its matching short-lived marker projection. `tenon transition` SHALL consume only that exact approved receipt. It SHALL not require an unavailable host-specific question event, shall not treat read-only inspection as a blocked write, and shall fail closed for unrelated or unconfirmed prompts. Direct marker deletion SHALL never be an approval mechanism.

例外：受轮次上限约束的步骤上，轮次未用完时的回退边 SHALL 不需要评审回执（见 `verify-round-limit`「轮次内回退 SHALL 不需要评审回执」）；这次转换照常清空当前步骤上任何待确认或已批准的回执。

#### Scenario: Explicit confirmation unlocks only the requested transition
- **WHEN** a review receipt for `verify-pass` is pending and the user explicitly confirms it
- **THEN** the confirmation hook or CLI acknowledgement persists approval for the current phase and `verify-pass`, clears only the matching marker projection, and the next authorized `verify-pass` transition can run

#### Scenario: A different event cannot reuse an approval
- **WHEN** a `verify-fail` receipt is approved and a caller attempts `verify-pass`
- **THEN** the transition is rejected because the approved receipt does not match the requested event

#### Scenario: 轮次内回退不需要回执
- **WHEN** verify 步轮次未用完，`verify-pass` 的回执已批准，调用方执行 `verify-fail`
- **THEN** 转换成功，`verify-pass` 的回执随之被清空，不能再用于之后的 `verify-pass`

#### Scenario: Unrelated prompt does not unlock a review marker
- **WHEN** a review marker is active and the user submits an unrelated message
- **THEN** the marker remains active, no approval receipt is written, and mutation attempts remain blocked
