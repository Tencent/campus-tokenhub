# 模型目录与腾讯云 TokenHub 对齐手册

> 最近一次对齐：2026-11-09（控制台 `DescribeModelList` 实测 + 产品页价格折算）
> 适用对象：`campus-tokenhub` 本地 OctaFuse 网关（Proxy `:8790` / Admin `:8789`）里的 `models` + `model_routes`

这份文档解决一件事：**腾讯云调价或上/下线模型后，怎么把网关里的目录重新对齐，以及对齐时哪些字段能信、哪些是坑。**

---

## 一、数据从哪来（唯一权威源）

模型广场页面 `https://console.cloud.tencent.com/tokenhub/models` 本身不展示全部字段，真正权威的是它背后的接口：

```
POST https://console.cloud.tencent.com/cgi/capi?cmd=DescribeModelList&action=delegate
     &serviceType=tokenhub&secure=1&version=3&json=1&dictId=3216&sts=1
     &uin=<你的 uin>&ownerUin=<owner uin>&csrfCode=<页面里的 csrfCode>

body: {"regionId":1,"serviceType":"tokenhub","cmd":"DescribeModelList",
       "data":{"Version":"2026-03-22","Offset":0,"Limit":100,"Source":"Model","Language":"zh-CN"}}
```

- `Limit` **必须 < 100**，超过直接返回 `InvalidParameter: Limit must be less than 100`
- 当前 `TotalCount = 126`，即需要 `Offset=0` 和 `Offset=100` 两次
- 该接口要登录态（Cookie），**只能在你已登录的浏览器里发**，不能拿 API Key 调

### 在浏览器控制台里一把梭（推荐）

打开模型广场页面 → DevTools Console → 粘贴执行：

```js
const url = 'https://console.cloud.tencent.com/cgi/capi?cmd=DescribeModelList&action=delegate&serviceType=tokenhub&secure=1&version=3&json=1&dictId=3216&sts=1'
  + '&uin=' + (document.cookie.match(/(?:^|;\s*)uin=o?(\d+)/)?.[1] ?? '')
  + '&ownerUin=' + (document.cookie.match(/ownerUin=O?([0-9A-Za-z]+)/)?.[1] ?? '')
  + '&csrfCode=' + (window.__csrfCode || '');   // csrfCode 可从 Network 里任意 capi 请求的 URL 复制

const get = async (offset) => {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-requested-with': 'XMLHttpRequest' },
    credentials: 'include',
    body: JSON.stringify({
      regionId: 1, serviceType: 'tokenhub', cmd: 'DescribeModelList',
      data: { Version: '2026-03-22', Offset: offset, Limit: 100, Source: 'Model', Language: 'zh-CN' },
    }),
  });
  const j = await r.json();
  return j.data.data.Response.ModelSet;
};

const all = [...(await get(0)), ...(await get(100))];
console.table(all.map((m) => ({
  id: m.ModelId,
  name: m.DisplayName,
  type: m.ModelType,          // Text / Vision / Multimodal / Embedding / Speech
  brand: m.Brand,
  status: m.Status,           // online / pre-offline / discontinued
  ctx: m.ModelSpec?.ContextLength,
  maxIn: m.ModelSpec?.MaxInputToken,
  maxOut: m.ModelSpec?.MaxOutputToken,
  charge: (m.ModelChargingInfo || []).map((c) => `${c.Type}|${c.Name || ''}|` +
    (c.ChargingItems || []).map((i) => `${i.PriceName}=${i.Price}${i.PriceUnit}`).join(',')).join(' ; '),
})));
copy(JSON.stringify(all));
```

> `csrfCode` 直接从 Network 面板里任意一条 `capi` 请求的 URL 复制即可（形如 `csrfCode=793510004`）。

---

## 二、字段口径（对齐时最容易错的地方）

| 控制台字段 | 含义 | 网关落点 |
| --- | --- | --- |
| `ModelSpec.ContextLength` | 上下文窗口（`1024K` / `1M` / `44k` 这种字符串） | `models.context_window`（换成数字：1024K→1024000，1M→1000000） |
| `ModelSpec.MaxInputToken` | 最大输入 | **网关没有这个字段**，只能人工核对，记在本表里 |
| `ModelSpec.MaxOutputToken` | 最大输出 | `models.max_tokens` |
| `ModelChargingInfo[].ChargingItems` | 单价，单位 `元/百万tokens` | `models.pricing_profile.tiers` |
| `ModelChargingInfo[].Type` | `Uniform` 单档 / `Tiered` 阶梯 | `Tiered` 必须落成多档 `tiers` |
| `ModelType=Vision` 且价格是 `Token 10` | **不是真实单价** | 见下文“图像/视频/3D 的坑” |
| `Status` | `online` / `pre-offline` / `discontinued` | 非 `online` 不建路由 |

