/**
 * One way to call the desk's routes: JSON in, JSON out, the server's own
 * sentence as the error. The routes are the v1 routes (`/api/admin/*`);
 * the desk only extends what it sends them.
 */
export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) { super(message); this.status = status; }
}

export async function call<T = Record<string, unknown>>(url: string, method: "POST" | "PATCH" | "DELETE", body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({})) as T & { error?: string };
  if (!res.ok) throw new ApiError(json.error ?? `The server answered ${res.status}.`, res.status);
  return json;
}

export const patchWorkspace = (id: string, body: Record<string, unknown>) =>
  call(`/api/admin/workspaces/${encodeURIComponent(id)}`, "PATCH", body);
