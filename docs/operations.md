# Benefit Hub · 第一阶段部署与运维约定

> 2026-10-23 更新：**基础容器及公网 HTTPS 入口已完成实证**；管理员登录与最小权限已在代码中实现（BHB-002），线上验收、真实供应商业务能力及备份恢复仍需单独交付、验证。此文不代表真实权益运营就绪。
>
> 架构见 [architecture.md](./architecture.md)，产品范围见 [product-scope.md](./product-scope.md)。`sanchuang-dev/proto-infra` 继续独立维护其静态原型和 Caddy 约定。

## 1. 仓库与分支

- 组织：`sanchuang-dev`，仓库：`benefit-hub`，**Public**。
- 依照用户明确的第一阶段项目例外：**`feat/* -> dev`**，`dev` 同时是默认分支/集成分支和唯一部署源。
- 不创建 `main`、`test`、`prod` 环境分支；未来调整时单独修订仓库 `AGENTS.md` 与工作流。
- `feat/*` 的 PR 只跑检查、不触发部署。合并到 `dev` 后才进入可自动部署路径；上游合作方真实发券等外部副作用仍须按授权与验收执行。
- 组织通用政策不改动；这个分支例外只适用于 `benefit-hub`。

## 2. 服务器及隔离

基础设施已经通过 GitHub Actions 远程检查：公司阿里云原型服务器 8.148.148.135，Docker/Compose 与 Caddy 已运行；Benefit Hub 应用容器在独立目录部署。未来修改网络/部署策略时仍必须重新核实现场状态，不能把静态文档当运行时证明。

```text
外部 HTTPS
    |
宿主机现有 Caddy（保持原型服务正常）
    |
127.0.0.1:18080（已验证的回环监听端口）
    |
Benefit Hub 单应用容器（Hono + React 静态产物）
    |
/data/benefit.sqlite（规划，业务库尚未落地）
    |
宿主机 /srv/benefit-hub/data（独立持久化）
```

- 服务器**只运行构建好的镜像**；Node/pnpm 依赖安装与前端编译在 GitHub Actions/CI，不能默认在 2C2G 服务器编译。
- 应用单容器，**不启动第二套 Caddy/Nginx**，也不需要 SQLite 容器。
- 宿主机端口仅监听 `127.0.0.1`；外部 80/443 继续由现有 Caddy 管理。
- Docker/Compose 运行目录、挂载和权限独立于 `/srv/proto`；不能清理或覆盖已存在的原型网站。
- 容器以非 root 运行；镜像内不嵌供应商 Secret、SSH 密码、管理员明文密码。
- 当前 Dockerfile、compose.yaml、pnpm workspace 与 lockfile 已进入 dev；已完成构建、容器健康检查和原型入口访问，**并不意味着登录、订单或数据库业务功能已实现**。

## 3. 镜像构建及交付

当前基础部署路径已验收，后续业务版本仍按相同安全门槛推进：

1. 对 `feat/*` PR 执行 pnpm lint/typecheck/test/build，并验证 Docker 构建。
2. 经审查合并到 `dev`，CI 再构建同一来源的容器镜像，按**不可变 commit SHA** 标记。
3. 当前 CI 将已构建验证的镜像导出为归档文件，经已核验主机身份的 SSH 传输到公司服务器并 docker load；**没有声称已接入 GHCR**。
4. 部署仅更新 Benefit Hub 的独立 Compose 服务；持久化目录不随镜像替换删除。
5. 验证容器健康检查、`GET /healthz`、后台登录入口、真实 HTTPS 访问和已存在原型站点未受影响。

**当前已有 dev push 构建与自动部署 workflow**：feature PR 只进行 CI，dev push 会构建镜像并尝试部署。即使是纯文档合并，也会触发不必要的容器重建/部署；需要在工作流演进时加入文档路径排除或其他经审核的跳过机制。

## 4. SSH 与 Secrets

仓库沿用四个既有命名：

| GitHub Actions Secret | 用途 |
| --- | --- |
| `PROTO_HOST` | 目标服务器主机/IP |
| `PROTO_USER` | SSH 用户名 |
| `PROTO_SSH_PORT` | SSH 端口 |
| `PROTO_SSH_KEY` | **SSH 登录密码**（名称沿用，不解释成私钥） |

上述仓库 Secret 的登录链路已通过实际 GitHub Actions 验证；**无法也不应该回显其值**。不另造 `PROTO_PASSWORD` 命名，也不因实现工具方便擅自改为私钥认证。

部署前核验 SSH 主机身份，不关闭主机验证；勿在日志、命令行参数输出或仓库中暴露密码。管理后台 Session Secret、羊毛 AppSecret 等**运行时**秘密与上述 SSH 部署密钥分别管理，待首次联调时明确加载方式。

### 管理员账号初始化与重置（BHB-002）

- 代码中**不存在**默认管理员账号或默认密码；首次部署后由运维管理员在服务器上创建账号。
- 密码只从标准输入读取，且必须通过管道传入，避免进入 shell 历史、进程参数或镜像层：