### 1. “闲时价”= DeepSeek 原厂直供的峰谷价

`DescribeModelList` 里 DeepSeek 系列只返回**一组**价格，那是**空闲时段价**。产品页把两档都写出来了：

| 模型 | 空闲时段（输入/输出/缓存） | 高峰时段 |
| --- | --- | --- |
| `deepseek/deepseek-flash`、`deepseek/deepseek-v4-flash-vision-exp`、`deepseek-v4.1-flash` | 1 / 4 / 0.02 | 2 / 8 / 0.04（= 空闲 ×2） |

高峰时段：**北京时间工作日 09:00–12:00、14:00–18:00**，其余时间和周末全天为空闲。

网关里的落法（**基准价填高峰价，闲时给 0.5 倍**）：

```json
"pricing_profile": {
  "tiers": [{ "upto": null, "input_price": 2, "output_price": 8, "cache_read_price": 0.04 }],
  "schedule": [
    {"start":"00:00","end":"09:00","factor":0.5,"days":[1,2,3,4,5]},
    {"start":"12:00","end":"14:00","factor":0.5,"days":[1,2,3,4,5]},
    {"start":"18:00","end":"24:00","factor":0.5,"days":[1,2,3,4,5]},
    {"start":"00:00","end":"24:00","factor":0.5,"days":[6,7]}
  ]
}
```

创建/修改这类路由时，`model_routes.price_override.schedule` 必须给**窗口相同、factor=1** 的 `charged` / `metered`，否则网关报
`Route time windows must match the model catalog schedule exactly`。

> **不要给 Hy4 加时段。** Hy4 是 `6 / 18 / 0.3` 一口价，页面上那个“5 折”是**限时活动**（至 2026-12-31），不是峰谷，用路由侧 `provider_factor=0.5` 表达。

### 2. 图像/视频/3D/语音的 `Token 10 元/百万tokens` 不是真单价

`DescribeModelList` 对多模态生成类模型统一返回 `Token 10 元/百万tokens`，只是占位。真实价格要按产品页的“规格 → token 用量 → 折合参考价”换算，例如：

| 模型 | 规格 | token 用量 | 折合 |
| --- | --- | --- | --- |
| Hy-Image-3.5-preview | 1K / 2K | 15,000 tokens/张 | 0.15 元/张 |
| Hy-Image-3.5-preview | 4K | 20,000 tokens/张 | 0.20 元/张 |
| Kling-Video-v4 | 720P 无参考 | 100,000 tokens/秒 | 1 元/秒 |
| Hy-ASR-3.0-Preview | — | 22 tokens/秒 | 0.00022 元/秒 |

所以图像模型在网关里用 `image_billing_mode: "per_image"` + `image.default`（元/张），**不能**照抄 `10`。

### 3. 阶梯价要落成多档 `tiers`

`MiniMax-M3` 是典型：

| 档位 | 输入 | 输出 | 缓存 |
| --- | --- | --- | --- |
| 输入 ≤ 512k | 2.1 | 8.4 | 0.42 |
| 输入 > 512k | 4.2 | 16.8 | 0.84 |

```json
"tiers": [
  { "upto": 524288, "label": "输入≤512k", "input_price": 2.1, "output_price": 8.4, "cache_read_price": 0.42 },
  { "upto": null,   "label": "输入>512k", "input_price": 4.2, "output_price": 16.8, "cache_read_price": 0.84 }
]
```

末档 `upto` 必须是 `null`，非末档必须是有限数字。

### 4. 缓存写入价只有单字段

`Kimi K3.1 Pro` 控制台给 `WriteCache5Min=13`、`WriteCache1Hour=26`，网关 `tiers` 只有 `cache_write_price` 一个字段，取 **5 分钟档 13**，长缓存价差记在这里备查。

---

## 三、当前目录快照（2026-11-09 对齐后）

