import { redirect } from "next/navigation";
import { AuthForm } from "@/components/auth-form";
import { getCurrentUser, hasUsers } from "@/lib/auth";

export default async function LoginPage() {
  if (!(await hasUsers())) redirect("/setup");
  if (await getCurrentUser()) redirect("/collaborations");
  return <AuthForm setup={false} />;
}
