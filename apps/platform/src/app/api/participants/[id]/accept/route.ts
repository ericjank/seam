import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { handleApiError } from "@/lib/http";
import { acceptParticipant } from "@/services/collaborations";

export async function POST(_: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { user } = await requireUser();
    await acceptParticipant(user.id, (await params).id);
    return NextResponse.json({ ok: true });
  } catch (error) { return handleApiError(error); }
}
