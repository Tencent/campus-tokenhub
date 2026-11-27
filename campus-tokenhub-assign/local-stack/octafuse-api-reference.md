# OctaFuse 开放接口速查

> 基于本地已部署实例（v2.18.0）仓库 `docs/developers/api/*` 整理。
> 本地地址：管理台 http://127.0.0.1:8789 （admin / octafuse123），代理 http://127.0.0.1:8790 。
> 管理 API 默认 master key：`sk-dev-admin-key`（仅 quickstart 种子值，**生产必须轮换**）。

---

## 一、部署形态与 Base URL

| 用途 | 运行时 | Base URL（本地示例） | 路径前缀 |
|------|--------|----------------------|----------|
| 健康检查 / 用户 API | Proxy | `http://127.0.0.1:8790` | `/`、`/health`、`/catalog/*`、`/v1/*`、`/v1beta/*` |
| 管理 API | Admin | `http://127.0.0.1:8789` | `/api/admin/*`（内部重写为 `/admin/*`） |

> 文档正文以**内部路径 `/admin/*`** 描述；对外调用请替换为 **`/api/admin/*`**。

---

## 二、认证方式

| 认证类型 | 场景 | 说明 |
|---------|------|------|
| 无认证 | 健康检查 / 公开目录 | Proxy：`/`、`/health`、`GET /catalog/models` |
| 具名 Admin API Key | 管理接口 | `Authorization: Bearer <ADMIN_KEY>`，打到 Admin 的 `/api/admin/*` |
| Bearer Token（用户 Key） | 用户接口 | `Authorization: Bearer sk-…`，打到 Proxy |
| `x-api-key` | Anthropic 兼容 | `POST /v1/messages` |
| `?key=` / `x-goog-api-key` | Gemini 兼容 | `POST /v1beta/models/...` |

---

## 三、公开接口（Proxy，无需 Key）

| 方法 | 端点 | 说明 |
|------|------|------|
| GET | `/` | 服务名与版本（`octafuse-proxy`） |
| GET | `/health` | 健康检查 |
| GET | `/catalog/models` | 运行时模型目录（含 `protocols_by_group` 与 `inbound`，**不过滤 kind**） |

---

## 四、用户接口（Proxy，需用户 Key）

全部部署在 Proxy（`GATEWAY_URL`），与 Admin 无关。

### 推理 / 生成

| 方法 | 端点 | 说明 |
|------|------|------|
| POST | `/v1/chat/completions` | OpenAI 兼容聊天（支持流式） |
| POST | `/v1/responses` | OpenAI Responses 透传（流式 / 非流式） |
| POST | `/v1/images/generations` | OpenAI 兼容文生图 |
| POST | `/v1/images/edits` | OpenAI 兼容图片编辑（multipart） |
| POST | `/v1/audio/transcriptions` | 语音转写（multipart） |
| POST | `/v1/audio/speech` | 语音合成 |
| POST | `/dashscope/api/v1/services/aigc/multimodal-generation/generation` | DashScope 同步 ASR 透传 |
| GET/WS | `/dashscope/api-ws/v1/inference` | DashScope 实时 ASR / TTS |
| GET/WS | `/dashscope/api-ws/v1/realtime?model=` | DashScope Qwen-Realtime |
| POST | `/v1/messages` | Anthropic Messages |
| POST | `/v1beta/models/:modelAction` | Gemini generateContent / streamGenerateContent |
| GET | `/v1/models` | 模型列表（需用户 Key；默认仅 LLM） |
| GET | `/v1/me` | 当前 Key 对应预算与元数据 |

### Agent Tools（按次计费）

| 方法 | 端点 | 说明 |
|------|------|------|
| POST | `/v1/tools/web-search` | 联网搜索 |
| POST | `/v1/tools/web-fetch` | 网页抓取 |
| POST | `/v1/tools/web-deep-search` | 深度检索（搜 + 读） |
| POST | `/v1/tools/ai-detection` | AI 率检测 |
| GET | `/v1/tools/pricing` | Tools 只读定价 |

### 模型 ID 与路由组（route group）

网关按 `models.id` 解析路由；客户端通过 `model` 字符串选择供应商通道（`model_routes.route_group`，如 `default`、`free`）。

- 传 `baseId`（如 `deepseek-v3.2`）→ 命中 `models.id`，有效组 = `default`
- 传 `baseId:group`（如 `deepseek-v3.2:free`）→ 基础模型 = `deepseek-v3.2`，有效组 = `free`

限流：Key 层 + 用户合计层双重 RPM（从当前时刻回溯 60s 滚动窗口，非自然分钟）；预算：周期额度 + 永久额度总剩余 ≤ 0 返回 403。

### 聊天补全示例（OpenAI 兼容）

```bash
curl http://127.0.0.1:8790/v1/chat/completions \
  -H "Authorization: Bearer sk-<USER_KEY>" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-v3.2",
    "messages": [
      {"role":"system","content":"You are a helpful assistant."},
      {"role":"user","content":"Hello!"}
    ],
    "stream": true,
    "temperature": 0.7,
    "max_tokens": 2048
  }'
```

---

## 五、管理接口（Admin，`/api/admin/*`）

