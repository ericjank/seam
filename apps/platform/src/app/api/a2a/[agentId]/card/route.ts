import { NextResponse } from "next/server";
import { handleApiError } from "@/lib/http";
import { authenticateConnector } from "@/services/connectors";
import { agentCard } from "@/lib/a2a";

export async function GET(request: Request, { params }: { params: Promise<{ agentId: string }> }) {
  try {
    const agent = await authenticateConnector(request, (await params).agentId);
    return NextResponse.json(agentCard(agent.id, agent.name));
  } catch (error) { return handleApiError(error); }
}
