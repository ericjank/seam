import { NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { handleApiError } from "@/lib/http";
import { optionalUuid } from "@/lib/validation";
import { createCollaboration, listCollaborations } from "@/services/collaborations";

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
      objective: z.string().min(1).max(20000), projectId: z.string().uuid(), agentId: optionalUuid,
    }).parse(await request.json());
    return NextResponse.json(await createCollaboration(user.id, { ...input, title: input.title || input.objective.trim().split("\n")[0]!.slice(0, 80) }), { status: 201 });
  } catch (error) { return handleApiError(error); }
}
