import { NextResponse } from "next/server";
import { z } from "zod";
import { handleApiError } from "@/lib/http";
import { authenticateConnector, completeConnectorJob } from "@/services/connectors";

export async function POST(request: Request) {
  try {
    const input = z.object({
      agentId: z.string().uuid(), jobId: z.string().uuid(), status: z.enum(["completed", "failed"]),
      attempts: z.number().int().positive().optional(),
      result: z.record(z.string(), z.unknown()).optional(), error: z.string().max(10000).optional(),
    }).parse(await request.json());
    await authenticateConnector(request, input.agentId);
    await completeConnectorJob(input.agentId, input);
    return NextResponse.json({ ok: true });
  } catch (error) { return handleApiError(error); }
}
