import { and, desc, eq, inArray } from "drizzle-orm";
import { createHash } from "node:crypto";
import { db } from "@/db";
import { artifactVersions, artifacts, collaborations, proposals, workItems } from "@/db/schema";
import { newId } from "@/lib/ids";
import { analyzeContractDiff, validateArtifact } from "@/lib/contract";
import { addSystemMessage } from "./collaborations";
import { authorizeActor, type Actor } from "./actor";
import { audit } from "@/lib/audit";

export async function upsertArtifact(actor: Actor, collaborationId: string, input: {
  artifactId?: string;
  title: string;
  type: "openapi" | "asyncapi" | "json-schema" | "markdown" | "test-plan" | "test-report" | "custom";
  content: string;
}) {
  const participantId = await authorizeActor(actor, collaborationId);
  validateArtifact(input.type, input.content);
  const hash = createHash("sha256").update(input.content).digest("hex");
  let artifactId = input.artifactId;
  let version = 1;
  let warnings: string[] = [];

  if (artifactId) {
    const [existing] = await db.select().from(artifacts)
      .where(and(eq(artifacts.id, artifactId), eq(artifacts.collaborationId, collaborationId))).limit(1);
    if (!existing) throw new Error("产物不存在");
    const [latest] = await db.select().from(artifactVersions)
      .where(eq(artifactVersions.artifactId, artifactId)).orderBy(desc(artifactVersions.version)).limit(1);
    if (latest?.contentHash === hash) return { artifactId, version: latest.version, unchanged: true, warnings: [] };
    version = existing.currentVersion + 1;
    if (latest && ["openapi", "asyncapi", "json-schema"].includes(existing.type)) {
      warnings = analyzeContractDiff(latest.content, input.content);
    }
    await db.update(proposals).set({ status: "superseded", updatedAt: new Date() })
      .where(and(eq(proposals.collaborationId, collaborationId), inArray(proposals.status, ["open", "accepted"])));
    await db.update(workItems).set({ status: "in_progress", updatedAt: new Date() })
      .where(and(eq(workItems.collaborationId, collaborationId), inArray(workItems.status, ["validating", "completed"])));
    await db.update(artifacts).set({ currentVersion: version, updatedAt: new Date() }).where(eq(artifacts.id, artifactId));
  } else {
    artifactId = newId();
    await db.insert(artifacts).values({ id: artifactId, collaborationId, title: input.title, type: input.type });
  }

  const versionId = newId();
  await db.insert(artifactVersions).values({
    id: versionId, artifactId, version, content: input.content, contentHash: hash, createdByParticipantId: participantId,
  });
  await db.update(collaborations).set({ status: "negotiating", updatedAt: new Date() }).where(eq(collaborations.id, collaborationId));
  await addSystemMessage(collaborationId, `产物《${input.title}》已发布 v${version}，相关审批与验收需要重新确认。${warnings.length ? `\n${warnings.join("\n")}` : ""}`);
  await audit({ collaborationId, actorType: actor.kind === "user" ? "user" : "agent", actorId: actor.id, action: "artifact.version_created", metadata: { artifactId, version, warnings } });
  return { artifactId, versionId, version, unchanged: false, warnings };
}