`GET http://127.0.0.1:8790/catalog/models` 返回 **20 个可用模型**（另有 `hy3` 模型已建但路由停用）。
价格单位：元/百万 tokens；`—` 表示控制台没有该项。

| 模型 ID | 品牌 | 上下文 | 最大输入 | 最大输出 | 标准/空闲（输入·输出·缓存） | 高峰 | 网关落点 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `hy4` | 混元 | 1024k | 960k | 64k | 6 · 18 · 0.3 | — | 目录价 + 路由 `provider_factor=0.5`（活动至 2026-12-31） |
| `hy3` | 混元 | 256k | 192k | 128k | 1 · 4 · 0.25 | — | 同左，**路由 disabled**（上游 401008） |
| `hy-vision-2.0-instruct` | 混元 | 44k | 24k | 16k | 7.5 · 17.5 · — | — | 一致 |
| `hunyuan-turbos-vision-video-20250728` | 混元 | 32k | 24k | 8k | 3 · 9 · — | — | 一致（上下文已由 24k 修为 32k） |
| `deepseek/deepseek-flash` | DeepSeek | 1024k | 1024k | 384k | 1 · 4 · 0.02 | 2 · 8 · 0.04 | 基价 2/8/0.04 + 闲时 0.5 |
| `deepseek/deepseek-v4-flash-vision-exp` | DeepSeek | 1024k | 1024k | 384k | 1 · 4 · 0.02 | 2 · 8 · 0.04 | 同上 |
| `deepseek-v4.1-flash` | DeepSeek | 1024k | 1024k | 348k | 1 · 4 · 0.02 | 2 · 8 · 0.04 | 同上 |
| `glm-5.2` | 智谱 | 1M | 1024k | 128k | 8 · 28 · 2 | — | 一致 |
| `glm-5.3` | 智谱 | 1024k | 1024k | 128k | 8 · 28 · 2 | — | 一致 |
| `glm-5.3-flash` | 智谱 | 1024k | 1024k | 128k | 0.8 · 2.8 · 0.23 | — | 一致 |
| `glm-5.3-flashx` | 智谱 | 1024k | 1024k | 128k | 2 · 7 · 0.57 | — | 一致 |
| `kimi-k3` | 月之暗面 | 1M | 1M | 1M | 20 · 100 · 2 | — | 一致 |
| `kimi-k3.1-pro` | 月之暗面 | 1024k | 1024k | 1024k | 13 · 68 · 1.3（写缓存 13 / 26） | — | 已补 `cache_write_price=13` |
| `kimi-k2.7-code` | 月之暗面 | 256k | 256k | 256k | 6.5 · 27 · 1.3 | — | 一致 |
| `minimax-m3` | MiniMax | 1M | 1M | 1M | ≤512k：2.1 · 8.4 · 0.42；>512k：4.2 · 16.8 · 0.84 | — | 已改为两档阶梯 |
| `minimax-m3.1-flash` | MiniMax | 1024k | 1024k | 512k | 1 · 4 · 0.1 | — | 一致 |
| `mimo-v2.6-pro` | 小米 | 1024k | — | 128k | 3 · 6 · 0.025 | — | 一致 |
| `mimo-v2.6-flash` | 小米 | 1024k | — | 128k | 1 · 2 · 0.02 | — | 一致 |
| `kinfra-text-embedding-4b` | kinfra | 32k | 32k | — | 文本输入 0.6 | — | 已改为 0.6（原占位 0.1），上下文 32k |
| `seedream-image-v5.0-flash` | Seedream | — | — | — | 10 元/百万 token ≈ 15,000 token/张 → **0.15 元/张** | — | `per_image` 0.15；路由挂**专用 provider**，capability 模板指向 `/v1/wand/si-image/generation`（见第六节；仅文生图，图生图暂不支持） |
| `kling-image-v3` | 可灵 | — | — | — | 10 元/百万 token，约 20,000 token/张 → **0.2 元/张**（折算待确认） | — | `per_image` 0.2；**暂不支持**：上游是异步任务，路由 `status=disabled`，模型不在目录（见第六节） |

### 本次修正的 6 处

