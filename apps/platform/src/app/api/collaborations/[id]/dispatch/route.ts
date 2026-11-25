import { NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { handleApiError } from "@/lib/http";
import { dispatchAgentTurns } from "@/services/agent-engine";
import { retryThreadJob } from "@/services/connectors";

const inputSchema = z.union([
  z.object({ action: z.literal("retry-thread"), jobId: z.string().uuid(), attempts: z.number().int().positive() }),
  z.object({ action: z.literal("retry-failed-thread"), jobId: z.string().uuid(), attempts: z.number().int().positive(),
    threadId: z.string().uuid(), confirmedThreadReleased: z.literal(true) }),
  z.object({ action: z.undefined().optional(), participantIds: z.array(z.string().uuid()).optional(), autoAdvance: z.boolean().default(false) }),
]);

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { user } = await requireUser();
    const { id } = await params;
    const input = inputSchema.parse(await request.json().catch(() => ({})));
    const jobs = input.action === "retry-thread" || input.action === "retry-failed-thread" ? [await retryThreadJob(user.id, id, input)]
      : await dispatchAgentTurns(user.id, id, input.participantIds, { autoAdvance: input.autoAdvance });
    return NextResponse.json({ jobs }, { status: 202 });
  } catch (error) { return handleApiError(error); }
}
