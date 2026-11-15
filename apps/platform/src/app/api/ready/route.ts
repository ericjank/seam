import { NextResponse } from "next/server";
import { databaseWritable } from "@/lib/readiness";
import { platformBuildInfo } from "@/lib/build-info";
export async function GET() {
  const ok = await databaseWritable();
  return NextResponse.json({ status: ok ? "ready" : "not_ready", database: "mysql", writable: ok, build: platformBuildInfo(), ...(!ok ? { code: "DATABASE_WRITE_UNAVAILABLE" } : {}) }, {status: ok ? 200 : 503, headers: {"cache-control":"no-store"}});
}