| # | 对象 | 原值 | 现值 | 原因 |
| --- | --- | --- | --- | --- |
| 1 | `hy4` 定价 | 6/18/0.3 + 4 段闲时窗口 | 6/18/0.3（无时段） | Hy4 无峰谷，5 折是限时活动，不该用 schedule 表达 |
| 2 | `hy4` 路由 | 带 `schedule`（factor 1） | 仅 `provider_factor=0.5` | 同上，避免重复口径 |
| 3 | `minimax-m3` | 单档 2.1/8.4 | 两档（≤512k / >512k） | 控制台 `Type=Tiered` |
| 4 | `hunyuan-turbos-vision-video` | 上下文 24k | 32k | 控制台 `ContextLength=32k` |
| 5 | `kinfra-text-embedding-4b` | 输入价 0.1（占位）、无上下文 | 0.6、上下文 32k | 控制台 `TextInput=0.6` |
| 6 | `kimi-k3.1-pro` | 无缓存写入价 | `cache_write_price=13` | 控制台 `WriteCache5Min=13` |

---

## 四、复核对齐的操作流程

腾讯每次调价/上架后，按这四步走，全程 10 分钟内：

### Step 1. 拉控制台快照

用第一节的 Console 脚本，`copy(JSON.stringify(all))` 拿到 126 条原始数据，存成 `tokenhub-YYYY-MM-DD.json`。

### Step 2. 拉网关现状

```bash
curl -s http://127.0.0.1:8790/catalog/models \
  | python3 -c "import json,sys;[print(m['id'], m['context_window'], m['max_tokens'], json.dumps(m.get('pricing_profile'), ensure_ascii=False)) for m in json.load(sys.stdin)['data']]"
```

### Step 3. 逐条比对，只改有差异的字段

- 上下文/最大输出：`PATCH /api/admin/models/:id` 传 `context_window` / `max_tokens`
- 价格：`PATCH /api/admin/models/:id` 传完整 `pricing_profile`（会整体覆盖，务必带全 `tiers`）
- 活动折扣：`PATCH /api/admin/routes/:route_id` 传 `price_override`

```bash
# 改价格（幂等覆盖）
curl -X PATCH http://127.0.0.1:8789/api/admin/models/hy4 \
  -H "Authorization: Bearer sk-dev-admin-key" -H 'Content-Type: application/json' \
  -d '{"pricing_profile":{"tiers":[{"upto":null,"label":null,"input_price":6,"output_price":18,"cache_read_price":0.3}]}}'

# 改活动倍数（provider_factor）
curl -X PATCH http://127.0.0.1:8789/api/admin/routes/<route_id> \
  -H "Authorization: Bearer sk-dev-admin-key" -H 'Content-Type: application/json' \
  -d '{"price_override":{"charged_factor":1,"metered_factor":1,"provider_factor":0.5,
        "provider_factor_starts_at":"2026-11-05T00:00:00.000Z","provider_factor_expires_at":"2026-12-31T15:59:59.000Z"}}'
```

> 未知路由 ID 先查：`curl "http://127.0.0.1:8789/api/admin/routes?model_id=hy4" -H "Authorization: Bearer sk-dev-admin-key"`

### Step 4. 等缓存 + 验证

- 网关目录缓存 **45 秒**，门户进程内缓存 **60 秒**
- 验证：`curl -s http://127.0.0.1:8790/catalog/models | python3 -c "import json,sys;print(len(json.load(sys.stdin)['data']))"`
- 页面：`http://localhost:3000/models` 应显示 `共 N 个可用模型`，点进详情看「当前价格 / 时段 / 限时折扣」

---

## 五、已知限制与待办

