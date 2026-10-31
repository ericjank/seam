import { db } from "@/db";
import { auditEvents } from "@/db/schema";
import { newId } from "./ids";

export async function audit(input: {
  collaborationId?: string | null;
  actorType: "user" | "agent" | "connector" | "system";
  actorId?: string | null;
  action: string;
  metadata?: Record<string, unknown>;
}) {
  await db.insert(auditEvents).values({
    id: newId(),
    collaborationId: input.collaborationId ?? null,
    actorType: input.actorType,
    actorId: input.actorId ?? null,
    action: input.action,
    metadata: input.metadata ?? {},
  });
}
