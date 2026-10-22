# Benefit Hub · 第一阶段部署与运维约定

> 2026-10-22 已确定的环境策略及待验证操作。**不是部署完成记录。**
>
> 架构见 [architecture.md](./architecture.md)，产品范围见 [product-scope.md](./product-scope.md)。`sanchuang-dev/proto-infra` 继续独立维护其静态原型和 Caddy 约定。

## 1. 仓库与分支

- 组织：`sanchuang-dev`，仓库：`benefit-hub`，**Public**。
- 依照用户明确的第一阶段项目例外：**`feat/* -> dev`**，`dev` 同时是默认分支/集成分支和唯一部署源。
- 不创建 `main`、`test`、`prod` 环境分支；未来调整时单独修订仓库 `AGENTS.md` 与工作流。
- `feat/*` 的 PR 只跑检查、不触发部署。合并到 `dev` 后才进入可自动部署路径；上游合作方真实发券等外部副作用仍须按授权与验收执行。
- 组织通用政策不改动；这个分支例外只适用于 `benefit-hub`。

## 2. 服务器及隔离

目标是公司**新买的**、目前用于原型展示的阿里云 2C2G 服务器；必须先核实机型、内存、磁盘、Docker/Compose、现有监听端口及 Caddy 现状，不能把仓库 README 当运行时证明。

```text
外部 HTTPS
    |
宿主机现有 Caddy（保持原型服务正常）
    |
127.0.0.1:18080（提议端口，未检查占用）
    |
Benefit Hub 单应用容器（Hono + React 静态产物）
    |
/data/benefit.sqlite
    |
宿主机 /srv/benefit-hub/data（独立持久化）
```

- 服务器**只运行构建好的镜像**；Node/pnpm 依赖安装与前端编译在 GitHub Actions/CI，不能默认在 2C2G 服务器编译。
- 应用单容器，**不启动第二套 Caddy/Nginx**，也不需要 SQLite 容器。
- 宿主机端口仅监听 `127.0.0.1`；外部 80/443 继续由现有 Caddy 管理。
- Docker/Compose 运行目录、挂载和权限独立于 `/srv/proto`；不能清理或覆盖已存在的原型网站。
- 容器以非 root 运行；镜像内不嵌供应商 Secret、SSH 密码、管理员明文密码。
- `Dockerfile`、`compose.yaml` 当前是**工程草案**，应用工作区及 lockfile 未落地，不能声称可成功构建/运行。

## 3. 镜像构建及交付

目前倾向：

1. 对 `feat/*` PR 执行 pnpm lint/typecheck/test/build，并验证 Docker 构建。
2. 经审查合并到 `dev`，CI 再构建同一来源的容器镜像，按**不可变 commit SHA** 标记。
3. 镜像通过 GHCR 或安全的镜像传输方式送到公司服务器；**是否使用 GHCR、访问权限和国内网络可达性仍需验证**，不能提前断言已接通。
4. 部署仅更新 Benefit Hub 的独立 Compose 服务；持久化目录不随镜像替换删除。
5. 验证容器健康检查、`GET /healthz`、后台登录入口、真实 HTTPS 访问和已存在原型站点未受影响。

**当前尚未实现自动部署 workflow**；目标是将来 `dev` 合并可自动部署，并保留失败停止与上一个健康镜像回退。

## 4. SSH 与 Secrets

仓库沿用四个既有命名：

| GitHub Actions Secret | 用途 |
| --- | --- |
| `PROTO_HOST` | 目标服务器主机/IP |
| `PROTO_USER` | SSH 用户名 |
| `PROTO_SSH_PORT` | SSH 端口 |
| `PROTO_SSH_KEY` | **SSH 登录密码**（名称沿用，不解释成私钥） |

用户已表示配置了新仓库 Secret，但我们**无法读取其值，也尚未用 workflow 验证实际可用**。不另造 `PROTO_PASSWORD` 命名，也不因实现工具方便擅自改为私钥认证。

部署前核验 SSH 主机身份，不关闭主机验证；勿在日志、命令行参数输出或仓库中暴露密码。管理后台 Session Secret、羊毛 AppSecret 等**运行时**秘密与上述 SSH 部署密钥分别管理，待首次联调时明确加载方式。

## 5. SQLite 数据安全

- 首期只有一个应用写实例，文件位于 `/data/benefit.sqlite`（挂载宿主机 `/srv/benefit-hub/data`，路径可经确认调整）。
- 原定运行 UID/GID 10001，首次部署前检查目录权限与宿主机所有权。
- 使用 SQLite 一致性备份机制（backup API 或 `VACUUM INTO` 等），不能只复制正在使用的主 DB 而忽略 WAL。
- 数据库 migration 与镜像升级分开审查；回滚镜像不等于回滚数据结构，禁止自动删库/重建。
- 避免多个服务实例/容器同时把同一个 SQLite 文件当多主数据库使用。
- 启用备份保留和实际恢复演练后才可承载真实权益扣减与发放记录。

## 6. 发布门槛与验收证据

- [ ] 仓库已具备 pnpm workspace、锁文件、可构建 Hono API、React Admin，且镜像构建验证通过。
- [ ] 公司新服务器 Docker/Compose、磁盘/内存、端口占用和已运行 Caddy/原型服务已读检查。
- [ ] SSH 凭证实际可用、主机身份已核实；无明文 Secret 进入 CI 日志或镜像。
- [ ] SQLite 挂载目录存在、文件权限正确，重建容器后数据仍存在。
- [ ] 镜像有可回退的上一个健康版本，数据库迁移与备份有明确恢复方案。
- [ ] Caddy 新站点路由经验证，已有网站不回归，真实 HTTPS 入口可访问。
- [ ] 业务发券启用前，签名、幂等、异常恢复、管理员访问控制通过合同与真实联调验收。

**明确禁止**：自动部署触发时无条件安装 Docker、开放新公网端口、覆盖 `/etc/caddy/Caddyfile`、修改别的项目 Compose 服务、删除挂载的数据目录。

## 7. 第一阶段仍未确定的基础设施细节

- Benefit Hub 域名、Caddy 站点配置位置和内网监听端口（18080 暂为提议）。
- Docker/Compose 是否已安装，2C2G 当前资源是否足够，实际系统与磁盘容量。
- 镜像发布与拉取路径：GHCR 直拉或可靠的其他传输途径。
- 生产环境的应用级密钥和管理员初始化/更换方案。
- 备份位置、自动化频率及恢复演练责任。

这些须以真实服务器检查结果为准，不允许凭历史对话或静态仓库文件推断上线成功。
