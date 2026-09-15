---
id: mysql
category: database
title: MySQL
directory: sql/
directory_label: 全部数据库初始化脚本
---
## 数据库（MySQL）

### 脚本

- 数据库使用 MySQL LTS 版本（8.4 或 9.7），禁止在生产环境使用 Innovation 版本。
- 所有初始化脚本放在 `sql/` 目录，按执行顺序编号命名（如 `sql/001_init_schema.sql`），脚本开头写 `SET NAMES utf8mb4;`。
- 禁止使用任何迁移框架与 ORM 自动建表：Flyway、Liquibase、Alembic、Django migrations、Prisma Migrate、EF Core migrations、
  Laravel migrations、Rails migrations、`sqlx migrate` 等一律不用。

### 表结构

- 每张表使用 `ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`，写在建表语句中。
- 每张表必须包含：

```sql
id         bigint      not null auto_increment primary key comment '主键',
version    bigint      not null default 0 comment '乐观锁版本号',
created_at datetime(3) not null default current_timestamp(3) comment '创建时间',
updated_at datetime(3) not null default current_timestamp(3) on update current_timestamp(3) comment '更新时间'
```

- 时间以 UTC 存储（连接时区设为 `+00:00`），时区转换由应用层负责。
- 禁止软删除（不得出现 `deleted`、`is_deleted`、`deleted_at` 等删除标记字段）。
- 所有表和字段必须用内联 `COMMENT` 写中文注释。
- 金额使用 `decimal`，禁止用 `float` / `double` 保存金额。

### 约束

- 禁止使用存储过程、触发器与事件；`updated_at` 由 `ON UPDATE CURRENT_TIMESTAMP(3)` 维护。
- 必须符合第三范式；确需反范式设计时，在表或字段注释以及回复中写明理由。
- 新增表之前必须梳理已有表的字段与关联关系，能用已有表表达的不得新增表；新增时在回复中说明梳理结论。
