# 成员自购站（campus-tokenhub-member）使用教程

> 面向：接手部署的运维、学校信息化老师、后续开发者
> 覆盖：部署 → 使用 → 运维 → 自定义需求开发
> 配套仓库：`campus-tokenhub-member`（本手册）；统一采买站见独立手册《campus-tokenhub-assign 使用教程》

---

## 目录

0. [十分钟看懂这套东西](#0-十分钟看懂这套东西)
1. [部署](#1-部署)
2. [使用](#2-使用)
3. [运维](#3-运维)
4. [自定义需求开发](#4-自定义需求开发)
5. [附录：配置 / 接口 / 数据表](#5-附录配置--接口--数据表)

---

## 0. 十分钟看懂这套东西

### 0.1 它是干什么的

老师用学校账号登录，自助申请**腾讯云集团成员账号**。管理员审核通过后，服务端调用腾讯云 `organization` 接口建号、分配到部门，把结果写回申请单。老师在自己的页面看到成员名、Uin 和状态。

一句话区分两个站：

| | 统一采买站（另一个仓库） | 成员自购站（本仓库） |
| --- | --- | --- |
| 解决什么 | 学生领 API Key、看模型、调试 | 老师申请腾讯云成员账号 |
| 依赖 OctaFuse 网关 | 是 | **否，零依赖** |
| 依赖腾讯云 organization | 否 | 是 |
| 会话 Cookie | `portal_session` | 同名同密钥，两站互认 |

**两站是独立部署单元**，不共享进程、不互相调用，只共享同一个 Postgres 里的 `portal_shared`（管理员名单、品牌、登录配置、密钥）。所以在任一站加一个管理员，另一站立刻生效。

### 0.2 三个容器

| 容器 | 职责 | 能不能少 |
| --- | --- | --- |
| `postgres` | 数据库。共享层 + 本侧业务表 | 不能 |
| `portal` | Next 应用，全部页面与接口 | 不能 |
| `portal-seed` | 一次性写入 SSO 参数，跑完退出 | 可选（首次有用） |

**没有网关、没有 nginx**。这是刻意的：成员站不参与算力发放，对外只需要一个反代（CLB / 学校现有 nginx / Caddy 都行）。

### 0.3 一次申请怎么走

```
老师浏览器
   │ 1. SSO 登录（门户会话 Cookie）
   ▼
申请表（email / 手机 / 部门路径 / 备注）
   │ 2. 提交 → status=pending
   ▼
管理员审核（/members/review）
   │ 3a. 驳回 → rejected（本人可改资料重提）
   │ 3b. 通过 → status=provisioning
   ▼
服务端调腾讯云
   ├─ 逐级查找/创建部门（缺失就建，Remark=portal:auto）
   ├─ CreateOrganizationMember（成员名=AccountName，全局唯一）
   └─ 写回 uin / resolvedNodeId / resolvedNodePath
   ▼
status=active（老师可看到成员信息）
```

### 0.4 数据落在哪

| schema | 归属 | 表 |
| --- | --- | --- |
| `portal_shared` | 两站共用 | `admins`、`app_config`、`login_config`、`settings`、`session_revocations`、`config_audit` |
| `portal_member` | **本仓库** | `member_applications` |

建表是应用启动时自动做的（`ensurePortalSchema`，事务 + advisory lock 兜并发），不需要手工执行 DDL。

### 0.5 三条必须先建立的认知

1. **成员账号 ≠ 算力账号**。腾讯云成员用于控制台、开票、独立配额，和统一采买站的 API Key、额度互不影响。
2. **建号是"云侧真实动作"**，会消耗组织的成员名额，删号不可逆。所以审核这一步必须是人来点。
3. **API 创建的成员默认不允许删除**。这不是 bug，是腾讯云的组织策略，见 2.5。

---

## 1. 部署

### 1.1 机器要求

| 项 | 最低 | 建议 |
| --- | --- | --- |
| CPU / 内存 | 2C 2G | 2C 4G（`next build` 阶段吃内存） |
| 磁盘 | 20 GB | 30 GB+ |
| 系统 | Linux x86_64 | Ubuntu 22.04 / Debian 12 |
| Docker | 24+ | 最新稳定版，需 Compose v2 |
| Node.js | 不需要 | 20 LTS（宿主机开发或装 CLI 时用） |
| 外网 | 必须能访问 `organization.tencentcloudapi.com` | 否则审核建号会超时 |

注意：成员站虽然是零网关，但**必须能出网访问腾讯云 API**。纯内网部署时要么配正向代理，要么把云调用改成走专线网关，否则"审核通过"这一步必然失败。

### 1.2 端口

| 端口 | 谁在听 | 绑定 | 用途 |
| --- | --- | --- | --- |
| 3200 | portal | `127.0.0.1` | 应用（`PORTAL_HOST_PORT` 可改） |
| 5433 | postgres | `127.0.0.1` | 宿主机 psql 排障 |

对外由前置反代接进来。生产环境不要把 3200 直接暴露到公网。

### 1.3 拿代码

```bash
git clone <仓库地址> campus-tokenhub-member && cd campus-tokenhub-member
# 或解压交付包
```

确认当前目录直接有 `package.json`，不要出现 `campus-tokenhub-member/campus-tokenhub-member/` 的嵌套（构建会被 Dockerfile 守卫拦下）。

### 1.4 写 `.env`

```bash
cp .env.example .env
```

生成密钥：

```bash
openssl rand -base64 48     # SESSION_SECRET
openssl rand -hex 24        # POSTGRES_PASSWORD
```

最小可跑配置：

```bash
# --- 数据库 ---
POSTGRES_PASSWORD=<openssl rand -hex 24>
PORTAL_DATABASE_URL=postgres://octafuse:<同上>@127.0.0.1:5433/octafuse

# --- 会话 ---
SESSION_SECRET=<openssl rand -base64 48>
SESSION_TTL_HOURS=8
COOKIE_SECURE=false                 # 上 TLS 后改 true

# --- 挂载前缀：二选一，见下方说明 ---
PORTAL_BASE_PATH=                   # 单站独立域名 / 根路径
# PORTAL_BASE_PATH=/tokenhub/member # 与统一采买站同域共存

# --- 对外地址 ---
PUBLIC_BASE_URL=https://members.school.edu.cn

# --- 腾讯云 CAM（只要有 organization 权限的子账号）---
TENCENTCLOUD_SECRET_ID=<AKID...>
TENCENTCLOUD_SECRET_KEY=<...>
TENCENTCLOUD_ORGANIZATION_REGION=ap-guangzhou
MEMBER_ACCOUNT_PROVIDER=tencent
MEMBER_ACCOUNT_PERMISSION_IDS=1,2

# --- 首次部署没有 SSO 时用（两站同时部署时与采买站填同一套） ---
PORTAL_ADMIN_USERNAME=ops-admin
PORTAL_ADMIN_PASSWORD=<≥12 字符随机串>
PORTAL_ADMIN_LOGIN=auto
```

`PORTAL_BASE_PATH` 是**构建期**参数，两条路只能选一条：

| 部署形态 | `PORTAL_BASE_PATH` | 访问地址 | 前置反代 |
| --- | --- | --- | --- |
| 独立域名 / 根路径 | 留空 | `https://members.school.edu.cn/` | 反代直接转 `:3200`，不剥前缀 |
| 与统一采买站同域 | `/tokenhub/member` | `https://ai.school.edu.cn/tokenhub/member` | 反代原样透传，不剥前缀 |

改完必须 `--build`。容器启动时会把运行期同名变量和镜像里的前缀比对，不一致直接拒绝启动。

### 1.5 起服务

```bash
docker compose up -d --build
docker compose ps -a        # -a 才能看到 portal-seed 这个一次性容器
```

期望：

```
campus-tokenhub-member-postgres   Up (healthy)
campus-tokenhub-member            Up (healthy)
campus-tokenhub-member-seed       Exited (0)
```

验收：

```bash
# 根路径部署
curl -s http://127.0.0.1:3200/api/health

# basePath=/tokenhub/member
curl -s http://127.0.0.1:3200/tokenhub/member/api/health
```

返回 `{"status":"ok"}` 即可。健康检查的路径由 `PORTAL_BASE_PATH` 自动拼出来，所以**只要 `PORTAL_BASE_PATH` 两处（build.args + environment）都有值**，探针就不会误判。compose 里已经这么写了，自己改的时候别删。

> 拆仓残留：`docker-compose.yml` 的 portal 服务里还留着 `OCTAFUSE_ADMIN_BASE` / `NEXT_PUBLIC_PROXY_BASE` / `REQUEST_CONTENT_*` 几项。成员站零网关，这些变量没有任何作用，看到不用管，也别照抄到新部署里。

### 1.6 首次初始化：SSO

`portal-seed` 会把一套 OAuth2 参数写进 `portal_shared.login_config`（只填空值）。你只需要补 Client Secret：

- `.env` 的 `OAUTH2_CLIENT_SECRET` 给值 → 直接生效；
- 或登录后进「设置 → 登录认证」填一次，加密落库（推荐，之后 env 那行可以删）。

回调地址：`<PUBLIC_BASE_URL>/api/auth/callback`，必须登记到 IdP 白名单。

还没有 SSO 时（先有鸡还是先有蛋）：

1. 配 `PORTAL_ADMIN_USERNAME` / `PORTAL_ADMIN_PASSWORD`；
2. `docker compose up -d portal`；
3. 打开 `/login`，用引导账号登录；
4. 进「设置 → 登录认证」填 SSO 参数并保存；
5. 保存成功后账号密码登录**仍然可用**（参数填齐不等于调得通，不再自动关闭）；
6. 用学校账号真的登进去一次，确认没问题后，把 `PORTAL_ADMIN_LOGIN` 改 `off`、清空口令 —— 那一刻旧密码会话立即失效。

把自己锁在外面：`PORTAL_ADMIN_LOGIN=on` → `up -d portal` → 登进去修 → 改回 `auto`。

### 1.7 配腾讯云（成员站的核心依赖）

#### 1.7.1 凭据

用一个**只授权 organization 接口的 CAM 子账号**，不要用主账号 AK：

| 变量 | 说明 |
| --- | --- |
| `TENCENTCLOUD_SECRET_ID` / `_SECRET_KEY` | 子账号密钥 |
| `TENCENTCLOUD_ORGANIZATION_REGION` | 默认 `ap-guangzhou`（腾讯云组织接口是全局接口，region 只影响签名） |
| `MEMBER_ACCOUNT_PROVIDER` | `tencent`（真实）/ `mock`（**仅本地测试**，生产环境启动即失败） |
| `MEMBER_ACCOUNT_PERMISSION_IDS` | 财务权限，`1` 查看账单、`2` 查看余额必选 |

可选财务权限：`3` 资金划拨、`4` 合并出账、`5` 开票、`6` 优惠继承、`7` 代付费、`8` 成本分析、`9` 预算管理、`10` 信用额度设置。其中 `3` 和 `10` 需要商务开通，填了没开通会在建号时报权限错误。

`MEMBER_ACCOUNT_POLICY_TYPE` 目前只能是 `Financial`（腾讯云仅支持这一种关系策略）。

凭据两种给法：

- 写 `.env`（简单，但改一次要重启容器）；
- 在「设置 → 成员组织」里填（加密落库，`CONFIG_ENCRYPTION_KEY` 或 `SESSION_SECRET` 派生密钥），推荐后者。

两处都给时**以库里的为准**。

#### 1.7.2 组织侧的三个前置条件（不满足就会在建号时炸）

1. **组织已存在，且这个 CAM 子账号在组织里有管理员身份**（`IsManager=true`）。
2. **「成员删除许可」要开**——但注意，它只对 `DeleteAccount`（销号）生效，见 2.5。
3. **部门树**：新部门会自动挂到组织根节点下（多根节点时取 `NodeId` 最小者）。根节点不用配。

#### 1.7.3 本地用 mock 跑通流程

```bash
MEMBER_ACCOUNT_PROVIDER=mock
```

mock 是内存假客户端：不调云、建号立刻成功、可跑完整审核流程。**生产环境禁止**，`instrumentation` 启动校验会直接拒绝。

### 1.8 前置反代

单站部署没有内置 nginx，用学校现有的即可。要点只有三个：

```nginx
location / {
    proxy_pass http://127.0.0.1:3200;   # 不要剥前缀（Next 自带 basePath）
    proxy_set_header Host $http_host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $remote_addr;   # 覆写，不要追加
    proxy_read_timeout 3600s;                        # 建号可能慢，别用默认 60s
}
```

仓库里的 `deploy/nginx.conf.template` 是**双站版**（含 portal / portal-member / gateway 四段 upstream）。单站使用时删掉 member 之外的段，只留 `portal → 127.0.0.1:3200`。

### 1.9 上线前安全检查

| 检查项 | 要求 |
| --- | --- |
| `SESSION_SECRET` | 生产重新生成 |
| `COOKIE_SECURE` | TLS 后必须 `true`，否则浏览器丢弃会话 |
| `PUBLIC_BASE_URL` | 实际 `https://` 地址；留空会回退到 `Host` 头，可伪造 |
| `MEMBER_ACCOUNT_PROVIDER` | 必须是 `tencent` |
| CAM 凭据 | 子账号、只授 organization、不要主账号 AK |
| 端口暴露 | 只开反代端口，3200 绑回环 |
| 引导账号 | SSO 配齐后 `off` + 清空口令 |
| 数据卷 | 必须挂 `portal_data`，否则容器重建丢全部申请单 |
| 出网 | 能访问 `organization.tencentcloudapi.com` |

### 1.10 与统一采买站同域部署

不要在本仓库起第二个 Postgres。双站编排在**统一采买站仓库**的 `docker-compose.dual.yml`，它把本仓库当 `../campus-tokenhub-member` 引用。

前置：

1. 本仓库与统一采买站仓库**同级**，目录名必须叫 `campus-tokenhub-member`；
2. 统一采买站的网关镜像已构建（`octafuse-admin:local` / `octafuse-proxy:local`）；
3. 旧数据卷 `campus-tokenhub_octafuse_pgdata` 存在（dual 文件里写死 external）。

```bash
cd ../campus-tokenhub-assign
cp .env.dual.example .env.dual
vim .env.dual
docker compose -f docker-compose.dual.yml --env-file .env.dual up -d --build
```

三个共享会话的条件（缺一个就互认失败，且不报错）：

```bash
SESSION_SECRET=<两站相同>
PORTAL_COOKIE_PATH=/tokenhub      # 公共前缀，不能填各自的 basePath
PORTAL_COOKIE_DOMAIN=             # 留空 = host-only
```

这两项在 dual 文件里由 compose 直接注入，**不需要在本仓库的 `.env` 里重复配**。但如果你改了 `.env.dual`，记得两站的值同源。

两种部署的数据卷不一样，别搞混：

| 形态 | 卷名 |
| --- | --- |
| 单站（本仓库 compose） | `campus-tokenhub-member_octafuse_pgdata` |
| 双站（assign 的 dual 文件） | `campus-tokenhub_octafuse_pgdata`（external，旧栈的卷） |

换形态部署时，要先把数据从旧卷导出来再导入新卷，不能指望它自己过去。

### 1.11 从旧的单库架构迁移数据

只读旧 `portal` schema，复制到 `portal_shared` / `portal_member`，不删不改旧表。

```bash
# 1) 先启动一次应用，让 ensurePortalSchema 把表建出来
docker compose up -d

# 2) 共享层
psql "$PORTAL_DATABASE_URL" -f deploy/migrate/020-shared.sql

# 3) 本侧业务表
psql "$PORTAL_DATABASE_URL" -f deploy/migrate/021-own.sql
```

**已知问题**：本仓库的 `deploy/migrate/` 里只有 `021-own.sql` 和 `README.md`，**缺 `020-shared.sql`**（README 引用了它）。该脚本在统一采买站仓库的同名目录下，两份内容逐字相同，直接拷过来用：

```bash
cp ../campus-tokenhub-assign/deploy/migrate/020-shared.sql deploy/migrate/
```

迁移要点：

- **加密列默认不迁**（`oauth2_client_secret_enc` / `tencent_secret_id_enc` / `tencent_secret_key_enc` 落 NULL）。原因：密文与部署机的 `SESSION_SECRET` 绑定，换机器必解不开，而且失败是"安静的"——页面显示已配置、实际报凭据无效。迁移后到设置页重录一次。
- **幂等**：靠 `portal_shared.settings` 里的 `migration.020.shared` / `021.member` 标记，重跑直接跳过；要重跑就删标记。
- **必须看对账表**：脚本会打印 `new_cnt / old_cnt`。曾出现过 `\if` 块里用 `RAISE NOTICE` 导致语法错、事务回滚，但前面 `INSERT` 仍打印成功的情况——只看"没报错"会被骗。

### 1.12 部署阶段就让 AI 核验

装好 CodeBuddy CLI 后（见 3.7），一条命令就能把"三容器状态 + 健康检查 + 关键配置 + 云凭据是否可用"读一遍。

---

## 2. 使用

### 2.1 角色

| 角色 | 怎么来 | 能做什么 |
| --- | --- | --- |
| 老师 | 学校 SSO 登录 | 提交/修改申请、看状态、看成员信息 |
| 全局管理员 | 名单 / 首个登录者认领 / 引导账号 / 角色同步 | 审核、删除、管理员名单、设置 |

管理员判定顺序（任一命中）：

1. 引导期账号密码登录的本地身份 `local:<username>`；
2. `portal_shared.admins` 名单。

名单为空时，首个合法登录者自动认领为管理员。`ADMIN_EMAILS` 邮箱白名单已移除。

「登录认证 → 管理员角色同步」可配置若干角色值：SSO 用户登录时角色命中（忽略大小写）即自动加入名单，**只新增不删除**，撤销仍需到 `/admins` 手动移除；留空即关闭。每次登录都会重新判定，原本不是管理员的账号在角色调整后重新登录当次即生效。

名单为空、首个登录者又不是 `school_id:user_id` 格式时：

```bash
npm run bootstrap-admin -- "school_001:100234567"
```

### 2.2 老师侧：一次完整申请

**第一步：登录**

`/login` → 「使用学校账号登录」。SSO 回调后落到 `/members`。

**第二步：填申请**

页面是**申请人本人**的视图，第一次进来就是表单：

| 字段 | 要求 | 说明 |
| --- | --- | --- |
| 申请人 | 自动，来自会话 | 不需要填 |
| 邮箱 | 合法邮箱 | 建号时作为成员联系邮箱 |
| 国际区号 | 1-4 位数字 | 默认 86 |
| 手机号 | 6-15 位数字 | 建号时作为联系电话 |
| 部门路径 | 例 `教务处/数学组` | 最多 3 级、每级 ≤40 字符、**不含根节点** |
| 备注 | 可选 | 开票主体、使用场景等，管理员审核时会看 |

成员名由服务端按姓名生成（≤25 字符、腾讯云允许的字符集、全局唯一），不需要老师填。同一时间一名申请人只能有一张单。

**第三步：等审核**

状态含义：

| 状态 | 老师看到什么 | 能做什么 |
| --- | --- | --- |
| `pending` | 已提交，等待审核 | 可修改资料重提 |
| `provisioning` | 正在开通 | 等；超过 120 秒算中断，可补资料重新排队 |
| `active` | 成员名 + Uin | 完成 |
| `needs_email` / `needs_phone` | 云侧要求补联系方式 | 补填后重新排队 |
| `failed` | 开通失败（中文提示） | 可重新申请，管理员也可重试 |
| `rejected` | 驳回 + 原因 | 改资料重提 |
| `removing` | 正在删除 | 等 |
| `deleted` | 已移除 | 可重新申请（沿用同一条单） |

**三条"防坑"提示**（直接抄给老师）：

1. 部门路径写**相对根节点**的路径，别写组织名；不确定就写自己所在的一级部门，管理员审核时能改。
2. 驳回后**先看原因再改**，反复提交同样的资料只会再被驳回一次。
3. 开通成功后成员名和 Uin 会显示出来，**截图保存**，后面找 IT 要权限时报这个。

### 2.3 管理员侧：三个页面 + 三个设置 Tab

**`/members/review` 审核列表**

每行显示申请人、部门路径、提交次数（首次 / 修改后重提）、状态。两个动作：

- **通过**：`pending → provisioning`，服务端立刻调云建号，结果写回单子；
- **驳回**：`pending → rejected`，必须填原因（会展示给老师）。

通过前请确认部门路径：服务端会从根节点逐级查找，**缺哪级建哪级**（`Remark=portal:auto`）。如果同名节点已存在但路径不同，会提示管理员去控制台核对。

**`/members` 成员列表**

已开通成员的总览，支持：

- 查看联系方式、成员名、Uin、落到的节点路径；
- 修改联系方式（`/api/portal/members/[id]/contact`）；
- **删除成员账号**（`DeleteMemberButton`），见 2.5。

**`/admins` 管理员名单**

搜索 + 多选 + 保存，名单两站共用。名单里只有一种角色：全局管理员。

**`/settings` 三个 Tab**

| Tab | 内容 |
| --- | --- |
| 首页配置 | 校名、登录页标题/副标题、页脚、主题色、Logo |
| 成员组织 | 腾讯云 AK/SK（加密）、财务权限 ID、关系策略；可点「检测凭据」 |
| 登录认证 | SSO 协议与参数、字段映射、管理员角色同步、登录限制、部署管理员开关 |

「检测凭据」只在你点的时候发探测请求，保存本身不探上游。

### 2.4 审核与建号的真实行为（管理员必须知道）

**建号是同步调云，不是后台队列。** 点「通过」后请求会一直等到云侧返回：

| 情况 | 结果 |
| --- | --- |
| 云侧成功 | `active`，写入 uin / nodeId / nodePath |
| 云侧报错 | `failed`，中文提示给老师，原始错误码 + RequestId 留给管理员 |
| 请求超时但云侧其实成功 | 单子可能停在 `provisioning`，会被 120 秒超时规则识别为中断 |
| 部门名冲突 | 提示去控制台核对同名节点 |

所以：**审核时不要连续点多次**（会并发建号），也**不要在反代上把超时设成 30 秒**（建号可能要更久）。

### 2.5 删除成员账号：两个接口，别选错

这是本项目最容易误判的一处，务必分清：

| 目的 | Action | 参数 | 典型错误 |
| --- | --- | --- | --- |
| 把成员**移出组织** | `DeleteOrganizationMembers` | `MemberUin` 数组 | `CreateMemberNotAllowDelete`：API 创建的成员不允许这样删 |
| **删除账号（销号）** | `DeleteAccount` | `MemberUin` 单值 | `DeleteAccountDisabled`：控制台没开「成员删除许可」 |

要点：

1. 参数名是 `MemberUin`（数组），写成 `Members` 会报 `MissingParameter`，写成标量会报"input type should be array-type"；
2. **API 创建的成员默认不允许删除**。要在腾讯云控制台开启「成员删除许可」，且**只能由具备 `QcloudOrganizationFullAccess` 的 CAM 子账号执行，主账号不行**；
3. `DeleteAccount` 比建号慢（要清理成员名下资源），代码里单独放宽到 **30 秒**。超时后**不要立刻重试**，先查云侧 `DescribeOrganizationMembers` 里成员还在不在——不在就说明云侧已成功，是响应回来晚了；
4. `DeleteAccount` 可能进入注销审核（`FailedOperation.MemberAccountDeregisterPending`），官方约 3 个工作日，**不能当失败处理**；
5. 删除是 `active → removing → deleted`，`removing` 允许回滚到 `active`（云侧拒绝时），不留中间态。

### 2.6 日常 SOP

| 场景 | 动作 |
| --- | --- |
| 开学集中申请 | 提前确认 CAM 凭据可用、组织成员名额够、部门树规划好 |
| 老师说"提交没反应" | 看 `/members` 状态；`pending` 说明在等审核，不是没提交 |
| 老师要改部门 | 审核前让他自己改；已开通的只能在腾讯云控制台改 |
| 建号失败 | 看 `failed` 的原因；管理员侧看 `errorCode` + `tencentRequestId` |
| 要删人 | 先确认控制台已开「成员删除许可」，否则必然失败 |
| 换 CAM 凭据 | 设置 → 成员组织 → 重填 → 点「检测凭据」 |
| 换域名 | 改 `PUBLIC_BASE_URL`（+ `PORTAL_BASE_PATH` 需重建）→ IdP 白名单登记新回调 |

---

## 3. 运维

### 3.1 命令速查

```bash
docker compose ps
docker compose logs -f --tail=200 portal
docker compose up -d portal                # 改 .env 后
docker compose up -d --build portal        # 改代码 / 改 basePath 后
docker compose exec -T postgres psql -U octafuse -d octafuse
docker compose down                        # 保留卷
```

双站形态下所有命令都去统一采买站仓库带文件执行：

```bash
cd ../campus-tokenhub-assign
docker compose -f docker-compose.dual.yml --env-file .env.dual ps
docker compose -f docker-compose.dual.yml --env-file .env.dual logs -f portal-member
docker compose -f docker-compose.dual.yml --env-file .env.dual restart nginx
```

### 3.2 健康检查

```bash
curl -s http://127.0.0.1:3200/api/health
# basePath 部署：
curl -s http://127.0.0.1:3200/tokenhub/member/api/health
```

| 探针 | 期望 |
| --- | --- |
| `/api/health` | `{"status":"ok"}` |
| 容器 healthcheck | `(healthy)` |
| 数据库 | `pg_isready` 返回 accepting connections |

健康检查**不探腾讯云**（避免把云侧抖动算成站点故障）。云凭据是否可用，靠设置页的「检测凭据」人工确认。

### 3.3 日志与审计

每行一个 JSON：

```bash
docker logs -f campus-tokenhub-member | jq -c 'select(.event)'
```

| 事件 | 含义 | 关键字段 |
| --- | --- | --- |
| `member.apply` | 提交 / 重提 | `sub`、`status` |
| `member.review` | 通过 / 驳回 | `target`、`result`、`reviewedBy` |
| `member.department.create` | 审核时新建的部门层级 | 层级路径、根节点 |
| `member.provision` | 建号结果 | `result`、腾讯云原始错误码 |
| `auth.login` / `auth.login.fail` | 登录 | `actor_email` |

`sk-`、密码、会话密钥都会脱敏。**腾讯云 RequestId 不脱敏**，它是找云侧技术支持的关键凭证，工单里要带上。

排查某一位老师的完整链路：

```bash
docker logs campus-tokenhub-member --since 24h | jq -c \
  'select(.event|startswith("member")) | select(.actor_external_id=="100051:1012173")'
```

### 3.4 备份与恢复

数据在 Postgres，加一个卷 `portal_data`（只放历史 JSON 迁移文件，运行期不写）。

```bash
# 备份
docker compose exec -T postgres pg_dump -U octafuse -d octafuse -Fc --no-owner --no-acl \
  > backup-member-$(date +%Y%m%d-%H%M).dump

# 恢复
docker compose up -d postgres
cat backup-member-20261124-0300.dump | docker compose exec -T postgres \
  pg_restore -U octafuse -d octafuse --no-owner --no-acl --clean --if-exists
docker compose up -d
```

要一起备份：`.env`（加密存放）、`.data` 里的历史申请单（如果有）。

**恢复后必做一件事**：检查 `portal_shared.app_config` 的加密列是否可解：

```sql
select tencent_secret_id_enc is null as id_missing,
       tencent_secret_key_enc is null as key_missing
from portal_shared.app_config;
```

`t`（为空）说明密文没迁过来或密钥变了，去设置页重录 CAM 凭据，否则审核建号会报"凭据无效"。

### 3.5 升级

```bash
git pull
docker compose up -d --build
docker compose ps
```

要点：

- 改了 `PORTAL_BASE_PATH` 必须重建；
- 双站形态重建 `portal-member` 后，**必须 `restart nginx`**（它缓存 upstream DNS，不重启会 404 或打到另一个站）；
- 升级前 `pg_dump`。schema 只增不减，但结构性迁移（旧 EAV → 结构化列）不可逆。

回滚：

```bash
git checkout <上一个 commit/tag>
docker compose up -d --build
```

### 3.6 故障排查手册

#### 1) 老师提交后一直 `pending`

正常。`pending` 表示等审核，不是提交失败。查审核列表是否有这张单；如果列表也没有，说明写库失败，看 `member.apply` 日志与 `member_applications` 表。

#### 2) 审核通过后卡在 `provisioning` 不动

**根因**：请求进程中断（容器重启、反代超时、OOM），云侧可能已经建了也可能没建。
**处置**：

```bash
# 先查云侧成员在不在
docker compose exec -T portal node -e "console.log(process.env.TENCENTCLOUD_ORGANIZATION_REGION)"
# 用控制台或 CLI 查 DescribeOrganizationMembers，比对 memberName
```

超过 120 秒（`PROVISION_TIMEOUT_MS`）后系统允许本人补资料重新排队；管理员也可重试。**重试前一定要确认云侧没有同名成员**，否则会开出第二个号。

#### 3) 建号报 `CreateMemberNotAllowDelete` / `UnsupportedOperation.CreateMemberNotAllowDelete`

你调的是 `DeleteOrganizationMembers`（移出组织），不是 `DeleteAccount`（销号）。按 2.5 换接口。这不是权限问题，别去查 CAM 权限，会浪费半天。

#### 4) 删除报 `UnsupportedOperation.DeleteAccountDisabled`

控制台的「成员删除许可」没开，或执行身份不对（必须是有 `QcloudOrganizationFullAccess` 的 **CAM 子账号**，主账号不行）。

#### 5) 删除报超时，但单子回滚成 `active`

云侧其实删成功了，只是响应晚于超时。代码已放宽到 30s，仍超时的话先查 `DescribeOrganizationMembers`——成员不在就手工把单子置为 `deleted`，别重复点删除。

#### 6) 部门建不出来 / 建到了错误的位置

现象：提示节点冲突，或建到了别的部门下。
**根因**：新部门挂在组织根节点下（多根节点取 `NodeId` 最小者）；同名节点已存在但路径不同。
**处置**：去腾讯云控制台核对同名节点；确认组织只有一个根节点，或接受"取最小 NodeId"的规则。

#### 7) 设置页报「凭据无效」

顺序排查：

```bash
# 1) 看库里是否有密文
docker compose exec -T postgres psql -U octafuse -d octafuse -c \
  "select tencent_secret_id_enc is null, tencent_secret_key_enc is null from portal_shared.app_config"

# 2) 看是不是密钥变了（换过 SESSION_SECRET / CONFIG_ENCRYPTION_KEY）
docker compose logs portal | grep -i "decrypt\|解密"
```

密文可解但探测仍失败 → AK/SK 本身没权限（子账号缺 organization 读权限），去 CAM 加策略。

#### 8) 登录成功又跳回登录页

浏览器里有两个同名 `portal_session`（新的 `Path=/tokenhub`，旧的 `Path=/`）。Next 的 `cookies().getAll()` 按名去重只返回最后一个，恰好是旧密钥签的 → 验签失败。
**处置**：清掉旧 Cookie；代码侧已改为解析 `cookie` 头并遍历所有同名值。

#### 9) 页面 404，但容器 healthy

两种可能：

- `PORTAL_BASE_PATH` 与访问路径不一致（basePath 是构建期参数，改了没重建）；
- 走反代时上游剥了前缀，Next 生成的资源路径对不上。

直连容器验证：

```bash
curl -s http://127.0.0.1:3200/tokenhub/member/api/health
```

直连通、反代不通 → 反代配置或 nginx DNS 缓存，`restart nginx`。

#### 10) 容器重建后申请单全没了

`portal_data` 卷没挂，或换部署形态换了卷（单站 `campus-tokenhub-member_octafuse_pgdata` vs 双站 `campus-tokenhub_octafuse_pgdata`）。数据在 Postgres 里，不在 `.data` 里；`.data` 只放历史 JSON。查 `member_applications` 表是否还有数据。

#### 11) 双站登录不互认

三个条件缺一个：`SESSION_SECRET` 不同、`PORTAL_COOKIE_PATH` 填成了各自 basePath、`PORTAL_COOKIE_DOMAIN` 设错。**不会报错**，只表现为"在 A 站登录，B 站还要再登一次"。

#### 12) 建号很慢 / 偶发超时

- 反代 `proxy_read_timeout` 太短（默认 60s，建号可能更久）；
- 服务器到腾讯云 API 的链路差；
- 组织成员数量接近上限（云侧会慢）。

先把反代超时提到 3600s，再判断是不是网络。

### 3.7 用 CodeBuddy CLI 让 AI 辅助定位（重点）

成员站的排障难点不在"服务挂没挂"，而在**云侧返回的错误码要翻译成人话**、**申请单状态机卡在哪个迁移**。这两件事 AI 特别擅长，前提是让它读到正确的证据。

#### 3.7.1 安装（服务器上，三选一）

要求 Node.js ≥ 18.20（原生安装器不需要 Node）。

```bash
# 方式一：npm
npm install -g @tencent-ai/codebuddy-code

# 方式二：Homebrew（macOS / Linux）
brew tap Tencent-CodeBuddy/tap
brew install codebuddy-code

# 方式三：原生二进制（服务器没 Node 时用，推荐）
curl -fsSL https://copilot.tencent.com/cli/install.sh | bash
```

验证：

```bash
codebuddy --version
codebuddy doctor
```

#### 3.7.2 登录

```bash
cd /opt/campus-tokenhub-member
codebuddy
```

首次启动选登录方式：国内站 / 国际站 / 企业域名（专享版，需企业给地址）/ iOA（腾讯内部）。选完浏览器自动打开完成认证。

#### 3.7.3 先让它认识项目

```bash
codebuddy
> /init
```

`/init` 生成项目上下文，后续会话自动加载。对本项目尤其重要：它需要知道"成员站零网关""`DeleteAccount` 不是 `DeleteOrganizationMembers`""`provisioning` 超 120 秒算中断""部门路径不含根节点"——这些不写进上下文，AI 会按通用腾讯云文档给建议，方向经常是错的。

#### 3.7.4 只读排查模式（服务器上必须这么用）

```bash
# 只读分析，不改文件
codebuddy --permission-mode plan "分析某个申请单为什么卡在 provisioning"

# 限定工具：只允许读文件和只读命令
codebuddy --permission-mode plan \
  --allowedTools "Read,Grep,Glob,Bash(docker compose ps:*),Bash(docker compose logs:*),Bash(docker compose exec:*)" \
  "检查三容器状态与最近 200 行 portal 日志，列出异常"

# 一次性问答，可进脚本
codebuddy -p "读 /tmp/member-diag/ 下所有文件，输出：结论、证据、下一步" --output-format text
```

**安全红线**：

1. 生产服务器**不要**加 `-y` / `--dangerously-skip-permissions`；
2. 用 `--permission-mode plan` 或 `--allowedTools` 收窄范围；
3. `.env` 里的 `TENCENTCLOUD_SECRET_KEY`、`SESSION_SECRET` 绝不贴进对话；只取非敏感项：

```bash
grep -E '^(PUBLIC_BASE_URL|PORTAL_BASE_PATH|MEMBER_ACCOUNT_PROVIDER|TENCENTCLOUD_ORGANIZATION_REGION|MEMBER_ACCOUNT_PERMISSION_IDS)=' .env
```

4. 腾讯云 `RequestId` 可以给（排障必需），`SecretId` 只给前 8 位。

#### 3.7.5 证据包：一条命令固定现场

```bash
mkdir -p /tmp/member-diag && cd /opt/campus-tokenhub-member

{
  echo "===== 时间 ====="; date -Is
  echo "===== compose ps ====="; docker compose ps
  echo "===== 端口 ====="; ss -lntp | grep -E '3200|5433'
  echo "===== 健康检查 ====="; curl -s -m 5 -D - "http://127.0.0.1:${PORTAL_HOST_PORT:-3200}${PORTAL_BASE_PATH:-}/api/health"
  echo
  echo "===== 申请单状态分布 ====="
  docker compose exec -T postgres psql -U octafuse -d octafuse -c \
    "select status, count(*) from portal_member.member_applications group by 1 order by 2 desc"
  echo "===== 最近 10 张单 ====="
  docker compose exec -T postgres psql -U octafuse -d octafuse -c \
    "select id, applicant_sub, status, error_code, tencent_request_id, updated_at
       from portal_member.member_applications order by updated_at desc limit 10"
  echo "===== 加密列是否可解 ====="
  docker compose exec -T postgres psql -U octafuse -d octafuse -c \
    "select tencent_secret_id_enc is null as id_missing, tencent_secret_key_enc is null as key_missing from portal_shared.app_config"
} > /tmp/member-diag/env.txt 2>&1

docker compose logs --tail=400 portal > /tmp/member-diag/portal.log 2>&1

# 非敏感配置
grep -E '^(PUBLIC_BASE_URL|PORTAL_BASE_PATH|MEMBER_ACCOUNT_PROVIDER|TENCENTCLOUD_ORGANIZATION_REGION|MEMBER_ACCOUNT_PERMISSION_IDS|COOKIE_SECURE)=' .env \
  > /tmp/member-diag/config.txt 2>&1
```

交给它：

```bash
codebuddy --permission-mode plan \
  "读 /tmp/member-diag/ 下的 env.txt、portal.log、config.txt。
   目标：解释为什么有申请单停在 provisioning 超过 10 分钟。
   要求：先结论，再证据（文件名+关键行），再 1-3 步处置命令。
   涉及腾讯云错误码时，对照 src/lib/tencent/errors.ts 给出中文含义。不要改文件。"
```

#### 3.7.6 六个可直接复制的 prompt

**① 云错误码翻译**

```
日志里有 member.provision 失败，errorCode 是 XXXX。
读 src/lib/tencent/errors.ts 与 src/lib/members/provision.ts，
说明这个错误码在腾讯云 organization 语义下是什么意思、门户为什么这样映射、
管理员下一步该做什么（控制台操作 or 代码侧重试）。
```

**② 申请单卡在 provisioning**

```
某单 status=provisioning，provisioningStartedAt 早于现在 15 分钟。
读 env.txt 里的状态分布和最近单据、portal.log 里该 sub 的 member.provision 日志。
判断：进程是否中断、云侧是否已建号、该重试还是该手工置状态。
给出判断依据和处置命令（不要直接改库，先给 SQL 让我确认）。
```

**③ 删除失败**

```
管理员点删除失败。日志里有 errorCode。
重点区分：CreateMemberNotAllowDelete（调错接口 DeleteOrganizationMembers）
vs DeleteAccountDisabled（成员删除许可未开）
vs 超时（云侧已删、响应晚到）。
给出结论、验证命令（查 DescribeOrganizationMembers）、以及是否需要人工置 deleted。
```

**④ 部门节点冲突**

```
审核时报部门节点冲突。读 src/lib/members/departments.ts 与 department-path.ts，
说明门户怎么从根节点找/建部门、为什么会撞名、管理员在控制台应该核对什么。
不要提议改部门名规则。
```

**⑤ 设置页凭据无效**

```
设置页「检测凭据」失败。env.txt 里加密列 id_missing/key_missing 的值是 X。
读 src/lib/config/crypto.ts、src/lib/tencent/factory.ts，
判断是「密文解不开（换了 SESSION_SECRET）」还是「AK/SK 无 organization 权限」。
给出区分方法和处置步骤。
```

**⑥ 双站登录不互认**

```
现象：在统一采买站登录后，成员站仍要求登录。
读 config.txt 的 PORTAL_BASE_PATH / COOKIE_SECURE，以及两站的 SESSION_SECRET 是否同源（不要打印值，只比对是否一致）。
重点检查：SESSION_SECRET 是否相同、PORTAL_COOKIE_PATH 是否是公共前缀 /tokenhub、PORTAL_COOKIE_DOMAIN 是否误设。
```

#### 3.7.7 接进巡检

```bash
#!/usr/bin/env bash
# scripts/ai-healthcheck.sh
set -euo pipefail
cd "$(dirname "$0")/.."
codebuddy -p "检查 docker compose ps、健康检查、以及 portal_member.member_applications 里
是否有超过 10 分钟仍为 provisioning 的单。全正常只输出 OK；
否则输出：问题、证据、建议命令（≤20 行）。" \
  --permission-mode plan --output-format text
```

cron 每天跑一次即可。**不要**让它自动改状态或重试删除。

---

## 4. 自定义需求开发

### 4.1 代码地图

```
src/
├─ app/
│  ├─ (portal)/
│  │  ├─ members/            本人申请与状态（page.tsx）
│  │  ├─ members/review/     管理员审核列表
│  │  ├─ admins/             管理员名单
│  │  └─ settings/           三个 Tab
│  ├─ api/
│  │  ├─ auth/               login / callback / logout / password / admin-entry
│  │  └─ portal/
│  │     ├─ members/         GET 列表 / POST 提交
│  │     ├─ members/[id]/    GET 详情 / DELETE 删除
│  │     ├─ members/[id]/review   审核
│  │     ├─ members/[id]/contact  改联系方式
│  │     ├─ admins/          名单
│  │     └─ settings/        读写、探测、Logo
│  └─ login/
├─ components/members/       ApplicationForm / ApplicationStatus / ReviewList / DeleteMemberButton ...
└─ lib/
   ├─ members/
   │  ├─ types.ts            申请单类型与状态枚举（**改字段先改这里**）
   │  ├─ rules.ts            纯业务规则：成员名生成、状态迁移表、可提交判定、校验
   │  ├─ store.ts            读写 Postgres（列 ↔ 领域对象）
   │  ├─ provision.ts        审核通过后的建号编排
   │  ├─ departments.ts      部门逐级查找/创建
   │  ├─ department-path.ts  路径规范化与校验
   │  ├─ access.ts           谁看得到哪张单
   │  └─ presentation.ts     页面展示用的合并/格式化
   ├─ tencent/
   │  ├─ organization.ts     organization 接口封装
   │  ├─ errors.ts           错误码 → 中文文案
   │  ├─ factory.ts          tencent / mock 分支
   │  ├─ signature.ts        TC3 签名
   │  └─ mock-client.ts      本地假客户端
   ├─ config/                字段驱动配置（fields.ts 是唯一声明处）
   ├─ db/                    portal-schema.ts / shared-schema.ts / portal-db.ts
   ├─ auth/                  会话与 SSO 适配器
   └─ portal/nav.ts          侧边栏
```

三条结构性约定：

1. **业务规则的唯一来源是 `rules.ts`**（纯函数，不碰 IO）。页面和接口共用同一套判定，避免"页面能点、接口拒绝"。
2. **`types.ts` 的状态枚举与 `rules.ts` 的 `TRANSITIONS` 必须同步改**，漏一个就会出现"状态改不过去"。
3. **侧边栏高亮统一走 `resolveActiveHref`**（最长 href 胜出），不要再往 `isNavItemActive` 加路径特判。

### 4.2 本地开发

```bash
npm ci
npm run env:local     # 生成本地 .env.local 与 compose 覆盖（都不入库）
npm run dev           # http://localhost:3000
```

本地调云接口不想真建号：

```bash
MEMBER_ACCOUNT_PROVIDER=mock
```

mock 是内存客户端，建号秒成功、可跑完整审核流程。它的存在意义就是让你在本地验证状态机，**不要**把它带进生产（启动校验会拒绝）。

### 4.3 门禁

```bash
npm run typecheck
npm run lint
npm test                 # vitest run（基线 624 passed）
npm run check:isolation  # src/ 中不得出现跨侧引用
npm run check:shared-ddl # 两站共享层 DDL 必须一致
npm run build
```

顺序：`typecheck → test → check:isolation → build`。

`check:isolation` 会拦住"把网关相关代码/统一采买站逻辑混进成员站"的改动。拆仓的目的就是让成员站能独立部署，这条门禁别关。

### 4.4 六个典型改动 recipe

#### R1 加一个设置项

1. `src/lib/config/fields.ts` 加 FIELDS 条目：`column`、`section`（`app` 或 `login`）、`auditName`、类型与校验；
2. `src/lib/db/portal-schema.ts` 或 `shared-schema.ts`：建表语句加列，**同时**加 `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`；
3. 若字段不在 `auth` 子树，检查 `src/lib/config/overlay.ts` 与 `settings-view.ts` 是否需要特判；
4. 设置页由 FIELDS 驱动渲染，通常不用改 UI；
5. `tests/lib/` 补字段读写与校验用例。

**字段分区决定落哪张表**：`section: 'app'` → `app_config`，`section: 'login'` → `login_config`。加到错的表会报 `column ... of relation ... does not exist`。

#### R2 加一个页面

```bash
src/app/(portal)/reports/page.tsx
src/components/reports/*.tsx
```

`src/lib/portal/nav.ts` 的 `buildNav` 加 `NavItem`（href、label、icon、是否仅管理员）。高亮交给 `resolveActiveHref`。

#### R3 加一个 API

`src/app/api/portal/reports/route.ts`。照同目录的写法：

- 取会话：`sessionFromCookieHeader` / `verifyAnySession`（`src/lib/auth/session.ts`）；
- 权限：`src/lib/members/access.ts` 或 `src/lib/auth/admin.ts`；
- 写操作做同源校验；
- 错误返回 `{ error: '中文可读文案' }`，云侧原始错误只进日志与 `errorCode` 字段。

#### R4 改申请单字段（最常见的业务改动）

以"加一个工号 `employeeNo`"为例，五处必须一起改：

1. `src/lib/members/types.ts`：加 `employeeNo: string`；
2. `src/lib/db/portal-schema.ts`：`member_applications` 加列（含 `ALTER ... IF NOT EXISTS`）；
3. `src/lib/members/store.ts`：`row → 对象` 与 `对象 → insert/upsert` 两处映射都要加；老数据给默认值 `''`；
4. `src/lib/members/rules.ts`：提交前校验（长度、字符集）；
5. `src/components/members/ApplicationForm.tsx` + `ApplicationStatus.tsx`：表单与回显；管理员侧 `ReviewList.tsx` 是否要展示由业务定。

**不要**只改表单不改 store：页面能填、提交后丢失，是最常见的自造 bug。

#### R5 改状态机

`src/lib/members/rules.ts` 的 `TRANSITIONS` 是唯一权威。加状态时：

1. `types.ts` 的 `MemberStatus` 加枚举值；
2. `TRANSITIONS` 补该状态的出入边；
3. `presentation.ts` 补中文标签与颜色；
4. `ApplicationStatus.tsx` / `ReviewList.tsx` 补展示分支；
5. 测试：`tests/lib/members-rules*` 补"允许/不允许"的迁移用例。

注意 `provisioning → pending` 只用于"中断单自救"（超过 `PROVISION_TIMEOUT_MS=120s`），别拿它做通用回退。

#### R6 接一个新的腾讯云接口

1. `src/lib/tencent/organization.ts` 加封装（复用 `signature.ts` 的 TC3 签名）；
2. `src/lib/tencent/errors.ts` 把新错误码映射成中文，**保留原始 code 与 RequestId**；
3. `src/lib/tencent/factory.ts` 的两个分支（tencent / mock）都要实现，否则本地跑不通；
4. 调用方（如 `provision.ts`）处理超时：写操作单独设超时，不要沿用默认 5s；
5. 补测试：mock 客户端 + 状态迁移断言。

### 4.5 数据契约红线

| 红线 | 违反后果 | 谁拦你 |
| --- | --- | --- |
| 共享表只写 `portal_shared` | 两站管理员/配置不同步 | `check:shared-ddl` |
| `src/` 不得引用网关或统一采买站代码 | 成员站失去"可独立部署"的前提 | `check:isolation` |
| 建表必须带 `ALTER ... IF NOT EXISTS` | 老库升级后缺列 | 代码评审 |
| 状态迁移只走 `TRANSITIONS` | 出现无法收敛的中间态 | `rules.ts` + 测试 |
| 云调用必须有超时与错误码映射 | 老师看到英文报错、单据卡死 | 代码评审 |
| 不存腾讯云密钥明文 | 泄露风险 | `*_enc` 列 + `crypto.ts` |

### 4.6 交付打包

用统一采买站仓库根目录的 `pack-for-school.sh`（它同时打两个仓库）。成员站侧要点：

- 打包前必须 commit。有未提交改动时脚本会中止，`--allow-dirty` 用 `git stash create` 打包但**不含未跟踪文件**；
- 交付包里不应该有 `.env` / `.env.local` / `node_modules` / `.data`；
- 内部域名会被替换成占位符，但**代码里的静态串**（注释、错误文案、测试字面量）也会被替换，改完要跑一次 `npm test` 确认没影响测试断言。

### 4.7 用 CodeBuddy CLI 辅助开发

```bash
cd /opt/campus-tokenhub-member
codebuddy
> /init
```

四条实用用法：

**① 改业务规则前先让它读全链路**

```
> 我要给申请单加一个「工号」字段。先只读，不要改：
  列出从 types → store → rules → 表单 → 审核列表需要改的文件与顺序，
  指出哪些地方老数据会出问题。
```

**② 用 plan 模式查状态机影响面**

```bash
codebuddy --permission-mode plan \
  "列出 src/lib/members/rules.ts 里所有状态迁移边，指出哪些边在页面层没有对应的操作入口。只读。"
```

**③ 让它把云错误码补全**

```
> 读 src/lib/tencent/errors.ts，对照腾讯云 organization 文档常见错误码，
> 列出还未覆盖的码，按「建号 / 删号 / 部门 / 权限」四类补上中文文案，
> 保留原始 code 与 RequestId 透传。改动后补测试。
```

**④ 提交前自查**

```bash
codebuddy -p "跑 npm run typecheck 和 npm test，把失败项按文件归类，
指出哪些是本次改动引入的。不要自动修改。" --permission-mode plan
```

---

## 5. 附录：配置 / 接口 / 数据表

### 5.1 环境变量

**必填**

| 变量 | 说明 |
| --- | --- |
| `SESSION_SECRET` | ≥32 字符；双站互认必须相同 |
| `POSTGRES_PASSWORD` | 数据库口令，十六进制 |
| `PORTAL_DATABASE_URL` | 门户库连接串（compose 会覆盖成 `postgres:5432`） |
| `PUBLIC_BASE_URL` | 对外根地址 |

**成员业务**

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `TENCENTCLOUD_SECRET_ID` / `_SECRET_KEY` | 空 | CAM 子账号，需 organization 权限 |
| `TENCENTCLOUD_ORGANIZATION_REGION` | `ap-guangzhou` | 签名 region |
| `TENCENTCLOUD_ORGANIZATION_ENDPOINT` | `organization.tencentcloudapi.com` | 一般不改 |
| `MEMBER_ACCOUNT_PROVIDER` | `tencent` | `mock` 仅本地 |
| `MEMBER_ACCOUNT_PERMISSION_IDS` | `1,2` | 财务权限；3、10 需商务开通 |
| `MEMBER_ACCOUNT_POLICY_TYPE` | `Financial` | 腾讯云仅支持这一种 |
| `PORTAL_DATA_DIR` | `./.data` | 历史 JSON 迁移文件目录 |

**站点与会话**

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORTAL_BASE_PATH` | 空 | Next basePath，**构建期** |
| `PORTAL_COOKIE_PATH` / `_DOMAIN` | 空 | 双站互认的作用域 |
| `COOKIE_SECURE` | `false` | TLS 后必须 `true` |
| `SESSION_TTL_HOURS` | `8` | 会话有效期 |
| `AUTH_PROVIDER` | `oauth2` | 只有 oauth2 / cas |
| `OAUTH2_*` / `CAS_*` | — | 首次由 seed 写库，之后设置页维护 |
| `OAUTH2_CLIENT_SECRET` | 空 | 仅兜底，之后加密落库 |
| `PORTAL_ADMIN_USERNAME` / `_PASSWORD` / `_LOGIN` | 空 / `auto` | 引导期账号 |
| `PORTAL_SCHOOL_NAME` | `学校` | 侧边栏兜底校名 |
| `CONFIG_ENCRYPTION_KEY` | 空 | 加密配置项，留空从 `SESSION_SECRET` 派生 |
| `PORTAL_HOST_PORT` / `POSTGRES_HOST_PORT` | `3200` / `5433` | 宿主端口 |

完整注释见 `.env.example`。

### 5.2 接口一览

| 路径 | 方法 | 用途 |
| --- | --- | --- |
| `/api/health` | GET | 健康检查 |
| `/api/auth/login` | GET | 发起 SSO |
| `/api/auth/callback` | GET | SSO 回调 |
| `/api/auth/logout` | POST | 登出 |
| `/api/auth/password` | POST | 引导期账密登录 |
| `/api/auth/admin-entry` | GET | 跳管理入口 |
| `/api/portal/members` | GET/POST | 我的单据 / 提交申请 |
| `/api/portal/members/[id]` | GET/DELETE | 详情 / 删除账号 |
| `/api/portal/members/[id]/review` | POST | 审核（通过 / 驳回） |
| `/api/portal/members/[id]/contact` | PUT | 改联系方式 |
| `/api/portal/admins` / `admins/candidates` | GET/POST/DELETE | 管理员名单 |
| `/api/portal/settings` | GET/PUT | 配置读写 |
| `/api/portal/settings/probe` | POST | 检测 CAM 凭据 |
| `/api/portal/settings/logo` / `branding/logo` | POST/GET | Logo |

### 5.3 数据表

| schema | 表 | 说明 |
| --- | --- | --- |
| `portal_shared` | `admins` | 全局管理员（两站共用） |
| | `app_config` | 品牌、额度、CAM 凭据（加密） |
| | `login_config` | SSO 参数、字段映射、管理员角色同步、登录限制、部署管理员 |
| | `settings` | 键值杂项 + 迁移标记 |
| | `session_revocations` / `config_audit` | 会话撤销 / 配置审计 |
| `portal_member` | `member_applications` | 申请单主表 |

`member_applications` 关键列：

| 列 | 含义 |
| --- | --- |
| `applicant_sub` | SSO 身份 `school_id:user_id` |
| `member_name` | 腾讯云成员名（= AccountName，≤25 字符，全局唯一） |
| `email` / `country_code` / `phone` | 联系方式 |
| `department_path` / `resolved_node_id` / `resolved_node_path` | 填写路径 / 实际落到的节点 |
| `status` | 状态机当前值 |
| `uin` | 云侧成员 Uin |
| `error_code` / `error_message` / `tencent_request_id` | 失败留痕 |
| `revision` | 修改后重提次数 |
| `provisioning_started_at` / `removing_started_at` | 中断判定 |
| `events` | 状态变更轨迹（有上限，不无限增长） |

常用查询：

```sql
-- 状态分布
select status, count(*) from portal_member.member_applications group by 1 order by 2 desc;

-- 卡住的单
select id, applicant_sub, member_name, status, provisioning_started_at
from portal_member.member_applications
where status = 'provisioning' and provisioning_started_at < now() - interval '10 minutes';

-- 失败原因
select id, member_name, error_code, tencent_request_id, updated_at
from portal_member.member_applications
where status = 'failed' order by updated_at desc limit 20;

-- 管理员名单
select sub, created_at from portal_shared.admins order by created_at;
```

### 5.4 术语

| 词 | 含义 |
| --- | --- |
| 成员账号 | 腾讯云集团组织里的成员，用于控制台/开票/独立配额 |
| 算力账号 | 统一采买站的 OctaFuse 账号（额度、API Key），与成员账号无关 |
| 部门路径 | 相对组织根节点的多级路径，如 `教务处/数学组` |
| 关系策略 | 腾讯云成员与主账号的财务关系，目前只支持 `Financial` |
| 中断单 | `provisioning` 超过 120 秒仍未出结果，视为进程中断 |
| 销号 | `DeleteAccount`，删除账号本人；不同于"移出组织" |
