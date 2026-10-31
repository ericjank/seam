# Seam

Seam 是一个面向多个独立项目的 Agent 协作平台。各项目源码和 AI 工具保留在本地，平台只传递显式发布的消息、契约、任务、凭据授权和验收证据。

## 作者与项目

- 作者：[ericjank](https://github.com/ericjank)
- GitHub 仓库：[github.com/ericjank/seam](https://github.com/ericjank/seam)

## 已实现

- 多方、跨组织项目协作：接口、事件、数据契约、发布协调和自定义工作。
- 本地 Connector + A2A：Agent Card、JSON-RPC `message/send`、`tasks/get`、`tasks/cancel`。
- Claude Code、Codex CLI、通用 CLI 和确定性 Mock Agent 适配器。
- 多 Agent 对话、提案、必要参与方/全体一致确认、任务依赖和协商轮次限制。
- OpenAPI、AsyncAPI、JSON Schema、Markdown 等产物版本、差异内容和破坏性变更提示。
- 契约变更后自动作废旧提案、审批和验收状态。
- API Token、测试账号、Webhook Secret、OAuth Client 凭据的申请、加密提交、审批、一次性领取和撤销。
- 本地测试证据、通用任务验收和中文 Web 操作界面。
- MySQL 持久化、邀请制用户、三级访问控制和操作审计。

## 技术结构

```text
apps/platform           Next.js Web、控制 API、A2A 网关、MySQL 服务
apps/connector          项目本地 Connector CLI
packages/protocol       共享 Zod 协议
packages/agent-adapters 本地 AI CLI 适配器
```

## 启动

要求 Node.js 22+、pnpm 12+ 和可访问的 MySQL 8。

```bash
pnpm install
```

复制 `apps/platform/.env.example` 为 `apps/platform/.env.local`，填写 MySQL 连接和随机主密钥。真实密码不要提交到仓库。

生成主密钥：

```bash
openssl rand -base64 32
```

执行迁移并启动：

```bash
pnpm db:migrate
pnpm dev
```

访问 `http://localhost:3000`，首次进入会要求创建组织与所有者账号。所有者可在“组织”页创建受邀成员。

## 接入项目 Agent

1. 在“项目与 Agent”页创建项目并注册 Agent。
2. 保存只显示一次的 Agent ID 和 Token。
3. 在对应项目的私有目录运行 Connector，不要把 Token 写入项目仓库。

```bash
pnpm build

node apps/connector/dist/cli.js \
  --platform http://localhost:3000 \
  --agent-id <AGENT_ID> \
  --token <AGENT_TOKEN> \
  --project-root /path/to/private/project \
  --adapter mock
```

`--adapter` 可选 `claude-code`、`codex`、`generic-cli`、`mock`。真实 AI CLI 必须事先在本地安装并登录。

通用 CLI 通过以下环境变量配置；命令最后一个参数会收到完整协商提示：

```bash
export SEAM_GENERIC_AGENT_COMMAND=/path/to/agent
export SEAM_GENERIC_AGENT_ARGS='["exec","--json"]'
```

如需由平台派发真实本地测试，在 Connector 上配置项目自己的测试命令。平台不会远程替换该命令：

```bash
export SEAM_TEST_COMMAND='pnpm test:contract'
```

## 协作流程

1. 创建协作并邀请其他项目；目标项目成员接受邀请。
2. 点击“运行一轮 Agent 协商”，各 Connector 领取任务并返回结构化消息和动作。
3. 将契约或文档整理为提案，必要参与方确认同一版本后开始实施。
4. 需要联调凭据时，通过独立凭据流程申请、提交、审批和一次性领取。
5. 各项目在本地实施和测试，只提交测试摘要与证据。
6. 所有任务完成后协作验收完成；契约变更会重新打开相关流程。

## 验证

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

集成测试需要运行中的平台及 MySQL 环境变量：

```bash
pnpm dev
# 另一个终端
pnpm test:integration
```

浏览器测试默认使用本机已安装的 Google Chrome，并自动构建、启动生产服务：

```bash
pnpm test:e2e
```

集成测试覆盖三方 Agent 协商、一致确认、凭据加密与一次性领取、验收、契约变更失效、通用协作、A2A 和组织隔离。测试使用独立数据，不清空数据库。

## 安全边界

- Connector 只发送协议消息、显式声明的产物和测试摘要；A2A 文件附件会被忽略。
- 凭据采用 AES-256-GCM 信封加密，主密钥由 `SEAM_MASTER_KEY` 提供。
- Web 和审计不回显凭据明文；只有获授权的接收方 Connector 能一次性领取。
- 平台不接受公开注册，跨组织资源默认不可见。
- 生产部署应在 HTTPS 反向代理之后运行，并妥善备份 MySQL 和主密钥。丢失主密钥将无法恢复已加密凭据。

## 开源协议

Seam 使用 [MIT License](LICENSE) 开源。你可以自由使用、修改和分发本项目，包括用于商业用途，但需保留原作者的版权声明和协议文本。软件按“现状”提供，不附带任何担保。
