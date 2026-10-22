# Benefit Hub · 系统级原型部署与运维

> 阶段：原型。内部已部署基础容器；目标公网 HTTPS 入口正在纳入 `proto-infra`。本文件区分已实证与待验证，不把配置意向写成生产成功。

## 1. 两个仓库、两套发布纪律

| 责任 | 所属仓库 | 工程分支 |
| --- | --- | --- |
| Hono + React、Docker 镜像、SQLite 挂载、服务健康 | `sanchuang-dev/benefit-hub` | `feat/* → dev`，`dev` 自动构建/部署 |
| 域名、Caddy 站点规则、公司原型展示基建 | `sanchuang-dev/proto-infra` | `feat/* → dev → test → prod`，只允许 `prod` 改现网 Caddy |

**演示域名**：`benefit.proto.3cgroup.cn`，由宿主机 Caddy 反向代理到 `127.0.0.1:18080`。本仓库部署流程不修改 Caddy。其他原型站点继续由 `proto-infra` 负责，不能改变其路径、端口或认证策略。

## 2. 已确认的服务器状态（2026-10-22）

只读检查证据：[Run #39729642393](https://github.com/sanchuang-dev/benefit-hub/actions/runs/39729642393)。

- Alibaba Cloud Linux 3，约 2C / 1.8GiB 内存，40GiB 系统盘。
- Docker Engine 26.1.3、Docker Compose v2.27.0 已安装，Caddy 运行中；服务器无 Swap。
- SSH 通过受控 Secret 和记录过的主机公钥指纹验证；不禁用主机校验。
- 数据路径：`/srv/benefit-hub/data` → 容器 `/data`（目录已建立，后续实际 SQLite 备份/恢复尚未演练）。

第一次 `dev` 部署证据：[Run #39730933459](https://github.com/sanchuang-dev/benefit-hub/actions/runs/39730933459)。

- pnpm 冻结安装、Lint/TS/测试、前端和 Docker 构建、容器 HTTP 冒烟检查全部通过。
- 镜像 `benefit-hub:cb0e8973423b5052f660e1710031494bd0c2a005` 已送到服务器，并以 Compose 独立运行。
- 宿主机监听地址 `127.0.0.1:18080`，`GET /healthz` 返回 `{"status":"ok","service":"benefit-hub"}`。
- **尚未验证首次实际 HTTPS 路由与公网访问**。当前服务只有基础设施验收页和系统状态接口，发券/运营管理处于关闭状态。

## 3. 镜像发布流程

`dev` push 在 GitHub Actions 中构建并测试，保存带完整 commit SHA 的不可变镜像，然后通过已认证的 SSH/SCP 送到阿里云 `/srv/benefit-hub`。更新应用自身 Compose 项目，前一个健康镜像可用于代码回滚。不得把构建任务压给 2C2G 服务器。

`feat/*` PR 只能验证，不触发远程部署。容器端口只绑定 127.0.0.1，不开放公网 18080。不要在应用容器中再启动 Caddy/Nginx。

## 4. 公网原型接入门槛

1. 在 `proto-infra` 通过 `feat/* → dev → test → prod` 单独登记 Caddy 站点 `benefit.proto.3cgroup.cn`；使用显式反代 `127.0.0.1:18080`。
2. 确认 DNS 指向本台服务器、已有 Caddy 配置无未登记改动、应用健康后才允许按基础设施仓库的流程发布。
3. 发布后实际请求 `https://benefit.proto.3cgroup.cn/` 和 `/healthz`，核实 TLS、反代响应和 `X-Robots-Tag: noindex, nofollow`。
4. 验证已有 `proto.3cgroup.cn` 门户及镜类原型未回归。如果任一验证失败，应在保存现场证据后按 `proto-infra` 的回滚方案处理。
5. 该原型仅演示系统能力：前端需明确标明“原型”，不得以模拟的发券/余额/履约状态欺骗使用者。

## 5. 秘密与数据

当前复用本仓库 GitHub Actions Secrets：`PROTO_HOST`、`PROTO_USER`、`PROTO_SSH_PORT`、`PROTO_SSH_KEY`；最后一项历史命名对应 **SSH 密码**。这些用于部署，不可当作业务运行时 Secrets。

SQLite 在单容器单实例持久化；真实数据库实现、Schema 迁移和一致性备份验证尚未交付。后续如果需用羊毛供应商沙箱联调，先补独立授权、响应审计、幂等和安全条件。**默认不得对真实用户、真实额度或真实卡密执行发放。**

## 6. 当前待做而未假定完成的事项

- `proto-infra` Caddy 路由经 prod 发布、HTTPS 和现有站点回归验证。
- 系统级原型的商品、订单、发放流程和运营后台模块。
- SQLite Schema、真实持久化/恢复演练；供应商详细接口状态及沙箱联调。
- 组织 Worker 与 AI Review 的真实端到端执行验证（workflow 文件存在不代表模型凭证可用）。

`design.md` 仅用于界面视觉、布局与交互规范；不把本文件写入该文件。
