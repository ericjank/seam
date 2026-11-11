import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/db";
import { connectorJobs } from "@/db/schema";
import { requireUser } from "@/lib/auth";
import { handleApiError, HttpError } from "@/lib/http";
import { requireParticipantAccess } from "@/lib/access";
import { optionalUuid } from "@/lib/validation";
import { getLifecycleContext } from "@/services/lifecycle";
import { newId } from "@/lib/ids";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { user } = await requireUser();
    const collaborationId = (await params).id;
    const input = z.object({
      participantId: z.string().uuid(), workItemId: optionalUuid, artifactId: optionalUuid,
    }).parse(await request.json());
    const { participant } = await requireParticipantAccess(user.id, input.participantId);
    if (participant.collaborationId !== collaborationId) throw new HttpError(400, "参与方不属于该协作");
    if (!participant.agentId) throw new HttpError(409, "该参与方尚未绑定 Agent");
    const lifecycle = await getLifecycleContext(collaborationId);
    if (lifecycle) throw new HttpError(409, "自动对接任务由已批准的实施轮次运行测试，不接受额外测试派发");
    const id = newId();
    await db.insert(connectorJobs).values({
      id, agentId: participant.agentId, collaborationId, kind: "local.test",
      payload: { participantId: participant.id, workItemId: input.workItemId ?? null, artifactId: input.artifactId ?? null },
    });
    return NextResponse.json({ id }, { status: 202 });
  } catch (error) { return handleApiError(error); }
}
