import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { handleApiError } from "@/lib/http";
import { getCollaborationDetail } from "@/services/collaborations";
import { requireCollaborationAccess } from "@/lib/access";
import { recoverInformationLookups } from "@/services/lifecycle";

export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { user } = await requireUser();
    const { id } = await params;
    await requireCollaborationAccess(user.id, id);
    await recoverInformationLookups(id);
    return NextResponse.json(await getCollaborationDetail(user.id, id));
  } catch (error) { return handleApiError(error); }
}
