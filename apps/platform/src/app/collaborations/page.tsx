import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { listCollaborations } from "@/services/collaborations";
import { listProjects } from "@/services/projects";
import { CollaborationList } from "@/components/collaboration-list";

export default async function CollaborationsPage() {
  const current = await getCurrentUser();
  if (!current) redirect("/login");
  const [collaborations, projects] = await Promise.all([listCollaborations(current.user.id), listProjects(current.user.id)]);
  return <CollaborationList collaborations={collaborations} projects={projects} />;
}
