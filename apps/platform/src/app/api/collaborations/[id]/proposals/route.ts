import { NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { handleApiError, HttpError } from "@/lib/http";
import { optionalUuid } from "@/lib/validation";
import { requireParticipantAccess } from "@/lib/access";
import { createProposal, decideProposal } from "@/services/proposals";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { user } = await requireUser();
    const collaborationId = (await params).id;
    const input = z.object({
      operation: z.enum(["create", "decide"]).default("create"),
      participantId: optionalUuid, proposalId: optionalUuid,
      title: z.string().min(1).max(200).optional(), body: z.string().min(1).max(50000).optional(),
      artifactId: optionalUuid, approvalMode: z.enum(["all", "required"]).optional(),
      decision: z.enum(["approved", "rejected"]).optional(), comment: z.string().max(5000).optional(),
    }).parse(await request.json());
    let actor: { kind: "user"; id: string } | { kind: "participant"; id: string } = { kind: "user", id: user.id };
    if (input.participantId) {
      await requireParticipantAccess(user.id, input.participantId);
      actor = { kind: "participant", id: input.participantId };
    }
    if (input.operation === "decide") {
      if (!input.proposalId || !input.decision) throw new HttpError(422, "缺少提案或决定");
      await decideProposal(actor, input.proposalId, input.decision, input.comment, collaborationId);
      return NextResponse.json({ ok: true });
    }
    if (!input.title || !input.body) throw new HttpError(422, "缺少提案标题或内容");
    return NextResponse.json(await createProposal(actor, collaborationId, { ...input, title: input.title, body: input.body }), { status: 201 });
  } catch (error) { return handleApiError(error); }
}
