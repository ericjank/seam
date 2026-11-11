import { withTransaction } from "@/db";
import { NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { handleApiError, HttpError } from "@/lib/http";
import { optionalUuid } from "@/lib/validation";
import { acceptParticipant, createCollaboration, inviteParticipant, listCollaborations } from "@/services/collaborations";
import { requireProjectAccess } from "@/lib/access";
import { startLifecycle } from "@/services/lifecycle";
import { dispatchAgentTurns } from "@/services/agent-engine";

export async function GET() {
  try {
    const { user } = await requireUser();
    return NextResponse.json({ collaborations: await listCollaborations(user.id) });
  } catch (error) { return handleApiError(error); }
}

export async function POST(request: Request) {
  try {
    const { user } = await requireUser();
    const input = z.object({
      title: z.string().trim().max(200).optional(),
      type: z.enum(["api-integration", "event-integration", "data-contract", "release-coordination", "custom"]).default("custom"),
      objective: z.string().trim().min(1).max(20000), projectId: z.string().uuid(), agentId: optionalUuid,
      targetProjectId: optionalUuid, targetAgentId: optionalUuid,
    }).parse(await request.json());
    if (input.targetProjectId) {
      if (user.role !== "owner") throw new HttpError(403, "仅管理员可以提交自动对接任务");
      if (input.targetProjectId === input.projectId) throw new HttpError(422, "请选择两个不同项目");
      await requireProjectAccess(user.id, input.targetProjectId, true);
    }
    return await withTransaction(async () => {
      const created = await createCollaboration(user.id, { ...input, title: input.title || input.objective.trim().split("\n")[0]!.slice(0, 80) });
      if (!input.targetProjectId) return NextResponse.json(created, { status: 201 });
      const target = await inviteParticipant(user.id, { collaborationId: created.id, projectId: input.targetProjectId, agentId: input.targetAgentId, role: "provider" });
      // Both projects are owned by the submitting administrator; no second form or
      // invitation acceptance is needed for this local connected-agent workflow.
      await acceptParticipant(user.id, target.id);
      await startLifecycle(user.id, created.id);
      const jobs = await dispatchAgentTurns(user.id, created.id, undefined, { autoAdvance: true });
      return NextResponse.json({ ...created, jobs }, { status: 201 });
    });
  } catch (error) { return handleApiError(error); }
}
