import { NextResponse } from "next/server";
import { z } from "zod";
import { handleApiError } from "@/lib/http";
import { authenticateConnector, recoverConnectorJob } from "@/services/connectors";

export async function POST(request:Request) {
  try {
    const input=z.object({agentId:z.string().uuid(),jobId:z.string().uuid(),attempts:z.number().int().positive(),recoveryKey:z.string().min(32).max(100)}).parse(await request.json());
    await authenticateConnector(request,input.agentId);
    return NextResponse.json({job:await recoverConnectorJob(input.agentId,input.jobId,input.attempts,input.recoveryKey)});
  } catch(error){return handleApiError(error);}
}
