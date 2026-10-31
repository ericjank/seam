import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { participants } from "@/db/schema";
import { requireCollaborationAccess } from "@/lib/access";
import { HttpError } from "@/lib/http";

export type Actor = { kind: "user"; id: string } | { kind: "participant"; id: string };

export async function authorizeActor(actor: Actor, collaborationId: string) {
  if (actor.kind === "user") {
    await requireCollaborationAccess(actor.id, collaborationId, true);
    return null;
  }
  const [participant] = await db.select().from(participants)
    .where(and(eq(participants.id, actor.id), eq(participants.collaborationId, collaborationId))).limit(1);
  if (!participant || participant.status !== "active") throw new HttpError(403, "Agent 不是该协作的有效参与方");
  return participant.id;
}
