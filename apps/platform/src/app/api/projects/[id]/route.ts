import { NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { handleApiError } from "@/lib/http";
import { deleteUnusedProject, setProjectArchived } from "@/services/projects";

type Context = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, { params }: Context) {
  try {
    const { user } = await requireUser();
    const { archived } = z.object({ archived: z.boolean() }).parse(await request.json());
    await setProjectArchived(user.id, (await params).id, archived);
    return NextResponse.json({ ok: true });
  } catch (error) { return handleApiError(error); }
}

export async function DELETE(_request: Request, { params }: Context) {
  try {
    const { user } = await requireUser();
    await deleteUnusedProject(user.id, (await params).id);
    return NextResponse.json({ ok: true });
  } catch (error) { return handleApiError(error); }
}