1. **视频 / 语音 / 3D / 音乐不进目录**：OctaFuse 的适配器 operation 是封闭枚举，没有 video / audio-speech 对应项（上游也没有 `/v1/audio/*`），网关路由不到。控制台里这些模型（`hy-video-v1.5`、`kling-video-*`、`hy-3d-*`、`minimax-speech-*` 等）**不要导入**。
2. **图像模型需要控制台开“在线推理-后付费”**：未开通会返回 402（`401007`/`401008`），而网关把 401/402/403 一律当鉴权失败，**整个供应商熔断 5 分钟**，连 LLM 一起 429。要么开通后付费，要么在 Octafuse 网关侧下线该模型；门户不再提供模型过滤白名单。
3. **`hy3` 目前不可用**：控制台显示 `online`，但调用返回 `401008 免费体验额度已耗尽且未开启后付费`。模型和路由已建好，路由 `status=disabled`；开通后把路由改回 `active` 即可恢复。
4. **最大输入 token 不落库**：网关模型只有 `context_window` 和 `max_tokens`，`MaxInputToken`（如 Hy4 的 960k）只在本表里记录，改价时别把它和上下文搞混。
5. **`kling-image-v3` 的按张换算未在控制台确认**：目前按其 10 元/百万 token × 20,000 token/张 = 0.2 元/张，若控制台给出别的 token 用量要回改。
6. **目录的唯一版本化副本在门户仓库**：`src/lib/onboarding/presets/tokenhub-<日期>.json`（由
   `scripts/export-tokenhub-preset.mjs` 从已对齐的网关导出，不含密钥）。本机库只服务当前实例；
   重建环境时先初始化向导导入 preset，或手工执行 `POST /api/setup/apply`。对齐完价格后记得导出新 preset 并
   更新 `src/lib/onboarding/preset.ts` 的 import。
7. **门户文案口径**：`src/lib/pricing/schedule.ts` 的 `scheduleHint` 只识别“折扣窗口”，高峰时段落在窗口外，卡片会显示「当前其他时段；高峰为工作日 9:00–12:00、14:00–18:00」。价格本身是对的（高峰按基准价），只是文案把高峰叫成“其他时段”，后续可改成「当前高峰 / 当前闲时」。

---

## 六、TokenHub 生图不走 OpenAI 兼容路径（2026-11-09 踩坑）

`GET /v1/models` 里能查到 `seedream-image-v5.0-flash`（`status=online`），但拿它调
`POST https://tokenhub.tencentmaas.com/v1/images/generations` 会直接返回：

```
400 {"error":{"code":"400004","type":"gateway_error",
  "message_zh":"请求中的模型或服务 ID seedream-image-v5.0-flash 不存在…服务 ID 可在控制台的在线推理服务列表中查看"}}
```

**原因**：TokenHub 的 `/v1/images/generations` 只服务**控制台「在线推理」里创建的专属服务 ID**（`svc-…` 这类），
不接受模型广场的模型名。图像模型各自有厂商原生端点，必须按模型走对应路径：

| 模型 | 上游接口 | 形态 |
| --- | --- | --- |
| `seedream-image-v5.0-pro` / `-flash` / `-lite` | `POST /v1/wand/si-image/generation` | 同步，返回 `data[].url` |
| `hy-image-v3.5-preview` 等混元生图 | 混元原生生图接口 | 同步 |
| `kling-image-v3` / `-o1` / `-v3-omni` | `POST /v1/wand/kling-image/generation` + `GET /v1/wand/kling-image/tasks/{task_id}` | **异步**，需轮询 |
| `vidu-image-q2` | 异步任务 + 轮询 | **异步** |

### 网关侧的落地方式（capability 模板）

`providers.endpoints` 支持按 capability 写**完整 URL 模板**（capability 优先于 `base` 派生），字段形如：

```json
{"openai":{"base":"https://tokenhub.tencentmaas.com/v1",
  "endpoints":{"images.generations":"https://tokenhub.tencentmaas.com/v1/wand/si-image/generation"}}}
```

因为 `kling-image-v3` 与 Seedream 共用同一个 provider 行，直接改主 provider 会连带把可灵也指到 Seedream 端点，
所以**给 Seedream 单开一个 provider**（`Tencent TokenHub (Seedream)`，同 key、同 base + 上面的 capability 模板），
再把 `seedream-image-v5.0-flash` 的路由 `provider_id` 指过去：

```bash
# 1) 建专用 provider（endpoints 传对象，不要传字符串）
curl -X POST http://127.0.0.1:8789/api/admin/providers \
  -H "Authorization: Bearer sk-dev-admin-key" -H 'Content-Type: application/json' \
  -d '{"name":"Tencent TokenHub (Seedream)","kind":"__custom__","status":"active","api_key":"<同 TokenHub key>",
       "endpoints":{"openai":{"base":"https://tokenhub.tencentmaas.com/v1",
         "endpoints":{"images.generations":"https://tokenhub.tencentmaas.com/v1/wand/si-image/generation"}}}}'

# 2) 路由改绑（PATCH 只传 provider_id 即可，其余字段保持）
curl -X PATCH http://127.0.0.1:8789/api/admin/routes/0602159f-ea12-4b38-a6c2-99da90bda97c \
  -H "Authorization: Bearer sk-dev-admin-key" -H 'Content-Type: application/json' \
  -d '{"provider_id":"<新 provider id>"}'
```

