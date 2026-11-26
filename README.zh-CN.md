# Seam

[English](README.md) | 简体中文

Seam 是一个面向多个独立项目的 Agent 协作平台。各项目源码和 AI 工具保留在本地，平台只传递显式发布的消息、契约、任务、凭据授权和验收证据。

## 作者与项目

- 作者：[ericjank](https://github.com/ericjank)
- GitHub 仓库：[github.com/ericjank/seam](https://github.com/ericjank/seam)

## 已实现

- 多方、跨组织项目协作：接口、事件、数据契约、发布协调和自定义工作。
- 本地 Connector + A2A：Agent Card、JSON-RPC `message/send`、`tasks/get`、`tasks/cancel`。
- Claude Code、Codex 原生持久对话、兼容 Codex CLI、通用 CLI 和确定性 Mock Agent 适配器。
- 多 Agent 对话、提案、必要参与方/全体一致确认、任务依赖和协商轮次限制。
- OpenAPI、AsyncAPI、JSON Schema、Markdown 等产物版本、差异内容和破坏性变更提示。
- 契约变更后自动作废旧提案、审批和验收状态。
- API Token、测试账号、Webhook Secret、OAuth Client 凭据的申请、加密提交、审批、一次性领取和撤销。
- 本地测试证据、通用任务验收和中文 Web 操作界面。
- MySQL 持久化、邀请制用户、三级访问控制和操作审计。

## 具体使用场景

### 场景一：前端与后端由不同人员、不同 AI 工具开发

订单前端由甲团队使用 Claude Code 开发，订单服务由乙团队使用 Codex 开发。双方需要新增“创建订单”接口，但不希望人员反复复制接口文档和修改意见。

1. 双方在本地连接 Connector，管理员选择两个在线项目并填写“创建订单接口”目标。
2. 两端 AI 自动分析接口、字段、错误码、分工和测试，汇总文档并确认同一版本。
3. 管理员阅读完整实施文档后点击执行，两端自动开发和测试，平台汇总报告。
4. 若订单字段或响应仍需调整，管理员补充要求，重新协商并批准下一轮。
5. 最终满意后由管理员手动终止，保留所有版本的文档、报告与对话。

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

中心顶栏显示构建时的 `VERSION`。每次发版前，先把仓库根目录的 `VERSION` 更新为目标版本并提交，再给该提交打同名 Git 标签。

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

在运行 Agent 的机器上克隆本仓库，进入 **Seam 仓库根目录**。用 `node --version` 确认当前终端使用 Node.js 22 或更高版本，按根目录 `package.json` 的 `packageManager` 选择 pnpm 版本，然后安装依赖并构建 Connector。

```bash
pnpm install --frozen-lockfile
pnpm --filter @seam/connector... build
```

为每个 Agent 在仓库外准备独立的配置文件。下例使用 `~/.seam/order-api.env`。

```bash
mkdir -p "$HOME/.seam"
touch "$HOME/.seam/order-api.env"
chmod 600 "$HOME/.seam/order-api.env"
```

1. 以组织所有者或成员身份打开「项目与 Agent」→「使用中」。找到目标项目，或点「新建项目」创建。在该项目行点「注册 Agent」，填写名称、选择适配器，再点「生成 Connector 凭据」。
2. 在「Connector 凭据」弹窗点「复制配置」。若内网 HTTP 页面只选中了文本（如 `v1.0.2`），或提示「自动复制受限」，直接按 `⌘C`（macOS）或 `Ctrl+C`（Windows/Linux），手机可长按选区选「复制」。然后将配置粘贴到刚准备的文件。
3. 确认文件里有完整的四行 `SEAM_AGENT_ID`、`SEAM_AGENT_TOKEN`、`SEAM_PLATFORM_URL`、`SEAM_PROJECT_ROOT`，保存后再点「已保存，关闭」。**Token 只显示这一次**，Agent ID 以后仍可在「项目详情」查看。
4. 将 `SEAM_PROJECT_ROOT` 的占位值换成本机业务项目的绝对路径。弹窗中的 `SEAM_PLATFORM_URL` 取自当前浏览器地址。如果平台在另一台机器上，请填写 Connector 能访问的平台域名或内网地址。
5. 在同一文件追加与注册时一致的适配器。选了「Codex 持久对话（推荐）」就写 `SEAM_ADAPTER=codex-app-server`。Claude Code、Codex CLI、通用 CLI 和 Mock 分别对应 `claude-code`、`codex`、`generic-cli` 和 `mock`。弹窗的四行配置不含此项，省略时 Connector 默认使用 `mock`。

使用 Codex 时，请先在本机安装并登录。持久对话模式可在 Connector 重启后续接原对话，也可从平台打开本机对话。更多配置见 [Connector 环境变量示例](apps/connector/.env.example)。

从 Seam 仓库根目录运行本地诊断，核对输出中的 `adapter`、`project.ok` 和 `cli.ok`，然后启动 Connector。

```bash
node --env-file="$HOME/.seam/order-api.env" apps/connector/dist/cli.js --doctor
node --env-file="$HOME/.seam/order-api.env" apps/connector/dist/cli.js
```

终端显示 `Seam Connector 已连接` 表示平台已收到心跳。保持进程运行，刷新「项目与 Agent」，展开该行的「项目详情」，确认对应 Agent 显示「在线」。

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

1. 两端在各自项目连接 Connector；管理员选择两端项目、填写目标并提交，平台自动加入双方并启动协商。
2. 双方 AI 只读分析项目。协调方 Agent 汇总统一接口契约、责任划分和联合验收用例。双方审阅同一文档，异议绑定需求、接口字段或验收用例，并指定责任方和恢复条件。相关修改或可核验证据收齐后，平台发布新文档并重新收集双方确认。
3. 管理员在平台阅读完整文档，点击“确认文档并执行”。AI 自身确认和提案审批不能代替此授权。
4. 两端按批准文档实施并运行本地测试，然后由平台自动推进真实联合验收，逐项记录通过、失败或未执行。失败后自动保留原报告并只读起草修复方案；双方确认后，仍需管理员批准新版，才重新实施和验证。
5. 管理员可补充要求开启下一轮，双方复用上版契约和报告，围绕变化生成完整新版文档并重新确认、批准。平台展示变更和影响项目，旧版授权不能用于新版。
6. 满意后管理员点击“满意，确认终止任务”。报告收齐不会自行终止，失败报告保持失败状态。

如需允许 Codex 在批准的实施阶段写入项目，可在该 Agent 的私有配置文件中设置 `SEAM_CODEX_SANDBOX=workspace-write` 并重启 Connector。

需要 Agent 在实施时访问测试接口或拉取依赖，可由本机维护者一次性设置 `SEAM_CODEX_NETWORK_ACCESS=true`，并用 `--doctor` 检查。默认关闭网络；规划阶段始终不开放网络。

`workspace-write` 只是本地能力上限：规划、文档确认及无有效授权时仍强制只读；只有 `executing` / `joint_verifying` 且本轮批准指纹匹配时才开放项目内写入。平台文字不能提升本地权限。会话映射按项目、协作和参与方保存在本机，支持重启续接、串行互斥及同一 job 的结果复用。后台交互审批会明确拒绝。

Connector 持久化待发送回执，平台持久化后续调度意图，心跳与轮询自动恢复；同一工作区的不同任务排队写入。管理员可暂停并恢复协作。详见 [协作执行架构升级](docs/协作执行架构升级.md)。

每项异议独立派发。连续两轮没有对应变化或新证据时，Seam 停止派发该项，其他异议可继续处理。「契约异议」显示责任项目、Agent 和恢复条件，管理员可提交该项的新证据或业务决定。新自动协作需要两端 Connector 支持协议 10。

缺失事实由各端 Agent 先查本地和共享资料，再自动向对端询证；查找结果和来源在平台显示，找到后续接。查找任务始终只读，不运行实施或验证命令；穷尽或需要真实权限时才请管理员介入。两端需升级 Connector，详见[修复审批与自动资料获取](docs/修复审批与自动资料获取.md)。

旧协作和跨组织邀请仍保留原有独立流程。完整模拟见 [本地 Docker 与真实 Codex 联调](docs/端到端模拟验证.md)，先前实际对话链路的问题分析见 [AI 协作改进](docs/AI协作改进.md)。

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
- 协作中提交的业务凭据仅供获授权的接收方 Connector 一次性领取，网页和审计记录不回显这些凭据的明文。
- 平台不接受公开注册，跨组织资源默认不可见。
- 生产部署应在 HTTPS 反向代理之后运行，并妥善备份 MySQL 和主密钥。丢失主密钥将无法恢复已加密凭据。

## 开源协议

Seam 使用 [MIT License](LICENSE) 开源。你可以自由使用、修改和分发本项目，包括用于商业用途，但需保留原作者的版权声明和协议文本。软件按“现状”提供，不附带任何担保。
