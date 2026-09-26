/**
 * Small, pure helpers the plan registry uses to talk to the existing routes.
 * Nothing here knows about a particular plan.
 */

import type { ApprovedQuote, NamedBody, PlanContext, QuotePart } from "./plan-types";

export class PlanRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "PlanRequestError";
  }
}

/** JSON request through the page's scoped fetch; throws the route's own error text. */
export async function call<T = Record<string, unknown>>(
  ctx: PlanContext,
  path: string,
  init?: { method?: string; body?: unknown; headers?: Record<string, string> },
): Promise<T> {
  const method = init?.method ?? (init?.body === undefined ? "GET" : "POST");
  const response = await ctx.fetch(path, {
    method,
    cache: "no-store",
    headers: {
      ...(init?.body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(init?.headers ?? {}),
    },
    ...(init?.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  const data = (await response.json().catch(() => null)) as
    | (Record<string, unknown> & { error?: unknown; code?: unknown })
    | null;
  if (!response.ok || !data) {
    const text =
      data && typeof data.error === "string" && data.error
        ? data.error
        : `The request failed (${response.status}).`;
    throw new PlanRequestError(
      text,
      response.status,
      data && typeof data.code === "string" ? data.code : undefined,
    );
  }
  return data as T;
}

/** Deterministic JSON (sorted keys) so equal inputs give equal keys. */
export function stableKey(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableKey).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableKey(record[key])}`)
    .join(",")}}`;
}

/** 64-bit FNV-1a as hex. An idempotency/fingerprint key, not a security hash. */
export function shortHash(text: string): string {
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ 0x5bd1e995;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b ^ c, 0x5bd1e995) >>> 0;
  }
  return a.toString(16).padStart(8, "0") + b.toString(16).padStart(8, "0");
}

export const newId = (ctx: PlanContext) =>
  ctx.newId ? ctx.newId() : globalThis.crypto.randomUUID();

export const wait = (ctx: PlanContext, ms: number) =>
  ctx.wait ? ctx.wait(ms) : new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Idempotency-Key the generate/audio routes accept: [A-Za-z0-9._:-]{8,160}.
 *
 * One key per request of one approved run: the run id and the request itself
 * (its body, and which copy of it when a run sends the same body twice).
 * Re-sending inside the same run (a resume after an uncertain dispatch)
 * recovers the job already admitted instead of paying twice, even when the
 * resume's quote holds fewer parts; a new run is a new request, so running a
 * plan again with unchanged inputs really renders again. (The quote
 * fingerprint is deterministic over the inputs, so a key made from it alone
 * replayed the previous run's job.)
 */
export const idempotencyKey = (prefix: string, part: QuotePart, approved: Pick<ApprovedQuote, "runId" | "parts">) => {
  const run = approved.runId.replace(/[^A-Za-z0-9._:-]/g, "").slice(0, 100);
  const request = stableKey(part.body);
  const index = approved.parts.indexOf(part);
  const copy = index < 0 ? 0 : approved.parts.slice(0, index).filter((other) => stableKey(other.body) === request).length;
  return `${prefix}:${run}:${shortHash(request)}${copy ? `.${copy}` : ""}`;
};

export const bodies = (list: NamedBody[] | undefined) =>
  (list ?? []).filter(
    (item): item is NamedBody =>
      !!item &&
      typeof item.name === "string" &&
      !!item.body &&
      typeof item.body === "object",
  );

export const plural = (n: number, one: string, many = `${one}s`) =>
  `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

/** Poll a real status read until it is terminal, a bounded number of times. */
export async function follow<T>(
  ctx: PlanContext,
  read: () => Promise<T>,
  terminal: (value: T) => boolean,
  options: { attempts?: number; intervalMs?: number } = {},
): Promise<{ value: T; settled: boolean }> {
  const attempts = options.attempts ?? 20;
  const interval = options.intervalMs ?? 3_000;
  let value = await read();
  for (let i = 1; i < attempts && !terminal(value); i += 1) {
    await wait(ctx, interval);
    value = await read();
  }
  return { value, settled: terminal(value) };
}
