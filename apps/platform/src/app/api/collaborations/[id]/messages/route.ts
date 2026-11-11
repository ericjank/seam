import { NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { handleApiError } from "@/lib/http";
import { addUserMessage } from "@/services/collaborations";
import { dispatchAgentTurns } from "@/services/agent-engine";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { user } = await requireUser();
    const { body, dispatch } = z.object({ body: z.string().trim().min(1).max(50000), dispatch: z.boolean().default(true) }).parse(await request.json());
    const collaborationId = (await params).id;
    const id = await addUserMessage(user.id, collaborationId, body, dispatch);
    // The message is saved even when no agent is bound. Report dispatch separately so
    // users never need to resend the same instruction after a configuration error.
    let dispatchError: string | undefined;
    let jobs: string[] = [];
    if (dispatch) {
      try { jobs = await dispatchAgentTurns(user.id, collaborationId, undefined, { autoAdvance: true }); }
      catch (error) { dispatchError = error instanceof Error ? error.message : "派发失败，可点击继续推进重试"; }
    }
    return NextResponse.json({ id, jobs, dispatchError }, { status: 201 });
  } catch (error) { return handleApiError(error); }
}
