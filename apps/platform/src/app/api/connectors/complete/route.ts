import { NextResponse } from "next/server";
import { z } from "zod";
import { connectorResultSchema } from "@seam/protocol";
import { handleApiError } from "@/lib/http";
import { authenticateConnector, completeConnectorJob } from "@/services/connectors";

export async function POST(request: Request) {
  try {
    const input = connectorResultSchema.and(z.object({ agentId: z.string().uuid() })).parse(await request.json());
    await authenticateConnector(request, input.agentId);
    await completeConnectorJob(input.agentId, input);
    return NextResponse.json({ ok: true });
  } catch (error) { return handleApiError(error); }
}