逻辑分层：**Catalog**（供应商 → 模型 → 路由）、**Tenancy / Billing**（用户 / Key / 额度）、**Observability**（日志 / 分析聚合）。

### 5.1 用户与密钥（重点）

#### `POST /api/admin/users` — 建用户

按 **`(external_system, external_user_id)`** 幂等创建（已存在则返回已有用户）。

| 字段 | 必填 | 说明 |
|------|------|------|
| `email` | 是 | 至少包含 email |
| `external_system` | 可选 | 与 `external_user_id` 成对（同空或同非空） |
| `external_user_id` | 可选 | 上游用户标识 |
| `budget_max` / `budget_base` / `budget_period` | 可选 | 周期额度计划 |
| `metadata` | 可选 | JSON 对象 |
| `charged_cost_factors` | 可选 | 用户级计费倍率 `{ "<modelId>": number | {"<routeGroup>"\|"*": number} }` |

#### `POST /api/admin/keys` — 建 Key（返回明文一次）

**路径 A — 已有网关用户**

| 字段 | 必填 | 说明 |
|------|------|------|
| `user_id` | 是 | `users.id`（须已存在） |
| `name` | 否 | 密钥显示名 |
| `metadata` | 否 | JSON 对象或可解析字符串 |
| `reason` | 否 | 写入 `key_created` 审计 `reason_text` |

**路径 B — 按外部身份匹配 / 创建用户后再建 Key**

| 字段 | 必填 | 说明 |
|------|------|------|
| `external_system` | 是 | 上游产品 / 租户标识 |
| `external_user_id` | 是 | 上游用户标识 |
| `email` | 是 | 新建用户时写入 `users.email` |
| `name` / `metadata` / `reason` | 否 | 同路径 A |

> 预算与邮箱在 `users` 表维护，请用 `PATCH /api/admin/users/:id`；**不要在创建 / 更新 Key 时携带预算或 `user_email`**。

**响应**（明文 `key` 仅本次返回，客户端须立即保存）：

```json
{ "success": true, "message": "Key created successfully",
  "data": { "key": "sk-xxx...", "key_id": "uuid", "user_id": "string" } }
```

> ⚠️ **文档与实测不一致**：上方按官方文档写的是"明文仅本次返回"，但实测 `GET /api/admin/keys`、`GET /api/admin/users/:id/keys`、`GET /api/admin/keys/:id` **都返回完整明文 `key`**（35 字符 `sk-` 真实可调用）。也就是说持有 admin key 者可随时读回全部用户密钥。门户据此把"密钥随时可查看复制"做成常态功能，但这也意味着 admin key 的泄露面等同于全站 Key 泄露，必须只在服务端持有。

#### 其他用户 / 密钥端点

| 方法 | 端点 | 说明 |
|------|------|------|
| GET | `/api/admin/users` | 分页列表（支持 `email` 模糊、`sort`/`order`、`status`；**另支持 `external_system` + `external_user_id` 精确过滤，见 5.4**） |
| GET/PATCH/DELETE | `/api/admin/users/:id` | 用户详情 / 更新 / 删除（级联删 Key） |
| GET/POST | `/api/admin/users/:id/keys` | 该用户密钥列表 / 新建（同全局建 Key 响应） |
| PATCH/DELETE | `/api/admin/users/:id/keys/:keyId` | 限定该用户的密钥更新 / 删除 |
| GET | `/api/admin/users/:id/logs` | 该用户 `api_key_request_logs` |
| GET | `/api/admin/users/:id/audit-logs` | 该用户 `user_audit_logs` |
| POST | `/api/admin/users/:id/budget/transition/preview` | 预算转换只读预览 |
| POST | `/api/admin/users/:id/budget/transition` | 原子应用预算转换 |
| POST | `/api/admin/users/:id/wallet/credit` | 永久额度增量（`amount`/`kind`/`external_ref` 必填，`dedup_key` 幂等） |
| GET | `/api/admin/keys` | Key 列表（JOIN users，预算只读） |
| GET/PATCH/DELETE | `/api/admin/keys/:id` | Key 详情 / 更新 / 删除 |

### 5.2 供应商 / 模型 / 路由（Catalog）

| 方法 | 端点 | 说明 |
|------|------|------|
| GET/POST | `/api/admin/providers` | 供应商列表 / 新建 |
| GET/PATCH/DELETE | `/api/admin/providers/:id` | 供应商详情 / 更新 / 删除（列表脱敏 `api_key`） |
| GET | `/api/admin/providers/:id/api-key` | 明文揭示密钥 |
| GET | `/api/admin/providers/:id/quota` | 实时查上游余额 / 周期额度（不回显密钥） |
| GET/POST | `/api/admin/providers/import` / `import/catalog` | 按 catalog 模板批量导入供应商 |
| GET/POST | `/api/admin/models` | 模型列表 / 新建 |
| GET/PATCH/DELETE | `/api/admin/models/:id` | 模型详情 / 更新 / 删除 |
| GET/POST | `/api/admin/models/import` / `import/catalog` | 按静态目录导入模型 |
| GET/POST | `/api/admin/routes` | 路由列表（`?model_id=&provider_id=`）/ 新建 |
| GET/PATCH/DELETE | `/api/admin/routes/:id` | 路由详情 / 更新 / 删除（Surface → Pool → Target） |
| PATCH | `/api/admin/routes/pools/:poolId` | Pool 策略 / Provider 粘性 |
| GET/POST | `/api/admin/mcp-servers` (+`/:id/*`) | MCP 服务器注册、测试、同步、按次定价 |

