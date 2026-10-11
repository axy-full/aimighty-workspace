"use client";
import { useApi } from "@/lib/useApi";

/**
 * The console's two ways of talking to the server: a read that refreshes itself, and a change that answers with the
 * server's own words when it is refused. Every route is the platform owner's (app/api/admin/*, requireSuperAdmin); a
 * refusal reads here as the server's sentence, never a code.
 */
export function useAdminRead<T>(url: string | null, everyMs = 0) {
  return useApi<T>(url, everyMs);
}

export type Sent<T> = { ok: true; json: T } | { ok: false; error: string; status: number };

export async function adminSend<T = Record<string, unknown>>(url: string, method: "POST" | "PATCH" | "DELETE", body?: unknown): Promise<Sent<T>> {
  try {
    const res = await fetch(url, { method, headers: body === undefined ? undefined : { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const json = (await res.json().catch(() => ({}))) as T & { error?: string };
    if (!res.ok) return { ok: false, status: res.status, error: json.error ?? `The server answered ${res.status}.` };
    return { ok: true, json };
  } catch {
    return { ok: false, status: 0, error: "Could not reach the server." };
  }
}
