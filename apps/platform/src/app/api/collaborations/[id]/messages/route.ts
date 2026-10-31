import { NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { handleApiError } from "@/lib/http";
import { addUserMessage } from "@/services/collaborations";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { user } = await requireUser();
    const { body } = z.object({ body: z.string().min(1).max(50000) }).parse(await request.json());
    const id = await addUserMessage(user.id, (await params).id, body);
    return NextResponse.json({ id }, { status: 201 });
  } catch (error) { return handleApiError(error); }
}