### 5.3 可观测 / 配置

| 方法 | 端点 | 说明 |
|------|------|------|
| GET | `/api/admin/stats` | 多表聚合 |
| GET | `/api/admin/request-logs` | 全站请求日志（多条件筛选分页） |
| GET | `/api/admin/request-logs/summary` | 按维度汇总条数 / Token / 金额（门户对账） |
| GET | `/api/admin/analytics/{models,providers,users,keys,reliability}` | 各维度分析聚合 |
| GET | `/api/admin/budget-audit-logs` | 预算与生命周期审计（`user_audit_logs`） |
| GET/PUT | `/api/admin/config` | `system_config`（ROUTE_STRATEGY 等） |
| GET/PUT | `/api/admin/maintenance` | 维护模式开关 |

### 5.4 按外部身份操作（v2.18.0 实测结论）

外部系统对接时不需要本地维护用户表，全部靠 `(external_system, external_user_id)` 关联。

| 需求 | 调用 | 实测结果 |
|---|---|---|
| 开户（不存在则建、存在则返回） | `POST /api/admin/users` `{external_system, external_user_id, email, ...}` | 200，`message` 为 `User created or returned (idempotent by external pair)`，`data.id` 即用户 ID |
| 按外部 ID 反查用户 ID | `GET /api/admin/users?external_system=X&external_user_id=Y` | `total=1`，`data[0].id` 为目标 ID |
| 只按外部 ID 反查（不带 system） | `GET /api/admin/users?external_user_id=Y` | 同样可过滤 |
| 按邮箱查 | `GET /api/admin/users?email=Y` | `total=1`（精确或模糊取决于取值） |
| 按外部身份直接建 Key | `POST /api/admin/keys` `{external_system, external_user_id, email, name}` | 200，自动解析/创建用户，返回该用户 `user_id` |
| 列某用户密钥 | `GET /api/admin/users/:id/keys` | 返回含明文 `key` 的完整列表 |
| 列某用户调用 | `GET /api/admin/users/:id/logs` | 返回 `api_key_request_logs` |
| 某 Key 维度调用 | `GET /api/admin/keys/:id/logs` | 同上，按 Key 过滤 |
| 判定已存在 active 密钥 | `GET /api/admin/users/:id/keys` 后过滤 `status === 'active'` | 门户「一人一把」据此校验 |

**幂等语义**：`POST /api/admin/users` 重复提交返回 **200 + 已有对象**（不报 409），因此可以无脑当作 get-or-create 使用，无需先查后建，也不会因并发产生重复账号。

**用户对象字段**：`id`、`email`、`budget_max`、`budget_base`、`budget_spent`、`budget_period`、`budget_reset_at`、`wallet_granted`、`wallet_spent`、`status`、`metadata`、`rate_limit`、`charged_cost_factors`、`external_system`、`external_user_id`、`created_at`、`updated_at`、`active_keys_count`、`keys_count`。

**注意**：`budget_max` 只在创建时生效，已存在用户的额度需用 `PATCH /api/admin/users/:id` 修改；`POST` 不会覆盖既有额度。

### 5.5 按用户配置模型（支持，但语义是计费而非授权）

Admin 用户详情页的「模型列表」页签就是按用户配置模型的入口：可以「添加目录模型」，并为每个模型/路由组设置倍率（`0` 表示不收费）。落库在 `users.charged_cost_factors`。

| 能力 | 接口 | 实测结果 |
|---|---|---|
| 读取「该用户配置了倍率的模型」 | `GET /api/admin/users/:id/display-discounts` | 未配置返回 `data: []`；配置 `{"hy4":1}` 后返回 `[{"id":"hy4","discounts":{...}}]` |
| 读取「该用户视角的完整模型列表」 | `GET /api/admin/users/:id/models` | 返回 `{object,data:[...],preview}`，**不按倍率过滤**，等同 `/v1/models` 视角 |
| 配置倍率 | `PATCH /api/admin/users/:id` `{"charged_cost_factors": {"<modelId>": 1}}` | 200；传 `null` 清空 |

**三种语义必须分清**：

1. **计费（已支持）**：倍率改变该用户在这些模型上的实扣金额，`display-discounts` 会叠加进展示折扣。
2. **展示收敛（可由下游实现）**：`display-discounts` 只回该用户配过倍率的模型，门户可据此渲染「你的模型」。实测确认该过滤存在（`user-display-discounts.ts` 里 `modelHasUserChargedCostFactor` 命中才继续）。注意 `/:id/models` 不过滤，两者不要混用。
3. **强制隔离（不支持）**：推理路径只把 `charged_cost_factors` 当计费输入（`userChargedCostFactorsJson`），没有任何 403 分支。学生直连 `/v1/models` 仍看到全部模型，也能调用未配置的模型，按路由原价计费。

**其余字段确认无模型授权能力**：

