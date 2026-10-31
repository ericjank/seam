import { NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { handleApiError } from "@/lib/http";
import { dispatchAgentTurns } from "@/services/agent-engine";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { user } = await requireUser();
    const input = z.object({ participantIds: z.array(z.string().uuid()).optional() }).parse(await request.json().catch(() => ({})));
    const jobs = await dispatchAgentTurns(user.id, (await params).id, input.participantIds);
    return NextResponse.json({ jobs }, { status: 202 });
  } catch (error) { return handleApiError(error); }
}
