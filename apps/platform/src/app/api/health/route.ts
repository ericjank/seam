import { NextResponse } from "next/server";
import { pool } from "@/db";

export async function GET() {
  await pool.query("SELECT 1");
  return NextResponse.json({ status: "ok", database: "mysql" });
}
