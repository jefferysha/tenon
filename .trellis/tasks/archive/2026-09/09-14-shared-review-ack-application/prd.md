# F2：共享 review acknowledge application

依赖 P 契约裁决和 F1 集成修复。将 CLI `review acknowledge` 的完整编排抽到不依赖 CLI/server/HTTP 的共享 application：Change lock、derived terminal key、exact receipt/binding、canonical patch、interaction/history/marker、rejected/错误结果。CLI 与 server 只做薄适配；server 传 `channel=dashboard`。POST 只支持 review，不能创建不存在的 approval。

验收：CLI/server 同一夹具结果等价（via 除外）；缺 receipt、binding mismatch、revision conflict、重复 key 和意外异常的错误码与零写入语义符合契约；无 server→cli 依赖；build、目标测试、dist freshness、架构检查通过。
