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

1. Create a project and register an Agent from the Projects & Agents page.
2. Save the Agent ID and token, which are displayed only once.
3. Run the Connector in the corresponding private project directory. Never store the token in the project repository.

```bash
pnpm build

node apps/connector/dist/cli.js \
  --platform http://localhost:3000 \
  --agent-id <AGENT_ID> \
  --token <AGENT_TOKEN> \
  --project-root /path/to/private/project \
  --adapter mock
```

Supported `--adapter` values are `codex-app-server` (recommended), `claude-code`, `codex` (legacy single-turn CLI), `generic-cli`, and `mock`. Codex must already be installed and authenticated locally. App Server threads persist across Connector restarts and can be opened from the platform.

Native Codex handoffs use readable project information and changes since the last successful turn. Output schemas travel through `turn/start.outputSchema`, rather than being pasted into the chat. Current requirements, user instructions, stage and approval state remain explicit; the full common document is supplied for review and again before implementation. See [handoff architecture and analysis](docs/对话交接优化.md) for synchronization and recovery behavior. Rebuild and restart the local Connector to use the updated adapter; existing threads are retained and receive a full initial synchronization.

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
2. Both Agents inspect their projects read-only, submit implementation plans, and confirm the same assembled document hash. Changes invalidate prior confirmations.
3. An administrator reviews the complete document and explicitly approves that revision for execution.
4. Both Agents implement and test locally, then submit actual evidence. Seam assembles the implementation report.
5. Add requirements to start a fresh revision, negotiate again, and approve the new plan. Previous approval cannot authorize a new revision.
6. After reviewing the final report, the administrator explicitly terminates the collaboration. Reports never automatically close it.

Use `--adapter codex-app-server` with a local `SEAM_CODEX_SANDBOX=workspace-write` capability. For test endpoints or dependencies, a local maintainer can also set `SEAM_CODEX_NETWORK_ACCESS=true`; network access remains disabled during planning. Planning and unapproved turns remain read-only; writing requires the current executing phase and matching approved document hash. The adapter persists native threads, resumes after restarts, serializes turns and rejects interactive approvals on the unattended channel. Legacy invitations and collaboration APIs remain available.

See [local Docker simulation with real Codex](docs/端到端模拟验证.md) for the full two-revision scenario, and [earlier workflow analysis](docs/AI协作改进.md) for the original dialogue-chain findings.

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
- The web interface and audit log never display plaintext credentials. Only an authorized recipient Connector can collect a credential once.
- Public registration is disabled, and resources are invisible across organizations by default.
- Run production behind an HTTPS reverse proxy, and back up both MySQL and the master key securely. Encrypted credentials cannot be recovered if the master key is lost.

## License

Seam is open source under the [MIT License](LICENSE). You may use, modify, and distribute the project, including for commercial purposes, provided that the original copyright notice and license text are preserved. The software is provided “as is”, without warranty of any kind.
