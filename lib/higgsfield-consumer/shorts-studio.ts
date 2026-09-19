/**
 * Shorts Studio on the connected account (Subatomik, slice F4): restyle ONE
 * project video (4–120 s) into a set of short clips with a style preset.
 *
 * Contract, from the connector's advertised schemas (19 September 2026,
 * `tests/fixtures/connected-shorts-studio.json`):
 * - `shorts_studio_list_presets {cursor?}` → `{items:[{id, name, preset_source}], next_cursor, has_more}` (free read).
 * - `shorts_studio_create {duration_seconds, get_cost:true}` → the exact credit
 *   price for a source of that length; no preset or source is needed, so the
 *   price is read BEFORE the source is imported.
 * - `shorts_studio_create {preset_id, preset_source, source_video_id,
 *   aspect_ratio, resolution:"720p", duration_seconds}` → a session
 *   `{id, status, job_ids:[]}` (PAID, one call).
 * - `shorts_studio_status {session_id}` → `{id, status, job_ids}`;
 *   `completed` means every clip job is terminal, not that each succeeded.
 * - each clip is read with `job_status` like any typed video job.
 *
 * One session is one quote, one approval, one dispatch claim and one
 * settlement; every successful clip is collected as its own original.
 * Pure (no database, no network) so the browser form and the server share it.
 */
import { z } from "zod";
import { consumerMediaIdentitySchema } from "./genjutsu-contract";
import { ConsumerVideoError } from "./video-contract";
import type { ConsumerGenerationInput } from "./generation-contract";

export const SHORTS_TOOLS = Object.freeze({
  presets: "shorts_studio_list_presets",
  create: "shorts_studio_create",
  status: "shorts_studio_status",
} as const);
export const SHORTS_ASPECT_RATIOS = ["9:16", "16:9"] as const;
export const SHORTS_PRESET_SOURCES = ["cms", "user"] as const;
export const SHORTS_LIMITS = Object.freeze({ minSeconds: 4, maxSeconds: 120, clips: 20, presets: 200, presetPages: 5 });
export const SHORTS_SOURCE_ROLE = "video";
export type ShortsAspectRatio = (typeof SHORTS_ASPECT_RATIOS)[number];

