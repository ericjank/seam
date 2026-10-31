import { redirect } from "next/navigation";
import { getCurrentUser, hasUsers } from "@/lib/auth";

export default async function Home() {
  if (!(await hasUsers())) redirect("/setup");
  if (!(await getCurrentUser())) redirect("/login");
  redirect("/collaborations");
}
