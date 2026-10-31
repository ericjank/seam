import { NextResponse } from "next/server";
import { z } from "zod";
import { handleApiError } from "@/lib/http";
import { authenticateConnector } from "@/services/connectors";
import { claimCredential } from "@/services/credentials";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { agentId } = z.object({ agentId: z.string().uuid() }).parse(await request.json());
    await authenticateConnector(request, agentId);
    const credential = await claimCredential(agentId, (await params).id);
    return NextResponse.json({ credential });
  } catch (error) { return handleApiError(error); }
}
