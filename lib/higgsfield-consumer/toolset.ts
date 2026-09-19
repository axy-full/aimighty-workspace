/**
 * Connected toolset guard (slice P0).
 *
 * The connected account's MCP tool surface differs by OAuth client and changes
 * over time: on 19 September 2026 Particl's own client advertised 98 tools
 * (including `job_status` and `marketing_studio_v2_*`) while another client of
 * the same account advertised 91 (no `job_status`, no `marketing_studio_v2_*`;
 * `job_display` and `jobs_wait` instead). Every paid submit, every quote that
 * may import media, and every status poll therefore checks the live
 * `tools/list` of OUR connection first: the tool must be advertised and must
 * accept exactly the arguments we are about to send. Anything else is refused
 * before spend with a neutral reason.
 *
 * This module is pure (no network, no database): the bounded in-memory cache,
 * the schema check, the status-tool resolution and the normalization of the
 * per-product status fallbacks. mcp.ts owns the reads.
 */

/** Short: a changed surface is noticed within a minute, and a miss re-reads at once. */
export const TOOLSET_TTL_MS = 60_000;
const CACHE_ENTRIES = 256;
const SCHEMA_DEPTH = 24;

export type ConnectedToolset = {
  tools: ReadonlyMap<string, Record<string, unknown>>;
  fetchedAt: number;
};
export type ToolCheck = "ok" | "missing" | "mismatch";

const cache = new Map<string, { toolset: ConnectedToolset; expiresAt: number }>();

export function cachedToolset(key: string, now = Date.now()): ConnectedToolset | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= now) {
    cache.delete(key);
    return null;
  }
  return entry.toolset;
}
export function storeToolset(key: string, toolset: ConnectedToolset, now = Date.now()) {
  cache.delete(key);
  cache.set(key, { toolset, expiresAt: now + TOOLSET_TTL_MS });
  while (cache.size > CACHE_ENTRIES) cache.delete(cache.keys().next().value!);
}
export function invalidateToolset(key: string) {
  cache.delete(key);
}
/** Tests only: forget every connection's toolset. */
export function resetConnectedToolsetCache() {
  cache.clear();
}

export function toolsetFrom(entries: { name: string; inputSchema: Record<string, unknown> }[], now = Date.now()): ConnectedToolset {
  return { tools: new Map(entries.map((entry) => [entry.name, entry.inputSchema])), fetchedAt: now };
}

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const typeOf = (value: unknown) =>
  value === null ? "null" : Array.isArray(value) ? "array" : typeof value === "number" ? (Number.isInteger(value) ? "integer" : "number") : typeof value;
function typeMatches(declared: unknown, value: unknown): boolean {
  if (declared === undefined) return true;
  const types = Array.isArray(declared) ? declared : [declared];
  const actual = typeOf(value);
  return types.some((type) => type === actual || (type === "number" && actual === "integer"));
}
/** `{"not": {}}` forbids the property outright (the batch tools declare
 * `get_cost` this way: "Cost preflight is not supported inside a batch"). */
const forbidden = (schema: unknown) => record(schema) && record(schema.not) && Object.keys(schema.not).length === 0;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Whether the advertised JSON schema accepts a value we built ourselves. It
 * checks what matters for "does the provider still take what we send":
 * declared types, required keys, `additionalProperties:false`, forbidden
 * properties, enum/const, numeric bounds, array item schemas and bounds, and
 * `anyOf`/`oneOf` branches. Provider-supplied `pattern` regular expressions are
 * deliberately not compiled or run (untrusted input); formats are not checked.
 */
export function schemaAccepts(schema: unknown, value: unknown, depth = 0): boolean {
  if (depth > SCHEMA_DEPTH) return false;
  if (schema === true || (record(schema) && Object.keys(schema).length === 0)) return true;
  if (!record(schema)) return false;
  if (forbidden(schema)) return false;
  for (const key of ["anyOf", "oneOf"] as const) {
    const branches = schema[key];
    if (branches !== undefined) {
      if (!Array.isArray(branches) || !branches.some((branch) => schemaAccepts(branch, value, depth + 1))) return false;
    }
  }
  if (Array.isArray(schema.allOf) && !schema.allOf.every((branch) => schemaAccepts(branch, value, depth + 1))) return false;
  if (!typeMatches(schema.type, value)) return false;
  if (Array.isArray(schema.enum) && !schema.enum.some((option) => same(option, value))) return false;
  if ("const" in schema && !same(schema.const, value)) return false;
  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) return false;
    if (typeof schema.maximum === "number" && value > schema.maximum) return false;
    if (typeof schema.exclusiveMinimum === "number" && value <= schema.exclusiveMinimum) return false;
    if (typeof schema.exclusiveMaximum === "number" && value >= schema.exclusiveMaximum) return false;
  }
  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength) return false;
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) return false;
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) return false;
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) return false;
    if (schema.items !== undefined && !value.every((item) => schemaAccepts(schema.items, item, depth + 1))) return false;
  }
  if (record(value)) {
    const properties = record(schema.properties) ? schema.properties : {};
    if (Array.isArray(schema.required) && !schema.required.every((key) => typeof key === "string" && key in value)) return false;
    for (const [key, child] of Object.entries(value)) {
      if (child === undefined) continue;
      if (key in properties) {
        if (!schemaAccepts(properties[key], child, depth + 1)) return false;
      } else if (schema.additionalProperties === false) {
        return false;
      } else if (record(schema.additionalProperties) && !schemaAccepts(schema.additionalProperties, child, depth + 1)) {
        return false;
      }
    }
  }
  return true;
}

