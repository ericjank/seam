import { NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { handleApiError } from "@/lib/http";
import { createAgent } from "@/services/projects";

export async function POST(request: Request) {
  try {
    const { user } = await requireUser();
    const input = z.object({
      projectId: z.string().uuid(), name: z.string().min(1).max(100),
      adapter: z.enum(["claude-code", "codex", "codex-app-server", "generic-cli", "mock"]),
    }).parse(await request.json());
    return NextResponse.json({ agent: await createAgent(user.id, input) }, { status: 201 });
  } catch (error) { return handleApiError(error); }
}