```bash
# 在容器内创建首个管理员（密码不回显）
read -rs ADMIN_PASSWORD
printf '%s' "$ADMIN_PASSWORD" | docker compose --project-name benefit-hub \
  exec -T benefit-hub node dist/cli/admin.js create --username ops --password-stdin
```

- 其他命令：`create --role viewer` 创建只读账号、`reset-password` 重置密码、`disable` 停用账号、`list` 列出账号。重置密码或停用会同时撤销该账号的全部现有会话。
- 密码策略：至少 12 个字符、不超过 256 个字符、首尾不能为空白、不能包含账号名。
- 数据库迁移在应用启动时按序自动应用（`schema_migrations` 记录），只允许新增；镜像回滚不会自动回滚或删除数据结构。

### 登录相关的运行时配置

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `DATABASE_FILE` | `/data/benefit.sqlite` | 持久化卷内路径 |
| `SESSION_TTL_HOURS` | `8` | 会话绝对有效期（1–168） |
| `COOKIE_SECURE` | `NODE_ENV=production` 时为 true | 生产必须保持 true；本地 http 联调才可关闭 |
| `TRUST_PROXY` | `false`（compose 为 `true`） | 仅当宿主机 Caddy 在容器前时才信任 `X-Forwarded-For` |

登录限速（同一账号 15 分钟 5 次失败、同一来源 15 分钟 20 次）保存在进程内存，重启只会解除锁定，不会放行凭据。

## 5. SQLite 数据安全

- 首期只有一个应用写实例，文件位于 `/data/benefit.sqlite`（挂载宿主机 `/srv/benefit-hub/data`，路径可经确认调整）。
- 原定运行 UID/GID 10001，首次部署前检查目录权限与宿主机所有权。
- 使用 SQLite 一致性备份机制（backup API 或 `VACUUM INTO` 等），不能只复制正在使用的主 DB 而忽略 WAL。
- 数据库 migration 与镜像升级分开审查；回滚镜像不等于回滚数据结构，禁止自动删库/重建。
- BHB-002/BHB-003 引入的迁移只做 `CREATE TABLE/INDEX`，启动时自动应用并记录；已有管理员账号、会话与审计记录在重启和再次迁移后保留（由 `apps/api/test/db-migrations.test.ts` 验证）。会话存在 SQLite 中，容器重启后仍然有效，直到绝对有效期结束、退出、改密或停用。内部商品及其操作审计同样保存在该文件中，停用商品不会删除行或历史。
- 避免多个服务实例/容器同时把同一个 SQLite 文件当多主数据库使用。
- 启用备份保留和实际恢复演练后才可承载真实权益扣减与发放记录。

## 6. 发布门槛与验收证据

- [x] 仓库已具备 pnpm workspace、锁文件、可构建 Hono API 和 React 占位页，基础镜像构建验证通过；实际运营页面仍待实现。
- [x] 公司原型服务器 Docker/Compose、端口占用及 Caddy/原型服务已读检查（后续变更须复核）。
- [x] SSH 凭证链路和主机指纹已在 CI 实测通过；不得回显 Secret。
- [ ] SQLite 挂载目录存在、文件权限正确，重建容器后数据仍存在（BHB-002 仅在本地临时 SQLite 验证迁移/重启，未在服务器复核）。
- [ ] 镜像有可回退的上一个健康版本，数据库迁移与备份有明确恢复方案。
- [x] Caddy Benefit Hub 新站点和 HTTPS 健康检查通过，发布作业也回归检查了既有原型站点；账号密码登录已在代码中实现并通过本地 HTTP/SQLite 测试，**线上登录验收仍未进行**。
- [ ] 业务发券启用前，签名、幂等、异常恢复、管理员访问控制通过合同与真实联调验收。

**明确禁止**：自动部署触发时无条件安装 Docker、开放新公网端口、覆盖 `/etc/caddy/Caddyfile`、修改别的项目 Compose 服务、删除挂载的数据目录。

## 7. 第一阶段仍未确定的基础设施细节

- Benefit Hub 域名、Caddy 站点配置和 18080 回环端口已验证；未来变更仍归 proto-infra 与 Benefit Hub 各自仓库所有。
- Docker/Compose 与基本可运行性已验证；实际业务负载下的 2C2G 资源容量仍需测量。
- 当前使用 CI 镜像归档经 SSH 传输，未来是否改用 GHCR 需另行验证国内网络和安全性。
- 生产环境的应用级密钥和管理员初始化/更换方案。
- 备份位置、自动化频率及恢复演练责任。

部署证据（2026-10-22）：[应用基础构建/部署](https://github.com/sanchuang-dev/benefit-hub/actions/runs/39738038904)、[公网 Caddy/HTTPS 真实验收](https://github.com/sanchuang-dev/proto-infra/actions/runs/39741032139)。

**本期还缺**：线上管理员初始化与登录验收、备份恢复演练、真实供应商接口凭证与联调、履约订单与安全发放流程。任何进一步上线声明都必须凭新证据，不能凭上述基础设施部署替代。