export class ShortsStudioError extends Error {
  readonly status: number;
  constructor(readonly code: "invalid_input" | "price_unknown" | "contract_unverified" | "invalid_presets" | "invalid_session", message: string) {
    super(message);
    this.name = "ShortsStudioError";
    this.status = code === "invalid_input" ? 400 : code === "price_unknown" ? 409 : 502;
  }
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const clean = (value: unknown, max: number) => (typeof value === "string" ? value.replace(/\p{Cc}/gu, "").trim().slice(0, max) : "");

/* ── Presets (read-only listing) ─────────────────────────────────────── */
export type ShortsPreset = { id: string; name: string; source: (typeof SHORTS_PRESET_SOURCES)[number] };
export type ShortsPresets = { presets: ShortsPreset[]; complete: boolean; fetchedAt: number };
/** One listing page. Preview media URLs are dropped: nothing from the
 * provider's CDN is loaded by the page. */
export function parseShortsPresetsPage(raw: unknown): { items: ShortsPreset[]; next: string | null } {
  if (!object(raw) || !Array.isArray(raw.items) || raw.items.length > SHORTS_LIMITS.presets)
    throw new ShortsStudioError("invalid_presets", "The connected account returned an unusable style list.");
  const items: ShortsPreset[] = [];
  for (const item of raw.items) {
    if (!object(item) || typeof item.id !== "string" || !UUID.test(item.id) || !SHORTS_PRESET_SOURCES.includes(item.preset_source as ShortsPreset["source"])) continue;
    items.push({ id: item.id.toLowerCase(), name: clean(item.name, 120) || "Untitled style", source: item.preset_source as ShortsPreset["source"] });
  }
  const next = raw.next_cursor;
  if (next !== null && next !== undefined && (typeof next !== "string" || !/^[\x21-\x7e]{1,512}$/.test(next)))
    throw new ShortsStudioError("invalid_presets", "The connected account returned an unusable style list.");
  return { items, next: raw.has_more === true && typeof next === "string" ? next : null };
}
export function mergeShortsPresets(pages: ShortsPreset[][], complete: boolean, fetchedAt = Date.now()): ShortsPresets {
  const seen = new Set<string>(), presets: ShortsPreset[] = [];
  for (const item of pages.flat()) {
    const key = `${item.source}:${item.id}`;
    if (seen.has(key) || presets.length >= SHORTS_LIMITS.presets) continue;
    seen.add(key); presets.push(item);
  }
  return { presets, complete, fetchedAt };
}

/* ── Request ─────────────────────────────────────────────────────────── */
export const consumerShortsInputSchema = z
  .object({
    /** The one project video (upload or completed generation) to restyle. */
    source: consumerMediaIdentitySchema,
    preset: z.object({ id: z.uuid(), source: z.enum(SHORTS_PRESET_SOURCES), name: z.string().max(120).optional() }).strict(),
    aspectRatio: z.enum(SHORTS_ASPECT_RATIOS),
  })
  .strict();
export type ConsumerShortsInput = z.infer<typeof consumerShortsInputSchema>;
export function parseConsumerShortsInput(value: unknown): ConsumerShortsInput {
  const parsed = consumerShortsInputSchema.safeParse(value);
  if (!parsed.success) throw new ConsumerVideoError("invalid_input");
  return parsed.data;
}
/** A stored source duration as Shorts Studio takes it: 4–120 s, rounded up to
 * hundredths so the priced length never undercounts. */
export function shortsDurationSeconds(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0)
    throw new ShortsStudioError("invalid_input", "This video has no stored duration. Re-upload it before making shorts.");
  const seconds = Math.ceil(value * 100) / 100;
  if (seconds < SHORTS_LIMITS.minSeconds || seconds > SHORTS_LIMITS.maxSeconds)
    throw new ShortsStudioError("invalid_input", `Shorts need a source video of ${SHORTS_LIMITS.minSeconds}–${SHORTS_LIMITS.maxSeconds} seconds.`);
  return seconds;
}
export type ConsumerShortsParams = {
  preset_id: string;
  preset_source: "cms" | "user";
  source_video_id: string;
  aspect_ratio: ShortsAspectRatio;
  resolution: "720p";
  duration_seconds: number;
};
/** Exactly the advertised create arguments, from a validated input, a
 * completed import's media id and the stored source duration. */
export function consumerShortsParams(value: unknown, mediaId: string, durationSeconds: unknown): ConsumerShortsParams {
  const input = parseConsumerShortsInput(value);
  if (!UUID.test(mediaId)) throw new ConsumerVideoError("invalid_input");
  return {
    preset_id: input.preset.id.toLowerCase(),
    preset_source: input.preset.source,
    source_video_id: mediaId.toLowerCase(),
    aspect_ratio: input.aspectRatio,
    resolution: "720p",
    duration_seconds: shortsDurationSeconds(durationSeconds),
  };
}
/** The advertised non-submitting cost form: duration only. */
export const shortsCostArguments = (params: Pick<ConsumerShortsParams, "duration_seconds">) => ({ duration_seconds: params.duration_seconds, get_cost: true });
/** The source as a Generate-style one-reference request, so validation,
 * resolution and the durable import claim are the Generate ones. */
export function shortsReferenceRequest(value: unknown): ConsumerGenerationInput {
  const input = parseConsumerShortsInput(value);
  return {
    type: "video",
    model: "shorts_studio",
    prompt: "",
    parameters: { preset_id: input.preset.id, preset_source: input.preset.source, aspect_ratio: input.aspectRatio },
    medias: [{ role: SHORTS_SOURCE_ROLE, source: input.source }],
  };
}

/* ── Advertised schema verification ──────────────────────────────────── */
/** The create tool must declare every argument we send at the top level plus
 * `get_cost`, no required argument we do not send, and enums/consts/bounds
 * that admit our values. */
