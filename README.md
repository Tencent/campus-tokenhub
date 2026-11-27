# campus-tokenhub

学校 AI 模型门户。面向高校的 AI 大模型统一接入与自助服务系统，包含两个可独立部署的应用与一个 OpenAI 协议兼容的推理网关。

## 目录

| 目录 | 说明 | 依赖网关 |
| --- | --- | --- |
| `campus-tokenhub-assign/` | 统一采买站：师生用学校账号登录，自助领取 API Key、看模型与用量、在线调试；管理后台负责供应商接入与策略配置 | 是 |
| `campus-tokenhub-member/` | 成员自购站：教师申请腾讯云集团成员账号，审核后自动建号 | 否，可独立部署 |
| `campus-tokenhub-assign/local-stack/octafuse-gateway/` | 推理网关：多供应商路由、定价、额度与调用日志（修改版 fork） | — |

两个门户是**独立部署单元**：分别安装依赖、分别构建、分别启动，只共享一个 PostgreSQL 实例（按 schema 隔离）。

## 快速开始

**两站同时部署（一份 compose 起全部服务、统一走 nginx 8088）**：AI 助手按 [`QUICKSTART.md`](QUICKSTART.md) 执行；它对应项目根的 [`docker-compose.yml`](docker-compose.yml)，一条命令同时起统一采买站、成员自购站、网关和 nginx，两站共享数据库与会话。

只部署单站时按各目录说明：

- [`campus-tokenhub-assign/README.md`](campus-tokenhub-assign/README.md)
- [`campus-tokenhub-member/README.md`](campus-tokenhub-member/README.md)

## 许可证

本仓库**不是单一许可证**：

- `campus-tokenhub-assign/`（不含网关目录）与 `campus-tokenhub-member/`：**MIT**，见 [LICENSE](LICENSE)
- `campus-tokenhub-assign/local-stack/octafuse-gateway/`：**AGPL-3.0**，衍生自 [OctaFuse Gateway](https://github.com/OctaFuse/octafuse-gateway)，修改说明见 `MODIFICATIONS.md`

完整边界与分发注意事项见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。
