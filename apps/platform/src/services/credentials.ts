import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { agents, credentials, participants } from "@/db/schema";
import { newId } from "@/lib/ids";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { requireCollaborationAccess, requireParticipantAccess } from "@/lib/access";
import { authorizeActor, type Actor } from "./actor";
import { addSystemMessage } from "./collaborations";
import { audit } from "@/lib/audit";
import { HttpError } from "@/lib/http";

export async function requestCredential(actor: Actor, collaborationId: string, input: {
  ownerParticipantId: string;
  name: string;
  type: "api-token" | "test-account" | "webhook-secret" | "oauth-client";
  environment?: string;
  purpose: string;
  expiresAt?: Date;
}) {
  const recipientParticipantId = await authorizeActor(actor, collaborationId);
  if (!recipientParticipantId) throw new Error("凭据申请必须来自具体项目参与方");
  const id = newId();
  await db.insert(credentials).values({
    id, collaborationId, ownerParticipantId: input.ownerParticipantId, recipientParticipantId,
    name: input.name, type: input.type, environment: input.environment ?? "test",
    purpose: input.purpose, expiresAt: input.expiresAt ?? null,
  });
  await addSystemMessage(collaborationId, `收到联调凭据申请《${input.name}》，用途：${input.purpose}`);
  return { id };
}

export async function offerCredential(userId: string, credentialId: string, secret: string) {
  const credential = await requireOwner(userId, credentialId);
  if (["revoked", "rejected", "expired"].includes(credential.status)) throw new Error("已关闭的凭据授权不能修改");
  const encrypted = encryptSecret(secret);
  await db.update(credentials).set({ ...encrypted, status: "offered", updatedAt: new Date() }).where(eq(credentials.id, credentialId));
  await audit({ collaborationId: credential.collaborationId, actorType: "user", actorId: userId, action: "credential.offered", metadata: { credentialId } });
}

export async function approveCredential(userId: string, credentialId: string) {
  const credential = await requireOwner(userId, credentialId);
  if (credential.status !== "offered" || !credential.ciphertext) throw new Error("请先提交凭据");
  await db.update(credentials).set({ status: "approved", approvedAt: new Date(), updatedAt: new Date() }).where(eq(credentials.id, credentialId));
  await addSystemMessage(credential.collaborationId, `联调凭据《${credential.name}》已授权，接收方 Connector 可一次性领取。`);
  await audit({ collaborationId: credential.collaborationId, actorType: "user", actorId: userId, action: "credential.approved", metadata: { credentialId } });
}

export async function revokeCredential(userId: string, credentialId: string) {
  const credential = await requireOwner(userId, credentialId);
  await db.update(credentials).set({ status: "revoked", ciphertext: null, encryptedDek: null, iv: null, authTag: null, updatedAt: new Date() }).where(eq(credentials.id, credentialId));
  await addSystemMessage(credential.collaborationId, `联调凭据《${credential.name}》已撤销。`);
  await audit({ collaborationId: credential.collaborationId, actorType: "user", actorId: userId, action: "credential.revoked", metadata: { credentialId } });
}

export async function claimCredential(agentId: string, credentialId: string) {
  const [credential] = await db.select().from(credentials).where(eq(credentials.id, credentialId)).limit(1);
  if (!credential || credential.status !== "approved") throw new HttpError(409, "凭据不存在、已领取或尚未授权");
  const [recipient] = await db.select().from(participants).where(eq(participants.id, credential.recipientParticipantId)).limit(1);
  if (!recipient || recipient.agentId !== agentId) throw new HttpError(403, "Connector 不是该凭据的接收方");
  if (credential.expiresAt && credential.expiresAt <= new Date()) {
    await db.update(credentials).set({ status: "expired", updatedAt: new Date() }).where(eq(credentials.id, credentialId));
    throw new HttpError(410, "凭据已过期");
  }
  if (!credential.ciphertext || !credential.encryptedDek || !credential.iv || !credential.authTag) throw new HttpError(409, "凭据内容不可用");
  const value = decryptSecret({
    ciphertext: credential.ciphertext, encryptedDek: credential.encryptedDek, iv: credential.iv, authTag: credential.authTag,
  });
  await db.update(credentials).set({ status: "granted", grantedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(credentials.id, credentialId), eq(credentials.status, "approved")));
  await audit({ collaborationId: credential.collaborationId, actorType: "connector", actorId: agentId, action: "credential.granted", metadata: { credentialId } });
  return { name: credential.name, type: credential.type, environment: credential.environment, value };
}

async function requireOwner(userId: string, credentialId: string) {
  const [credential] = await db.select().from(credentials).where(eq(credentials.id, credentialId)).limit(1);
  if (!credential) throw new Error("凭据申请不存在");
  await requireCollaborationAccess(userId, credential.collaborationId, true);
  await requireParticipantAccess(userId, credential.ownerParticipantId);
  return credential;
}
