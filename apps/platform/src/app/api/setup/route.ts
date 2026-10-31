import { NextResponse } from "next/server";
import { z } from "zod";
import { setupOwner } from "@/lib/auth";
import { handleApiError } from "@/lib/http";

const inputSchema = z.object({
  name: z.string().min(1).max(100),
  email: z.string().email(),
  password: z.string().min(12).max(200),
  organizationName: z.string().min(1).max(200),
});

export async function POST(request: Request) {
  try {
    await setupOwner(inputSchema.parse(await request.json()));
    return NextResponse.json({ ok: true }, { status: 201 });
  } catch (error) {
    return handleApiError(error);
  }
}
