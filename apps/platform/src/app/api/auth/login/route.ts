import { NextResponse } from "next/server";
import { z } from "zod";
import { login } from "@/lib/auth";
import { handleApiError } from "@/lib/http";

export async function POST(request: Request) {
  try {
    const input = z.object({ email: z.string().email(), password: z.string().min(1) }).parse(await request.json());
    await login(input.email, input.password);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return handleApiError(error);
  }
}
