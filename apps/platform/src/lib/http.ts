import { NextResponse } from "next/server";
import { ZodError } from "zod";

export function apiError(message: string, status = 400, code = "BAD_REQUEST", details?: unknown) {
  return NextResponse.json({ error: { code, message, details } }, { status });
}

export function handleApiError(error: unknown) {
  if (error instanceof ZodError) {
    return apiError("请求参数不正确", 422, "VALIDATION_ERROR", error.flatten());
  }
  if (error instanceof Error && "status" in error) {
    return apiError(error.message, Number(error.status), "REQUEST_ERROR");
  }
  console.error(error);
  return apiError("服务器处理失败", 500, "INTERNAL_ERROR");
}

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}