export function checkTool(toolset: ConnectedToolset, name: string, args: Record<string, unknown>): ToolCheck {
  const schema = toolset.tools.get(name);
  if (!schema) return "missing";
  return schemaAccepts(schema, args) ? "ok" : "mismatch";
}

/* ── Status reads ───────────────────────────────────────────────────── */

/** In order of preference. `job_status` is the qualified normalized envelope;
 * `job_display` (one job by id) and `jobs_wait` (an immediate snapshot of up to
 * twelve jobs) are the per-product status reads some connections advertise
 * instead. Every one is read-only. */
export const STATUS_TOOLS = ["job_status", "job_display", "jobs_wait"] as const;
export type StatusTool = (typeof STATUS_TOOLS)[number];
export function statusArguments(tool: StatusTool, jobId: string, rawData = false): Record<string, unknown> {
  if (tool === "job_status") return { jobId, sync: false, raw_data: rawData };
  if (tool === "job_display") return { id: jobId };
  return { jobs: [{ index: 0, job_id: jobId }], timeout_seconds: 0 };
}
/** The first advertised status tool that accepts our arguments, or null. A
 * caller that needs the raw provider envelope (raw_data) accepts only job_status. */
export function resolveStatusTool(toolset: ConnectedToolset, jobId: string, options: { rawData?: boolean } = {}): StatusTool | null {
  const candidates: readonly StatusTool[] = options.rawData ? ["job_status"] : STATUS_TOOLS;
  return candidates.find((tool) => checkTool(toolset, tool, statusArguments(tool, jobId, options.rawData)) === "ok") ?? null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const idOf = (value: Record<string, unknown>) => {
  const ids = ["id", "job_id", "jobId"].map((key) => value[key]).filter((id) => id !== undefined);
  if (!ids.length || ids.some((id) => typeof id !== "string" || !UUID.test(id))) return null;
  const unique = new Set(ids.map((id) => (id as string).toLowerCase()));
  return unique.size === 1 ? [...unique][0] : null;
};
/** Exactly one HTTPS result URL under a recognised key, or undefined. */
function resultUrl(entry: Record<string, unknown>): string | undefined {
  const found = new Set<string>();
  const add = (value: unknown) => {
    if (typeof value === "string" && value.startsWith("https://")) found.add(value);
  };
  const results = entry.results;
  if (record(results)) {
    add(results.rawUrl);
    add(results.raw_url);
    add(results.url);
  } else if (Array.isArray(results)) {
    for (const item of results) {
      if (typeof item === "string") add(item);
      else if (record(item)) add(item.rawUrl ?? item.raw_url ?? item.url);
    }
  }
  add(entry.result_url);
  add(entry.url);
  if (Array.isArray(entry.result_urls)) entry.result_urls.forEach(add);
  if (Array.isArray(entry.urls)) entry.urls.forEach(add);
  return found.size === 1 ? [...found][0] : undefined;
}
export type StatusExpectation = { model?: string; type?: string };
/**
 * Rewrites a `job_display` or `jobs_wait` reply into the normalized
 * `{generation:{id,status,model,type,params,results:{rawUrl}}}` envelope the
 * collectors already qualify. The entry must name exactly the acknowledged job
 * id. A model or output type the entry states must be the expected one (the
 * collector re-checks); when the entry omits them the job is bound by its id
 * alone, the id we received from our own acknowledged submission. Anything
 * unrecognised becomes an inert diagnostic that can never qualify an original.
 */
export function normalizeFallbackStatus(tool: Exclude<StatusTool, "job_status">, raw: unknown, jobId: string, expected: StatusExpectation = {}): Record<string, unknown> {
  const unrecognised = { status_source: tool, recognised: false };
  if (!record(raw)) return unrecognised;
  let entry: Record<string, unknown> | undefined;
  let wait: unknown;
  if (tool === "job_display") {
    const candidate = [raw.generation, raw.job, raw].find((value) => record(value) && idOf(value) !== null);
    if (record(candidate)) entry = candidate;
  } else {
    const list = [raw.jobs, raw.results, raw.statuses].find(Array.isArray) as unknown[] | undefined;
    const matching = (list ?? []).filter((item) => record(item) && idOf(item) === jobId.toLowerCase());
    if (matching.length === 1 && record(matching[0])) entry = matching[0];
    if (raw.all_terminal !== true) wait = raw.poll_after_seconds;
  }
  if (!entry || idOf(entry) !== jobId.toLowerCase() || typeof entry.status !== "string") return unrecognised;
  const generation: Record<string, unknown> = { id: jobId.toLowerCase(), status: entry.status };
  const model = entry.model ?? expected.model;
  const type = entry.type ?? expected.type;
  if (model !== undefined) generation.model = model;
  if (type !== undefined) generation.type = type;
  if (entry.params !== undefined) generation.params = entry.params;
  const url = resultUrl(entry);
  if (url) generation.results = { rawUrl: url };
  else if (entry.results != null) generation.results = { unrecognised: true };
  return {
    status_source: tool,
    generation,
    ...(typeof wait === "number" && Number.isFinite(wait) && wait >= 0 && wait <= 3600 ? { poll_after_seconds: wait } : {}),
  };
}
