import { NextResponse } from "next/server";
import { z } from "zod";
import { requireCollaborationAccess } from "@/lib/access";
import { requireUser } from "@/lib/auth";
import { handleApiError } from "@/lib/http";
import { dispatchAgentTurns } from "@/services/agent-engine";
import { appendLifecycleRequirements, approveLifecycle, getLifecycleContext, startLifecycle, terminateLifecycle } from "@/services/lifecycle";

const inputSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("start") }),
  z.object({ action: z.literal("approve"), revision: z.number().int().positive(), documentHash: z.string().regex(/^[a-f0-9]{64}$/) }),
  z.object({ action: z.literal("append"), requirements: z.string().trim().min(1).max(50_000) }),
  z.object({ action: z.literal("terminate"), revision: z.number().int().positive().optional() }),
]);

export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { user } = await requireUser();
    const { id } = await params;
    await requireCollaborationAccess(user.id, id);
    return NextResponse.json({ lifecycle: await getLifecycleContext(id) });
  } catch (error) { return handleApiError(error); }
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { user } = await requireUser();
    const { id } = await params;
    const input = inputSchema.parse(await request.json());
    const lifecycle = input.action === "start" ? await startLifecycle(user.id, id)
      : input.action === "approve" ? await approveLifecycle(user.id, id, input)
        : input.action === "append" ? await appendLifecycleRequirements(user.id, id, input)
          : await terminateLifecycle(user.id, id, input);
    // Approval and requirements are already durable. A dispatch error must not
    // make the client repeat the administrator's action against a changed phase.
    let dispatchError: string | undefined;
    if (input.action !== "terminate") {
      try { await dispatchAgentTurns(user.id, id, undefined, { autoAdvance: true }); }
      catch (error) { dispatchError = error instanceof Error ? error.message : "自动派发失败，请重试派发"; }
    }
    return NextResponse.json({ lifecycle, ...(dispatchError ? { dispatchError } : {}) });
  } catch (error) { return handleApiError(error); }
}
