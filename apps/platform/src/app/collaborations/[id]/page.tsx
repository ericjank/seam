import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { getCollaborationDetail } from "@/services/collaborations";
import { CollaborationDetail } from "@/components/collaboration-detail";

export default async function CollaborationPage({ params }: { params: Promise<{ id: string }> }) {
  const current = await getCurrentUser();
  if (!current) redirect("/login");
  const data = await getCollaborationDetail(current.user.id, (await params).id);
  return <CollaborationDetail data={data} />;
}
