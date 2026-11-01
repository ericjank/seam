# Seam

[English](README.md) | 简体中文

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

## 具体使用场景

### 场景一：前端与后端由不同人员、不同 AI 工具开发

订单前端由甲团队使用 Claude Code 开发，订单服务由乙团队使用 Codex 开发。双方需要新增“创建订单”接口，但不希望人员反复复制接口文档和修改意见。

1. 双方分别在自己的项目目录启动 Connector，源码保留在本地。
2. 甲团队创建“订单创建接口对接”协作，邀请订单服务项目；乙团队接受邀请。
3. 点击“运行一轮 Agent 协商”，后端 Agent 发布 OpenAPI 草案，前端 Agent 提出字段、错误码和分页方式等修改意见。
4. 双方 Agent 将最终契约整理为提案并确认同一版本，再分别生成实施任务。
5. 前端需要调用测试环境时，通过凭据流程向后端申请测试 API Token；后端所有者加密提交并授权，前端 Connector 一次性领取。
6. 双方完成开发后，在本地运行契约测试，只上传测试结果和证据。全部任务通过后协作验收完成。
7. 后续删除字段或调整响应结构时发布新契约版本，旧审批和验收自动失效，双方重新确认。

### 场景二：与外部公司联调，但双方源码都需要保密

你的团队需要接入合作方的支付服务。合作方不能提供源码，你也不能开放自己的业务代码。

- 合作方只提供支付 API 契约、测试地址和必要的错误码说明。
- 你的 Agent 根据实际调用需求提出澄清和变更请求，合作方 Agent 在同一协作中回应。
- 双方只交换允许公开的接口产物、任务状态和测试摘要，不交换仓库文件、浏览器或完整项目上下文。
- 合作方通过受限凭据流程提供仅适用于测试环境的 Token，并设置用途和有效期。
- 你的项目在本地完成调用和测试，合作方只看到契约版本及验收结果。

### 场景三：多个微服务同时升级事件或数据契约

订单、库存和结算三个服务需要给 `OrderPaid` 事件增加 `paymentChannel` 字段，并停止发送旧的 `payType` 字段。

1. 创建“订单支付事件升级”协作，三个项目作为参与方加入。
2. 订单服务发布 AsyncAPI 或 JSON Schema 新版本，平台提示删除字段等破坏性变更。
3. 库存和结算 Agent 分别确认消费逻辑及兼容窗口，三方通过提案冻结契约。
4. 为每个服务创建独立实施任务，并设置“订单服务先提供兼容事件，消费方再升级”的依赖关系。
5. 各方在本地运行消费者或提供者契约测试，全部通过后完成验收。

### 场景四：多个项目协调一次发布

一次版本发布涉及后端、前端和运维项目，需要按顺序完成数据库兼容、后端发布、前端发布和旧接口下线。

- 使用“发布协调”类型创建协作，将数据库兼容检查、后端部署、前端部署和旧接口下线拆成任务。
- 通过任务依赖阻止前端在后端尚未就绪时提前发布。
- 每个项目上传自己的发布检查单、测试摘要和回滚说明，不需要公开部署脚本或服务器信息。
- 某项检查失败时任务保持阻塞；修复后重新提交本地测试证据，再继续后续任务。

## 技术结构

```text
apps/platform           Next.js Web、控制 API、A2A 网关、MySQL 服务
apps/connector          项目本地 Connector CLI
packages/protocol       共享 Zod 协议
packages/agent-adapters 本地 AI CLI 适配器
```

## Docker 快速部署

Docker Compose 会同时启动 Next.js 应用和 MySQL 8，应用启动时自动执行数据库迁移，数据保存在 `mysql-data` 数据卷中。

1. 创建部署环境配置：

```bash
cp .env.example .env
openssl rand -base64 32
```

2. 编辑 `.env`，设置 `MYSQL_ROOT_PASSWORD`、`DB_PASSWORD` 和上一步生成的 `SEAM_MASTER_KEY`。该文件已被 Git 忽略，不要提交真实密码。

3. 构建并启动：

```bash
docker compose up -d --build
docker compose ps
```

4. 查看应用日志，确认迁移和启动成功：

```bash
docker compose logs -f app
```

默认访问 `http://localhost:3000`。如需修改端口，在 `.env` 中设置 `APP_PORT=8080`；正式部署时将 `SEAM_APP_URL` 设置为外部访问地址，例如 `https://seam.example.com`，并在应用前配置 HTTPS 反向代理。

停止服务：

```bash
docker compose down
```

`docker compose down` 不会删除数据库。只有确定需要永久删除全部数据时，才使用 `docker compose down -v`。

## 手动启动（不使用 Docker）

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
