import { NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { handleApiError } from "@/lib/http";
import { optionalUuid } from "@/lib/validation";
import { inviteParticipant } from "@/services/collaborations";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { user } = await requireUser();
    const input = z.object({
      projectId: z.string().uuid(), agentId: optionalUuid,
      role: z.enum(["provider", "consumer", "reviewer", "participant"]),
    }).parse(await request.json());
    return NextResponse.json({ participant: await inviteParticipant(user.id, { collaborationId: (await params).id, ...input }) }, { status: 201 });
  } catch (error) { return handleApiError(error); }
}
