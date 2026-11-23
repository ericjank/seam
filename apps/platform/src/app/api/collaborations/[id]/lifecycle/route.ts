import { NextResponse } from "next/server";
import { z } from "zod";
import { requireCollaborationAccess } from "@/lib/access";
import { requireUser } from "@/lib/auth";
import { handleApiError } from "@/lib/http";
import { drainWorkflowWakeups } from "@/services/workflow-outbox";
import { appendLifecycleRequirements, approveLifecycle, getLifecycleContext, pauseLifecycle, startLifecycle, terminateLifecycle, retryInformationLookup, retryLifecyclePlanning, retryLifecycleValidation, resolveInformation, grantRetryBudget, resolvePausedObjection } from "@/services/lifecycle";

const inputSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("grant-retry-budget"), revision: z.number().int().positive(), phase: z.string(), participantId: z.string().uuid(), generation: z.number().int().nonnegative(), reason: z.string().trim().min(10).max(1000) }),
  z.object({ action: z.literal("start") }),
  z.object({ action: z.literal("approve"), revision: z.number().int().positive(), documentHash: z.string().regex(/^[a-f0-9]{64}$/) }),
  z.object({ action: z.literal("append"), requirements: z.string().trim().min(1).max(50_000) }),
  z.object({ action: z.literal("terminate"), revision: z.number().int().positive().optional(), decision: z.enum(["accepted", "stopped"]).optional(), reportHash: z.string().regex(/^[a-f0-9]{64}$/).nullable().optional() }),
  z.object({ action: z.literal("pause") }),
  z.object({ action: z.literal("resume"), resolution: z.string().trim().min(1).max(5000).optional() }),
  z.object({ action: z.literal("retry-information"), requestId: z.string().uuid() }),
  z.object({ action: z.literal("resolve-information"), requestId: z.string().uuid(), resolution: z.string().trim().min(1).max(5000) }),
  z.object({ action: z.literal("resolve-objection"), revision: z.number().int().positive(), objectionId: z.string().uuid(),
    attempts: z.number().int().nonnegative(), evidence: z.string().trim().min(10).max(5000) }),
  z.object({ action: z.literal("retry-planning"), revision: z.number().int().positive(), participantId: z.string().uuid() }),
  z.object({ action: z.literal("retry-validation"), revision: z.number().int().positive(), documentHash: z.string().regex(/^[a-f0-9]{64}$/) }),
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
      : input.action === "grant-retry-budget" ? await grantRetryBudget(user.id, id, input)
      : input.action === "retry-information" ? await retryInformationLookup(user.id, id, input.requestId)
      : input.action === "resolve-information" ? await resolveInformation(user.id, id, input.requestId, input.resolution)
      : input.action === "resolve-objection" ? await resolvePausedObjection(user.id, id, input)
      : input.action === "retry-planning" ? await retryLifecyclePlanning(user.id, id, input)
      : input.action === "retry-validation" ? await retryLifecycleValidation(user.id, id, input)
      : input.action === "approve" ? await approveLifecycle(user.id, id, input)
        : input.action === "append" ? await appendLifecycleRequirements(user.id, id, input)
          : input.action === "pause" || input.action === "resume" ? await pauseLifecycle(user.id, id, input.action === "pause", input.action === "resume" ? input.resolution : undefined)
            : await terminateLifecycle(user.id, id, input);
    // Approval and requirements are already durable. A dispatch error must not
    // make the client repeat the administrator's action against a changed phase.
    let dispatchError: string | undefined;
    if (!["terminate", "pause"].includes(input.action)) {
      try { await drainWorkflowWakeups({ collaborationId: id }); }
      catch (error) { dispatchError = error instanceof Error ? error.message : "自动派发失败，请重试派发"; }
    }
    return NextResponse.json({ lifecycle, ...(dispatchError ? { dispatchError } : {}) });
  } catch (error) { return handleApiError(error); }
}