验证（应返回 `data[].url`，日志里 `upstream generations POST …/v1/wand/si-image/generation status=200`，
按张计费 `charged=0.15`）：

```bash
curl -X POST http://127.0.0.1:8790/v1/images/generations \
  -H "Authorization: Bearer <门户/网关 sk->" -H 'Content-Type: application/json' \
  -d '{"model":"seedream-image-v5.0-flash","prompt":"一只在图书馆看书的橘猫","n":1}'
```

### 6.1 可灵 / 图生图：暂不支持（2026-11-09 已回退）

**当前状态**

| 能力 | 现状 | 表现 |
| --- | --- | --- |
| `kling-image-v3` 文生图 | **不支持**：路由 `status=disabled`，模型已从目录移除 | `404 {"error":"No available route"}` |
| `/v1/images/edits`（Seedream 参考生图） | **不支持**：路由与 surface 已删除 | `404 {"error":"No available route"}` |

**为什么回退**：这两项都需要**改网关源码**（新增 `images.generations.tasks` 能力、`tokenhub-wand-image-edit`
转换适配器、`GET /v1/images/tasks/:taskId` 路由）。而网关源码在 `local-stack/octafuse-gateway`，
被 `.gitignore` 排除在门户仓库之外，改完无法随门户一起提交，所以只保留本地不可维护的改动没有意义，已整体回退。

**将来要接时的最小改动清单**（在能提交的网关仓库里做）

1. `packages/core/src/provider-endpoints.ts`
   - 新增 capability `images.generations.tasks`（类型 + `OPENAI_ENDPOINT_CAPABILITIES`），模板必须含 `{task_id}`
   - 写 `validateAndNormalizeProviderEndpoints` 的占位符校验、`resolveUpstreamEndpoint` 的 taskId 必填校验
2. `packages/core/src/adapters/registry.ts`
   - 新增转换适配器 `tokenhub-wand-image-edit`：`images.edits`(multipart) → 上游 `images.generations`
3. `packages/proxy/src/services/egress/tokenhub-wand-image-driver.ts`
   - multipart 转 JSON：`{model, prompt, images: ["data:image/png;base64,..."], size?}`
4. `packages/proxy/src/services/egress/dispatch-table.ts` + `proxy.ts`
   - 新增 `dispatchImageEdits`，按 `route.adapter` 分派
5. `packages/proxy/src/routes/v1/images.ts`
   - 新增 `GET /tasks/:taskId?model=`：填 `{task_id}` 模板转发；`task_status=succeed` 时按图张数扣费（同 task 去重）
   - 提交响应含 `data.task_id` 时按「异步受理」判定成功，不要报 `Upstream returned no image data`
6. admin：供应商端点新增「生图任务查询」字段（`images_generations_tasks`）+ 四语文案 + `adapterGuides` 文案

**保留的部分**：`seedream-image-v5.0-flash` 文生图仍走专用 provider `Tencent TokenHub (Seedream)`
（`images.generations` → `https://tokenhub.tencentmaas.com/v1/wand/si-image/generation`），不受本次回退影响。

### 6.2 仍未解决

- **`kling-image-v3` 按张价格**：仍按 10 元/百万 token × 20,000 token/张 = 0.2 元/张估算，未在控制台复核；
  重新启用路由前建议先确认单价口径。
- **onboarding preset 无法表达专用 provider / 额外路由**：`src/lib/onboarding/presets/*.json` 的 `provider` 是单对象，
  没有 provider 数组与 `route.providerId`，重建环境后需要手工补 Seedream provider（含 `images.generations` 模板）。
- **管理员在 UI 里保存 provider 会覆盖 capability 模板**：只填 Base URL 保存会丢模板，
  改价/改 key 时注意别把 `images.generations` 的完整 URL 清空。

---

## 七、2026-11-18 输入模态对齐（模型集市分类前置）

### 起因

模型集市加分类时发现：`deepseek-v4.1-flash`、`deepseek/deepseek-flash`、`hy4` 在网关里
`input_modalities` 都是 `["text"]`，与官方「能力支持 = 图片理解」不符。这不是分类代码写错，
而是数据没对齐。

