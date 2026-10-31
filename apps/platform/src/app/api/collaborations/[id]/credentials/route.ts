import { NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { handleApiError } from "@/lib/http";
import { optionalDateTime } from "@/lib/validation";
import { requireParticipantAccess } from "@/lib/access";
import { requestCredential } from "@/services/credentials";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { user } = await requireUser();
    const collaborationId = (await params).id;
    const input = z.object({
      recipientParticipantId: z.string().uuid(), ownerParticipantId: z.string().uuid(),
      name: z.string().min(1).max(200), type: z.enum(["api-token", "test-account", "webhook-secret", "oauth-client"]),
      environment: z.string().min(1).max(50).optional(), purpose: z.string().min(1).max(5000),
      expiresAt: optionalDateTime,
    }).parse(await request.json());
    const { participant } = await requireParticipantAccess(user.id, input.recipientParticipantId);
    if (participant.collaborationId !== collaborationId) throw new Error("接收方不属于该协作");
    return NextResponse.json(await requestCredential({ kind: "participant", id: participant.id }, collaborationId, {
      ...input, expiresAt: input.expiresAt ? new Date(input.expiresAt) : undefined,
    }), { status: 201 });
  } catch (error) { return handleApiError(error); }
}
