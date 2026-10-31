import { NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { handleApiError } from "@/lib/http";
import { optionalUuid } from "@/lib/validation";
import { requireParticipantAccess } from "@/lib/access";
import { submitAcceptance } from "@/services/acceptance";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { user } = await requireUser();
    const collaborationId = (await params).id;
    const input = z.object({
      participantId: z.string().uuid(), workItemId: optionalUuid, artifactId: optionalUuid,
      status: z.enum(["passed", "failed"]), summary: z.string().min(1).max(20000),
      evidence: z.record(z.string(), z.unknown()).optional(),
    }).parse(await request.json());
    const { participant } = await requireParticipantAccess(user.id, input.participantId);
    if (participant.collaborationId !== collaborationId) throw new Error("参与方不属于该协作");
    return NextResponse.json(await submitAcceptance({ kind: "participant", id: participant.id }, collaborationId, input), { status: 201 });
  } catch (error) { return handleApiError(error); }
}