- `api_keys` / `users` 表无模型或分组字段；`PATCH /api/admin/keys/:id` 只接受 `name / metadata / metadata_replace / status / rate_limit`
- `model_routes` / `route_pools` / `model_surfaces` 全挂 `model_id`，无 `user_id` / `key_id`
- `route_group` 由客户端通过 `model:group` 自行选择，非服务端授权
- `metadata` 无任何代码读取做鉴权

### 5.6 模型列表相关接口全清单

| # | 接口 | 认证 | 数据范围 | 服务端过滤参数 | 备注 |
|---|---|---|---|---|---|
| 1 | `GET /catalog/models` | 无 | 仅有 ≥1 条 active 路由的模型 | `route_groups`（CSV，大小写不敏感，空/省略=全部组） | 45 秒进程内缓存；字段含 `pricing_profile`、`route_groups`、`discounts`、`inbound` |
| 2 | `GET /v1/models` | 用户 Key | 同上 | `route_groups`（默认 `default,free`）、`kind` | 叠加该用户 `charged_cost_factors` 折扣；额度超限/限流时仍允许只读列举 |
| 3 | `GET /api/admin/models` | admin key | **全部模型**（含 0 路由、retired） | 无——实测 `route_groups`/`kind`/`tag`/`search` 均被忽略 | 比 catalog 多 `routes_count`、`active_routes_count`、`retired_at`、`note` |
| 4 | `GET /api/admin/models/:id` | admin key | 单模型 | — | |
| 5 | `GET /api/admin/users/:id/models` | admin key | 全部模型 + 该用户折扣 | `route_groups`、`kind`、`model`（关键字） | 返回 `{object,data,preview}`，**不按倍率过滤** |
| 6 | `GET /api/admin/users/:id/display-discounts` | admin key | 仅该用户配过倍率的模型 | `route_groups` | 返回 `[{id, discounts}]` |
| 7 | `GET /api/admin/analytics/models` | admin key | 有用量的模型 × 路由组 | 时间/维度 | 聚合，非目录 |
| 8 | `GET /api/admin/routes?model_id=&provider_id=` | admin key | 路由配置 | `model_id`、`provider_id` | 看模型分布在哪些组 |

**关键差异**：`/catalog/models` 与 `/v1/models` 只列「能真正调用」的模型（至少一条 active 路由）；`/api/admin/models` 列全部，包括刚建好还没配路由的（本地就有个 `deepseek/deepseek-flash` 是 0 路由，只出现在 admin 列表里）。

#### 路由组（route_group）—— 分组过滤的唯一机制

模型的 `route_groups` 是**从 active 路由聚合出来的**，不是独立字段：

```sql
(SELECT json_agg(r.route_group) FROM model_routes r
  WHERE r.model_id = m.id AND r.status = 'active') AS route_groups
```

所以「把模型放进某组」= 给它加一条该组的 active 路由：

```bash
# 给 hy4 增加 grad 组路由（复用同一 provider，不需要新建模型）
curl -X POST http://127.0.0.1:8789/api/admin/routes \
  -H "Authorization: Bearer $ADMIN_KEY" -H "Content-Type: application/json" \
  -d '{"model_id":"hy4","provider_id":"<provider-uuid>",
       "provider_model_name":"hy4","route_group":"grad",
       "upstream_protocol":"openai","status":"active"}'
```

实测效果（加完后等 45 秒缓存失效）：

| 请求 | 返回 |
|---|---|
| `/catalog/models` | `hy4`，`route_groups: ['default','grad']` |
| `/catalog/models?route_groups=default` | `hy4`，`route_groups` 收窄为 `['default']` |
| `/catalog/models?route_groups=grad` | `hy4`，`route_groups: ['grad']` |
| `/catalog/models?route_groups=undergrad` | `[]` |

删除该路由即退出该组。新建路由会自动补一条 `model_surfaces` 记录（`request_operation` 为 `*`）。

#### 同一模型挂在多个组时怎么区分

模型 ID 不变，靠**调用时的 `model` 字符串后缀**区分走哪个组：

```
deepseek/deepseek-flash:student
deepseek/deepseek-flash:teacher
```

要点：

- 目录里**一个模型只有一条记录**，`route_groups` 是数组（`['student','teacher']`），不会列成两行。带 `?route_groups=student` 查询后该数组会收窄为 `['student']`，可直接据此拼后缀。
- 响应体的 `model` 字段是**上游模型名**（实测返回 `deepseek-v4.1-flash-1017`），不是目录 ID，也无法从响应判断走了哪个组。
- 判断实际走的组只能看请求日志：`api_key_request_logs.route_group` 有值，实测两条记录分别为 `teacher` 和 `student`。
- 两个组若指向同一 provider、同一上游模型、同一倍率，则功能上完全等价，区别仅在路由记录与日志归属。要让分组有实质差异，需让两组指向不同 provider（隔离上游 key / 配额）、不同上游模型，或配置不同计费倍率。

#### 用户能否被限制在某个组：不能

网关没有「Key / 用户 → 组」的归属概念，组名完全由客户端在 `model` 里自己传。

| 检查项 | 结论 |
|---|---|
| `api_keys` / `users` 表 | 无组字段 |
| `PATCH /api/admin/keys/:id` | 只接受 `name / metadata / metadata_replace / status / rate_limit` |
| 实测越权 | 用无 teacher 归属的 Key 请求 `deepseek/deepseek-flash:teacher` → **200 成功** |

