import { NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { handleApiError } from "@/lib/http";
import { optionalUuid } from "@/lib/validation";
import { createWorkItem, updateWorkItem } from "@/services/work-items";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { user } = await requireUser();
    const collaborationId = (await params).id;
    const input = z.object({
      operation: z.enum(["create", "update"]).default("create"), workItemId: optionalUuid,
      title: z.string().min(1).max(200).optional(), description: z.string().max(20000).optional(),
      assigneeParticipantId: optionalUuid, priority: z.enum(["low", "normal", "high", "critical"]).optional(),
      acceptanceCriteria: z.string().max(20000).optional(), dependsOn: z.array(z.string().uuid()).optional(),
      status: z.enum(["pending", "in_progress", "blocked", "validating", "completed", "rejected"]).optional(),
      summary: z.string().max(20000).optional(),
    }).parse(await request.json());
    const actor = { kind: "user" as const, id: user.id };
    if (input.operation === "update") {
      if (!input.workItemId) throw new Error("缺少任务 ID");
      await updateWorkItem(actor, input.workItemId, input);
      return NextResponse.json({ ok: true });
    }
    if (!input.title) throw new Error("缺少任务标题");
    return NextResponse.json(await createWorkItem(actor, collaborationId, { ...input, title: input.title }), { status: 201 });
  } catch (error) { return handleApiError(error); }
}