### 数据来源

`https://cloud.tencent.com/document/product/1823/130051`（模型列表，2026-11-17 更新）的
「能力支持」列，能力名与控制台 `ModelType` 同源：

| 官方能力 | `input_modalities` |
| --- | --- |
| 图片理解 | `["text","image"]` |
| 图片和视频理解 / 图片、视频理解 | `["text","image","video"]` |
| 多模态理解 | 按控制台模态，常见 `["text","image","video"]` 或 `["text","image","audio","video"]` |
| 视频理解 | `["text","video"]` |
| 无视觉能力（深度思考/结构化输出/FC/缓存） | `["text"]` |
| 向量模型 / 图像生成 | 按输出模态，见 `output_modalities` |

### 本次改动

| 对象 | 原值 | 现值 |
| --- | --- | --- |
| `deepseek-v4.1-flash` | `["text"]` | `["text","image"]` |
| `deepseek/deepseek-flash` | `["text"]` | `["text","image"]` |
| `hy4` | `["text"]` | `["text","image"]` |

- 用 `PATCH /api/admin/models/:id` 写入（带斜杠的 id 必须 URL 编码：`deepseek%2Fdeepseek-flash`，
  否则 404）；`src/lib/onboarding/preset.ts` 里补登记的 `deepseek-v4.1-flash-1017` 同步改为 `["text","image"]`。
- 重新导出 preset 为 `src/lib/onboarding/presets/tokenhub-2026-11-18.json`（22 个模型，比上一版多
  `seedream-image-v5.0-pro`），`preset.ts` 的 import 已切过去。旧版 `tokenhub-2026-11-09.json` 保留备查。
- 其余模型的模态与官方能力列一致（`glm-5.3-flash*` 额外带 `file`，官方未写但无害，未动）。

### 连带影响（有意为之）

`PlaygroundClient` 用 `input_modalities` 判断能否上传图片/视频，模型详情页也会展示「输入模态」。
改完上面三个模型后，调试台对它们开放了传图入口，详情页不再显示成纯文本。

### 分类口径（`src/lib/gateway/catalog-category.ts`）

集市 tab 只按**输出模态**切三类：对话 / 向量 / 图像生成。
不给「文本 / 多模态」单独立 tab —— 官方能力列里 21 个模型只有 `glm-5.2`、`glm-5.3` 是纯文本，
单立 tab 反而多一个只有两个模型的空分类；「是否多模态」改用卡片上的能力标签
（`纯文本` / `图片理解` / `视频理解` / `语音理解`）表达。

**不要用 `input_modalities` 判「多模态」**：网关 `packages/core/src/db/model-kind.ts` 的注释已写明
「多模态 LLM 不能用 input 含 image/audio 判断」，而且历史数据里普遍只填了 `text`。

---

## 八、2026-11-19 生产网关对齐 + 重跑初始化自动补模态

### 现象

生产网关（`https://api.aiedu.tencent.com/tokenhub`）里 `deepseek-v4.1-flash`、`hy4` 的
`input_modalities` 仍是 `["text"]`，接入指南的「图片输入」只能显示「不勾选」。

### 根因

生产是 2026-11-11 用旧版清单（`tokenhub-2026-11-09.json`，当时这两个模型还是 `["text"]`）初始化的。
第七节修正的是**清单**与**本地网关**，而重跑初始化时 `plan.ts` 对已存在模型一律
`skip`（未勾「强制覆盖」），模态永远不会被补上——定价没变，能力标识却一直是老的。

### 改动

1. **生产数据**：`PATCH /tokenhub/admin/api/admin/models/:id`，只传 `input_modalities`：

   | 模型 | 原值 | 现值 |
   | --- | --- | --- |
   | `deepseek-v4.1-flash` | `["text"]` | `["text","image"]` |
   | `hy4` | `["text"]` | `["text","image"]` |

2. **重跑不再漏补**：`src/lib/onboarding/plan.ts` 增加模态比对，**即使没勾「强制覆盖」**，
   只要 `input_modalities` / `output_modalities` 与清单不一致就产出 `update`；
   `apply.ts` 在这种非强制场景只 PATCH 模态字段，不碰定价、上下文与折扣。
