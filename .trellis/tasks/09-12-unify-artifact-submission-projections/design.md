# 技术设计

## 分层边界

`ArtifactSubmissionService` 负责 subject/version/lineage 和跨 projection orchestration；document ledger、field reducer、runtime artifact service 仍分别负责自己的治理与持久化。submission service 不直接编辑 `.pipeline.yaml`，而是调用已有 transition/reducer adapter。

```text
declaration / governed record / runtime observation
                    ↓
       ArtifactSubmissionService
       subject resolve + digest + auth
          ↓             ↓             ↓
 document adapter   field adapter   runtime adapter
 ledger projection  reducer commit   artifact version
                    ↓
          one lineage receipt/event
```

## Subject 解析

优先使用声明中的 `logicalKey`；其次使用已有 subject mapping；首次出现时由 host 生成 subject。路径、document kind、field 名称只进入 projection source metadata。每个 adapter 返回 subject ref、version、digest 和治理 receipt。

## 文档 adapter

在 `recordDocumentLedger()` 保留所有现有 policy 校验后，接受可选 subject ref，并将它写入 DocumentRecord。旧记录在首次写入时补齐 subject ref，生成 migration receipt；只读路径继续兼容无 ref 的记录。

## 字段 adapter

定位现有 field transition commit 入口，在 transition draft/record 中增加可选 output subject metadata。提交仍由 reducer 完成；submission service 只构造受限 draft 并验证 subject/version，不直接修改 state 文件。

## API/UI

Server artifact/catalog 和 workflow snapshot 返回 bounded projection metadata。Dashboard 统一以 subject_id 分组，projection 标签区分 document/field/runtime，内容读取仍按需进行。

## 失败与迁移

任一 projection adapter 失败时，canonical submission receipt 标记 `partial`，保留已写入的 immutable runtime version，并记录 retryable diagnostic。旧数据迁移必须幂等，不能删除旧路径、旧字段或旧 document records。

## 测试

加入 adapter 单测、跨 projection submission 集成测试、旧状态迁移测试和真实两阶段 workflow evidence。重点验证重复提交、rename、projection failure、权限拒绝和 restart。
