# Benefit Hub · 组织 Worker 与 AI Review 接入

> 2026-10-23 复核。本文是工程开关和运维说明，**工作流入口已进入 dev，但不能据此宣称真实 Worker 派工或 AI Review 已通过端到端验收**。仓库默认分支/施工基线均为 `dev`。组织规范以 [sanchuang-dev/.github/AGENTS.md](https://github.com/sanchuang-dev/.github/blob/main/AGENTS.md) 当前版本为准。

## 1. 接入的三个组织能力

| 入口文件 | 用途 | 指向的组织固定版本 |
| --- | --- | --- |
| `.github/workflows/sanchuang-free-worker.yml` | 免费 MiMo / DeepSeek V2（手工/受控 Issue 评论派工） | `985ff50c297b844af65a920bd38f9c0b1ae31098` |
| `.github/workflows/sanchuang-paid-worker.yml` | OpenCode Go 付费 DeepSeek（手工/受控 Issue 评论派工） | `43a2aa17be3451c90cce6cb82425012b26096811` |
| `.github/workflows/sanchuang-ai-review.yml` | PR 触发只读 AI Review（OpenAI-compatible Gateway） | `6d61f17fa3f3c49af141d39c529639697395c665` |

相关审查重点在 `.github/ai-review/profile.md`；Review 合同由三创组织定义，不自造另一套打分标准。

## 2. Worker 触发与权限

**合入仓库默认 `dev` 后**，两个 Worker 可经 Actions 的 workflow_dispatch 在维护者明确授权已存在、状态 Open 的 Issue 后触发。两条评论入口也采用经过受控校验的全文精确指令：

- 免费：`/free-worker run`（默认 MiMo）；`/free-worker run model=deepseek-v4.1-flash-free`。
- 付费：`/paid-worker run`。**必须有明确付费施工授权**，不会从免费自动切换。
- 评论入口逐次校验原始 Issue、当前账号权限、全文命令及未被修改的评论；只能在仓库默认分支执行，交付 **Draft PR → dev**。
- 免费与付费共享 `free-worker-<repo>-<issue>` 并发锁，**不并行执行同一 Issue**。
- Worker 不得合并、关卡、部署、发布、自动创建 Issue，也没有真实供应商环境凭证。

### 当前 pnpm / Worker 验证基线

当前 `dev` **已经具备**可运行的 pnpm Workspace、lockfile、Hono/React bootstrap 和真实 `lint`、`typecheck`、`test`、`build` 脚本。两个 Worker caller 对代码补丁要求 `pnpm install --frozen-lockfile` 与全部质量检查，使用组织固定的 pnpm 10.19.0；PR #7 将原有 `node:test` 切换为 Vitest，合入之前依照 `dev` 当前实际测试命令验收。

Caller 中保留“当工作区三要件缺失时仅允许文档补丁”的历史兜底逻辑；**那不是当前仓库没有代码的证明，也不可用于规避应用代码质量验证**。暂存差异空白检查、非空补丁检查持续生效，不得通过 `true`、`echo pass` 或禁用检查伪造验收。

## 3. 初次设置（GitHub Actions）

维护者需要核实：
- Repository → Settings → Actions → General：允许 Actions 创建/审批 PR；默认 GITHUB_TOKEN 最小读权限，由调用 Job 单独提升 PR 写权限。若组织策略禁止，不能绕过。
- 付费 Worker：此**仓库**（或按仓库授权的组织级）Secret `SANCHUANG_OPENCODE_GO_API_KEY`。模型：`opencode-go/deepseek-v4.1-flash`。没有 Key 必须失败，不自动切到免费或其他付费服务。
- AI Review：此仓库需要 Variables `SANCHUANG_AI_REVIEW_ENDPOINT`（完整 HTTPS OpenAI-compatible chat/completions 路径或可追加该路径的 /v1）、`SANCHUANG_AI_REVIEW_MODEL`（网关实际支持的模型标识）；Secret `SANCHUANG_AI_REVIEW_API_KEY`。
- 组织 reusable workflow 必须允许跨仓库调用；新项目初次接入需要跑一次真实 Issue → Draft PR 和一次真实 PR Review 才能标记全链路可用。

仓库已有的 PR #6/#7 **组织 AI Review 均在配置校验阶段失败**，没有进入模型审查，见 [PR #6 Run](https://github.com/sanchuang-dev/benefit-hub/actions/runs/39746190399) 和 [PR #7 Run](https://github.com/sanchuang-dev/benefit-hub/actions/runs/39754107500)。这不能简单归因为某一个具体 Secret 缺失，因为当前没有足够证据读取其配置状态；修好后仍需真实审查成功记录。付费 Worker 凭证、免费 Worker 能否在 Benefit Hub 完成真实 Issue→Draft PR，同样尚未通过该仓库的端到端验证。

### AI Review 安全边界

`pull_request_target` 仅以目标基线 `dev` 的可信调用器运行，**不 checkout 或执行 PR head**。组织 Gateway 根据实时 PR 的 base SHA/head SHA 拉取差异、只读检查和发布当前评审结果。它不会 merge、approve、修改代码或发布。缺少有效的 endpoint/model/key 时，配置 Job 明确失败，避免伪装审查成功。

Review 的结论是组织 P0–P2 缺陷与验证缺口判断，**不替代人工代码审查、实际运行验收或本仓库负责人合并决定**。

## 4. 生效与核验步骤

1. **Caller 已合入默认 `dev`**，仍要核对默认分支当前工作流和权限；文件存在或历史 PR 合并不意味着每条派工链已成功烟测。
2. 核实上述权限、Secrets、Variables；**仅公开仓库代码与文档，不暴露任何 Key**。
3. 选一张明确授权的低风险 Open Issue 验证免费或付费 Worker，检查 `worker → verify → delivery`、Draft PR 的 base、diff 与实际 CI。
4. 提交有实质差异的 `feat/* → dev` 测试 PR，核对 AI Review 的组织标准化评审评论及当前 commit 身份。
5. 记录上述 Run URL、成功/失败状态和缺口；没有证据不得宣称“牛马/Review 可用”。

## 5. 不做

- 不给 Worker 生产 SSH、服务器 Docker socket、供应商 AppSecret 或部署权限。
- 不把 PR 事件作为自动施工授权；只有符合组织合同的 Open Issue 可派。
- 不在这个接入 PR 添加 Hono/React 应用、供应商真实调用、Docker 发布脚本。
- 不将 `dev` 自动部署规则扩展至 Worker 的 feature 分支；业务发布另按 `docs/operations.md` 审定。