唯一的软约束是计费倍率（`charged_cost_factors`，按组生效，`USER_CHARGED_COST_FACTOR_MODE` 默认 `multiply`）。实测给某用户配 `{"deepseek/deepseek-flash":{"teacher":100,"*":1}}` 后：

```
route_group | standard_cost | charged_cost
teacher     |      0.000158 |     0.015800   ← 100 倍
student     |      0.000158 |     0.000158   ← 1 倍
```

即越权调用仍会成功，但按惩罚倍率扣费；倍率设到 1e6 时一次越权就能耗尽额度，此后请求返回 403。这是「经济惩罚」，不是拒绝，第一次必然放行。

要真正拒绝只能在上游加一层校验（反代 `/v1/*`，比对 `model` 后缀与用户所属组）。

#### 实测：不留 `default` 组会怎样

把 `deepseek/deepseek-flash` 分到 `student`+`teacher`、`hy4` 分到 `student`，`default` 组清空后：

| 请求 | 结果 |
|---|---|
| `/catalog/models` | 两个模型都在（无参数=全部组） |
| `/catalog/models?route_groups=student` | `deepseek/deepseek-flash`、`hy4` |
| `/catalog/models?route_groups=teacher` | 只有 `deepseek/deepseek-flash` |
| `/catalog/models?route_groups=default` | `[]` |
| `GET /v1/models`（不带参数） | **`[]`** — 默认只查 `default,free` 两组 |
| `POST /v1/chat/completions` `model=hy4` | **404**，`x-octafuse-error-code: gateway.no_route`，body `{"error":"No available route","code":"gateway.no_route"}` |
| `POST /v1/chat/completions` `model=hy4:student` | 200 正常返回 |

**给客户端产品的重要提示**：`GET /v1/models` 默认 `route_groups=default,free`。一旦所有路由都不在 `default` 或 `free` 组，未带参数的 `/v1/models` 返回空数组，任何依赖它拉列表的客户端（WorkBuddy、Cherry Studio、OpenAI SDK 的模型选择器）都会看到空列表，必须手填 `id:group` 才能调用。

#### 调用侧：模型名可带 `:group` 后缀

选路时「客户端未带 `baseId:group` 后缀 → 有效组固定为 `default`」（`services/route-selection.ts`）。因此：

- 模型在 `default` 组有路由 → 裸 `id` 可调用
- 模型**只**在其他组有路由 → 裸 `id` 会解析到 `default` 组并因无路由失败，必须写 `id:grad`

这条决定了分组能做到什么程度：

| 模式 | 配法 | 效果 |
|---|---|---|
| 仅展示分组 | 每个模型都保留 `default` 路由，另加组路由 | 学生只看到自己组的模型，调用一律裸 `id` |
| 调用隔离 | 模型只在特定组配路由，不给 `default` 配 | 非该组学生裸 `id` 直接失败，需知道组名才能 `:group` 绕过 |

---

## 六、错误响应

分类权威是响应头 **`X-OctaFuse-Error-Code`**；不要只按 HTTP 状态分支（404 可能是 `gateway.model_not_found` / `gateway.no_route` / `upstream.not_found`）。

| 前缀 | 含义 |
|------|------|
| `gateway.*` | 请求未出网关 |
| `circuit.*` | 熔断短路（未打上游，如 `circuit.upstream_capacity_exhausted`、`circuit.sensitive_content`） |
| `upstream.*` | 已打上游，网关分类 |
| `responses.*` | Responses 会话约束 |

管理接口：未授权多为 `{ "error": "Unauthorized" }`（401）；业务失败多为 `{ "success": false, "message": "..." }`。

---

## 七、本地实例快速验证

管理接口**不接受 Bearer master key**（本地实测 `Authorization: Bearer ...` 一律 401）。正确姿势是先用 `ADMIN_USERNAME`/`ADMIN_PASSWORD` 换一个 httpOnly 会话 Cookie：

```bash
PW=$(grep '^ADMIN_PASSWORD=' octafuse-gateway/.env.local | cut -d= -f2-)

# 1) 健康检查
curl http://127.0.0.1:8790/health

# 2) 登录换 Cookie（路径是 /api/auth/login，不是 /api/admin/auth/login）
curl -X POST http://127.0.0.1:8789/api/auth/login \
  -H 'content-type: application/json' \
  -d "{\"username\":\"admin\",\"password\":\"$PW\"}" \
  -c /tmp/of-cookie.txt

# 3) 新建用户（按外部身份幂等）
curl -X POST http://127.0.0.1:8789/api/admin/users \
  -b /tmp/of-cookie.txt \
  -H 'Content-Type: application/json' \
  -d '{"email":"demo@example.com","external_system":"my-app","external_user_id":"u-1001"}'

# 4) 给用户建 Key（最小入参 user_id + name）
curl -X POST http://127.0.0.1:8789/api/admin/keys \
  -b /tmp/of-cookie.txt \
  -H 'Content-Type: application/json' \
  -d '{"user_id":"<上一步返回的 id>","name":"demo-key"}'

# 5) 新建模型 + 路由（图像类：必须同时给 request_operation / upstream_operation / adapter）
curl -X POST http://127.0.0.1:8789/api/admin/models -b /tmp/of-cookie.txt \
  -H 'Content-Type: application/json' \
  -d '{"id":"seedream-image-v5.0-flash","display_name":"Seedream Image 5.0 Flash","vendor":"tencent",
       "pricing_profile":{"image_billing_mode":"per_image","image":{"default":0.15,"uncertain_result_policy":"requested"}},
       "input_modalities":["text","image"],"output_modalities":["image"]}'

curl -X POST http://127.0.0.1:8789/api/admin/routes -b /tmp/of-cookie.txt \
  -H 'Content-Type: application/json' \
  -d '{"model_id":"seedream-image-v5.0-flash","provider_id":"<provider-id>",
       "provider_model_name":"seedream-image-v5.0-flash","route_group":"default",
       "upstream_protocol":"openai","request_protocol":"openai",
       "request_operation":"images.generations","upstream_operation":"images.generations",
       "adapter":"passthrough","status":"active","priority":0,"weight":1,
       "price_override":{"charged_factor":1,"metered_factor":1}}'
```

