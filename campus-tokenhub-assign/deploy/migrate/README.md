# 旧数据迁移（`portal` → `portal_shared` / 本侧 schema）

拆仓后数据按归属分三层，旧库的 `portal` schema 原地保留不动，只把数据**复制**到新位置。
脚本只做 `SELECT`，不 `UPDATE` / `DELETE` / `DROP` 任何旧表——迁移出问题可以重来。

## 顺序

```bash
# 1. 先启动一次任一站点：表由应用的 ensurePortalSchema 创建，脚本不建表
# 2. 共享层（两侧脚本逐字相同，双站部署时谁先跑谁生效）
psql "$PORTAL_DATABASE_URL" -f deploy/migrate/020-shared.sql

# 3. 本侧业务表
psql "$PORTAL_DATABASE_URL" -f deploy/migrate/021-own.sql
```

`020-shared.sql` 把 `admins` / `app_config` / `login_config` / `settings` /
`session_revocations` / `config_audit` 迁入 `portal_shared`；
`021-own.sql` 只迁本侧业务表（统一采买站是 `activity_configs`，成员站是 `member_applications`）。

## 加密字段默认不迁

`tencent_secret_id_enc` / `tencent_secret_key_enc` / `oauth2_client_secret_enc` 落 `NULL`，
迁移后需要到「设置 → 成员组织 / 登录认证」重新录入一次。

原因：这几列是用 `SESSION_SECRET`（或 `CONFIG_ENCRYPTION_KEY`）派生的密钥加密的，
换部署后密钥几乎必然不同，旧密文带过去只会解密失败——更糟的是失败很安静，
表现为「设置页显示已配置，但探测/登录报凭据无效」。

**本项目接受旧会话失效**（用户重新登录即可），因此新部署直接用新的 `SESSION_SECRET`；
既然密钥变了，就不存在「沿用旧密文」的合理场景，`COPY_SECRETS` 这条路实际用不上：

```bash
# 仅在两侧 SESSION_SECRET 确实相同（例如原地升级、没动过密钥）时才有意义
PGOPTIONS='-c campus_tokenhub.copy_secrets=1' psql "$PORTAL_DATABASE_URL" -f deploy/migrate/020-shared.sql
```

## 幂等

执行成功会往 `portal_shared.settings` 写标记：

| 脚本 | 标记 |
| --- | --- |
| `020-shared.sql` | `migration.020.shared` |
| `021-own.sql`（统一采买） | `migration.021.assign` |
| `021-own.sql`（成员自购） | `migration.021.member` |

标记存在时脚本直接跳过，不报错、不重复插入。要重跑就删掉对应标记再执行。

## 迁移后核对

两个脚本都会打印 `new_cnt / old_cnt` 对照表。共享层还应确认：

```sql
-- 加密列应为 t（NULL）——除非显式开了 COPY_SECRETS
SELECT tencent_secret_id_enc IS NULL, tencent_secret_key_enc IS NULL
FROM portal_shared.app_config;

-- 模式字段不迁，应为 NULL
SELECT mode_assign_enabled, mode_member_enabled, mode_default FROM portal_shared.app_config;
```

凭据的验证结论一律重置为 `unverified`：换了部署、换了出口 IP，旧的可达性结论不再成立，
需要到设置页重新点一次「检测」。