export function shortsCreateSchemaMatches(inputSchema: unknown, params: ConsumerShortsParams): boolean {
  if (!object(inputSchema) || !object(inputSchema.properties)) return false;
  const properties = inputSchema.properties;
  const required = Array.isArray(inputSchema.required) ? inputSchema.required : [];
  const keys = Object.keys(params) as (keyof ConsumerShortsParams)[];
  if (!("get_cost" in properties) || !keys.every((key) => key in properties)) return false;
  if (required.some((key) => typeof key !== "string" || !keys.includes(key as keyof ConsumerShortsParams))) return false;
  for (const key of keys) {
    const declared = properties[key], value = params[key];
    if (!object(declared)) return false;
    if (Array.isArray(declared.enum) && !declared.enum.includes(value)) return false;
    if (declared.const !== undefined && declared.const !== value) return false;
    if (typeof value === "number") {
      if (declared.type !== "number" && declared.type !== "integer") return false;
      if (typeof declared.maximum === "number" && value > declared.maximum) return false;
      if (typeof declared.exclusiveMinimum === "number" && value <= declared.exclusiveMinimum) return false;
    } else if (declared.type !== undefined && declared.type !== "string") return false;
  }
  return true;
}
/** The status tool must take exactly `session_id`. */
export function shortsStatusSchemaMatches(inputSchema: unknown): boolean {
  if (!object(inputSchema) || !object(inputSchema.properties) || !("session_id" in inputSchema.properties)) return false;
  const required = Array.isArray(inputSchema.required) ? inputSchema.required : [];
  return required.every((key) => key === "session_id");
}

/* ── Session acknowledgement and status ──────────────────────────────── */
/** Exactly one structured session UUID is acceptance; anything else is uncertain. */
export function consumerShortsAcknowledgement(value: unknown): string | null {
  if (!object(value)) return null;
  const ids = ["id", "session_id"].filter((key) => key in value).map((key) => value[key]);
  if (!ids.length || ids.some((id) => typeof id !== "string" || !UUID.test(id))) return null;
  const unique = new Set((ids as string[]).map((id) => id.toLowerCase()));
  if (unique.size !== 1) return null;
  if ("job_ids" in value && !Array.isArray(value.job_ids)) return null;
  return [...unique][0];
}
export type ShortsSessionStatus = { sessionId: string; status: string; terminal: boolean; failed: boolean; jobIds: string[] };
const SESSION_FAILED = new Set(["failed", "canceled", "cancelled", "error"]);
/** `shorts_studio_status` for exactly the acknowledged session. */
export function parseShortsSessionStatus(value: unknown, sessionId: string): ShortsSessionStatus {
  if (!object(value) || consumerShortsAcknowledgement({ id: value.id ?? value.session_id }) !== sessionId.toLowerCase() || typeof value.status !== "string")
    throw new ShortsStudioError("invalid_session", "The connected account returned an unusable session status.");
  const list = value.job_ids ?? [];
  if (!Array.isArray(list) || list.length > SHORTS_LIMITS.clips || list.some((id) => typeof id !== "string" || !UUID.test(id)))
    throw new ShortsStudioError("invalid_session", "The connected account returned an unusable session status.");
  const jobIds = [...new Set((list as string[]).map((id) => id.toLowerCase()))];
  if (jobIds.length !== list.length || jobIds.includes(sessionId.toLowerCase()))
    throw new ShortsStudioError("invalid_session", "The connected account returned an unusable session status.");
  const status = value.status.toLowerCase().slice(0, 40);
  return { sessionId: sessionId.toLowerCase(), status, terminal: status === "completed" || SESSION_FAILED.has(status), failed: SESSION_FAILED.has(status), jobIds };
}

/* ── Clips ───────────────────────────────────────────────────────────── */
export type ShortsClipOutcome =
  | { index: number; providerJobId: string; state: "collected"; original: Record<string, unknown> }
  | { index: number; providerJobId: string; state: "failed"; reason: string };
/** A settled session: at least one clip, every clip terminal. */
export function shortsSettlement(clips: ShortsClipOutcome[]) {
  const collected = clips.filter((clip) => clip.state === "collected").length;
  return { clips: clips.length, collected, failed: clips.length - collected };
}
/** "<source> · short 2 of 5" */
export function shortsClipName(sourceName: string, index: number, total: number, style?: string) {
  const base = sourceName.replace(/\.[A-Za-z0-9]{1,5}$/, "").trim().slice(0, 100) || "Source";
  return `${base} · short ${index + 1} of ${total}${style ? ` (${style.slice(0, 40)})` : ""}`;
}