创建模型时 `pricing_profile` 必填，且模态与计费模式必须自洽（图像模型 `output_modalities` 含 `image` + `image_billing_mode: per_image`；向量模型 `output_modalities: ["embedding"]` + `tiers` 里给 `input_price`）。向量模型没有 `context_window` / `max_tokens`，传了会被忽略。

---

## 八、上游模型清单与参数（TokenHub 实测，2026-11-05）

本地上游只有一个供应商：`腾讯`，`base = https://tokenhub.tencentmaas.com/v1`。以下结论来自对该 base 的实测（`GET /v1/models` + 逐类端点探测），不是文档摘抄。

### 8.1 账号可用性总览

`GET /v1/models` 返回 **125 个模型**，字段只有 `{id, object, name, created, status}`，`status` 取值 `online` / `pre-offline` / `discontinued`。**这个接口不区分类别**，LLM、图像、视频、语音、3D、音乐混在一张表里，只能按 ID 前缀猜。

实测可用性是三分：

| 类型 | 上游端点 | 本账号状态 | 网关能否路由 |
|---|---|---|---|
| 语言模型（chat） | `POST /v1/chat/completions` | ✅ 正常 | ✅ `openai / chat` |
| 向量（embedding） | `POST /v1/embeddings` | ✅ 正常，已跑通 | ✅ `openai / embeddings` |
| 图像生成 | OpenAI 兼容 `POST /v1/images/generations`；原生 `POST /v1/wand/<family>/generation` | ⚠️ 结构通，**402 未开通后付费** | ⚠️ 只能走 OpenAI 兼容路径 |
| 视频生成 | `POST /v1/wand/hunyuan-video/generation` + 轮询 `GET .../tasks/{id}` | ⚠️ 402 未开通 | ❌ 网关无 video operation |
| 语音合成 / 识别 | `POST /v1/tenlai/ttsproxy/text_to_voice`、`POST /v1/wand/asrproxy/sync_transcribe` | ⚠️ 402 未开通 | ❌ 上游无 `/v1/audio/*` |
| 3D 生成 | `POST /v1/wand/hunyuan-3d/*` 系列 | — | ❌ 同视频 |

402 的完整报文（所有视觉/语音模型一致）：

```json
{"error":{"type":"permission_error","code":"401007",
  "message_zh":"服务无可用免费体验额度，且未开启后付费，无法正常访问。请前往控制台 > 在线推理服务开启后付费"}}
```

**要让图像/视频/语音跑起来，必须先在 TokenHub 控制台「在线推理服务」为对应模型开启后付费。** 这不是网关配置问题。

### 8.2 语言模型（已按官方规格对齐，可路由）

上下文与最大输出取自官方文档（Hy / DeepSeek / GLM 各自 API Guide），不是估值：

| 模型 ID | 上下文 | 最大输出 | 输入 ¥/1M | 输出 ¥/1M | 缓存命中 | 备注 |
|---|---|---|---|---|---|---|
| `deepseek/deepseek-flash` | 1M | 384k | 2（高峰）/ 1（空闲） | 8 / 4 | 0.04 / 0.02 | 峰谷计费，见 8.2.1 |
| `deepseek/deepseek-v4-flash-vision-exp` | 1M | 384k | 2 / 1 | 8 / 4 | 0.04 / 0.02 | 多模态，同样峰谷 |
| `hy4` | 1M（输入上限 960k） | 64k | 6 | 18 | 0.3 | 2026-12-31 前按 5 折结算 |
| `glm-5.3` | 1M | 128k | 8 | 28 | 2 | 默认 `reasoning_effort=max`，思考不可关 |
| `hy-vision-2.0-instruct` | 44k | 16k | 7.5 | 17.5 | — | 看图 |
| `hunyuan-turbos-vision-video-20250728` | 24k | 8k | 3 | 9 | — | **视频理解**：输入视频→输出文字，`output_modalities` 只有 `text`；不是生视频（上下文待控制台二次确认） |

