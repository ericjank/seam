import { NextResponse } from "next/server";
import { z } from "zod";
import { handleApiError } from "@/lib/http";
import { authenticateConnector, heartbeat } from "@/services/connectors";

export async function POST(request: Request) {
  try {
    const { agentId } = z.object({ agentId: z.string().uuid() }).parse(await request.json());
    await authenticateConnector(request, agentId);
    await heartbeat(agentId);
    return NextResponse.json({ ok: true, serverTime: new Date().toISOString() });
  } catch (error) { return handleApiError(error); }
}
