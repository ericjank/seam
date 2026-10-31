import { NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { handleApiError } from "@/lib/http";
import { optionalUuid } from "@/lib/validation";
import { requireParticipantAccess } from "@/lib/access";
import { upsertArtifact } from "@/services/artifacts";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { user } = await requireUser();
    const collaborationId = (await params).id;
    const input = z.object({
      artifactId: optionalUuid, title: z.string().min(1).max(200),
      type: z.enum(["openapi", "asyncapi", "json-schema", "markdown", "test-plan", "test-report", "custom"]),
      content: z.string().min(1).max(1000000), participantId: optionalUuid,
    }).parse(await request.json());
    let actor: { kind: "user"; id: string } | { kind: "participant"; id: string } = { kind: "user", id: user.id };
    if (input.participantId) {
      const { participant } = await requireParticipantAccess(user.id, input.participantId);
      if (participant.collaborationId !== collaborationId) throw new Error("参与方不属于该协作");
      actor = { kind: "participant", id: input.participantId };
    }
    return NextResponse.json(await upsertArtifact(actor, collaborationId, input), { status: 201 });
  } catch (error) { return handleApiError(error); }
}
