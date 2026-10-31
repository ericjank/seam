import { NextResponse } from "next/server";
import { z } from "zod";
import { handleApiError } from "@/lib/http";
import { authenticateConnector, pollConnectorJob } from "@/services/connectors";

export async function POST(request: Request) {
  try {
    const input = z.object({ agentId: z.string().uuid(), waitMs: z.number().int().min(0).max(20000).default(20000) }).parse(await request.json());
    await authenticateConnector(request, input.agentId);
    const job = await pollConnectorJob(input.agentId, input.waitMs);
    return NextResponse.json({ job });
  } catch (error) { return handleApiError(error); }
}
