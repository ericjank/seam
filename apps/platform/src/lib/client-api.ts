"use client";

export async function apiRequest(path: string, body?: unknown, method = "POST") {
  const response = await fetch(path, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json() as { error?: { message?: string } };
  if (!response.ok) throw new Error(data.error?.message ?? `请求失败（${response.status}）`);
  return data as Record<string, any>;
}

export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
