# 统一采买站（campus-tokenhub-assign）使用教程

> 面向：接手部署的运维、学校信息化老师、后续开发者  
> 覆盖：部署 → 使用 → 运维 → 自定义需求开发  
> 配套仓库：`campus-tokenhub-assign`（本手册）；成员自购站见独立手册《campus-tokenhub-member 使用教程》

---

## 目录

1. [十分钟看懂这套东西](#0-十分钟看懂这套东西)
2. [部署](#1-部署)
3. [使用](#2-使用)
4. [运维](#3-运维)
5. [自定义需求开发](#4-自定义需求开发)
6. [附录：配置 / 接口 / 数据表](#5-附录配置--接口--数据表)

---

## 0. 十分钟看懂这套东西

### 0.1 它是干什么的

学校自己的 AI 模型门户。学生用学校账号登录，自助领取一个 API Key，查看可用模型、价格和用量，并在浏览器里直接试调；管理员在同一个后台配登录方式、默认额度、运营活动和品牌。

它本身**不承载推理流量**：学生拿着 Key 直连网关，门户只负责身份、发号、看板和配置。

### 0.2 五个部件

| 部件       | 容器              | 职责                        | 能不能少      |
| -------- | --------------- | ------------------------- | --------- |
| Postgres | `postgres`      | 一个库，多个 schema。网关数据 + 门户数据 | 不能        |
| 网关迁移     | `migrate`       | 一次性建表 / 升级表结构，跑完退出        | 不能（但只跑一次） |
| 推理网关     | `gateway-proxy` | 学生请求的落点，`/v1/*` 流式转发      | 不能        |
| 网关管理台    | `gateway-admin` | 供应商、模型、路由、额度、调用日志         | 不能        |
| 门户       | `portal`        | 学生看到的全部页面 + 管理配置          | 不能        |
| 登录种子     | `portal-seed`   | 一次性把学校 SSO 参数写进库，跑完退出     | 可选（首次有用）  |
| nginx    | `nginx`         | 唯一对外入口，按路径分流              | 生产必需      |

### 0.3 一次请求怎么走

```
学生浏览器
   │  https://<域名>/tokenhub/portal/...      （页面 / 登录）
   │  https://<域名>/tokenhub/v1/chat/...     （带 Bearer Key 的真实调用）
   ▼
CLB（只做一级转发，不改写路径）
   ▼
nginx :8088
   ├─ /tokenhub/admin/**   → gateway-admin:8789   （剥掉前缀）
   ├─ /tokenhub/portal/**  → portal:3000          （原样透传，Next 自带 basePath）
   └─ /tokenhub/**         → gateway-proxy:8787   （剥掉前缀）
```

记住一句话：**门户原样透传，管理台和网关剥前缀**。门户是 Next，静态资源和跳转都是根绝对路径，剥了前缀就会去域名根取 `/_next/...`，在共享域名上既 404 又抢别人的路径。

### 0.4 数据边界（排障时最有用的一张表）

| 数据              | 权威来源                                              | 门户是否存           |
| --------------- | ------------------------------------------------- | --------------- |
| 学生身份            | 学校 IdP                                            | 否，只在会话 Cookie 里 |
| 网关用户 ID         | OctaFuse（`external_system + external_user_id` 幂等） | 否，在会话里          |
| 额度 / Key / 调用日志 | 网关 Admin API                                      | 否，实时读           |
| 模型目录            | 网关 Proxy `/catalog/models`                        | 进程内缓存 60 秒      |
| 运营活动            | 门户库 `portal_assign.activity_configs`              | **是**           |
| 管理员名单           | 门户库 `portal_shared.admins`                        | **是**（两站共用一份）   |
| 学校云厂商 Key       | 网关 `providers.api_key`                            | 否，只在服务端流转       |

判断"这是门户的问题还是网关的问题"，先看这张表：额度不对、Key 领不出来、模型看不到，八成在网关侧；页面打不开、登录跳转异常、设置存不进去，在门户侧。

---

## 1. 部署


### 1.1 机器规格

生产按 **16C / 32G / 1TB SSD 起步**。这不是"跑得动"的下限，而是"全校在用、还要留出构建与扩容余量"的起步线。

| 环境         | CPU | 内存  | 磁盘      | 说明                           |
| ---------- | --- | --- | ------- | ---------------------------- |
| **生产（起步）** | 16C | 32G | 1TB SSD | 单机部署全套（PG + 网关 + 门户 + nginx） |
| 生产（规模更大）   | 32C | 64G | 2TB SSD | 或把 Postgres 拆到独立实例           |
| 预发 / 验收    | 8C  | 16G | 200G    | 与生产同架构，缩规格，用来验证升级            |
| 本地开发       | 4C  | 8G  | 50G     | 只跑网关 + `npm run dev`，不需要全栈   |

SSD 是硬要求：Postgres 的 WAL 写入和 `request_content` 分区表都吃随机 IO，机械盘上调用日志页会明显卡。

> 100 路并发流式请求要多少内存/CPU、以及"要不要把 proxy 与数据库拆到两台机器"，见 1.1.6——结论是单机够，拆机看的是 QPS 不是并发数。

其余前置条件：

| 项       | 要求                               | 说明                                             |
| ------- | -------------------------------- | ---------------------------------------------- |
| 系统      | Ubuntu 22.04 / Debian 12（x86_64） | macOS 能跑，生产不建议                                 |
| Docker  | 24+，含 Compose v2                 | 用 `docker compose`，不是 `docker-compose`         |
| Node.js | 生产不需要                            | 只在宿主机跑 dev 或装 CodeBuddy CLI 时需要（CLI 可用原生安装器绕开） |
| 域名 / 证书 | 生产必需                             | TLS 在 CLB 或外层反代终止，容器内是 HTTP                    |
| 出网      | 能访问模型供应商 API                     | 否则学生调用全部失败，且初始化向导的"检测 Key"不过                   |

#### 1.1.1 32G 内存怎么分

单机跑全套时，按这个比例留，别让某个容器把整机吃干：

| 用途            | 建议内存   | 说明                                 |
| ------------- | ------ | ---------------------------------- |
| Postgres      | 8–10 G | `shared_buffers` 2–4 G，其余留给页缓存与连接  |
| gateway-proxy | 2–4 G  | 流式转发，占用随并发连接线性涨                    |
| gateway-admin | 1–2 G  | 管理台 + 它的 Node 服务                   |
| portal（每个副本）  | 1–2 G  | Next standalone，Node 堆通常 512 M–1 G |
| nginx         | 256 M  |                                    |
| 系统 + 文件缓存     | 剩余     | **不要把 32G 全部分给容器**，PG 依赖页缓存        |

需要硬限制时给单个服务加（Compose v2 也生效）：

```yaml
services:
  gateway-proxy:
    deploy:
      resources:
        limits:
          memory: 4g
```

#### 1.1.2 16 核不等于快 16 倍

这条必须提前说清，否则会误判"机器买了还是很慢"：

- **Next standalone 是单进程**。一个 portal 副本平时只吃 1 个核，`docker stats` 里看到它 100% 就是单核打满，不是整机打满。
- 16C 的价值主要在：Postgres 的并行查询 / autovacuum / 多连接、gateway-proxy 的并发流式连接、镜像构建，以及留出多副本的余量。
- 门户本身是 IO 等待型（等 PG、等网关），单副本扛几百并发很常见。**先看 `docker stats` 再决定要不要多副本**：portal 长期贴着单核 100% 才需要。

真要多副本时（会话是 JWT，无状态，**不需要 sticky session**）：

```yaml
# docker-compose.yml：先删掉 portal 服务的 container_name
services:
  portal:
    # container_name: campus-tokenhub   ← 删掉这行
```

> 别以为删不删都行：**带着 `container_name` 执行 `--scale`，compose 只打一条 WARNING 就继续跑，实际仍然只有 1 个副本**（实测 Compose v5）：
> `WARNING: The "portal" service is using the custom container name ... Remove the custom name to scale the service`
> 不报错、`ps` 里也确实只有一个，很容易误判"扩容成功但没效果"。

```bash
docker compose up -d --scale portal=4
docker compose logs portal          # 聚合所有副本；docker logs campus-tokenhub 不再适用
```

但注意：compose 里的 nginx 写的是 `upstream { server portal:3000; }`，**启动时只解析一次 DNS**，扩容后流量仍然只打到其中一个副本。要让 nginx 跟着走，得改成运行时解析：

```nginx
# 在 server 块外
resolver 127.0.0.11 valid=10s ipv6=off;   # Docker 内置 DNS

# 在 server 块内，替换原来的 location /tokenhub/portal/ 两段
location /tokenhub/portal/ {
    set $portal_backend "portal:3000";
    proxy_pass http://$portal_backend;
    proxy_http_version 1.1;
    proxy_set_header Connection "";
}
```

取舍：变量形式的 `proxy_pass` 用不了 upstream 的 `keepalive`，连接复用靠 HTTP/1.1 长连接；换来的是副本数变化无需改配置。副本数固定时，也可以直接写 4 条 `server` 条目 + `least_conn`，性能更好但扩容要改配置重启 nginx。

改完模板必须 `docker compose restart nginx`——模板只在容器启动时由 `envsubst` 渲染一次，热改文件不生效。之后 `docker compose ps` 应看到 4 个 portal 全部 healthy，再 `curl` 两次健康检查确认都被服务到。

proxy 的多副本思路完全一样，但要先看 1.1.6 的结论：100 并发不需要给 proxy 扩副本，它的瓶颈在数据库写入而不在自身。

#### 1.1.3 1TB 磁盘怎么用

| 占用               | 量级      | 说明                                  |
| ---------------- | ------- | ----------------------------------- |
| Docker 镜像 + 构建缓存 | 20–40 G | 构建缓存会长，定期 `docker builder prune -f` |
| Postgres 数据      | 主要增长项   | 调用日志 + `request_content` 正文留存       |
| 系统 / 日志 / 备份临时文件 | 20–50 G | `pg_dump` 落盘时是瞬时峰值                  |
| 预留               | ≥ 20%   | 别写满，PG 需要空间做 vacuum 与 WAL           |

正文留存的量级按 `每天调用数 × 单次正文大小 × 保留天数` 估，**1 万学生的具体账见下一节 1.1.4**，那里给了单次字节拆解和三档场景表。

**运维动作**：磁盘 80% 告警。到 85% 先查是谁在涨：

```bash
docker system df
docker compose exec -T postgres psql -U octafuse -d octafuse -c "
select relname,
       pg_size_pretty(pg_total_relation_size(c.oid)) as total
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'octafuse_gateway' and c.relkind = 'r'
order by pg_total_relation_size(c.oid) desc limit 10;"
```

前十名里通常是 `api_key_request_logs` 和 `request_content_*` 分区。处置见 3.6 第 12 条。

#### 1.1.4 日志容量估算（1 万学生口径）

先给结论：**1 万学生按日常使用，正文留 90 天 + 日志留 1 年，典型场景第一年末约 100 GB；按这个用法 1TB 盘能撑十年上下**。会爆盘的不是学生数量，而是三种情况：长上下文调用占比高、`api_key_request_logs` 从不清（它没有自动清理）、以及删数据后没回收空间。

**单次调用的真实字节**（下面这张表是本节的算法基础）：

| 环节       | 量级             | 说明                                                          |
| -------- | -------------- | ----------------------------------------------------------- |
| 正文原文     | 8.6 KB         | 按本机实测均值：输入 1532 tokens + 输出 6                               |
| PG 压缩后   | ≈ 4.7 KB       | text 超 2 KB 走 TOAST + pglz，中文/代码压缩率约 45%                    |
| 主键索引     | ≈ 0.2 KB       | `request_content` 只有 `(request_log_id, created_at)` 一个 pkey |
| **正文合计** | **≈ 5 KB/次**   | 存进 `request_content_YYYY_MM`                                |
| 日志行 heap | ≈ 0.7 KB       | `api_key_request_logs` 一行约 45 列，多数为 NULL                    |
| 日志索引     | ≈ 1.1 KB       | **15 个 btree**，多数是 `(text, timestamptz)` 组合键                |
| **日志合计** | **≈ 1.8 KB/次** | 这张表没有自动清理，会一直涨                                              |

> 本地库现在 `api_key_request_logs` 显示 1739 行占 580 MB（heap 107 MB + 索引 473 MB），**不能拿它当单行成本**——那是压测后删数据留下的高水位（`n_dead_tup=0` 但文件没缩）。判断自己的库是"真大"还是"膨胀"，见本节最后的排查 SQL。

**三档场景**（日活、调用频次、上下文长度一起变）：

| 参数       | 保守               | 典型                | 重度                 |
| -------- | ---------------- | ----------------- | ------------------ |
| 学生总数     | 10,000           | 10,000            | 10,000             |
| 日活比例     | 20%（2,000 人）     | 40%（4,000 人）      | 60%（6,000 人）       |
| 人均调用 / 天 | 5                | 20                | 40                 |
| **日调用量** | 1 万              | **8 万**           | 24 万               |
| 单次输入+输出  | 500 + 300 tokens | 1532 + 614 tokens | 4000 + 1200 tokens |
| 单次正文     | 2 KB             | 5 KB              | 12 KB              |

**容量汇总**（正文按 90 天保留、日志按自然累积）：

| 场景     | 每天新增       | 正文 90 天（上界 120 天） | 日志（1 年）   | 第一年末占用       | 1TB 可撑（不含备份）                |
| ------ | ---------- | ----------------- | --------- | ------------ | --------------------------- |
| 保守     | 38 MB      | 1.8 GB（2.4 GB）    | 6.6 GB    | ≈ 9 GB       | 二十年以上                       |
| **典型** | **544 MB** | **36 GB（48 GB）**  | **52 GB** | **≈ 100 GB** | **约 10 年；含 1 份本地全量备份约 5 年** |
| 重度     | 3.3 GB     | 259 GB（345 GB）    | 158 GB    | ≈ 500 GB     | 约 2 年；备份必须外置到对象存储           |

正文是滚动保留（不随年限增长），日志是线性累积——所以"能撑多久"由日志那一列决定，不是由学生数量决定。

折算成好记的系数：**每 1,000 名日活学生，典型场景约 136 MB/天**（8 万次按 4,000 日活算）。人数翻倍就乘 2，上下文翻倍就在正文那一列再乘 2。

三个必须知道的边界：

1. **正文保留是"整月 drop"**。`request_content_drop_expired()` 只删整月都过期的分区，`REQUEST_CONTENT_RETENTION_DAYS=90` 实际最多留 **120 天**，估算按 120 天算上界。
2. **`api_key_request_logs` 没有保留策略**。网关代码里只有正文分区的清理，日志明细只能自己删，不删就是永久累积——上表"日志（1 年）"这一列是理想值，放任不管会是它的 3 倍。
3. **极端值会直接击穿估算**。单侧上限 `REQUEST_CONTENT_MAX_CHARS=65536`，两侧打满约 200 KB/次：8 万次/天就是 16 GB/天，1TB 撑不到 3 个月。长文档问答、代码整文件分析这类场景要单独压测，不能套上表。

**测自己库的真实增长**（跑一周就有数）：

```sql
-- 每天调用量与平均正文字符数（只扫最近 14 天分区）
select date_trunc('day', created_at)::date as day,
       count(*)                                        as calls,
       round(avg(coalesce(input_chars,0) + coalesce(output_chars,0))) as avg_chars
from octafuse_gateway.request_content
where created_at > now() - interval '14 days'
group by 1 order by 1 desc;

-- 日志每天涨多少行
select date_trunc('day', created_at)::date as day, count(*) as calls
from octafuse_gateway.api_key_request_logs
where created_at > now() - interval '14 days'
group by 1 order by 1 desc;
```

**判断"真大"还是"膨胀"**（三个数一起看）：

```sql
select c.relname,
       pg_size_pretty(pg_relation_size(c.oid))        as heap,
       pg_size_pretty(pg_indexes_size(c.oid))         as indexes,
       pg_size_pretty(pg_total_relation_size(c.oid))  as total,
       c.reltuples::bigint                            as est_rows
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'octafuse_gateway'
  and c.relkind = 'r'
  and (c.relname = 'api_key_request_logs' or c.relname like 'request_content_%')
order by pg_total_relation_size(c.oid) desc;
```

`est_rows` 是统计信息里的估算行数，`-1` 表示这张表还没被 analyze 过（新建分区常见），此时用 `select count(*)` 补。

`total / 实际行数` 明显高于 1.8 KB（日志）或单次正文大小，就是膨胀。**删数据不会自动还磁盘**，两种处理：分批 `DELETE` 后 `VACUUM`（空间可复用、文件不缩），或 `VACUUM FULL`（文件缩、期间锁表）；正文分区表直接 `DROP TABLE` 分区，立刻释放。

**四个控量开关**（按影响面从小到大）：

| 手段     | 做法                                                                                                    | 代价                   |
| ------ | ----------------------------------------------------------------------------------------------------- | -------------------- |
| 缩短正文保留 | `REQUEST_CONTENT_RETENTION_DAYS=30`                                                                   | 调用详情只能看近 30 天        |
| 关正文留存  | `REQUEST_CONTENT_CAPTURE=off`                                                                         | 详情页看不到输入输出，日志与计费不受影响 |
| 手动清理日志 | 分批 `DELETE FROM octafuse_gateway.api_key_request_logs WHERE created_at < now() - interval '180 days'` | 用量看板历史趋势变短           |
| 归档后清理  | 先 `COPY ... TO` 到对象存储，再分批删                                                                            | 多一步运维动作，换长期可查        |

批量删一定要分批（每批 ≤ 1 万行 + `VACUUM`），一次性删几十万行会撑爆 WAL 并长时间持锁。

#### 1.1.5 Postgres 参数（32G 机器的起点值）

`postgres:16-alpine` 默认 `shared_buffers=128MB`，在 32G 机器上等于浪费。给 `postgres` 服务加：

```yaml
services:
  postgres:
    command:
      - postgres
      - -c
      - shared_buffers=4GB
      - -c
      - effective_cache_size=12GB
      - -c
      - maintenance_work_mem=512MB
      - -c
      - max_connections=200
      - -c
      - wal_compression=on
```

改完 `docker compose up -d postgres` 重建容器（数据在卷里，不影响）。按实际内存调整：32G 机器给 PG 8–10G 是安全区间；如果后面拆库，参数要重新算。

#### 1.1.6 100 并发流式请求要多少资源 / 要不要拆机器

先给结论：**100 路并发流式请求，单台 16C/32G 属于轻载，不需要为此拆机器。** proxy 的内存占用不到 1 GB，CPU 不到单核的三成；真正要先看的是 **Postgres 的写入 QPS**，而 100 路并发在 30 秒级的对话里只折算成 3 QPS 上下。

**先把"并发"定义清楚**：这里说的是**同时在途**的流式请求数（一个请求持续 10–60 秒）。它和 QPS 是两个量，换算关系是

```
完成 QPS ≈ 并发数 ÷ 平均响应时长(秒)
```

100 并发 + 30 秒响应 = 3.3 QPS；100 并发 + 3 秒响应 = 33 QPS。**同一个"100 并发"，对数据库的压力差 10 倍。**

**proxy 是什么模型**（`packages/proxy`）：Hono + `@hono/node-server`，`CMD node dist/runtime/node.js`，**单进程、无 cluster、无 worker_threads，也没有并发上限或信号量**——来多少接多少。所以：

- 过载时它不会拒绝，只会让延迟一起变高（需要外部限流，见本节最后）；
- 单副本只吃一个核，CPU 打满也只用 1/16 的机器。

**单请求的内存上限**（有代码依据，不是估的）：

| 组成                | 上限                      | 出处                                                        |
| ----------------- | ----------------------- | --------------------------------------------------------- |
| 正文累积器（输入 + 输出各一份） | 2 × 65,536 字符 ≈ 256 KB  | `content-capture/limits.ts` 的 `DEFAULT_MAX_CONTENT_CHARS` |
| socket 读写缓冲       | 32–64 KB                | Node 默认 highWaterMark                                     |
| 请求体（长上下文 JSON）    | 极端 256 KB               | 同上上限                                                      |
| 写入队列（全局，非每请求）     | 1000 条 ≈ 16 MB，**满即丢弃** | `content-sink.ts` 的 `DEFAULT_MAX_QUEUE`                   |

**100 并发需要多少**：

| 项           | 典型（短对话 8K 字符） | 极端（全部打满 64K 字符） |
| ----------- | ------------- | --------------- |
| Node 基础 RSS | 150 MB        | 150 MB          |
| 每请求         | ≈ 100 KB      | ≈ 500 KB        |
| 100 请求合计    | 10 MB         | 50 MB           |
| 队列 + 碎片     | 20 MB         | 20 MB           |
| **建议内存上限**  | **1 GB**      | **2 GB**        |

CPU 的账也类似：一次流式响应通常几百到几千个 SSE 帧，每帧解析 + 累积在几十微秒量级。100 并发按 30 秒、500 帧算，是 1,600 帧/秒，**单核占用约 5%–20%**。真正会顶上去的是"长上下文 + 极高 chunk 速率"的混合场景，也远不到一个核。

**那什么时候单机就不够了**——判断标准不在并发数，在这四个数：

| 指标           | 观察方式                      | 单机够用         | 该拆了                          |
| ------------ | ------------------------- | ------------ | ---------------------------- |
| 完成 QPS       | 日志按分钟计数 / 网关压测脚本          | < 50         | > 80 持续                      |
| PG 写入        | `pg_stat_bgwriter`、WAL 增速 | WAL < 1 MB/s | WAL > 5 MB/s 或 checkpoint 频繁 |
| proxy 单核 CPU | `docker stats`            | < 70%        | 长期 > 85%（此时该扩副本而非加核）         |
| 备份窗口         | `pg_dump` 耗时与业务抖动         | 业务无感         | 备份期间明显掉速                     |

> `local-stack/octafuse-gateway/scripts/bench/request-content-load.ts` 里的验收标准是 **P95 增量 < 5%、WAL 峰值 < 150 KB/s**，默认压到 **52 QPS**。这是网关团队给正文写入定的设计基线，拿来当"单机 PG 的舒适区"参考很合适。

**拆不拆，按这张表决定**：

| 规模                   | 典型形态           | 建议拓扑                                    |
| -------------------- | -------------- | --------------------------------------- |
| ≤ 100 并发，≤ 30 QPS    | 一所学校的日常        | **单机 16C/32G/1TB**，全套跑一起                |
| 100–300 并发，30–80 QPS | 集中上课、考试周       | **拆数据库**：app 8C/16G + DB 8C/32G（SSD 独立） |
| 300+ 并发或 > 100 QPS   | 多校共用 / 对外服务    | app 拆 proxy 与 portal，DB 主从，前置 CLB       |
| 需要独立扩缩容              | proxy 与门户负载差异大 | proxy ×N + portal ×N + DB，nginx/CLB 做分流 |

**关于"proxy 和数据库各单独一台"**，我的判断是：

- **数据库先拆**，收益最大。不是因为它性能不够，而是：备份窗口不再影响业务、PG 重启不影响门户、`shared_buffers` 可以按 DB 机器单独给、以后上主从也顺手。
- **proxy 单独一台收益最小**。它内存 CPU 都吃得很少，100 并发下和 portal 挤在一台完全没问题。只有三种情况值得单独拆：要跑多副本做零停机发布、出网带宽需要单独限速、或者要按 proxy 做独立的网络策略。
- 拆机器解决的是**隔离**，不解决**性能**。如果 QPS 上不去，先看 PG 的 WAL 和索引，再谈加机器。

拆库时连接串要改三处，并删掉 app 机上的 `postgres` 段与所有指向它的 `depends_on`（跨机时这个条件永远等不到）：

```yaml
services:
  portal:
    environment:
      PORTAL_DATABASE_URL: postgres://octafuse:<口令>@10.0.1.20:5432/octafuse
  gateway-proxy:
    environment:
      DATABASE_URL: postgres://octafuse:<口令>@10.0.1.20:5432/octafuse
  gateway-admin:
    environment:
      DATABASE_URL: postgres://octafuse:<口令>@10.0.1.20:5432/octafuse
```

DB 机器上只留 Postgres，5432 只绑内网、加 `pg_hba.conf` 白名单；app 机上的 `postgres` 段与相关 `depends_on` 整段删掉。**完整的跨机改动清单和六个失效点见 1.1.7。**

**过载保护必须自己加**，因为 proxy 没有并发上限：

```nginx
# http 块
limit_conn_zone $binary_remote_addr zone=apiconn:10m;
limit_req_zone  $binary_remote_addr zone=apireq:10m rate=20r/s;

# /tokenhub/ 的推理 location
limit_conn apiconn 20;      # 单个 IP 最多 20 路在途
limit_req  apireq  burst=40 nodelay;
proxy_read_timeout 3600s;   # 流式要给足，别用默认 60s
```

单 IP 20 路是按"一个宿舍 NAT 出去"估的，学校统一出口 NAT 时这个值要放大或改成按 Key 限流（网关本身有 `DEFAULT_RATE_LIMIT_RPM/TPM`，那是按用户计，不按 IP）。

**别凭感觉，压一轮**：网关自带两个基准脚本，先把"正文捕获的开销"和"写入延迟"测出来，再用 `docker stats` 观察真实占用：

```bash
# 脚本引用 workspace 包 @octafuse/core，先装网关依赖（一次性）
cd local-stack/octafuse-gateway
npm ci

# 每帧捕获开销（不接网络，只测解析 + 累积的 CPU 成本）
npx tsx scripts/bench/request-content-capture-overhead.ts --frames 100000

# 正文写入压测（默认 dry-run，确认后再加 --allow-write）
DATABASE_URL=postgres://octafuse:<口令>@127.0.0.1:5433/octafuse \
  npx tsx scripts/bench/request-content-load.ts --qps 52 --seconds 60 --dry-run
```

压测期间另开一个终端看 `docker stats gateway-proxy postgres`，记下 CPU% 与 MEM。**这比任何估算都准**——不同上游的首 token 时间、chunk 密度、上下文长度差异很大，估算只用来判断"量级够不够"，不用来定容量。

#### 1.1.7 多机部署：compose 的边界在哪

**短答：不能。** `docker compose` 只操作**本机**的 Docker daemon，一条命令管不到第二台机器，也没有"compose 集群"这个东西。想要多机，只有三种做法：

| 做法 | 实际是什么 | 适不适合本项目 |
| --- | --- | --- |
| 一个 compose 管多台 | **不存在** | — |
| 每台机器各放一份 compose，内网地址互连 | 手工拆分，compose 各管各的 | **推荐**，2–3 台够用 |
| `docker stack deploy`（Swarm） | 真集群 | 需改造，且官方投入有限 |
| Kubernetes | 真集群 | 多校/多租户、或已有集群才考虑 |

对学校这种 1–3 台机器的规模，**第二种就够了**，别为了"多机"上 Swarm。

**两机拆分的具体做法**（DB 一台、app 一台）：

DB 机上放一份只含数据库的 compose，端口**绑内网 IP**，不要 `0.0.0.0`：

```yaml
# docker-compose.db.yml（DB 机，10.0.1.20）
services:
  postgres:
    image: postgres:16-alpine
    restart: unless-stopped
    environment:
      POSTGRES_USER: octafuse
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?POSTGRES_PASSWORD_MUST_BE_SET}
      POSTGRES_DB: octafuse
    ports:
      - '10.0.1.20:5432:5432'      # 只在内网地址上监听
    volumes:
      - pgdata:/var/lib/postgresql/data
    command: [postgres, -c, shared_buffers=4GB, -c, effective_cache_size=12GB,
              -c, max_connections=200, -c, wal_compression=on]
    healthcheck:
      test: ['CMD-SHELL', 'pg_isready -U "$$POSTGRES_USER" -d "$$POSTGRES_DB"']
      interval: 5s
      retries: 20

volumes:
  pgdata:
```

app 机上把原 `docker-compose.yml` 的 `postgres` 服务整段删掉，三处连接串换成 DB 机地址，并**删掉所有指向 postgres 的 `depends_on`**（跨机时这个条件永远等不到，会直接卡住启动）：

```yaml
services:
  portal:
    environment:
      PORTAL_DATABASE_URL: postgres://octafuse:<口令>@10.0.1.20:5432/octafuse
    # depends_on: postgres  ← 删掉
  gateway-proxy:
    environment:
      DATABASE_URL: postgres://octafuse:<口令>@10.0.1.20:5432/octafuse
  gateway-admin:
    environment:
      DATABASE_URL: postgres://octafuse:<口令>@10.0.1.20:5432/octafuse
```

数据库建表/迁移只在**一台机器上执行一次**（多跑不会坏，但没必要），把 `migrate` 放进 profile，平时不启动：

```yaml
  migrate:
    profiles: ['tools']    # 只在需要时 docker compose --profile tools run --rm migrate
```

```bash
docker compose --profile tools run --rm migrate
```

**跨机器后会失效的东西**（这张表是拆机最容易踩的）：

| 原来靠什么 | 跨机后 | 怎么办 |
| --- | --- | --- |
| `depends_on: postgres: service_healthy` | 失效，因为只检查本机容器 | 删掉；改成启动重试或等待脚本 |
| 服务名 DNS（`postgres:5432`） | 失效，compose DNS 只在本机网络内 | 换成 DB 机内网 IP 或内网域名 |
| 命名卷 `pgdata` | 不能跨机共享 | 数据只留 DB 机，备份也在 DB 机做 |
| 容器 healthcheck | 只反映本机 | DB 机单独接监控 |
| `migrate` 一次性容器 | 每台都会跑 | 用 profile 收起来，手动触发一次 |
| `build` 构建 | 各机器各自构建，耗 CPU | 规模上来后推镜像仓库，各机只 pull |

`pg_hba.conf` 别忘了放行 app 机网段，否则报的是「连接被拒绝」还是「密码错误」，很容易查错方向：

```bash
# DB 机，在容器里执行
docker compose -f docker-compose.db.yml exec -T postgres \
  psql -U octafuse -d octafuse -c "show hba_file;"
```

**如果真要走 Swarm**（`docker stack deploy`），本项目这几处必须改，否则直接失败：

- `build:` 被忽略 → 必须先在别处构建并推到镜像仓库；
- `container_name:` 不允许 → 全部删掉（Swarm 自己命名）；
- `depends_on` 在 v3 里不生效 → 启动顺序得靠应用重试兜住；
- `restart: unless-stopped` 要换成 `deploy.restart_policy`；
- 多副本要求 `docker-compose.yml` 里不能再写固定宿主端口。

这也是我建议"1–3 台就用两份 compose"的原因：改造量比省下的运维工作大得多。

### 1.2 端口清单

| 端口   | 谁在听           | 绑定          | 用途                    |
| ---- | ------------- | ----------- | --------------------- |
| 8088 | nginx         | `0.0.0.0`   | **唯一对外入口**            |
| 3000 | portal        | `127.0.0.1` | 直连排障用                 |
| 8790 | gateway-proxy | `127.0.0.1` | 直连排障；同时是「在线调试台」的浏览器落点 |
| 8789 | gateway-admin | `127.0.0.1` | 直连排障                  |
| 5433 | postgres      | `127.0.0.1` | 宿主机 psql 排障           |

除 8088 外都只绑回环。**不要**为了"方便访问"把 3000 / 8789 / 5433 改成 `0.0.0.0`。

### 1.3 拿代码

```bash
# 方式一：git
git clone <仓库地址> campus-tokenhub-assign && cd campus-tokenhub-assign

# 方式二：交付包
unzip campus-tokenhub-deliver-<日期>.zip && cd campus-tokenhub-assign
```

解压后确认一件事：**当前目录直接包含 `package.json`**。如果看到 `campus-tokenhub-assign/campus-tokenhub-assign/` 这种嵌套，镜像构建会被 Dockerfile 里的守卫直接拦下（报"构建上下文里存在嵌套副本"）。删掉内层或换到正确目录重来。

网关源码不在本仓库内。两种处理：

```bash
# A. 本机构建网关镜像（推荐首次部署）
git clone https://github.com/OctaFuse/octafuse-gateway local-stack/octafuse-gateway
# 或在 .env 里把 OCTAFUSE_GATEWAY_DIR 指到已有源码目录

# B. 已有镜像（迁移机器、或双站部署时复用）
docker images | grep octafuse
# 需要看到 octafuse-proxy:local / octafuse-admin:local / octafuse-migrate:local
```

### 1.4 写 `.env`

```bash
cp .env.example .env
```

四个值必须自己生成，不要用示例值：

```bash
openssl rand -base64 48     # SESSION_SECRET（≥32 字符）
openssl rand -hex 24        # POSTGRES_PASSWORD（只用十六进制，避免破坏 DATABASE_URL）
openssl rand -hex 12        # PORTAL_ADMIN_PASSWORD（人登录用的部署管理员口令）
# OCTAFUSE_ADMIN_API_KEY 在网关后台「系统集成 → 集成密钥」创建后填入 .env
```

最小可跑配置（裸机、单域名、nginx 入口）：

```bash
# --- 必须写在 env：基础设施与启动必需 ---
SESSION_SECRET=<openssl rand -base64 48>
POSTGRES_PASSWORD=<openssl rand -hex 24>
OCTAFUSE_ADMIN_API_KEY=<网关后台「系统集成 → 集成密钥」签发>
OCTAFUSE_EXTERNAL_SYSTEM=campus-tokenhub

# --- 对外地址（都是浏览器访问的地址，带前缀）---
PUBLIC_BASE_URL=https://ai.school.edu.cn/tokenhub/portal
PORTAL_BASE_PATH=/tokenhub/portal
NEXT_PUBLIC_PROXY_BASE=https://ai.school.edu.cn/tokenhub
ADMIN_UI_PUBLIC_PATH=/tokenhub/admin
ADMIN_PUBLIC_BASE_URL=https://ai.school.edu.cn/tokenhub/admin
COOKIE_SECURE=true
ADMIN_COOKIE_SECURE=1
NGINX_PUBLIC_PROTO=https

# --- 部署管理员通道：唯一保留在 env 的业务配置 ---
# 用于首次部署（或 SSO 填错被锁在外面时）进入设置页；SSO 配齐后不会自动关闭，确认调通后手动置 off
# 两站同时部署时，两站的用户名与口令必须逐字一致
PORTAL_ADMIN_USERNAME=ops-admin
PORTAL_ADMIN_PASSWORD=<≥12 字符随机串>
PORTAL_ADMIN_LOGIN=auto
```

**运行期配置只存数据库**：学校名称、开户额度、限流、SSO 参数（含 OAuth2 Client Secret、CAS 两个地址）全部在「设置」页面维护，保存即生效。写在 `.env` 里的同名变量（`AUTH_PROVIDER`、`OAUTH2_*`、`CAS_*`、`DEFAULT_BUDGET_*`、`PORTAL_SCHOOL_NAME`）**不会生效**，启动日志会列出被忽略的项，方便清理。

必须走 env 的只有基础设施类：数据库连接、网关地址、构建期前缀、端口、`SESSION_SECRET`。

三个容易踩的规则：

1. **`PORTAL_BASE_PATH` 和 `ADMIN_UI_PUBLIC_PATH` 是构建期参数**。改了必须 `--build`，只 `up -d` 不生效；管理台还会因为"镜像里的前缀和运行期不一致"直接拒绝启动（这是有意设计的失败）。
2. **`PORTAL_BASE_PATH` 要同时出现在 `build.args` 和 `environment`**。compose 已经这么写了，自己改 compose 时别只留一处——容器内 `process.env` 为空时，健康检查会去探 `/api/health`，而实际路径是 `/tokenhub/portal/api/health`，结果永远 unhealthy。
3. **不要再写 `AUTH_PROVIDER`**。登录协议由设置页选择并存入数据库，env 里的该变量会被忽略；登录参数没配齐也能启动，缺项在设置页提示。

部署形态与关键差异：

| 形态              | `PORTAL_BASE_PATH` | `COOKIE_SECURE` | 入口                             |
| --------------- | ------------------ | --------------- | ------------------------------ |
| 裸机试跑（直接开 3000）  | 留空                 | `false`         | `http://<ip>:3000`             |
| 单域名 + nginx（生产） | `/tokenhub/portal` | `true`          | `https://<域名>/tokenhub/portal` |
| 双站同域（+ 成员站）     | `/tokenhub/portal` | `true`          | 同上，成员站在 `/tokenhub/member`     |

### 1.5 起服务

```bash
docker compose up -d --build
docker compose ps -a        # -a 才能看到 migrate / portal-seed 这两个一次性容器
```

期望状态：

```
postgres          Up (healthy)
migrate           Exited (0)        ← 一次性，0 才算成功
gateway-proxy     Up (healthy)
gateway-admin     Up (healthy)
portal            Up (healthy)
portal-seed       Exited (0)        ← 一次性
nginx             Up (healthy)
```

第一次构建慢是正常的（管理台镜像最重，构建期内存峰值 4–6 G，32G 机器无压力；8G 以下的机器容易 OOM）。如果 `migrate` 是 `Exited (1)`，先看 `docker compose logs migrate`，通常是数据库口令或 `DATABASE_URL` 拼错。

### 1.6 验收（不要跳过）

```bash
# 1) 走 nginx 的健康检查，网关连通性也为 true
curl -s http://127.0.0.1:8088/tokenhub/portal/api/health
# {"status":"ok","gateway":true}
```

如果返回 `gateway:false`，说明门户连不上网关管理端，按顺序查：

```bash
# 2) 直连门户容器（绕开 nginx，用于区分"应用问题"和"入口问题"）
docker compose exec -T portal node -e \
  "fetch('http://127.0.0.1:3000/tokenhub/portal/api/health').then(r=>r.text()).then(console.log)"

# 3) 直连网关
docker compose exec -T portal node -e \
  "fetch('http://gateway-admin:8789/dashboard').then(r=>console.log(r.status))"

# 4) 看入口日志有没有打到错误的 upstream
docker compose logs --tail=50 nginx
```

`curl 直连容器返回 200、走 nginx 返回 404/502` 是最典型的一组对照：后端容器重建后地址变了。当前 nginx 模板已改成**按 10s TTL 重新解析后端地址**（`NGINX_RESOLVER` + 变量转发），正常情况下重建容器不用动 nginx；仍出现时按 3.6 第 1 条排查。

### 1.7 首次初始化：两条路，按学校情况选

#### 路径 A：学校有统一认证（推荐）

部署前把学校的参数填到 `deploy/init/010-login-config.sql` 顶部的「学校对接参数」：`school_auth_provider`（`oauth2` 或 `cas`）、OAuth2 三个端点与 `client_id`、或 CAS 两个地址。`portal-seed` 会在建表后写入 `portal_shared.login_config`（只填空值，不覆盖设置页改过的值），页面上直接带出这些值，**只剩 Client Secret 需要手填**：用引导账号登录后进「设置 → 登录认证」填一次，加密落库。

Client Secret 不再支持写在 `.env` 里——它只在数据库保存，且与部署机的 `SESSION_SECRET` 绑定，换机器需重填。

验证种子是否生效：

```bash
docker compose logs portal-seed | tail -5
docker compose exec -T postgres psql -U octafuse -d octafuse -c \
  "select provider, oauth2_client_id, oauth2_token_auth_method, oauth2_user_info_token_carrier from portal_shared.login_config"
```

然后打开登录页点「使用学校账号登录」。回调地址是 `https://<域名>/tokenhub/portal/api/auth/callback`，**必须提前登记到 IdP 白名单**，否则授权页会拒绝 `redirect_uri`。

#### 路径 B：还没有 SSO，先用引导账号把 SSO 配进去

这是"先有鸡还是先有蛋"的解法：配置页需要登录，登录又需要 SSO。

1. `.env` 里配 `PORTAL_ADMIN_USERNAME` / `PORTAL_ADMIN_PASSWORD`（口令 ≥12 字符）；
2. `docker compose up -d portal`——**首次启动会把这两项加密写进共享配置**（`portal_shared.login_config`，与设置页同一列），此后以库内为准、改 `.env` 不再生效（启动日志会提示被忽略）；同库双站部署两站读同一行、口令天然一致，分栈部署（两套库）则必须把两处写成同一个值；
3. 打开 `/login`，此时页面是「部署管理员入口 · 引导配置」的账号密码表单；
4. 登录后直接落在 `/settings`，切到「登录认证」，把 OAuth2 或 CAS 参数填齐并保存；
5. 保存成功后**账号密码登录仍然可用**：参数填齐不等于调得通（密钥错、回调没登记、字段映射不对都很常见），所以不再自动关闭。页面会同时给出 SSO 按钮和引导入口；
6. 用学校账号真的登进去一次，确认没问题后，再去把「账号密码登录」改成 `off`——那一刻旧密码会话立即失效，引导入口一并消失。

两条判据互不影响，别混：

| 判据 | 看什么 |
| --- | --- |
| SSO 按钮出不出来 | 当前协议的必填项是否全部非空（oauth2 五项 / cas 两项）。只填一半仍算"未对接" |
| 账号密码登录能不能用 | 只看 `PORTAL_ADMIN_LOGIN`：`off` 关闭；`auto` / `on` 可用 |

把自己锁在外面时：把 `PORTAL_ADMIN_LOGIN` 改成 `on`，`docker compose up -d portal`，用引导账号进去修参数，再改回 `auto`。

#### 路径 C：这一轮先不接 SSO

`deploy/init/010-login-config.sql` 顶部的参数全部留空，`portal-seed` 不写入任何登录配置，登录页只有引导账号入口。等学校把 OAuth2 / CAS 参数给你了，再填 SQL 或直接进设置页填——初始化模型、跑通门户本体不受影响。

### 1.8 进入 `/setup` 初始化向导（录 Key、建模型）

首次部署还没有负责人时，**第一个登录的账号会被直接带到 `/setup`** 并成为初始化负责人（记在网关 `ONBOARDING_OWNER`）。之后这个入口只对管理员展示。

向导流程：

1. 选供应商：腾讯云 TokenHub / 阿里云百炼 / 火山方舟；
2. 去对应控制台创建 API Key（页面第一步给了直达链接，模板里**不含任何 Key**）；
3. 点「检测 Key」——门户会请求上游 `/models`，拿不到列表时退化为一次 8 token 的最小对话；
4. 按模型类型勾选（默认只勾每个家族的主流模型）；
5. 点「开始初始化」，门户按顺序创建供应商 → 模型 → 路由，并写入 `BILLING_CURRENCY=CNY`。

几个要知道的行为：

- **幂等，可重跑**。中途失败不回滚，已完成项下次自动跳过；重跑默认复用网关里已保存的 Key，换 Key 才选「换成新的 Key」。
- **同款模型进同一个路由池**，按 `model_routes.weight` 分流（默认腾讯云 8 : 阿里云 1 : 火山 1）。要改倾斜比例去网关后台改 `weight` 或把 `route_policy.strategy` 改成 `weight_priority` / `hash_affinity`。
- **入口不会关闭**。重新进入就是"重新初始化"，可以补选模型。

### 1.9 上线前安全检查（逐条过）

| 检查项                       | 要求                                                                         |
| ------------------------- | -------------------------------------------------------------------------- |
| `SESSION_SECRET`          | 生产重新生成，不要复用本地 `.env`                                                       |
| `POSTGRES_PASSWORD`       | 强口令；`docker compose config` 能看到真实值说明没漏                                     |
| `OCTAFUSE_ADMIN_API_KEY`  | 网关后台签发的集成密钥，不能用示例值；门户不再持管理员账密                                  |
| `PUBLIC_BASE_URL`         | `https://` 实际域名，**含路径前缀**。留空会回退到 `Host` 头，可被伪造                             |
| `COOKIE_SECURE`           | TLS 后必须 `true`，否则浏览器丢弃会话 Cookie                                            |
| `NEXT_PUBLIC_PROXY_BASE`  | 必须 `https://`。这个地址由浏览器直连并携带 `Authorization: Bearer <Key>`，走 http 等于明文传 Key |
| 端口暴露                      | 只对外开 8088                                                                  |
| 管理员名单                 | 在「设置 → 管理员」维护，存 `portal_shared.admins`；为空时首个登录者会被认领为管理员                          |
| 引导账号                      | 配齐 SSO 后 `PORTAL_ADMIN_LOGIN=off` 并清空口令                                    |
| 反向代理                      | 由反代终止 TLS，并且**覆写**而不是追加 `X-Forwarded-For`（nginx 模板已按这个口径写）                 |

### 1.10 双站同域部署（和成员自购站共存）

双站编排文件在**本仓库**：`docker-compose.dual.yml`。它负责起一个 Postgres + 两个网关服务（复用已有镜像）+ 两个 Next 应用 + 一套 nginx，成员站的代码目录是 `../campus-tokenhub-member`。

前置条件：

1. 网关镜像已存在（`octafuse-admin:local` / `octafuse-proxy:local`）——双站文件里是 `image:` 而不是 `build:`；
2. 成员站仓库就绪，目录名必须是 `campus-tokenhub-member`，且与本仓库同级；
3. 旧数据卷 `campus-tokenhub_octafuse_pgdata` 存在（文件里写死 `external`，改名会找不到数据）。

```bash
cp .env.dual.example .env.dual
vim .env.dual        # 至少填 POSTGRES_PASSWORD / SESSION_SECRET / PUBLIC_BASE_URL
docker compose -f docker-compose.dual.yml --env-file .env.dual up -d --build
```

两站共享会话的三个条件（缺一个就互认失败，而且**不报错**）：

```bash
SESSION_SECRET=<两站相同>
PORTAL_COOKIE_PATH=/tokenhub     # 公共前缀，不能填各自的 basePath
PORTAL_COOKIE_DOMAIN=            # 留空 = host-only，同域最安全
```

`PORTAL_COOKIE_PATH` 填成 `/tokenhub/portal` 和 `/tokenhub/member` 的后果：两站各存一份同名 Cookie，互认直接断。这是本项目历史上最隐蔽的坑之一。

入口地址：

```
http://<host>:8088/tokenhub/portal    统一采买
http://<host>:8088/tokenhub/member    成员自购
```

**重建应用容器后必须 `restart nginx`**：

```bash
docker compose -f docker-compose.dual.yml --env-file .env.dual restart nginx
```

### 1.11 只部署门户（网关由外部提供）

```bash
docker build -t campus-tokenhub .
docker run -d --name campus-tokenhub --env-file .env -p 3000:3000 campus-tokenhub
```

此时 `.env` 里 `OCTAFUSE_ADMIN_BASE` / `OCTAFUSE_PROXY_BASE` 必须是外部网关的真实地址，且 `NEXT_PUBLIC_PROXY_BASE` 是学生浏览器能访问到的地址。

### 1.12 部署阶段就让 AI 接手核验

见 3.7。装好 CodeBuddy CLI 后，一条命令就能把"七容器状态 + 健康检查 + 关键配置"读一遍并给出结论，比逐条肉眼比对快得多。

---

## 2. 使用

### 2.1 角色与权限

| 角色      | 怎么来                                                         | 能做什么                       |
| ------- | ----------------------------------------------------------- | -------------------------- |
| 学生 / 老师 | 学校 SSO 登录                                                   | 领 Key、看模型与价格、看用量、在线调试、领活动  |
| 全局管理员   | `portal_shared.admins` 名单 / 名单为空时首个登录者认领 / 引导账号 / 角色同步 | 设置、管理员名单、运营活动、网关后台外链、初始化入口 |

管理员判定顺序（任一命中即为全局管理员）：

1. 引导期账号密码登录的本地身份（`local:<username>`，凭据只来自 env）；
2. `portal_shared.admins` 名单命中；
3. 前两层都没命中、且名单为空时，**首个合法登录者自动认领**（等价于初始化 owner）。

名单非空时只认名单，不会再回落到 owner；名单为空才走认领。

另外，「登录认证 → 管理员角色同步」可配置若干角色值：SSO 用户登录时，用户角色（来自「字段映射 → 角色」，或用内置别名兜底）命中任一值（忽略大小写）就自动写进 `portal_shared.admins`。**只新增不删除**，撤销管理员仍需到 `/settings/admins` 手动移除；留空即关闭该同步。每次登录都会重新判定：原本不是管理员的账号，角色调整后重新登录当次即成为管理员，不需要再登一次。

名单为空、首个登录者又不是 `school_id:user_id` 格式时，用兜底命令：

```bash
npm run bootstrap-admin -- "school_001:100234567"
```

直连库写 `portal_shared.admins`，幂等，不依赖 Web 会话。

### 2.2 学生侧：五个入口

| 页面   | 路径            | 干什么                                  |
| ---- | ------------- | ------------------------------------ |
| 我的算力 | `/overview`   | 额度余额、**API Key 的领取/查看/吊销**、近期用量、活动入口 |
| 模型集市 | `/models`     | 模型列表、上下文/模态/价格；点进详情看参数与代码片段          |
| 数据看板 | `/dashboard`  | 用量趋势、模型分布、调用日志、导出 CSV                |
| 接入指南 | `/guide`      | 复制即用的接入代码（cURL / Node / Python）      |
| 运营活动 | `/activities` | 领取算力（管理员配的）                          |

在线调试台在 `/playground`，**不在侧边栏**：从「我的算力」里某个 Key 的「调试」按钮跳进去（带 `?key=<keyId>`），或在模型详情页点试用。它的作用是"不写代码先发一次请求看看通不通"。

新生第一次用的顺序：登录 → `/overview` 领 Key → `/models` 挑模型 → `/guide` 抄代码 → 出问题用调试台对比。

三个必须提前告知学生的事实：

1. **Key 只在创建时完整显示一次**，丢了只能吊销重建；
2. 调试台是**浏览器直连网关**，公司网络/校园网如果拦了外网 API，页面能开但"发送请求"会失败；
3. 页面上的价格是**估算**（目录档位 × 时段倍率 × 路由折扣），不是账单。

### 2.3 管理员侧：设置页三个 Tab

`/settings` 只有全局管理员能进。

**首页配置**：学校名称、登录页标题/副标题、页脚联系方式、主题色、Logo、开户默认额度与限流。

**额度与限流**：开户默认 `budget_max` / 周期、默认 RPM / TPM。注意这几项**只在网关真正建号时写入**，已存在的用户不受影响；页面上这一项优先于环境变量。

**登录认证**：

| 区块     | 要点                                                                    |
| ------ | --------------------------------------------------------------------- |
| 协议     | 只有 `oauth2` 和 `cas`；选完只显示该协议需要的字段                                     |
| oauth2 | 三个端点 + Client ID/Secret + 授权范围 + Token 认证方式 + UserInfo Token 携带方式     |
| cas    | 认证 URL + Ticket 校验 URL                                                |
| 回调地址   | 不用填，固定 `/api/auth/callback`，按 `PUBLIC_BASE_URL` 自动生成；换域名要去 IdP 重新登记   |
| 字段映射   | 把 userinfo 字段映射到门户身份，支持级联（`data.user_id`）和 `{school_id}:{user_id}` 模板 |
| 管理员角色同步 | 角色命中下列任一值（忽略大小写）即自动加入管理员名单；只新增不删除，留空关闭                      |
| 登录限制   | 开关 + 条件列表（字段 = 值），多条之间是「且」                                            |
| 密钥     | 加密落库，页面只回显尾号与长度，留空表示不修改                                               |
| 部署管理员  | `auto` / `on` / `off`，见 1.7 路径 B                                      |

两个反直觉的点：

- **没有「测试连接」按钮**。保存不对 IdP 发探测，只能让真实用户登录验证。
- **保存只提交改动过的字段**。老版本前端会把回显字段全量提交，导致"只改了校名却报 Client Secret 不能为空"，现已修，但排障时要记得看 PUT 的 **request body**。

### 2.4 管理员名单

`/settings/admins`：搜索 + 多选 + 保存。名单只有一种角色——全局管理员（设置、活动、网关后台、成员审核通吃），不要找"角色下拉"。

- 名单两站共用（存 `portal_shared.admins`）；
- 名单为空时会出现"首个登录者自动认领"，所以**上线当天先把名单配好**，别留空。

### 2.5 运营活动

`/activities`（管理视角可配）：一行一个活动，字段是标题、算力点数、周期、启用、排序。

学生端看到的是"领取算力"卡片，领取动作会走网关开户/加额度。活动改完即时生效，不需要重启。

### 2.6 日常运营 SOP

| 场景           | 动作                                                                                     |
| ------------ | -------------------------------------------------------------------------------------- |
| 新学期开学        | 确认 SSO 可用 → 检查默认额度 → 检查活动是否启用 → 发一条公告                                                  |
| 学生说"领不到 Key" | 看 `/overview` 是否报网关错误 → 查 `docker compose logs portal` 的 `provision.fail` → 查网关用户是否已存在 |
| 学校要加模型       | 网关后台加模型 / 重新跑初始化向导补选                                                                   |
| 要调某人的额度      | **在网关管理台改**，门户不重复实现                                                                    |
| 要临时关闭密码登录    | 设置 → 登录认证 → 部署管理员 = `off`                                                              |
| 换域名          | 改 `PUBLIC_BASE_URL` + `PORTAL_BASE_PATH`（需重建）→ IdP 白名单登记新回调 → nginx/CLB 同步             |

### 2.7 用户高频问题速查

| 现象             | 多半原因                                         | 处置                                               |
| -------------- | -------------------------------------------- | ------------------------------------------------ |
| 点登录没反应 / 跳回登录页 | IdP 回调白名单没登记，或 Cookie 作用域不对                  | 看地址栏 `redirect_uri`；浏览器里是否有多个同名 `portal_session` |
| 登录成功但页面空白      | 资源被 404（前缀不一致）                               | 看浏览器 Network 里 `_next` 请求的路径前缀                   |
| 领 Key 报错       | 网关未就绪 / 网关账号密码错                              | `curl` 健康检查看 `gateway` 字段                        |
| 模型列表是空的        | 网关没有模型 / 目录缓存未过期                             | 等 60 秒或重启 portal                                 |
| 调试台发不出请求       | 浏览器到 `NEXT_PUBLIC_PROXY_BASE` 不通，或网关 CORS 收紧 | 让学生复制 cURL 线下试，能通就是 CORS                         |

---

## 3. 运维

### 3.1 命令速查

```bash
# 状态与日志
docker compose ps
docker compose logs -f --tail=200 portal
docker compose logs -f --tail=200 nginx

# 重启单个服务（改 .env 后最常用）
docker compose up -d portal
docker compose up -d --no-deps portal

# 重建（改了构建期参数 / 代码）
docker compose up -d --build portal
docker compose up -d --build migrate gateway-proxy gateway-admin

# 进库
docker compose exec -T postgres psql -U octafuse -d octafuse

# 停止（保留数据卷）
docker compose down

# 停止并删卷（危险：数据全没）
# docker compose down -v
```

双站部署时每条命令都要带文件：

```bash
docker compose -f docker-compose.dual.yml --env-file .env.dual ps
docker compose -f docker-compose.dual.yml --env-file .env.dual restart nginx
```

### 3.2 健康检查

| 探针       | 地址                                                       | 期望                               |
| -------- | -------------------------------------------------------- | -------------------------------- |
| nginx    | `http://127.0.0.1:8088/nginx-health`                     | `ok`                             |
| 门户（经入口）  | `http://127.0.0.1:8088/tokenhub/portal/api/health`       | `{"status":"ok","gateway":true}` |
| 网关 Proxy | `http://127.0.0.1:8790/health`                           | 200                              |
| 网关 Admin | `http://127.0.0.1:8789/dashboard`                        | 200（SPA 入口）                      |
| 数据库      | `docker compose exec -T postgres pg_isready -U octafuse` | `accepting connections`          |

容器自带的 healthcheck 已经覆盖前四项，`docker compose ps` 直接看 `(healthy)`。

外部监控建议：只探 nginx 的 `/nginx-health` 和门户的 `/api/health` 两个，别探容器内端口（换机器就失效）。`gateway` 字段为 `false` 时告警——这代表门户活着但网关挂了，用户体验是"能登录、什么都干不了"。

**资源水位**也要进监控，16C / 32G / 1TB 的机器按这个告警：

| 指标            | 告警线                          | 先看哪里                              |
| ------------- | ---------------------------- | --------------------------------- |
| 磁盘使用率         | > 80%                        | 见 1.1.3 的三条命令，增长速率按 1.1.4 的 SQL 测 |
| 整机内存          | > 85%                        | `docker stats`，确认不是某个容器泄漏         |
| portal 容器 CPU | 长期贴 100%（= 单核满）              | 是否要多副本，见 1.1.2                    |
| 整机 CPU        | 持续 > 80% 十分钟                 | 先分清是 PG 还是 gateway-proxy          |
| PG 连接数        | > 150（`max_connections=200`） | 是否有连接泄漏或副本扩太多                     |

```bash
docker stats --no-stream
df -h /
docker compose exec -T postgres psql -U octafuse -d octafuse -c \
  "select state, count(*) from pg_stat_activity group by 1 order by 2 desc;"
```

门户用连接池，单个副本通常只占几条连接；连接数持续上涨且不回落，基本是某处 `pg` 客户端没释放。

### 3.3 日志与审计

审计是**每行一个 JSON 打到 stdout**：

```bash
docker logs -f campus-tokenhub | jq -c 'select(.event)'
```

| 事件                                     | 含义            |
| -------------------------------------- | ------------- |
| `auth.login` / `auth.login.fail`       | 登录成功 / 失败     |
| `provision.success` / `provision.fail` | 网关开户结果        |
| `key.create` / `key.revoke`            | 发 Key / 吊销    |
| `member.*`                             | 成员账号相关（成员站产生） |

脱敏规则：`sk-…` 一律变 `sk-***`，管理员密码与会话密钥出现即替换 `***`。所以**不要把 Key 贴在工单里**，日志里也查不到完整值。

接入 Loki / CLS 时按行采集 stdout 即可，不需要额外文件。

### 3.4 备份与恢复

数据全在 Postgres。备份用逻辑备份，别直接拷数据卷（PG 16 的卷跨版本不可靠）。

```bash
# 备份（单站）
docker compose exec -T postgres pg_dump -U octafuse -d octafuse -Fc --no-owner --no-acl \
  > backup-$(date +%Y%m%d-%H%M).dump

# 双站
docker compose -f docker-compose.dual.yml --env-file .env.dual exec -T postgres \
  pg_dump -U octafuse -d octafuse -Fc --no-owner --no-acl > backup-$(date +%Y%m%d-%H%M).dump
```

恢复：

```bash
docker compose up -d postgres
cat backup-20261124-0300.dump | docker compose exec -T postgres \
  pg_restore -U octafuse -d octafuse --no-owner --no-acl --clean --if-exists
docker compose up -d
```

要一起备份的还有 `.env`（含密钥，单独加密存放）和 `deploy/init/*.sql`。

三点容量相关的注意：

- `pg_dump -Fc` 输出的是自定义压缩格式，**峰值约等于数据库未压缩大小的 1.1 倍**（压缩在流里做）。1TB 盘上如果数据已经几百 G，别把 dump 写到根分区，指到独立数据盘：

```bash
mkdir -p /data/backup
docker compose exec -T postgres pg_dump -U octafuse -d octafuse \
  -Fc -Z 9 --no-owner --no-acl > /data/backup/backup-$(date +%Y%m%d).dump
```

- 备份保留策略按磁盘算：建议留 7 份日备 + 4 份周备，其余归档到对象存储，别长期堆在本机。**不要再对 `-Fc` 输出套 gzip**，它本来就压缩过，只会白烧 CPU。
- `request_content` 正文留存是数据增长的主要来源。只想保配置和业务数据时，备份里可以排除正文分区（`--exclude-table='octafuse_gateway.request_content*'`），体量能小一个数量级，代价是调用详情里的输入输出无法恢复。

恢复演练建议每学期一次：在另一台机器上恢复 → 起全栈 → `curl` 健康检查 → 用测试账号登录一次。**没演练过的备份不算备份。**

### 3.5 升级

```bash
git pull                     # 或解压新交付包（注意别形成嵌套目录）
docker compose up -d --build
docker compose ps            # migrate 必须是 Exited(0)
docker compose logs migrate | tail -20
```

升级要点：

- `migrate` 失败会阻断后续服务（`depends_on: service_completed_successfully`），这是好事，别绕过；
- 改了 `PORTAL_BASE_PATH` / `ADMIN_UI_PUBLIC_PATH` 必须重建对应镜像；
- 重建 portal 或 gateway 容器后，**如果前面有 nginx，必须 restart nginx**；
- 门户启动时会自动把旧的 EAV 配置表迁移成结构化列（一次性），**升级前先备份**，旧表不保留。

回滚：

```bash
git checkout <上一个 tag/commit>
docker compose up -d --build
```

数据库 schema 只增不减，回滚代码一般不用回滚库；但如果是"结构性迁移"那一次升级，回滚需要恢复备份——所以升级前那条 `pg_dump` 不能省。

### 3.6 故障排查手册（都是踩过的）

#### 1) 容器全 healthy，但页面 404

**根因**：旧版模板用 `upstream` 块，nginx 只在**启动时**解析一次后端容器名并缓存，重建应用容器后 IP 变了，请求仍打向旧 IP（或落到另一个站）。  
**现状**：模板已改为 `resolver ${NGINX_RESOLVER} valid=10s ipv6=off` + 变量转发（`proxy_pass http://$portal_backend`），每个请求按 TTL 重新解析，重建容器无需重启 nginx；前缀剥离改由 `rewrite ... break` 完成。  
**仍出现时**：先确认容器能访问 `NGINX_RESOLVER`（Docker 内置 DNS 是 `127.0.0.11`，裸机部署要改成本机 DNS），再临时兜底：

```bash
docker compose restart nginx          # 双站用 -f docker-compose.dual.yml
```

**判据**：`curl` 直连容器 200、走 nginx 404/502。返回的 HTML 里如果引用另一个站的 `_next` 路径，基本可以确诊。

#### 2) 密码正确、日志有 `auth.login success`，页面立刻跳回登录页

**根因**：浏览器里存在**两个同名 `portal_session`**（新的 `Path=/tokenhub`，旧的 `Path=/`）。浏览器按 Path 长度降序发送，新 Cookie 在前；而 Next 的 `cookies().getAll()` 会按名去重只返回**最后一个**，恰好拿到旧密钥签的那个 → 验签失败。  
**处置**：清掉旧 Cookie（浏览器 DevTools → Application → Cookies，删 `Path=/` 那条）；代码侧已改为直接解析 `cookie` 头并遍历所有同名值。  
**判据**：DevTools 的 Request Headers 里 `cookie` 出现两个 `portal_session`。

#### 3) 设置页改任何东西都提示「Client Secret 不能为空」

**根因**：前端把回显的全部字段都提交了，后端按"本次提交里含 login 字段"判定 → 触发 SSO 必填校验；而迁移时 `oauth2_client_secret_enc` 落的是 NULL（换密钥解不开），必然失败。  
**处置**：进「设置 → 登录认证」重新录一次 Client Secret 并保存；或确认前端只提交 dirty 字段。  
**判据**：看 PUT 请求的 **body**，里面出现了一堆没改过的 `oauth2*` 字段。

#### 4) 健康检查一直 unhealthy，但容器里手动 `curl` 是通的

**根因**：`PORTAL_BASE_PATH` 只给了 `build.args`，没给 `environment`，容器内 `process.env` 为空，健康检查探的是 `/api/health`。  
**处置**：compose 里两处都要有；改完 `up -d --build`。

#### 5) 管理台直连 8789 打不开 / 起来就退出

**根因**：`ADMIN_UI_PUBLIC_PATH` 是构建期参数。镜像按 `/tokenhub/admin` 构建，运行时却给了空值（或反过来），入口脚本前缀自检直接 `exit 1`。  
**处置**：`docker compose build gateway-admin` 重建；浏览器一律走 `/tokenhub/admin`，不要直连 8789 做验收。

#### 6) 初始化页显示「暂时读不到网关状态」

**根因**：门户比网关先起来，页面一加载就调 `/api/admin/config`，网关还没监听。  
**处置**：compose 已加 `depends_on: gateway-admin: service_healthy`；手工重启时按 `postgres → migrate → gateway → portal` 顺序。

#### 7) `migrate` 退出码 1，日志里 SQL 语法错

**根因**：迁移脚本里 `\if` 块中用了 `RAISE NOTICE`（不是 PL/pgSQL 上下文）；或模板字符串里的 `${}` 被单引号包住没插值。  
**处置**：改 SQL 用 `\echo`；检查脚本里的引号。**注意**：`ON_ERROR_STOP` 中止后事务回滚，但前面已执行的 `INSERT` 可能仍然打印成功，所以必须看迁移后的对账表，不能只看"没报错"。

#### 8) 管理台点「退出」后门户还登着

**根因**：没配 `PORTAL_LOGOUT_URL`。  
**处置**：配成 `<门户地址的上级>/api/auth/logout`，compose 里 `gateway-admin` 已有对应项。

#### 9) 学生领 Key 报 500

排查顺序：

```bash
docker compose logs --tail=100 portal | grep -E "provision|error"
docker compose exec -T portal node -e \
  "fetch('http://gateway-admin:8789/api/admin/config').then(r=>console.log(r.status))"
```

`provision.fail` 后面一般带网关原始错误（额度、外部用户冲突、网关未初始化）。外部用户冲突说明同一 `sub` 开过两次号——检查 `external_user_id` 映射是否被改过。

#### 10) 调试台能打开，点发送报 CORS / 连不上

**根因**：浏览器直连 `NEXT_PUBLIC_PROXY_BASE`。这个值是**构建期写进前端**的，改了必须重建；另外 `gateway-proxy` 的宿主端口没映射也会连不上（compose 已映射 `127.0.0.1:8790`）。  
**处置**：确认 `NEXT_PUBLIC_PROXY_BASE` 是公网可达的 `https://` 地址；确认网关 CORS 没有收紧。

#### 11) SSO 配齐了，登录页却只有密码表单

**根因**：`PORTAL_ADMIN_LOGIN=on` 会强制 passwordMode，把 SSO 入口藏掉（旧版本行为，现已在 SSO 齐全时把密码表单降级为"救急通道"）。  
**处置**：改成 `auto`；确认 `isSsoConfigured` 的五项齐全（含 clientSecret 明文可解）。

#### 12) 磁盘越用越满

`request_content` 分区表按保留天数整月清理。先定位是谁在涨（**按字节数排序，不要按 `pg_size_pretty` 的文本排**）：

```sql
select c.relname,
       pg_size_pretty(pg_total_relation_size(c.oid)) as total,
       pg_total_relation_size(c.oid) as bytes
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'octafuse_gateway' and c.relkind = 'r'
order by pg_total_relation_size(c.oid) desc
limit 10;
```

按顺序处置：

1. **正文分区涨**：把 `REQUEST_CONTENT_RETENTION_DAYS` 调小并 `up -d gateway-proxy`，或临时 `REQUEST_CONTENT_CAPTURE=off`（只影响后续调用，已落库的仍按保留天数清）；
2. **构建缓存涨**：`docker builder prune -f`，常见能回收十几到几十 G；
3. **悬空镜像/卷**：`docker image prune -a`（确认没有旧版本镜像要留着回滚）；
4. 磁盘已 > 90% 且降不下来：先把 `/data/backup` 的老 dump 迁到对象存储，再考虑加盘——PG 在空间不足时会进入只读保护，比慢更糟。

容量基线见 1.1.3，1 万学生口径的估算与控量开关见 1.1.4。

**最容易忽略的一条**：`request_content` 分区有自动清理，但 `api_key_request_logs` **没有**。只靠正文保留天数，日志明细仍会一年一年往上堆，最终占住磁盘的是它和它的 15 个索引。

### 3.7 用 CodeBuddy CLI 让 AI 辅助定位（重点）

排障的瓶颈通常不是"想不出原因"，而是"证据散在七个容器里，懒得一条条敲"。CodeBuddy CLI 能读代码、也能执行只读命令，把这两件事合成一步：**让它去收集、对照、给结论**。

#### 3.7.1 安装（服务器上，三选一）

要求 Node.js ≥ 18.20（原生安装器不需要 Node）。

```bash
# 方式一：npm（机器上已有 Node）
npm install -g @tencent-ai/codebuddy-code

# 方式二：Homebrew（macOS / Linux）
brew tap Tencent-CodeBuddy/tap
brew install codebuddy-code

# 方式三：原生二进制（服务器上没有 Node 时用这个，推荐）
curl -fsSL https://copilot.tencent.com/cli/install.sh | bash
```

验证：

```bash
codebuddy --version
codebuddy doctor        # 自检安装 / 自动更新是否正常
```

#### 3.7.2 登录

```bash
cd /opt/campus-tokenhub-assign
codebuddy
```

首次启动会让你选登录方式：

| 方式                 | 适用                   |
| ------------------ | -------------------- |
| Chinese Site       | 国内用户，走腾讯云国内站         |
| International Site | 海外站点                 |
| Enterprise Domain  | 专享版 / 私有化，需要企业给的服务地址 |
| iOA                | 腾讯内部员工（零信任）          |

选中后浏览器自动打开完成认证。**服务器没有浏览器**时，在本地机器完成登录后把 `~/.codebuddy` 目录同步过去，或改用其中的 token 方式（按提示操作）。

#### 3.7.3 第一件事：让 AI 认识这个项目

```bash
cd /opt/campus-tokenhub-assign
codebuddy
> /init
```

`/init` 会扫描仓库生成项目上下文（项目说明文件），后续会话自动加载。它对本项目的价值很直接：知道"七容器各自是什么""nginx 为什么对门户透传、对管理台剥前缀""`PORTAL_BASE_PATH` 是构建期参数"——这些背景不写进上下文，AI 每次都会给出错误的方向（比如建议你改 nginx 去掉门户前缀）。

仓库结构大改（加模块、拆目录）后重新 `/clear` + `/init` 一次。

#### 3.7.4 只读排查模式（服务器上必须这么用）

```bash
# 只读分析：只出结论和处置步骤，不改文件、不执行写操作
codebuddy --permission-mode plan "按 README 的部署与排障章节，定位当前 portal 容器 unhealthy 的原因"

# 限定可用工具：只允许读文件和跑 docker/curl/psql 查询
codebuddy --permission-mode plan \
  --allowedTools "Read,Grep,Glob,Bash(docker compose ps:*),Bash(docker compose logs:*),Bash(curl:*)" \
  "检查七容器状态与门户健康检查，列出异常项"

# 一次性问答，结果进管道（适合写进巡检脚本）
codebuddy -p "读 /tmp/portal-diag/ 下的所有文件，输出三段：结论、证据、下一步" \
  --output-format text
```

**安全红线（写在最前面）**：

1. 生产服务器上**不要**加 `-y` / `--dangerously-skip-permissions`；
2. 用 `--permission-mode plan` 或 `--allowedTools` 把可执行范围收窄到只读命令；
3. 贴给 AI 的日志先脱敏（`sk-`、口令、`SESSION_SECRET`）——虽然审计日志本身已脱敏，但 `docker compose config` 的输出没有；
   |   |   |   |
   | - | - | - |
4. `.env` 不要整份贴进对话，用 `grep -E '^(PUBLIC_BASE_URL|PORTAL_BASE_PATH|COOKIE_SECURE)=' .env` 只取非敏感项。

#### 3.7.5 标准动作：先打证据包，再让 AI 读

一条命令把现场固定下来，避免"AI 问一句、你敲一条"来回。

```bash
mkdir -p /tmp/portal-diag && cd /opt/campus-tokenhub-assign

{
  echo "===== 时间 ====="; date -Is
  echo "===== compose ps ====="; docker compose ps
  echo "===== 端口 ====="; ss -lntp | grep -E '8088|3000|8789|8790|5433'
  echo "===== nginx 配置渲染结果 ====="
  docker compose exec -T nginx cat /etc/nginx/conf.d/default.conf 2>/dev/null | head -80
  echo "===== 健康检查（经入口）====="
  curl -s -m 5 -D - http://127.0.0.1:8088/tokenhub/portal/api/health
  echo
  echo "===== 健康检查（直连容器）====="
  docker compose exec -T portal node -e \
    "fetch('http://127.0.0.1:3000/tokenhub/portal/api/health').then(r=>r.text()).then(console.log).catch(e=>console.log('ERR',e.message))"
  echo "===== 容器 IP ====="
  docker inspect -f '{{.Name}} {{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' \
    $(docker compose ps -q) 2>/dev/null
} > /tmp/portal-diag/env.txt 2>&1

docker compose logs --tail=300 portal   > /tmp/portal-diag/portal.log 2>&1
docker compose logs --tail=200 nginx    > /tmp/portal-diag/nginx.log  2>&1
docker compose logs --tail=200 migrate  > /tmp/portal-diag/migrate.log 2>&1
docker compose logs --tail=200 gateway-admin > /tmp/portal-diag/admin.log 2>&1

# 非敏感配置项
grep -E '^(PUBLIC_BASE_URL|PORTAL_BASE_PATH|PORTAL_COOKIE_PATH|COOKIE_SECURE|NGINX_HOST_PORT|NGINX_PUBLIC_PROTO)=' .env \
  > /tmp/portal-diag/config.txt 2>&1
```

然后一句话交给它：

```bash
codebuddy --permission-mode plan \
  "读 /tmp/portal-diag/ 下的 env.txt、portal.log、nginx.log、migrate.log、config.txt。
   目标：解释为什么 /tokenhub/portal/api/health 不通。
   要求：先给结论（一句话），再列证据（文件名+关键行），最后给 1-3 步处置命令。
   不要改任何文件。"
```

#### 3.7.6 六个可直接复制的排查 prompt

**① 入口 404 / 路由错乱**

```
直连 portal 容器是 200，走 nginx 8088 是 404。
读 /tmp/portal-diag/env.txt 里 nginx 渲染后的配置、容器 IP 段和 compose ps。
判断是「nginx 缓存了旧 upstream DNS」还是「location 前缀写错」，给出验证命令和修复命令。
```

**② 登录成功又跳回登录页**

```
现象：服务端日志有 auth.login success，浏览器立刻回到 /login。
附件是 curl -v 抓到的响应头与请求头。
重点看是否出现两个同名 portal_session、Path 分别是什么、verifyAnySession 是否被调用。
给出结论和清 Cookie 的操作步骤。
```

**③ 健康检查 unhealthy**

```
portal 容器 unhealthy，但 docker compose exec portal 里 curl 本机 3000 是通的。
读 env.txt 里 PORTAL_BASE_PATH 和 healthcheck 定义，判断是 basePath 没进 environment
还是应用启动失败，给出修复后的重建命令。
```

**④ 设置页保存失败**

```
PUT /api/portal/settings 返回 400，message 是「Client Secret 不能为空」。
附件是该请求的 body 与 src/lib/config/validate.ts 的相关片段。
指出是哪些字段被一起提交导致触发了 SSO 必填校验，以及最小修复点。
```

**⑤ 迁移失败**

```
migrate 容器 Exited(1)。读 migrate.log，定位第一条真正的 SQL 错误。
注意：日志里可能有前面语句的成功输出，事务其实已回滚。
判断是语法问题（\if 块里的 RAISE NOTICE、单引号里的 ${} 未插值）还是权限/连接问题。
给出改哪个文件、怎么验证对账表。
```

**⑥ 学生领 Key 失败**

```
某学生 /overview 领 Key 报 500。portal.log 里有 provision.fail，带网关原始错误。
结合 gateway 的用户模型（external_system + external_user_id 幂等）判断：
是网关没初始化、额度配置非法，还是同一 sub 开过两次号。
给出排查 SQL 与后续动作。
```

#### 3.7.7 把 AI 接进日常巡检（可选）

```bash
#!/usr/bin/env bash
# /opt/campus-tokenhub-assign/scripts/ai-healthcheck.sh
set -euo pipefail
cd "$(dirname "$0")/.."
codebuddy -p "检查 docker compose ps 与 curl http://127.0.0.1:8088/tokenhub/portal/api/health。
若全部正常只输出 OK；否则输出：问题、证据、建议命令（不超过 20 行）。" \
  --permission-mode plan --output-format text
```

放进 cron，每天 8:00 跑一次，结果发到运维群。**注意**：`-p` 模式不要加 `-y`，并且只授予只读命令。

---

## 4. 自定义需求开发

### 4.1 代码地图（改之前先认路）

```
src/
├─ app/
│  ├─ (portal)/            页面：overview / models / dashboard / playground / guide / activities / settings / setup
│  ├─ api/
│  │  ├─ auth/             login / callback / logout / password / admin-entry
│  │  ├─ portal/           keys / settings / admins / activities / calls / branding / provision / workbuddy
│  │  └─ setup/            初始化向导的三个接口
│  └─ login/               登录页
├─ components/             按页面分目录，UI 原子件在 ui/
└─ lib/
   ├─ auth/                会话签发验签、SSO 适配器（providers/）、管理员判定
   ├─ config/              **字段驱动配置中心**：fields.ts 是唯一声明处
   ├─ db/                  portal-schema.ts（建表 DDL）/ shared-schema.ts / portal-db.ts
   ├─ gateway/             调网关 Admin/Proxy 的客户端
   ├─ onboarding/          初始化向导：presets / providers / model-catalog
   ├─ portal/              nav、分页、额度展示、调用详情等页面级工具
   ├─ pricing/             价格估算
   └─ security/            同源校验、脱敏
```

三条结构性约定，改代码前必须知道：

1. **配置是字段驱动的**。字段名、DB 列、校验、是否密钥，全在 `src/lib/config/fields.ts` 声明；页面和读写都按类型化字段 id 走，不再拼 `auth.*` 字符串。加一个配置项，优先想"能不能只加一条 FIELDS"。
2. **数据分 schema**。共享层写 `portal_shared`（两站共用），本侧写 `portal_assign`。`check:shared-ddl` 会校验两侧共享 DDL 一致，`check:isolation` 会拦住跨侧引用。
3. **侧边栏高亮统一走 `resolveActiveHref`**（最长 href 胜出）。不要往 `isNavItemActive` 里加路径特判——历史上就是这么产生"管理员和系统设置同时高亮"的。

### 4.2 本地开发环境

```bash
npm ci
cp .env.example .env          # 至少改 SESSION_SECRET / 网关账号密码
npm run dev:local             # 一键切本地环境 + 起 dev
```

`dev:local` 会做两件事：把 `env/profiles/local.env` 写进 `.env.local`，并生成 `docker-compose.override.yml`（compose 自动加载、不入库），只覆盖浏览器侧那几个地址。

网关依赖单独用 compose 起，门户仍在宿主机跑热更新：

```bash
docker compose up -d postgres migrate gateway-proxy gateway-admin
```

环境切换：

```bash
npm run env:current    # 现在生效的是哪套
npm run env:local      # 本地
npm run env:lan        # 局域网（自动探测内网 IP，填入 PUBLIC_BASE_URL）
npm run env:online     # 线上地址（本机调线上 SSO 时用）
```

`lan` 模式下 `PUBLIC_BASE_URL` 变成 `http://<内网IP>:3000/...`，这个地址**也要在 IdP 白名单里**，否则授权页会拒 `redirect_uri`。内网 IP 变了重跑 `env:lan`。

### 4.3 门禁：提交前必须全绿

```bash
npm run typecheck        # tsc --noEmit
npm run lint             # eslint（flat config）
npm test                 # vitest run
npm run check:isolation  # src/ 里不得出现跨侧引用
npm run check:shared-ddl # 两站共享层 DDL 必须一致
npm run build            # next build（standalone）
```

顺序建议：`typecheck → test → check:isolation → build`。`build` 最后跑，因为它最慢，而且会暴露 basePath / standalone 相关问题。

测试现状参考：assign 侧 843 个用例、member 侧 606 个（拆仓时数据），全绿才算可以提交。

### 4.4 六个典型改动 recipe

#### R1 加一个设置项（最高频）

以"加一个 `default_context_limit`"为例：

1. `src/lib/config/fields.ts` 加一条 FIELDS：`column: 'default_context_limit'`、`section: 'app'`、`auditName`、类型与校验；
2. `src/lib/db/portal-schema.ts`（或 `shared-schema.ts`，看 section）：建表语句加列，**同时**加 `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`——`CREATE TABLE IF NOT EXISTS` 不会给已有表加列，老库启动后会缺列；
3. 若该字段不在 `auth` 子树：检查 `src/lib/config/overlay.ts` 与 `settings-view.ts` 是否需要特判（`portal.localAdmin` 就是踩过这个坑，界面一直显示空值）；
4. 页面通常**不用改**——设置页由 FIELDS 驱动渲染；
5. 补测试：`tests/lib/` 下加字段读写与校验用例。

#### R2 加一个页面

```bash
src/app/(portal)/reports/page.tsx        # 服务端组件，读会话 + 取数
src/components/reports/*.tsx             # 交互部分标 'use client'
```

侧边栏入口在 `src/lib/portal/nav.ts` 的 `buildNav`：加 `NavItem`（`href`、`label`、`icon`、是否仅管理员）。高亮不用管，`resolveActiveHref` 会处理父子路径。

#### R3 加一个 API

`src/app/api/portal/reports/route.ts`。照同目录已有 route 的结构写：

- 取会话：`sessionFromCookieHeader` / `verifyAnySession`（`src/lib/auth/session.ts`）；
- 管理员校验：`src/lib/auth/admin.ts` + `src/lib/admin/roster.ts`；
- 写操作做同源校验（`src/lib/security/`）；
- 错误统一返回 `{ error: '中文可读文案' }`，不要把上游原始错误直接抛给浏览器；
- 加审计：沿用现有 `audit(...)` 写法，事件名形如 `report.export`。

#### R4 换品牌 / 文案

- 校名、登录页标题、页脚、主题色、Logo：设置页「首页配置」，存 `portal_shared.app_config`；
- 侧边栏兜底校名：`PORTAL_SCHOOL_NAME`；
- 登录页按钮文案是代码默认值（`src/app/login/page.tsx` 与 `src/lib/auth/`），改代码时注意：文案属于"门户默认"，学校真实文案由 IdP 页面决定。

#### R5 加一种登录协议

实现 `AuthAdapter`（`src/lib/auth/providers/types.ts`）的 `start` / `complete`，在 `providers/registry.ts` 注册一行，再在设置页的协议选项里放开。身份 claim 的兼容与允许名单校验在 `providers/identity.ts`，不要各写一套。

注意：登录协议由设置页选择并存数据库。新增协议需要在 `providers/registry.ts` 注册，并在设置页的协议选项里放开。

#### R6 改运营活动字段

`src/lib/activities/` 的领域逻辑 + `portal_assign.activity_configs` 表 + `/activities` 页面。改表结构同样要处理 `ALTER TABLE`；活动是**本侧专属**数据，别写进 `portal_shared`。

### 4.5 数据契约红线

| 红线                              | 违反后果                          | 谁拦你                |
| ------------------------------- | ----------------------------- | ------------------ |
| 共享表只写 `portal_shared`           | 两站数据分裂，管理员名单不同步               | `check:shared-ddl` |
| `src/` 不得引用成员站代码                | 拆仓白做了，单独部署会炸                  | `check:isolation`  |
| 建表必须带 `ALTER ... IF NOT EXISTS` | 老库升级后缺列，运行期报 column not exist | 代码评审               |
| 金额/额度计算不要落门户                    | 门户与网关两套账，对不上                  | 数据边界（0.4）          |
| 会话 Cookie 的 `path` 用公共前缀        | 两站各存一份，互认断且不报错                | 部署检查               |

### 4.6 交付打包

仓库根有 `pack-for-school.sh`（在上层工作区目录）：用 `git archive` 只导出版本库跟踪文件，天然排除 `node_modules` / `.next` / `.env*` / 数据卷。

```bash
./pack-for-school.sh                 # 有未提交改动会中止
./pack-for-school.sh --allow-dirty   # 用 git stash create 打包（不含未跟踪文件）
```

它还会做三件收尾：排除 `openspec` 与内部架构文档、把内部域名替换成占位符、导出后反向校验敏感文件与残留域名。

注意：`sed -i ''` 是 macOS 写法，脚本已改成临时文件 + mv 的可移植写法，别改回去。

### 4.7 用 CodeBuddy CLI 辅助开发

```bash
cd /opt/campus-tokenhub-assign
codebuddy
> /init
```

四条最实用的用法：

**① 先让它读，再让它改**

```
> 我要在设置页加一个「默认上下文长度」字段。先只读：
  列出需要改的文件、每个文件改什么、有哪些坑（字段分区、ALTER TABLE、overlay 特判），
  不要动代码。
```

确认方案后再让它执行。这比"直接改"省掉一轮返工。

**② 用 plan 模式做影响面分析**

```bash
codebuddy --permission-mode plan \
  "把 src/lib/config/fields.ts 里所有 section=login 的字段列出来，
   并指出哪些在 src/lib/config/overlay.ts 里有特判。只读不改。"
```

**③ 让它写测试（这个项目重稳定性，重构必须带单测）**

```
> 给 src/lib/portal/nav.ts 的 resolveActiveHref 补测试：
> 覆盖父子路径、query 参数、无命中、多命中取最长。
> 用 vitest，放在 tests/lib/portal-nav.test.ts，不要引入 DOM 依赖。
```

**④ 提交前自查**

```bash
codebuddy -p "跑 npm run typecheck 和 npm test，把失败项按文件归类，
  指出哪些是本次改动引入的、哪些是既有失败。不要自动修改。"
```

---

## 5. 附录：配置 / 接口 / 数据表

### 5.1 环境变量（按重要性分组）

**必填**

| 变量                                      | 说明                                    |
| --------------------------------------- | ------------------------------------- |
| `SESSION_SECRET`                        | ≥32 字符，签会话；两站互认必须相同                   |
| `POSTGRES_PASSWORD`                     | 数据库口令，只用十六进制                          |
| `OCTAFUSE_ADMIN_API_KEY`                | 网关后台集成密钥，门户用它 Bearer 调 `/api/admin/*`  |
| `OCTAFUSE_EXTERNAL_SYSTEM`              | 外部身份命名空间，如 `campus-tokenhub`，**无代码默认值** |
| `PUBLIC_BASE_URL`                       | 对外根地址，含前缀；线上必填                        |

**常用**

| 变量                                               | 默认                | 说明                            |
| ------------------------------------------------ | ----------------- | ----------------------------- |
| `PORTAL_BASE_PATH`                               | 空                 | Next basePath，**构建期**         |
| `ADMIN_UI_PUBLIC_PATH`                           | 空                 | 管理台公网前缀，**构建期**               |
| `ADMIN_PUBLIC_BASE_URL`                          | 空                 | 侧边栏外链地址                       |
| `NEXT_PUBLIC_PROXY_BASE`                         | 空                 | 学生浏览器直连网关的地址                  |
| `COOKIE_SECURE` / `ADMIN_COOKIE_SECURE`          | `false`           | TLS 后必须 true / 1              |
| `PORTAL_COOKIE_PATH` / `_DOMAIN`                 | 空                 | 两站互认的作用域，见 1.10               |
| `SESSION_TTL_HOURS`                              | `8`               | 会话有效期                         |
| `PORTAL_ADMIN_USERNAME` / `_PASSWORD` / `_LOGIN` | 空 / `auto`        | 引导期账号（唯一保留 env 的业务配置）         |
| `CONFIG_ENCRYPTION_KEY`                          | 空                 | 加密配置项，留空从 `SESSION_SECRET` 派生 |

> `AUTH_PROVIDER`、`OAUTH2_*`、`CAS_*`、`DEFAULT_BUDGET_*`、`PORTAL_SCHOOL_NAME` 已改为只在「设置」页维护，写在 env 里不生效。

**网关与留存**

| 变量                                       | 默认                               | 说明                                                  |
| ---------------------------------------- | -------------------------------- | --------------------------------------------------- |
| `OCTAFUSE_ADMIN_BASE` / `_PROXY_BASE`    | —                                | 容器内走服务名：`gateway-admin:8789` / `gateway-proxy:8787` |
| `OCTAFUSE_GATEWAY_DIR`                   | `./local-stack/octafuse-gateway` | 网关源码路径（构建期）                                         |
| `REQUEST_CONTENT_CAPTURE`                | `on`                             | 正文留存总开关                                             |
| `REQUEST_CONTENT_RETENTION_DAYS`         | `90`                             | 保留天数，按月整月清理                                         |
| `REQUEST_CONTENT_MAX_CHARS`              | `65536`                          | 单侧正文上限                                              |
| `NGINX_HOST_PORT` / `NGINX_PUBLIC_PROTO` | `8088` / `https`                 | 入口端口与后端协议                                           |

完整清单和逐条说明见 `.env.example`（每一项都有中文注释，比任何二手文档都准）。

### 5.2 接口一览

| 路径                                                  | 方法              | 用途                    |
| --------------------------------------------------- | --------------- | --------------------- |
| `/api/health`                                       | GET             | 健康检查（含 `gateway` 连通性） |
| `/api/auth/login`                                   | GET             | 发起 SSO（303 到 IdP）     |
| `/api/auth/callback`                                | GET             | SSO 回调                |
| `/api/auth/logout`                                  | POST            | 登出                    |
| `/api/auth/password`                                | POST            | 引导期账号密码登录             |
| `/api/auth/admin-entry`                             | GET             | 侧边栏跳网关后台              |
| `/api/portal/keys`                                  | GET/POST        | 列出 / 创建 Key           |
| `/api/portal/keys/[id]`                             | DELETE          | 吊销                    |
| `/api/portal/settings`                              | GET/PUT         | 读写配置                  |
| `/api/portal/settings/probe`                        | POST            | 检测凭据 / 网关币种           |
| `/api/portal/settings/logo`                         | POST            | 上传 Logo               |
| `/api/portal/admins`                                | GET/POST/DELETE | 管理员名单                 |
| `/api/portal/admins/candidates`                     | GET             | 候选搜索                  |
| `/api/portal/activities` / `activities/config`      | GET / PUT       | 活动读取与配置               |
| `/api/portal/calls` / `calls/[id]` / `[id]/content` | GET             | 调用日志与正文               |
| `/api/portal/branding` / `branding/logo`            | GET             | 品牌资源                  |
| `/api/portal/provision`                             | POST            | 网关开户                  |
| `/api/setup` / `apply` / `probe` / `status`         | GET/POST        | 初始化向导                 |

### 5.3 数据表

| schema               | 表                     | 说明                               |
| -------------------- | --------------------- | -------------------------------- |
| `portal_shared`      | `admins`              | 全局管理员名单（两站共用）                    |
|                      | `app_config`          | 单行结构化列：品牌、额度、限流、云凭据（加密）          |
|                      | `login_config`        | 单行结构化列：SSO 协议与参数、字段映射、管理员角色同步、登录限制、部署管理员 |
|                      | `settings`            | 键值杂项（含迁移标记 `migration.*`）        |
|                      | `session_revocations` | 会话撤销                             |
|                      | `config_audit`        | 配置变更审计                           |
| `portal_assign`      | `activity_configs`    | 运营活动                             |
| `portal_member`      | `member_applications` | 成员站在用，本侧不碰                       |
| `octafuse_gateway.*` | 网关表                   | 由 `migrate` 建，门户只读               |

常用查询：

```sql
-- 管理员名单
select sub, created_at from portal_shared.admins order by created_at;

-- 活动
select id, title, points, period, enabled from portal_assign.activity_configs order by sort_order;

-- 迁移标记
select key, value from portal_shared.settings where key like 'migration.%';
```

### 5.4 术语

| 词             | 含义                            |
| ------------- | ----------------------------- |
| 门户            | 本项目，学生看到的 Next 应用             |
| 网关 / OctaFuse | 真正承接推理请求的服务，含 proxy 与 admin   |
| 两站            | 统一采买站（本仓库）+ 成员自购站（另一个仓库）      |
| 共享层           | `portal_shared`，两站共用一份        |
| 引导账号          | SSO 没配齐时用来进设置页的临时账号密码         |
| 初始化负责人        | 首个登录者，记在网关 `ONBOARDING_OWNER` |
| 正文留存          | 网关把请求/响应正文旁路写库，供调用详情查看        |
