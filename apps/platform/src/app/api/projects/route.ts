import { NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { handleApiError } from "@/lib/http";
import { createProject, listProjects } from "@/services/projects";

export async function GET() {
  try {
    const { user } = await requireUser();
    return NextResponse.json({ projects: await listProjects(user.id) });
  } catch (error) { return handleApiError(error); }
}

export async function POST(request: Request) {
  try {
    const { user } = await requireUser();
    const input = z.object({ name: z.string().min(1).max(200), description: z.string().max(5000).optional() }).parse(await request.json());
    return NextResponse.json({ project: await createProject(user.id, input) }, { status: 201 });
  } catch (error) { return handleApiError(error); }
}
