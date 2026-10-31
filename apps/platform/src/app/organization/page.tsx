import { asc, eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { db } from "@/db";
import { users } from "@/db/schema";
import { getCurrentUser } from "@/lib/auth";
import { OrganizationManager } from "@/components/organization-manager";

export default async function OrganizationPage() {
  const current = await getCurrentUser();
  if (!current) redirect("/login");
  const members = await db.select({ id: users.id, name: users.name, email: users.email, role: users.role, createdAt: users.createdAt })
    .from(users).where(eq(users.orgId, current.user.orgId)).orderBy(asc(users.createdAt));
  return <OrganizationManager organizationName={current.organization.name} currentRole={current.user.role} members={members} />;
}
