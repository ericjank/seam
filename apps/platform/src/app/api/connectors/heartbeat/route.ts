import { NextResponse } from "next/server";
import { z } from "zod";
import { handleApiError } from "@/lib/http";
import { authenticateConnector, heartbeat } from "@/services/connectors";

export async function POST(request: Request) {
  try {
    const { agentId, capabilities } = z.object({
      agentId: z.string().uuid(),
      capabilities: z.object({
        adapter: z.enum(["codex", "claude-code", "generic-cli", "mock"]),
        executionMode: z.enum(["read-only", "workspace-write", "external"]), testConfigured: z.boolean(),
      }).optional(),
    }).parse(await request.json());
    await authenticateConnector(request, agentId);
    await heartbeat(agentId, capabilities);
    return NextResponse.json({ ok: true, serverTime: new Date().toISOString() });
  } catch (error) { return handleApiError(error); }
}
