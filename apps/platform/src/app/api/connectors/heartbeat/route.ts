import { NextResponse } from "next/server";
import { z } from "zod";
import { handleApiError } from "@/lib/http";
import { authenticateConnector, heartbeat } from "@/services/connectors";

export async function POST(request: Request) {
  try {
    const { agentId, capabilities, activeJob } = z.object({
      agentId: z.string().uuid(),
      activeJob: z.object({ id: z.string().uuid(), attempts: z.number().int().positive(), cancelled: z.boolean().optional() }).optional(),
      capabilities: z.object({
        adapter: z.enum(["codex", "codex-app-server", "claude-code", "generic-cli", "mock"]),
        executionMode: z.enum(["read-only", "workspace-write", "external"]), testConfigured: z.boolean(),
        supportsInformationLookup: z.boolean().optional(),
      }).optional(),
    }).parse(await request.json());
    await authenticateConnector(request, agentId);
    const jobState = await heartbeat(agentId, capabilities, activeJob);
    return NextResponse.json({ ok: true, serverTime: new Date().toISOString(), jobState });
  } catch (error) { return handleApiError(error); }
}