`deepseek-v4-pro` 有两套价：原厂直供档（`deepseek/deepseek-v4-pro-0813` 等）是 4.5/13.5 空闲、9/27 高峰；不带 `deepseek/` 前缀的 `deepseek-v4-pro` 是 12/24 一口价、没有峰谷。**本期两个都没接**（用户决定不接旗舰档），列在这里备查。

**思考参数的写法因厂商而异，这是 3 套不同语法：**

| 模型族 | 开启方式 | 深度 |
|---|---|---|
| DeepSeek | `"thinking": {"type": "enabled"}` | `thinking.reasoning_effort`：`high` / `max`（`low`/`medium` 会映射成 `high`） |
| GLM | `"thinking": {"type": "enabled"}` | 顶层 `reasoning_effort`：`max`/`high`/`low`；**5.3 系列不许传 `disabled`，会报错** |
| Hy | 无开关，默认开 | 顶层 `reasoning_effort`：hy4 只认 `none`/`high` |

顶层 `reasoning_effort` 对 DeepSeek **不生效也不报错**（实测传 `low` 返回 200 但被忽略）。调试台表单必须按模型族决定是给「开关」还是给「档位」。

### 8.2.1 峰谷计费怎么落到网关上

TokenHub 的规则：**北京时间工作日 9:00–12:00、14:00–18:00 为高峰，其余时段与周末全天为空闲**；判定按服务端收到请求的时刻。

网关有对应的机制：`models.pricing_profile.schedule` 是窗口数组，元素为 `{start, end, factor, days?}`，时区取 `system_config.BUSINESS_TIMEZONE`（本机已是 `Asia/Shanghai`），命中窗口则把该 `factor` 乘到该档**全部**单价（input/output/cache/image/audio）上，未命中按 1。半开区间 `[start, end)`，`days` 用 ISO 星期（1=周一）。

本机的配法：**基准价填高峰价（2/8），空闲时段给 `factor: 0.5`**，四个窗口：

```json
"schedule": [
  {"start":"00:00","end":"09:00","factor":0.5,"days":[1,2,3,4,5]},
  {"start":"12:00","end":"14:00","factor":0.5,"days":[1,2,3,4,5]},
  {"start":"18:00","end":"24:00","factor":0.5,"days":[1,2,3,4,5]},
  {"start":"00:00","end":"24:00","factor":0.5,"days":[6,7]}
]
```

实测验证（19:39，周四）：`pricing_audit.snapshot.standard.schedule` 记录

```json
{"timezone":"Asia/Shanghai","local_time":"19:39","local_weekday":4,"factor":0.5,
 "window":{"start":"18:00","end":"24:00","factor":0.5,...}}
```

同一请求 `standard_cost` = (7×2 + 31×8)/1M × 0.5 = **0.000131**，正好半价，说明分时确实进了计费。

**Hy4 的限时 5 折不是峰谷，是日期区间**，`pricing_profile.schedule` 表达不了（它没有有效期字段）。改用路由侧供应商倍率：`price_override.provider_factor=0.5` + `provider_factor_starts_at` / `provider_factor_expires_at`（UTC，北京 2026-12-31 24:00 = `2026-12-31T15:59:59Z`）。catalog 里能看到它生效：

```json
"provider_factor": {"base":0.5,"effective":0.5,"active":true,
 "starts_at":"2026-11-05T00:00:00.000Z","expires_at":"2026-12-31T15:59:59.000Z"}
```

到期后自动回到 1，不用改配置。

**注意 `GET /v1/models` 的 `input_price` / `output_price` 是兼容展示字段**：它取各档里**最低**输入价所在档，且**不含**官方时段倍率。门户要显示"当前时段多少钱"，必须自己读 `pricing_profile.schedule` + `BUSINESS_TIMEZONE` 算，不能直接用这两个字段。

请求参数（OpenAI 兼容）：

| 参数 | 说明 |
|---|---|
| `model` / `messages` / `stream` | 标准 |
| `max_tokens` | **推理模型必须给够**，见 8.7 坑 1 |
| `temperature` / `top_p` | 标准（DeepSeek 可 0–2，默认 1） |
| `tools` / `response_format` | 支持 function calling 与结构化输出 |

响应里除了 `choices[].message.content` 还有 **`choices[].message.reasoning_content`**（思考过程），`usage.completion_tokens_details.reasoning_tokens` 单独计量。

### 8.3 图像生成（两套端点，形态完全不同）

**这是最容易踩坑的一类。** TokenHub 的图像模型有三套原生端点，参数互不兼容：

| 模型族 | 原生端点 | 同步/异步 | 关键参数 |
|---|---|---|---|
| Seedream | `POST /v1/wand/si-image/generation` | 同步 | `prompt`≤600字、`images[]`≤10张、`size` = `1K`/`1.5K`/`2K` **或** `宽x高`、`layer_decomposition` |
| Kling | `POST /v1/wand/kling-image/generation` | **异步**（返回 `task_id`，再轮询） | `prompt`≤2500字、`negative_prompt`、`image`（单图）、`aspect_ratio` 8 种、`resolution` = `1k`/`2k`、`n` 1-9、`watermark_info` |
| Hunyuan Image | `POST /v1/wand/hunyuan-image/v3-generation` | 同步 | `prompt`≤8192字、`images[]`≤3张、`size` 宽高各 512-2048 且面积 ≤1024×1024、`seed`、`footnote`、`revise` |

