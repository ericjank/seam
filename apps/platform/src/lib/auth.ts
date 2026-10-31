import { cookies } from "next/headers";
import { cache } from "react";
import bcrypt from "bcryptjs";
import { and, eq, gt, sql } from "drizzle-orm";
import { db } from "@/db";
import { organizations, sessions, users } from "@/db/schema";
import { hashToken, newId, newToken } from "./ids";
import { HttpError } from "./http";

const SESSION_COOKIE = "seam_session";
const SESSION_DAYS = 14;

export async function setupOwner(input: {
  name: string;
  email: string;
  password: string;
  organizationName: string;
}) {
  const [countRow] = await db.select({ count: sql<number>`count(*)` }).from(users);
  if (Number(countRow?.count ?? 0) > 0) throw new HttpError(409, "系统已完成初始化");

  const orgId = newId();
  const userId = newId();
  await db.transaction(async (tx) => {
    await tx.insert(organizations).values({ id: orgId, name: input.organizationName });
    await tx.insert(users).values({
      id: userId,
      orgId,
      name: input.name,
      email: input.email.toLowerCase(),
      passwordHash: await bcrypt.hash(input.password, 12),
      role: "owner",
    });
  });
  return createSession(userId);
}

export async function login(email: string, password: string) {
  const [user] = await db.select().from(users).where(eq(users.email, email.toLowerCase())).limit(1);
  if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
    throw new HttpError(401, "邮箱或密码不正确");
  }
  return createSession(user.id);
}

async function createSession(userId: string) {
  const token = newToken();
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000);
  await db.insert(sessions).values({ tokenHash: hashToken(token), userId, expiresAt });
  const jar = await cookies();
  jar.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    expires: expiresAt,
    path: "/",
  });
}

export async function logout() {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (token) await db.delete(sessions).where(eq(sessions.tokenHash, hashToken(token)));
  jar.delete(SESSION_COOKIE);
}

export const getCurrentUser = cache(async () => {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const [row] = await db
    .select({ user: users, organization: organizations })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .innerJoin(organizations, eq(users.orgId, organizations.id))
    .where(and(eq(sessions.tokenHash, hashToken(token)), gt(sessions.expiresAt, new Date())))
    .limit(1);
  return row ?? null;
});

export async function requireUser() {
  const current = await getCurrentUser();
  if (!current) throw new HttpError(401, "请先登录");
  return current;
}

export async function hasUsers() {
  const [countRow] = await db.select({ count: sql<number>`count(*)` }).from(users);
  return Number(countRow?.count ?? 0) > 0;
}
