# P 设计

契约必须先消除“终端 acknowledge 无 revision/key”与“hook 无 revision/key 只能 observation”的矛盾；GET/POST 使用同一 projection 输入；Dashboard POST 只接受 review；共享 acknowledge application 由 F2 先抽取，避免 server 复制 CLI 编排。
