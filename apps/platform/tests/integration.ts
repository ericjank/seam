import assert from "node:assert/strict";
import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { runConnector } from "@seam/connector";
import { db, pool } from "../src/db";
import { credentials, messages, organizations, users } from "../src/db/schema";
import { newId } from "../src/lib/ids";

const base = process.env.SEAM_APP_URL ?? "http://localhost:3000";
const email = process.env.SEAM_TEST_OWNER_EMAIL ?? "owner@seam.test";
const password = process.env.SEAM_TEST_OWNER_PASSWORD ?? "SeamTest!12345";
let cookie = "";

async function raw(path: string, body?: unknown, token?: string, method = "POST") {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(token ? { authorization: `Bearer ${token}` } : cookie ? { cookie } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const setCookie = response.headers.get("set-cookie");
  if (setCookie?.startsWith("seam_session=")) cookie = setCookie.split(";")[0] as string;
  const data = await response.json() as Record<string, any>;
  return { response, data };
}

async function api(path: string, body?: unknown, token?: string, method = "POST") {
  const { response, data } = await raw(path, body, token, method);
  if (!response.ok) throw new Error(`${method} ${path} -> ${response.status}: ${JSON.stringify(data)}`);
  return data;
}

async function processAgent(agent: { id: string; token: string }) {
  await runConnector({
    platformUrl: base, agentId: agent.id, token: agent.token, projectRoot: process.cwd(),
    stateDir: process.env.SEAM_CONNECTOR_STATE_DIR, workspaceLockDir: process.env.SEAM_WORKSPACE_LOCK_DIR,
    adapter: "mock", once: true, pollMs: 1,
  });
}

async function verifyProjectPermissions(projectPath: string) {
  const ownerCookie = cookie;
  for (const role of ["viewer", "member"] as const) {
    const email = `${role}-${newId()}@seam.test`;
    await api("/api/users", { name: "项目管理验收", email, password, role });
    await api("/api/auth/login", { email, password });
    try {
      for (const archived of [true, false]) {
        const change = await raw(projectPath, { archived }, undefined, "PATCH");
        assert.equal(change.response.status, role === "viewer" ? 403 : 200);
      }
      assert.equal((await raw(projectPath, undefined, undefined, "DELETE")).response.status, 403);
    } finally { cookie = ownerCookie; }
  }
}

async function verifyProjectArchiving(collaborationId: string, activeProjectId: string) {
  const { project } = await api("/api/projects", { name: "项目归档验证" });
  const path = `/api/projects/${project.id}`;
  const setArchived = (archived: boolean) => api(path, { archived }, undefined, "PATCH");
  const list = async (archived = false) => {
    const { projects } = await api(archived ? "/api/projects?view=archived" : "/api/projects", undefined, undefined, "GET");
    return projects.find((row: { project: { id: string } }) => row.project.id === project.id);
  };
  assert.equal((await list()).unused, true);
  await setArchived(true);
  const archivedAt = (await list(true)).project.archivedAt;
  assert.ok(archivedAt);
  await setArchived(true);
  assert.equal((await list(true)).project.archivedAt, archivedAt);
  assert.equal(await list(), undefined);
  const agentInput = { projectId: project.id, name: "归档验证 Agent", adapter: "mock" };
  const goal = { projectId: project.id, objective: "验证归档限制" };
  const invitation = { projectId: project.id, role: "reviewer" };
  assert.equal((await raw("/api/agents", agentInput)).response.status, 409);
  assert.equal((await raw("/api/collaborations", goal)).response.status, 409);
  assert.equal((await raw("/api/collaborations", { ...goal, projectId: activeProjectId, targetProjectId: project.id })).response.status, 409);
  assert.equal((await raw(`/api/collaborations/${collaborationId}/participants`, invitation)).response.status, 409);
  await setArchived(false);
  assert.equal((await list()).project.archivedAt, null);
  assert.equal(await list(true), undefined);

  // Agent-only and participation-only projects must each survive deletion attempts.
  await api("/api/agents", agentInput);
  assert.equal((await list()).unused, false);
  assert.equal((await raw(path, undefined, undefined, "DELETE")).response.status, 409);
  const { project: peer } = await api("/api/projects", { name: "仅有协作记录的项目" });
  const peerPath = `/api/projects/${peer.id}`;
  const history = await api("/api/collaborations", { ...goal, projectId: peer.id });
  await api(peerPath, { archived: true }, undefined, "PATCH");
  assert.equal((await raw(peerPath, undefined, undefined, "DELETE")).response.status, 409);
  const detail = await api(`/api/collaborations/${history.id}`, undefined, undefined, "GET");
  assert.equal(detail.participants[0].project.id, peer.id);
  assert.ok(!detail.availableProjects.some((row: { project: { id: string } }) => row.project.id === peer.id));
  assert.ok(detail.messages.length);

  const { project: empty } = await api("/api/projects", { name: "误建的空项目" });
  const emptyPath = `/api/projects/${empty.id}`;
  await verifyProjectPermissions(emptyPath);
  await api(emptyPath, undefined, undefined, "DELETE");
  assert.equal((await raw(emptyPath, { archived: false }, undefined, "PATCH")).response.status, 404);
}

async function main() {
  const setup = await raw("/api/setup", { name: "Seam 测试所有者", email, password, organizationName: "Seam 测试组织" });
  if (setup.response.status === 409) await api("/api/auth/login", { email, password });
  else if (!setup.response.ok) throw new Error(JSON.stringify(setup.data));
  await api("/api/projects", undefined, undefined, "GET").catch(async () => {
    cookie = "";
    await api("/api/auth/login", { email, password });
  });

  const projects = [];
  const agents = [];
  for (const name of ["订单中台", "契约提供方", "调用方"]) {
    const { project } = await api("/api/projects", { name: `${name} ${Date.now()}`, description: "端到端测试独立项目" });
    const { agent } = await api("/api/agents", { projectId: project.id, name: `${name}-mock`, adapter: "mock" });
    projects.push(project);
    agents.push(agent);
  }

  const collaboration = await api("/api/collaborations", {
    title: `三项目接口对接 ${Date.now()}`, type: "api-integration", objective: "协商契约、分工、共享测试 Token 并验收",
    projectId: projects[0].id, agentId: agents[0].id,
  });
  const collaborationId = collaboration.id as string;
  const participants = [collaboration.participantId as string];
  for (const [index, role] of [[1, "provider"], [2, "consumer"]] as const) {
    const { participant } = await api(`/api/collaborations/${collaborationId}/participants`, {
      projectId: projects[index].id, agentId: agents[index].id, role,
    });
    await api(`/api/participants/${participant.id}/accept`, {});
    participants.push(participant.id as string);
  }

  await api(`/api/collaborations/${collaborationId}/dispatch`, {});
  for (const index of [0, 1, 2, 0, 2]) await processAgent(agents[index]);
  let detail = await api(`/api/collaborations/${collaborationId}`, undefined, undefined, "GET");
  assert.equal(detail.artifacts.length, 1, "Agent 应发布 OpenAPI");
  assert.equal(detail.workItems.length, 2, "两个消费方应各自创建任务");

  const artifactId = detail.artifacts[0].id as string;
  const proposal = await api(`/api/collaborations/${collaborationId}/proposals`, {
    operation: "create", title: "确认 API v1", body: "全部参与方按同一契约版本实施", artifactId, approvalMode: "all",
  });
  for (const participantId of participants) {
    await api(`/api/collaborations/${collaborationId}/proposals`, {
      operation: "decide", proposalId: proposal.id, participantId, decision: "approved",
    });
  }
  detail = await api(`/api/collaborations/${collaborationId}`, undefined, undefined, "GET");
  assert.equal(detail.proposals[0].status, "accepted");

  const credential = await api(`/api/collaborations/${collaborationId}/credentials`, {
    ownerParticipantId: participants[1], recipientParticipantId: participants[2], name: "契约测试 Token",
    type: "api-token", environment: "test", purpose: "仅用于契约测试",
  });
  const testSecret = `integration-${newId()}`;
  await api(`/api/credentials/${credential.id}`, { operation: "offer", secret: testSecret });
  await api(`/api/credentials/${credential.id}`, { operation: "approve" });
  const claimed = await api(`/api/connectors/credentials/${credential.id}`, { agentId: agents[2].id }, agents[2].token);
  assert.equal(claimed.credential.value, testSecret);
  const secondClaim = await raw(`/api/connectors/credentials/${credential.id}`, { agentId: agents[2].id }, agents[2].token);
  assert.equal(secondClaim.response.status, 409, "凭据只能领取一次");
  const [storedCredential] = await db.select().from(credentials).where(eq(credentials.id, credential.id)).limit(1);
  assert.ok(storedCredential);
  assert.ok(storedCredential.ciphertext && !storedCredential.ciphertext.includes(testSecret));
  const messageRows = await db.select().from(messages).where(eq(messages.collaborationId, collaborationId));
  assert.ok(!messageRows.some((message) => message.body.includes(testSecret)));

  process.env.SEAM_TEST_COMMAND = `${JSON.stringify(process.execPath)} -e "console.log('pact contract ok')"`;
  for (const [index, item] of detail.workItems.entries()) {
    if (index === 0) {
      await api(`/api/collaborations/${collaborationId}/test-runs`, {
        participantId: item.assigneeParticipantId, workItemId: item.id, artifactId,
      });
      await processAgent(agents[participants.indexOf(item.assigneeParticipantId)]);
    } else {
      await api(`/api/collaborations/${collaborationId}/acceptance`, {
        participantId: item.assigneeParticipantId, workItemId: item.id, artifactId,
        status: "passed", summary: "本地契约测试通过", evidence: { passed: 1, failed: 0 },
      });
    }
  }
  detail = await api(`/api/collaborations/${collaborationId}`, undefined, undefined, "GET");
  assert.equal(detail.collaboration.status, "completed");

  await api(`/api/collaborations/${collaborationId}/artifacts`, {
    artifactId, title: "订单 API", type: "openapi",
    content: JSON.stringify({ openapi: "3.1.0", info: { title: "Orders", version: "2.0.0" }, paths: { "/orders": {} } }),
  });
  detail = await api(`/api/collaborations/${collaborationId}`, undefined, undefined, "GET");
  assert.equal(detail.collaboration.status, "negotiating");
  assert.ok(detail.workItems.every((item: { status: string }) => item.status === "in_progress"));
  assert.equal(detail.proposals[0].status, "superseded");

  const release = await api("/api/collaborations", {
    title: `通用发布协调 ${Date.now()}`, type: "release-coordination", objective: "验证非 API 多方任务与验收",
    projectId: projects[0].id, agentId: agents[0].id,
  });
  const releaseWork = await api(`/api/collaborations/${release.id}/work-items`, { operation: "create", title: "确认发布窗口" });
  await api(`/api/collaborations/${release.id}/acceptance`, {
    participantId: release.participantId, workItemId: releaseWork.id, status: "passed", summary: "发布检查单完成",
  });
  const releaseDetail = await api(`/api/collaborations/${release.id}`, undefined, undefined, "GET");
  assert.equal(releaseDetail.collaboration.status, "completed");

  await api(`/api/a2a/${agents[0].id}/card`, undefined, agents[0].token, "GET");
  const a2a = await api(`/api/a2a/${agents[0].id}`, {
    jsonrpc: "2.0", id: 1, method: "message/send",
    params: { message: { kind: "message", messageId: newId(), role: "user", parts: [{ kind: "text", text: "A2A 健康检查" }] } },
  }, agents[0].token);
  await processAgent(agents[0]);
  const task = await api(`/api/a2a/${agents[0].id}`, { jsonrpc: "2.0", id: 2, method: "tasks/get", params: { id: a2a.result.id } }, agents[0].token);
  assert.equal(task.result.status.state, "completed");

  const invalid = await raw("/api/connectors/poll", { agentId: agents[0].id, waitMs: 0 }, "invalid-token");
  assert.equal(invalid.response.status, 401);
  await verifyProjectArchiving(collaborationId, projects[0].id);
  const outsiderOrg = newId();
  const outsiderId = newId();
  await db.insert(organizations).values({ id: outsiderOrg, name: "隔离测试组织" });
  await db.insert(users).values({
    id: outsiderId, orgId: outsiderOrg, name: "外部用户", email: `outsider-${newId()}@seam.test`,
    passwordHash: await bcrypt.hash(password, 4), role: "owner",
  });
  cookie = "";
  const [outsider] = await db.select().from(users).where(eq(users.id, outsiderId)).limit(1);
  assert.ok(outsider);
  await api("/api/auth/login", { email: outsider.email, password });
  const forbidden = await raw(`/api/collaborations/${collaborationId}`, undefined, undefined, "GET");
  assert.equal(forbidden.response.status, 404, "其他组织不能读取协作");
  const foreignProject = `/api/projects/${projects[0].id}`;
  assert.equal((await raw(foreignProject, { archived: true }, undefined, "PATCH")).response.status, 404);
  assert.equal((await raw(foreignProject, undefined, undefined, "DELETE")).response.status, 404);

  console.log(JSON.stringify({
    ok: true, collaborationId, releaseCollaborationId: release.id,
    checks: ["三方 Agent 协商", "提案一致确认", "凭据加密与一次性领取", "自动验收", "契约变更失效", "通用协作", "A2A", "项目归档、恢复与删除", "组织隔离"],
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(async () => {
  await pool.end();
});
