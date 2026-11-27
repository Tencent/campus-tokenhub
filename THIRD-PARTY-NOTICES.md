# 许可证说明与第三方组件

本仓库是**多组件仓库**，不同目录适用不同许可证。使用或再分发前请确认所取代码属于哪一部分。

## 许可证地图

| 路径 | 许可证 | 版权 | 说明 |
| --- | --- | --- | --- |
| `campus-tokenhub-assign/`（不含下列网关目录） | MIT | Copyright (c) 2026 Tencent | 学校 AI 模型门户 · 统一采买站 |
| `campus-tokenhub-member/` | MIT | Copyright (c) 2026 Tencent | 学校 AI 模型门户 · 成员自购站 |
| `campus-tokenhub-assign/local-stack/octafuse-gateway/` | **AGPL-3.0** | Copyright (c) OctaFuse contributors | 修改版 fork，见下节 |

仓库根目录 `LICENSE` 为 MIT 全文，仅覆盖上表标注 MIT 的部分。

## octafuse-gateway（AGPL-3.0）

- 上游项目：[OctaFuse Gateway](https://github.com/OctaFuse/octafuse-gateway)
- 本仓库中的副本是**修改版本**，修改内容见 `campus-tokenhub-assign/local-stack/octafuse-gateway/MODIFICATIONS.md`
- 原许可证全文保留于 `campus-tokenhub-assign/local-stack/octafuse-gateway/LICENSE`
- 依 AGPL-3.0 第 5 条，该目录及其衍生作品**整体仍以 AGPL-3.0 授权**，不得按 MIT 使用、不得闭源再分发

## 组件之间的关系

`campus-tokenhub-assign` 与 `campus-tokenhub-member` 均为独立部署单元，与推理网关的交互**只有 HTTP 调用**：

- 不 import、不链接、不复制网关的任何包或源码
- 各自独立 Dockerfile、独立镜像、独立进程
- 门户不承载推理流量

依 AGPL-3.0 第 5 条末段，二者与网关构成**聚合（aggregation）**而非单一作品，因此门户代码不受 AGPL 传染，可按 MIT 授权。

## 分发注意事项

- 单独分发 `octafuse-gateway` 目录时，须随附 AGPL-3.0 全文与修改说明
- 若对外提供基于该网关的网络服务，依 AGPL-3.0 第 13 条须向服务使用者提供对应源码
- 请勿将本仓库整体声明为单一 MIT 许可
