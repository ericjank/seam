"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiRequest, errorMessage } from "@/lib/client-api";

export function useAction() {
  const router = useRouter();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function run(path: string, body?: unknown) {
    setBusy(true); setError("");
    try {
      const result = await apiRequest(path, body);
      router.refresh();
      return result;
    } catch (err) {
      setError(errorMessage(err));
      throw err;
    } finally { setBusy(false); }
  }
  return { run, error, busy, setError };
}
