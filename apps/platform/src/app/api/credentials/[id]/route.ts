import { NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { handleApiError } from "@/lib/http";
import { approveCredential, offerCredential, revokeCredential } from "@/services/credentials";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { user } = await requireUser();
    const credentialId = (await params).id;
    const input = z.object({
      operation: z.enum(["offer", "approve", "revoke"]), secret: z.string().min(1).max(100000).optional(),
    }).parse(await request.json());
    if (input.operation === "offer") {
      if (!input.secret) throw new Error("缺少凭据内容");
      await offerCredential(user.id, credentialId, input.secret);
    } else if (input.operation === "approve") {
      await approveCredential(user.id, credentialId);
    } else {
      await revokeCredential(user.id, credentialId);
    }
    return NextResponse.json({ ok: true });
  } catch (error) { return handleApiError(error); }
}
