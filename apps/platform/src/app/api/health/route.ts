import { NextResponse } from "next/server";
import { platformBuildInfo } from "@/lib/build-info";
import { pool } from "@/db";

export async function GET() {
  await pool.query("SELECT 1");
  return NextResponse.json({ status: "ok", database: "mysql", build:platformBuildInfo() });
}
