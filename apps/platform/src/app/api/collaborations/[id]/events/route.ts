import { NextResponse } from "next/server";
import { z } from "zod";
import { and,asc,desc,eq,gt } from "drizzle-orm";
import { db } from "@/db";
import { auditEvents, collaborations, connectorJobs } from "@/db/schema";
import { requireUser } from "@/lib/auth";
import { requireCollaborationAccess } from "@/lib/access";
import { handleApiError } from "@/lib/http";
import { RECENT_JOB_LIMIT } from "@/services/collaborations";
export async function GET(request:Request,{params}:{params:Promise<{id:string}>}) {
  try {
    const {user}=await requireUser(),{id}=await params;await requireCollaborationAccess(user.id,id);
    // Preserve the existing browser refresh subscription. Cursor-based clients
    // receive JSON below; EventSource explicitly requests this media type.
    if (request.headers.get("accept")?.includes("text/event-stream")) {
      const encoder = new TextEncoder();
      let timer: ReturnType<typeof setInterval> | undefined, stopped = false;
      const stop = () => { stopped = true; if (timer) clearInterval(timer); };
      const stream = new ReadableStream({
        async start(controller) {
          let previous = "", updating = false;
          const update = async () => {
            if (stopped || updating) return;
            updating = true;
            try {
              const [[collaboration], [event], jobs] = await Promise.all([
                db.select({updatedAt:collaborations.updatedAt}).from(collaborations).where(eq(collaborations.id,id)).limit(1),
                db.select({sequence:auditEvents.sequence}).from(auditEvents).where(eq(auditEvents.collaborationId,id)).orderBy(desc(auditEvents.sequence)).limit(1),
                db.select({ sequence: connectorJobs.sequence, status: connectorJobs.status, attempts: connectorJobs.attempts })
                  .from(connectorJobs).where(eq(connectorJobs.collaborationId, id))
                  .orderBy(desc(connectorJobs.sequence)).limit(RECENT_JOB_LIMIT),
              ]);
              // Claims change the execution records before the Agent publishes a message or audit event.
              const jobStates = jobs.map(job => `${job.sequence}.${job.status}.${job.attempts}`).join(",");
              const current = `${collaboration?.updatedAt.toISOString() ?? ""}:${event?.sequence ?? 0}:${jobStates}`;
              if (!stopped && current !== previous) { previous = current; controller.enqueue(encoder.encode(`data: ${current}\n\n`)); }
            } finally { updating = false; }
          };
          request.signal.addEventListener("abort", () => { if (!stopped) { stop(); controller.close(); } }, {once:true});
          if (request.signal.aborted) { stop(); controller.close(); return; }
          await update();
          if (!stopped) timer = setInterval(() => { void update().catch(() => undefined); }, 3000);
        },
        cancel: stop,
      });
      return new Response(stream,{headers:{"content-type":"text/event-stream","cache-control":"no-cache",connection:"keep-alive",Vary:"Accept"}});
    }
    const url=new URL(request.url),after=z.coerce.number().int().nonnegative().parse(url.searchParams.get("after")??0),limit=z.coerce.number().int().min(1).max(200).parse(url.searchParams.get("limit")??100);
    const rows=await db.select().from(auditEvents).where(and(eq(auditEvents.collaborationId,id),eq(auditEvents.action,"lifecycle.transition"),gt(auditEvents.sequence,after))).orderBy(asc(auditEvents.sequence)).limit(limit+1);
    const events=rows.slice(0,limit).map(row=>({sequence:row.sequence,at:row.createdAt.toISOString(),...(row.metadata as Record<string,unknown>)}));
    return NextResponse.json({events,nextCursor:events.at(-1)?.sequence??after,hasMore:rows.length>limit});
  }catch(error){return handleApiError(error);}
}
