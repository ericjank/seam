import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { asc, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { users } from "@/db/schema";
import { requireUser } from "@/lib/auth";
import { handleApiError, HttpError } from "@/lib/http";
import { newId } from "@/lib/ids";

export async function GET() {
  try {
    const { user } = await requireUser();
    const members = await db.select({ id: users.id, name: users.name, email: users.email, role: users.role, createdAt: users.createdAt })
      .from(users).where(eq(users.orgId, user.orgId)).orderBy(asc(users.createdAt));
    return NextResponse.json({ members });
  } catch (error) { return handleApiError(error); }
}

export async function POST(request: Request) {
  try {
    const { user } = await requireUser();
    if (user.role !== "owner") throw new HttpError(403, "只有组织所有者可以邀请成员");
    const input = z.object({
      name: z.string().min(1).max(100), email: z.string().email(),
      password: z.string().min(12).max(200), role: z.enum(["member", "viewer"]),
    }).parse(await request.json());
    const member = {
      id: newId(), orgId: user.orgId, name: input.name, email: input.email.toLowerCase(),
      passwordHash: await bcrypt.hash(input.password, 12), role: input.role,
    };
    await db.insert(users).values(member);
    return NextResponse.json({ member: { id: member.id, name: member.name, email: member.email, role: member.role } }, { status: 201 });
  } catch (error) { return handleApiError(error); }
}
