import { eq } from "drizzle-orm";
import { db } from "@/db";
import { collaborations } from "@/db/schema";
import { requireUser } from "@/lib/auth";
import { requireCollaborationAccess } from "@/lib/access";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { user } = await requireUser();
  const { id } = await params;
  await requireCollaborationAccess(user.id, id);
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      let previous = "";
      const send = (value: string) => controller.enqueue(encoder.encode(`data: ${value}\n\n`));
      const update = async () => {
        const [collaboration] = await db.select({ updatedAt: collaborations.updatedAt }).from(collaborations).where(eq(collaborations.id, id)).limit(1);
        const current = collaboration?.updatedAt.toISOString() ?? "";
        if (current !== previous) { previous = current; send(current); }
      };
      await update();
      const timer = setInterval(() => { void update().catch(() => undefined); }, 3000);
      request.signal.addEventListener("abort", () => { clearInterval(timer); controller.close(); });
    },
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" } });
}
