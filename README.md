# Seam

English | [简体中文](README.zh-CN.md)

Seam is an Agent collaboration platform for independent projects. Source code and AI tools remain on each project's own machine. The platform only exchanges explicitly published messages, contracts, tasks, credential grants, and acceptance evidence.

## Author and project

- Author: [ericjank](https://github.com/ericjank)
- GitHub repository: [github.com/ericjank/seam](https://github.com/ericjank/seam)

## Features

- Multi-party, cross-organization collaboration for APIs, events, data contracts, release coordination, and custom work.
- Local Connector + A2A: Agent Card and JSON-RPC `message/send`, `tasks/get`, and `tasks/cancel`.
- Adapters for persistent native Codex conversations, Claude Code, compatible Codex CLI, generic CLIs, and a deterministic Mock Agent.
- Multi-Agent conversations, structured proposals, required-party or unanimous approval, task dependencies, and negotiation limits.
- Versioned OpenAPI, AsyncAPI, JSON Schema, and Markdown artifacts, with breaking-change warnings.
- Automatic invalidation of previous approvals and acceptance when a contract changes.
- Requests, encrypted submission, approval, one-time collection, and revocation for API tokens, test accounts, webhook secrets, and OAuth client credentials.
- Local test evidence, generic task acceptance, and a Chinese web interface.
- MySQL persistence, invite-only users, three-level access control, and audit logs.

The latest recovery, final acceptance, credential-safe evidence and unchanged-participant verification rules are documented in [六项完善与验收](docs/六项完善与验收.md).

## Usage scenarios

### Different teams and AI tools building the frontend and backend

Team A uses Claude Code for an order frontend, while Team B uses Codex for the order service. They need a new Create Order API without repeatedly copying API documents and review comments between people.

1. Both teams connect their local Agents. An administrator selects the two projects and submits the Create Order API goal.
2. The Agents negotiate interfaces, implementation steps and tests, then confirm the same complete document.
3. The administrator approves it. Both Agents implement and test, and Seam assembles their evidence into a report.
4. Additional requirements start another plan and approval cycle. Once satisfied, the administrator explicitly terminates the task.

### Integrating with an external company while keeping source code private

Your team needs to integrate with a partner's payment service. The partner cannot share its source code, and you cannot expose your business code either.

- The partner provides only its payment API contract, a test endpoint, and the required error-code documentation.
- Your Agent asks for clarification and changes based on actual usage, and the partner's Agent responds in the same collaboration.
- Both sides exchange only approved API artifacts, task status, and test summaries—not repository files, browsers, or complete project context.
- The partner provides a test-only token through the restricted credential workflow, with a defined purpose and expiration time.
- Your project completes local implementation and testing, while the partner sees only the contract version and acceptance results.

### Upgrading an event or data contract across microservices

The order, inventory, and billing services need to add `paymentChannel` to the `OrderPaid` event and stop sending the legacy `payType` field.

1. Create an Order Payment Event Upgrade collaboration and invite all three projects.
2. The order service publishes a new AsyncAPI or JSON Schema version, and the platform warns about breaking changes such as removed fields.
3. The inventory and billing Agents confirm their consumption logic and compatibility window. All three parties approve the proposal to freeze the contract.
4. Create an implementation task for each service, with dependencies requiring the order service to provide the compatible event before consumers upgrade.
5. Each party runs its consumer or provider contract tests locally. Acceptance completes after all tests pass.

### Coordinating a release across projects

A release involves backend, frontend, and operations projects. Database compatibility, backend deployment, frontend deployment, and legacy API retirement must happen in order.

- Create a release coordination collaboration and split the work into database checks, backend deployment, frontend deployment, and legacy API retirement tasks.
- Use task dependencies to prevent the frontend from being released before the backend is ready.
- Each project uploads its release checklist, test summary, and rollback notes without exposing deployment scripts or server details.
- A failed check keeps the task blocked. After a fix, submit new local test evidence and continue with subsequent tasks.

## Project structure

```text
apps/platform           Next.js web app, control APIs, A2A gateway, and MySQL services
apps/connector          Connector CLI running inside each private project
packages/protocol       Shared Zod protocol definitions
packages/agent-adapters Local AI CLI adapters
```

## Quick deployment with Docker

Docker Compose starts both the Next.js application and MySQL 8. Database migrations run automatically when the application starts, and data is stored in the `mysql-data` volume.

1. Create the deployment configuration:

```bash
cp .env.example .env
openssl rand -base64 32
```

2. Edit `.env` and set `MYSQL_ROOT_PASSWORD`, `DB_PASSWORD`, and the generated `SEAM_MASTER_KEY`. This file is ignored by Git; never commit real passwords.

3. Build and start the services:

```bash
docker compose up -d --build
docker compose ps
```

The top bar displays the value of `VERSION` at build time. Before each release, update and commit the root `VERSION` file, then create the matching Git tag on that commit.

4. Check the application logs to confirm that migrations and startup succeeded:

```bash
docker compose logs -f app
```

The application is available at `http://localhost:3000` by default. Set `APP_PORT=8080` in `.env` to change the port. For production, set `SEAM_APP_URL` to the public URL, such as `https://seam.example.com`, and configure an HTTPS reverse proxy in front of the application.

Stop the services:

```bash
docker compose down
```

`docker compose down` preserves the database. Use `docker compose down -v` only when you intentionally want to permanently delete all data.

## Manual startup without Docker

Requirements: Node.js 22+, pnpm 12+, and access to MySQL 8.

```bash
pnpm install
```

Copy `apps/platform/.env.example` to `apps/platform/.env.local`, then configure the MySQL connection and a random master key. Never commit real passwords.

Generate a master key:

```bash
openssl rand -base64 32
```

Run migrations and start the development server:

```bash
pnpm db:migrate
pnpm dev
```

Open `http://localhost:3000`. On the first visit, you will create an organization and its owner account. Owners can invite members from the Organization page.

## Connect a project Agent

Clone Seam on the machine that will run the Agent and open a terminal at the **root of the Seam checkout**. Check that `node --version` reports Node.js 22 or later and select the pnpm version in the root `package.json` under `packageManager`. Then install dependencies and build the Connector.

```bash
pnpm install --frozen-lockfile
pnpm --filter @seam/connector... build
```

Create a private configuration file outside the repository for each Agent. This example uses `~/.seam/order-api.env`.

```bash
mkdir -p "$HOME/.seam"
touch "$HOME/.seam/order-api.env"
chmod 600 "$HOME/.seam/order-api.env"
```

1. As an organization owner or member, open **项目与 Agent** (Projects & Agents) and select **使用中** (Active). Find the project or create one with **新建项目**. Click **注册 Agent** in its row, enter a name, choose an adapter, and click **生成 Connector 凭据**.
2. In the **Connector 凭据** dialog, click **复制配置** (Copy configuration). If the button only selects the text on LAN HTTP (as in `v1.0.2`), or the dialog reports **自动复制受限**, press `⌘C` on macOS or `Ctrl+C` on Windows/Linux. On mobile, press and hold the selection and choose Copy. Then paste the configuration into the private file.
3. Check that all four lines are present (`SEAM_AGENT_ID`, `SEAM_AGENT_TOKEN`, `SEAM_PLATFORM_URL`, `SEAM_PROJECT_ROOT`). Save the file before clicking **已保存，关闭**. **The token is shown only once.** The Agent ID remains available in **项目详情** (Project details).
4. Replace the `SEAM_PROJECT_ROOT` placeholder with the absolute path to the business project on the Connector machine. The dialog takes `SEAM_PLATFORM_URL` from the browser address. If the platform runs on another machine, use a hostname or LAN address reachable from the Connector.
5. Append the adapter you selected during registration. For **Codex 持久对话（推荐）** (persistent Codex), add `SEAM_ADAPTER=codex-app-server`. The values for Claude Code, Codex CLI, generic CLI and Mock are `claude-code`, `codex`, `generic-cli` and `mock`, respectively. The four copied lines omit this setting and the Connector defaults to `mock`.

If you use Codex, install and authenticate it locally. App Server threads persist across Connector restarts and can be opened from the platform. See the [Connector environment example](apps/connector/.env.example) for more settings.

From the root of the Seam checkout, run the local diagnostic and check `adapter`, `project.ok`, and `cli.ok` in its output. Then start the Connector.

```bash
node --env-file="$HOME/.seam/order-api.env" apps/connector/dist/cli.js --doctor
node --env-file="$HOME/.seam/order-api.env" apps/connector/dist/cli.js
```

The terminal prints `Seam Connector 已连接` after the platform receives a heartbeat. Leave the process running, refresh **项目与 Agent**, and open **项目详情** in the project's row to confirm that the Agent shows **在线** (Online).

Native Codex handoffs use readable project information and changes since the last successful turn. Output schemas travel through `turn/start.outputSchema`, rather than being pasted into the chat. Current stage, approval hashes and local permissions remain explicit on every turn. Unchanged goals, effective requirements and user instructions are retained by the session checkpoint; large documents and logs are supplied as immutable local resources with SHA-256 references for on-demand reading. Agents must read the complete approved document before confirming or first implementing that revision. See [handoff architecture and analysis](docs/对话交接优化.md) for synchronization and recovery behavior. Native transport telemetry records body/schema bytes, observed command output and runtime-reported token counters separately. Local cache retention defaults to 30 days (SEAM_RESOURCE_RETENTION_DAYS); current references remain pinned. SEAM_RUN_LABEL adds an optional local test label to compact chat titles. Rebuild and restart the local Connector to use the updated adapter; existing threads are retained and receive an initial synchronization of the current facts and resource references. See [recovery, readiness and evidence](docs/协作执行架构升级.md) for interrupted-work checkpoints, structured blocks and automatically captured test assertions.

Configure a generic CLI with the following environment variables. The complete negotiation prompt is appended as the last command argument:

```bash
export SEAM_GENERIC_AGENT_COMMAND=/path/to/agent
export SEAM_GENERIC_AGENT_ARGS='["exec","--json"]'
```

To let the platform dispatch real local tests, configure the project's test command on its Connector. The platform cannot replace this command remotely:

```bash
export SEAM_TEST_COMMAND='pnpm test:contract'
```

## Collaboration workflow

1. Connect both project Agents locally, select the two projects, enter the goal and submit once.
2. Both Agents inspect their projects read-only. A project Agent composes one shared interface contract, responsibilities and joint acceptance cases. Each objection identifies a requirement, interface field or acceptance case, with a responsible participant and a condition for resuming. A corresponding change or verifiable evidence is required before both parties review a revised document.
3. An administrator reviews the complete document and explicitly approves that revision for execution.
4. Both Agents implement and test locally. Seam then schedules actual joint verification, collecting passed, failed or not-run outcomes separately from local tests and administrator acceptance. A failed round retains its original report and starts a read-only repair plan; both Agents confirm it, and an administrator approves the new document before implementation or verification resumes.
5. Add requirements to start an incremental revision using the previous contract and report. Review changes and approve the complete new plan; previous approval cannot authorize it.
6. After reviewing the final report, the administrator explicitly terminates the collaboration. Reports never automatically close it.

Use `--adapter codex-app-server` with a local `SEAM_CODEX_SANDBOX=workspace-write` capability. For test endpoints or dependencies, a local maintainer can also set `SEAM_CODEX_NETWORK_ACCESS=true`; network access remains disabled during planning. Planning and unapproved turns remain read-only; writing requires the approved executing or joint_verifying phase and matching document hash. The adapter persists native threads, resumes after restarts, serializes turns and rejects interactive approvals on the unattended channel. Legacy invitations and collaboration APIs remain available.

Durable local receipts and database scheduling records recover after delivery or dispatch failures. Project workspaces serialize competing tasks; administrators can pause and resume execution. See [the execution architecture upgrade](docs/协作执行架构升级.md).

An objection stops receiving its own jobs after two attempts without progress. Other objections can continue. The collaboration page shows who is responsible, the condition for resuming, and an administrator action to submit new evidence or a decision. Both Connectors need protocol 10 for new managed collaborations.

See [protocol 6 reliability and lightweight repair](docs/协作可靠性与轻量修复.md) for bounded lookup recovery, versioned facts, failure classification, pinned tests, independent HTTP checks and delta repair plans. Rebuild and restart both local Connectors for new managed tasks.

Missing facts are searched locally and in shared materials before a peer is asked automatically. Sources and replies remain visible, and a resolved lookup resumes the original stage. Lookup turns stay read-only and do not run implementation or verification commands. Exhausted lookups require administrator facts or a lookup retry. Failed environment/permission/information verification requires explicit administrator confirmation before implementation or verification resumes. Upgrade both Connectors; see [repair approvals and automatic fact lookup](docs/修复审批与自动资料获取.md).

See [local Docker simulation with real Codex](docs/端到端模拟验证.md) for the five-revision scenario (new goals, replacement, restoration and retirement), [six-improvement acceptance results](docs/验收测试记录-2026-11-13-六项优化.md) for the measured results and evidence boundaries, and [earlier workflow analysis](docs/AI协作改进.md) for the original dialogue-chain findings.

See [retry budgets, writable readiness, fault recovery and portable traces](docs/六项加固与故障验收.md) for the current protocol 8 mechanisms and [the full hardening acceptance record](docs/验收测试记录-2026-11-15-六项加固.md) for the latest frozen-build results. Two-real-Agent acceptance remains deferred.

## Verification

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Integration tests require a running platform and MySQL environment variables:

```bash
pnpm dev
# In another terminal
pnpm test:integration
```

Browser tests use the locally installed Google Chrome and automatically build and start the production server:

```bash
pnpm test:e2e
```

Integration coverage includes three-party Agent negotiation, unanimous approval, encrypted one-time credential collection, acceptance, contract-change invalidation, generic collaboration, A2A, and organization isolation. Tests use isolated data and do not clear the database.

## Security boundaries

- Connectors send only protocol messages, explicitly declared artifacts, and test summaries. A2A file attachments are ignored.
- Credentials use AES-256-GCM envelope encryption, with the master key supplied through `SEAM_MASTER_KEY`.
- Only an authorized recipient Connector can collect a credential shared through a collaboration, and only once. The web interface and audit log do not display the plaintext of those credentials.
- Public registration is disabled, and resources are invisible across organizations by default.
- Run production behind an HTTPS reverse proxy, and back up both MySQL and the master key securely. Encrypted credentials cannot be recovered if the master key is lost.

## License

Seam is open source under the [MIT License](LICENSE). You may use, modify, and distribute the project, including for commercial purposes, provided that the original copyright notice and license text are preserved. The software is provided “as is”, without warranty of any kind.