3. **静态目录修正**（`src/lib/onboarding/model-catalog.ts`，供「清单外」模型导入用）：
   - `hunyuan-turbos-vision-video-20250728`：`["text","image","video"]` → `["text","video"]`
     （官方写明是**视频理解**模型，CloudBase 能力表也标图片 ❌）
   - `glm-5.3-flash` / `glm-5.3-flashx` 补 `file`（官方支持文档类文件输入，与 preset 对齐）
   - `MODEL_CATALOG_VERSION` → `2026-11-17`，核对日期 → `2026-11-19`

### 口径核对结果（2026-11-19）

官方 `130051`「能力支持」列与生产 11 个模型逐条对比，除上面两个外均一致：

| 模型 | 官方能力 | `input_modalities` |
| --- | --- | --- |
| `hy4` / `deepseek-v4.1-flash` / `deepseek-v4.1-flash-1017` | 图片理解 | `text,image` |
| `glm-5.3-flash` | 多模态理解（图片、视频、文件） | `text,image,video,file` |
| `glm-5.3` | 深度思考 / 结构化输出 / FC / 缓存 | `text` |
| `hy-vision-2.0-instruct` | 图生文 | `text,image` |
| `kimi-k3.1-pro` / `minimax-m3` | 图片、视频理解 | `text,image,video` |
| `kling-image-v3` / `seedream-image-v5.0-flash` | 文生图、图生图 | `text,image`（输出 `image`） |
| `kinfra-text-embedding-4b` | 文本向量 | `text`（输出 `embedding`） |

以后新上线模型只在清单里补，然后**重跑一次初始化**即可；无需再手工 PATCH。

---

## 九、2026-11-27 接入指南「思考模式」（supportsReasoning）

### 起因

接入指南生成的 WorkBuddy `models.json` 里 `supportsReasoning` 一直是硬编码 `false`，
连 GLM-5.3、DeepSeek V4 这类官方标注「深度思考」的模型也被关掉，写进去后客户端看不到思考过程。

### 数据来源与判定

网关 `/v1/models` **不返回**思考能力（`packages/proxy/src/routes/v1/models.ts` 明确写「由客户端维护」），
因此按官方 `130051`「能力支持」列的「深度思考」标注，预置在
`src/lib/onboarding/model-catalog.ts` 的 `REASONING_MODEL_IDS`，由 `catalogSupportsReasoning(id)` 查询：

| 类别 | 结论 |
| --- | --- |
| Hy4 / Hy4 preview / Hy3 | 支持（官方写「保留式思考」） |
| DeepSeek V4 全系列（含原厂直供 `deepseek/*`、Vision-Exp、V4-Pro） | 支持 |
| GLM-5.2 / 5.3 / 5.3-Flash / 5.3-FlashX、GLM-5V-Turbo | 支持 |
| Kimi K2.6 / K2.7 / K2.8 / K3 / K3.1（含 HighSpeed） | 支持 |
| MiniMax M2.7 / M3 / M3.1-Flash | 支持 |
| MiMo V2.5-Pro / V2.6-Pro / V2.6-Flash | 支持 |
| Step 5 Preview | 支持 |
| HY-Vision-1.5-Thinking（`hunyuan-t1-vision-20250916`） | 支持 |
| HY-Vision-2.0-Instruct | 不支持（官方写「快思考模型」） |
| HY-Vision-Video（`hunyuan-turbos-vision-video-20250728`） | 不支持（只有视频理解） |
| Hy-MT2 翻译、Hy-Role 角色扮演、YT-VITA | 不支持 |
| 图像 / 视频 / 语音 / 3D / 音乐 / 向量 | 不适用（本来就不能接 WorkBuddy） |

不在表里的模型一律按不支持处理：勾了思考模式却拿不到 `reasoning_content` 比不勾更糟。

### 改动

1. `model-catalog.ts`：新增 `REASONING_MODEL_IDS` 与 `catalogSupportsReasoning()`，核对日期更新为 2026-11-27。
2. `lib/guide/chat-models.ts`：`loadChatModels()` 返回的 `GuideModel` 增加 `supportsReasoning`。
3. `lib/guide/workbuddy.ts`：`buildWorkBuddyEntry()` 按入参写 `supportsReasoning`（缺省 false）。
4. 指南页「手动接入」把「思考模式 / 自定义协议」拆成两行，思考模式按当前模型给勾选建议；
   「一键接入」与 `/api/portal/workbuddy/script` 同步使用该字段。
