import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { handleApiError } from "@/lib/http";
import { getCollaborationDetail } from "@/services/collaborations";

export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { user } = await requireUser();
    return NextResponse.json(await getCollaborationDetail(user.id, (await params).id));
  } catch (error) { return handleApiError(error); }
}
