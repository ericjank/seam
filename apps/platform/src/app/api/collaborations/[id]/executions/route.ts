import { NextResponse } from "next/server";
import { z } from "zod";
import { and,asc,eq,gt } from "drizzle-orm";
import { db } from "@/db";
import { connectorJobs } from "@/db/schema";
import { requireUser } from "@/lib/auth";
import { requireCollaborationAccess } from "@/lib/access";
import { handleApiError } from "@/lib/http";
const provenance=z.object({protocolVersion:z.number().int(),jobPayloadHash:z.string().length(64),connector:z.object({kind:z.string(),sourceId:z.string().max(100),files:z.number()}),platform:z.object({kind:z.string(),sourceId:z.string().max(100),files:z.number()}).nullable()});
export async function GET(request:Request,{params}:{params:Promise<{id:string}>}) {
 try {
  const {user}=await requireUser(),{id}=await params;await requireCollaborationAccess(user.id,id);
  const url=new URL(request.url),after=z.coerce.number().int().nonnegative().parse(url.searchParams.get("after")??0),limit=z.coerce.number().int().min(1).max(200).parse(url.searchParams.get("limit")??100);
  const rows=await db.select().from(connectorJobs).where(and(eq(connectorJobs.collaborationId,id),gt(connectorJobs.sequence,after))).orderBy(asc(connectorJobs.sequence)).limit(limit+1);
  const executions=rows.slice(0,limit).map(row=>{const value=provenance.safeParse((row.result as {provenance?:unknown}|null)?.provenance),snapshot=(row.payload as {lifecycleSnapshot?:unknown}).lifecycleSnapshot;return {id:row.id,sequence:row.sequence,agentId:row.agentId,status:row.status,attempts:row.attempts,kind:row.kind,snapshot,provenance:value.success?value.data:null,createdAt:row.createdAt.toISOString(),updatedAt:row.updatedAt.toISOString()};});
  return NextResponse.json({executions,nextCursor:executions.at(-1)?.sequence??after,hasMore:rows.length>limit});
 }catch(error){return handleApiError(error);}
}