**网关只能走 `POST /v1/images/generations` 这一条**（`images.generations` + `passthrough`）。原生 wand 端点没有适配器，到不了。

已配置的两个图像模型：

| 目录 ID | 上游模型 | 计费 | 说明 |
|---|---|---|---|
| `seedream-image-v5.0-flash` | `seedream-image-v5.0-flash` | 按张 ¥0.15（估算，上游按 token 计 10 元/1M，约 26.7k token/张） | 快，1K/1.5K/2K |
| `kling-image-v3` | `kling-image-v3` | 按张 ¥0.2 | 20k token/张，1K/2K，**上游异步** |

`size` 的取值域是**模型私有**的：Seedream 认 `1K`/`2K`，Kling 认 `aspect_ratio`+`resolution`，Hunyuan 认 `1024x1024`。OpenAI 兼容层会不会把它们统一，必须等后付费开通后实测——**这是调试台做图像表单前必须确认的第一件事**。

### 8.4 视频生成（网关做不到）

原生就有，而且不止混元：

```
POST /v1/wand/hunyuan-video/generation     → {"task_id": "...", "created": ..., "request_id": "..."}
GET  /v1/wand/hunyuan-video/tasks/{task_id} → {"status":"queued|running|succeeded|failed", "videos":[{"url":...}]}
```

`hy-video-v1.5`：5 秒、720p、文生/图生自动区分（带 `image` 即图生）、`aspect_ratio` 仅文生可指定。任务表里还有 `kling-video-v4/v3/v3-turbo/v3-omni/o1`、`vidu-video-q*`、`pixverse-video-*`、`minimax-video-*`、`yt-video-humanactor`，各家族路径不同。

**但 OctaFuse 的适配器 operation 是 19 项封闭枚举，里面没有任何 video 项**（`packages/core/src/adapters/registry.ts`），`ModelKind` 也只有 `llm/image/asr/tts/embedding`。所以视频无法通过网关调用，只能直连 TokenHub——而学生手里只有网关 Key。

### 8.5 语音（上游是私有路径）

| 能力 | 端点 | 实测 |
|---|---|---|
| 同步 TTS | `POST /v1/tenlai/ttsproxy/text_to_voice` | 端点存在，402 未开通 |
| 同步 ASR | `POST /v1/wand/asrproxy/sync_transcribe` | 端点存在，报「服务 ID 不存在」= 缺 model 参数 |
| OpenAI 兼容 TTS | `POST /v1/audio/speech` | **404 page not found** |
| OpenAI 兼容 ASR | `POST /v1/audio/transcriptions` | **404 page not found** |

网关的 `audio.speech` / `audio.transcriptions` 只会打 OpenAI 那两条路径，所以**上游没有对应端点 = 网关的音频能力对本上游完全不可用**。

### 8.6 向量（可路由，已验证）

`POST /v1/embeddings` 是标准 OpenAI 形状，`input` 支持字符串与数组（实测一次 2 条正常）。

| 模型 ID | 维度 | 备注 |
|---|---|---|
| `kinfra-text-embedding-4b` | 2560 | 快（0.5s） |
| `kinfra-text-embedding-0.6b` | 1024 | 慢（8s），维度小 |
| `kinfra-vl-embedding-2b` | — | **不支持 `/embeddings`**，返回 400005 |

响应 `usage.prompt_tokens` 正常返回，网关按 `input_price` 计费。

### 8.7 实测踩坑

1. **推理模型 `max_tokens` 给小了，`content` 会是空字符串。** 实测 hy4 / kimi-k3 在 `max_tokens=32` 时，32 个 token 全花在 `reasoning_content` 上，`content` 返回 `''`。调试台的默认值至少给 512，并在结果区把 `reasoning_content` 折叠展示。
2. **上游 402 会被网关当成 auth 失败，把整个供应商熔断 5 分钟。** `provider-circuit-breaker.ts` 里 `AUTH_COOLDOWN_MS = 300_000`，401/402/403 一律按 auth 处理。实测调用未开通的图像模型一次后，**同一供应商下所有模型（含正常可用的 LLM）立刻返回 429 `circuit.upstream_capacity_exhausted`，持续 300 秒**。这对学生门户是硬风险：一个学生点了未开通的模型，全班 5 分钟不能用。
3. **`hy-image-v3` 已 `discontinued`**，`seedream-image-v5.0-lite` 是 `pre-offline`。选模型必须过滤 `status !== 'online'`。
4. **`/v1/models` 不区分类别**，`/catalog/models` 才带 `inbound` 和 `modalities`——门户判断能力必须用后者。
5. `GET /v1/models` 默认只返回 `kind=llm`，图像/向量要显式带 `?kind=image` / `?kind=embedding`。
6. **视频输入的 content 形状与拉取限制**（`hunyuan-turbos-vision-video-20250728` 实测）：消息里用 `{"type":"video_url","video_url":{"url":"https://..."}}` 加一个 `{"type":"text",...}`，能正常返回视频描述。但**上游要能自己拉到这个 URL**：`w3schools.com` 的 mp4 返回 502 `20010 fetch fail`，`media.w3.org` 的同样请求 200 并准确描述了画面。学生上传本地文件走不通，必须给公网 URL。
