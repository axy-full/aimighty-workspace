/**
 * Voice, dubbing and analysis tools on the connected account (Atomik Generate,
 * slice I3). Each tool is a typed request over ONE project video: the
 * arguments are exactly the ones the connector's discovery advertised on
 * 19 September 2026 (`tests/fixtures/connected-voice-tools.json`), nothing
 * else is ever sent, and the advertised schema is re-read from `tools/list`
 * at quote and submit time so a changed contract refuses the request.
 *
 * None of the three tools advertised a `get_cost` preflight on that day and
 * no catalogue entry prices them, so a quote is possible only when the live
 * schema declares `get_cost`; otherwise the request is refused before any
 * import or paid call (`price_unknown`). Analyse video additionally stays
 * behind `capabilities.analysis` (off) because its report schema is unverified.
 *
 * Pure (no database, no network) so the browser form and the server share it.
 */
import { z } from "zod";
import { consumerMediaIdentitySchema, type ConsumerMediaIdentity } from "./genjutsu-contract";
import { ConsumerVideoError } from "./video-contract";

export const VOICE_TOOL_NAMES = ["voice_change", "dubbing", "video_analysis"] as const;
export type VoiceToolName = (typeof VOICE_TOOL_NAMES)[number];
/** ISO-639-3 codes exactly as the `dubbing` tool's `target_language` enum advertised them. */
export const DUBBING_LANGUAGES = Object.freeze([
  { code: "eng", name: "English" }, { code: "cmn", name: "Chinese" }, { code: "fra", name: "French" }, { code: "hin", name: "Hindi" },
  { code: "ita", name: "Italian" }, { code: "jpn", name: "Japanese" }, { code: "kor", name: "Korean" }, { code: "por", name: "Portuguese" },
  { code: "rus", name: "Russian" }, { code: "tur", name: "Turkish" }, { code: "spa", name: "Spanish" }, { code: "deu", name: "German" },
  { code: "ara", name: "Arabic" }, { code: "pol", name: "Polish" }, { code: "ind", name: "Indonesian" }, { code: "fil", name: "Filipino" },
  { code: "swe", name: "Swedish" }, { code: "fin", name: "Finnish" },
] as const);
export type DubbingLanguage = (typeof DUBBING_LANGUAGES)[number]["code"];
const LANGUAGE_CODES = DUBBING_LANGUAGES.map((entry) => entry.code) as [DubbingLanguage, ...DubbingLanguage[]];
export const dubbingLanguageName = (code: string) => DUBBING_LANGUAGES.find((entry) => entry.code === code)?.name ?? code;
export const VOICE_TYPES = ["preset", "element"] as const;
export type VoiceType = (typeof VOICE_TYPES)[number];

export type VoiceTool = {
  name: VoiceToolName;
  label: string;
  description: string;
  /** The advertised MCP tool that creates the job, and the one that reports it. */
  create: string;
  status: "job_status" | "video_analysis_status";
  /** The argument names this workflow sends, in the order they are built. */
  arguments: readonly string[];
  /** A dubbed/revoiced video is collected as an original; a report is filed as a note. */
  output: "video" | "report";
  suffix: string;
};
export const VOICE_TOOLS: readonly VoiceTool[] = Object.freeze([
  { name: "voice_change", label: "Change voice", description: "Replace the spoken voice in a project video with a voice from the connected account, keeping the timing and picture.", create: "voice_change", status: "job_status", arguments: ["video_id", "voice_id", "voice_type"], output: "video", suffix: "voice changed" },
  { name: "dubbing", label: "Dub", description: "Translate a project video’s speech into another language, re-voice it and lip-sync the result.", create: "dubbing", status: "job_status", arguments: ["video_id", "target_language"], output: "video", suffix: "dubbed" },
  { name: "video_analysis", label: "Analyse video", description: "Ask the connected account for a scene-by-scene report on a project video. Shorter clips give the most reliable report.", create: "video_analysis_create", status: "video_analysis_status", arguments: ["video_input_id"], output: "report", suffix: "analysed" },
]);
export const VOICE_TOOL_STATUS_ARGUMENT = "video_analyze_id";
export function findVoiceTool(name: string): VoiceTool | null {
  return VOICE_TOOLS.find((tool) => tool.name === name) ?? null;
}
export type VoiceToolErrorCode = "tool_unknown" | "invalid_input" | "price_unknown" | "contract_unverified" | "analysis_disabled" | "invalid_voices";
export class VoiceToolError extends Error {
  readonly status: number;
  constructor(readonly code: VoiceToolErrorCode, message: string) {
    super(message);
    this.name = "VoiceToolError";
    this.status = code === "tool_unknown" || code === "invalid_input" ? 400 : code === "analysis_disabled" ? 403 : code === "price_unknown" ? 409 : 502;
  }
}
export function requireVoiceTool(name: string): VoiceTool {
  const tool = findVoiceTool(name);
  if (!tool) throw new VoiceToolError("tool_unknown", "Choose a voice tool from the list.");
  return tool;
}

/* ── Request ─────────────────────────────────────────────────────────── */
const voiceId = z.string().min(1).max(200).regex(/^[\x21-\x7e]+$/);
export const consumerVoiceToolInputSchema = z
  .object({
    tool: z.enum(VOICE_TOOL_NAMES),
    /** The one project video (upload or completed generation) the tool works on. */
    source: consumerMediaIdentitySchema,
    /** Change voice: the exact `{voice_id, voice_type}` pair from `list_voices`; `name` is display only. */
    voice: z.object({ id: voiceId, type: z.enum(VOICE_TYPES), name: z.string().max(160).optional() }).strict().optional(),
    /** Dub: the target language code. */
    targetLanguage: z.enum(LANGUAGE_CODES).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const needsVoice = value.tool === "voice_change", needsLanguage = value.tool === "dubbing";
    if (needsVoice !== Boolean(value.voice)) ctx.addIssue({ code: "custom", message: needsVoice ? "Choose a voice." : "This tool takes no voice." });
    if (needsLanguage !== Boolean(value.targetLanguage)) ctx.addIssue({ code: "custom", message: needsLanguage ? "Choose a target language." : "This tool takes no language." });
  });
export type ConsumerVoiceToolInput = z.infer<typeof consumerVoiceToolInputSchema>;
export function parseConsumerVoiceToolInput(value: unknown): ConsumerVoiceToolInput {
  const parsed = consumerVoiceToolInputSchema.safeParse(value);
  if (!parsed.success) throw new ConsumerVideoError("invalid_input");
  return parsed.data;
}
export type ConsumerVoiceToolParams = Record<string, string>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Exactly the declared arguments for the tool, from a validated input and a
 * completed import's media id. Never carries prompt, count, model or presets. */
export function consumerVoiceToolParams(value: unknown, mediaId: string): ConsumerVoiceToolParams {
  const input = parseConsumerVoiceToolInput(value);
  if (!UUID.test(mediaId)) throw new ConsumerVideoError("invalid_input");
  const id = mediaId.toLowerCase();
  if (input.tool === "voice_change") return { video_id: id, voice_id: input.voice!.id, voice_type: input.voice!.type };
  if (input.tool === "dubbing") return { video_id: id, target_language: input.targetLanguage! };
  return { video_input_id: id };
}
export const consumerVoiceToolSourceKey = (source: ConsumerMediaIdentity) => (source.genId ? `generation:${source.genId}` : `upload:${source.uploadId}`);

/* ── Advertised schema verification ──────────────────────────────────── */
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
export type VoiceToolShape = { nested: boolean; getCost: boolean };
/** The advertised input schema must declare every argument we send (at the
 * top level or under `params`) and no required argument we do not send.
 * Declared enums must include the values we would send. `getCost` reports
 * whether a non-submitting `get_cost` form is advertised beside them. */
export function voiceToolArgumentShape(inputSchema: unknown, sent: ConsumerVoiceToolParams): VoiceToolShape | null {
  if (!object(inputSchema)) return null;
  const keys = Object.keys(sent);
  const level = (schema: Record<string, unknown>) => {
    const properties = object(schema.properties) ? schema.properties : null;
    if (!properties) return null;
    const required = Array.isArray(schema.required) ? schema.required.filter((k): k is string => typeof k === "string") : [];
    if (!keys.every((key) => key in properties)) return null;
    if (required.some((key) => !keys.includes(key))) return null;
    for (const key of keys) {
      const declared = properties[key];
      if (object(declared) && Array.isArray(declared.enum) && !declared.enum.includes(sent[key])) return null;
      if (object(declared) && typeof declared.const === "string" && declared.const !== sent[key]) return null;
    }
    return { getCost: "get_cost" in properties };
  };
  const top = level(inputSchema);
  if (top) return { nested: false, ...top };
  const properties = object(inputSchema.properties) ? inputSchema.properties : null;
  const params = properties && object(properties.params) ? properties.params : null;
  const nested = params ? level(params) : null;
  return nested ? { nested: true, ...nested } : null;
}
/** The exact argument object to send: nested under `params` when advertised so,
 * with `get_cost` only when the schema declares it. */
export function voiceToolArguments(params: ConsumerVoiceToolParams, shape: VoiceToolShape, getCost: boolean | null): Record<string, unknown> {
  const body: Record<string, unknown> = { ...params, ...(getCost === null ? {} : { get_cost: getCost }) };
  return shape.nested ? { params: body } : body;
}

/* ── Acknowledgement and status envelopes ────────────────────────────── */
const uuid = (value: unknown): value is string => typeof value === "string" && UUID.test(value);
const ACK_ID_KEYS = ["id", "job_id", "jobId", "video_analyze_id"] as const;
/** Exactly one structured job UUID is acceptance; prose, batches and
 * conflicting identifiers are not. */
export function consumerVoiceToolAcknowledgement(value: unknown): string | null {
  if (!object(value)) return null;
  const ids: string[] = [];
  let invalid = false;
  const add = (id: unknown) => {
    if (!uuid(id)) invalid = true;
    else ids.push(id.toLowerCase());
  };
  const entry = (item: unknown) => {
    if (typeof item === "string") return add(item);
    if (!object(item)) { invalid = true; return; }
    const keys = ACK_ID_KEYS.filter((key) => key in item);
    if (!keys.length) { invalid = true; return; }
    for (const key of keys) add(item[key]);
  };
  for (const key of ACK_ID_KEYS) if (key in value) add(value[key]);
  for (const key of ["jobs", "job_ids", "results"]) {
    if (!(key in value)) continue;
    const list = value[key];
    if (!Array.isArray(list) || list.length !== 1) invalid = true;
    else entry(list[0]);
  }
  if (object(value.generation)) entry(value.generation);
  return !invalid && new Set(ids).size === 1 ? ids[0] : null;
}
const FAILED = new Set(["failed", "canceled", "cancelled", "nsfw", "ip_detected", "error"]);
const safeUrl = (value: unknown) => {
  if (typeof value !== "string" || value.length > 8192) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.port && !url.hash ? url.toString() : null;
  } catch {
    return null;
  }
};
/** The normalized `job_status` envelope (`raw_data:false`) for exactly the
 * acknowledged job. The provider's model name for these tools is unverified,
 * so it is recorded but not matched; the output type, when present, must be
 * video. Anything else stays diagnostic. */
function videoEvidence(value: unknown, jobId: string) {
  if (!object(value) || !object(value.generation)) return null;
  if (["id", "job_id", "jobId", "jobs", "job_ids", "results"].some((k) => k in value) && consumerVoiceToolAcknowledgement({ ...value, generation: undefined }) !== jobId) return null;
  const g = value.generation;
  if (consumerVoiceToolAcknowledgement(Object.fromEntries(ACK_ID_KEYS.filter((k) => k in g).map((k) => [k, g[k]]))) !== jobId) return null;
  if (typeof g.status !== "string" || ("type" in g && g.type !== "video")) return null;
  if ("status" in value && value.status !== g.status) return null;
  return g;
}
export function consumerVoiceToolOriginalResult(value: unknown, jobId: string): { url: string } | null {
  const g = videoEvidence(value, jobId);
  if (!g || g.status !== "completed" || !object(g.results)) return null;
  const url = safeUrl(g.results.rawUrl);
  return url ? { url } : null;
}
export function consumerVoiceToolFailureResult(value: unknown, jobId: string): string | null {
  const g = videoEvidence(value, jobId);
  if (!g || !FAILED.has(String(g.status)) || g.results != null) return null;
  return String(g.status);
}

/* ── Analysis report (unverified schema, bounded and labelled) ───────── */
export const ANALYSIS_REPORT_LIMITS = { scenes: 200, text: 2000, figures: 24, jsonBytes: 65_536 } as const;
export type VideoAnalysisFigure = { key: string; label: string; value: number };
export type VideoAnalysisScene = { index: number; start?: number; end?: number; text: string };
export type VideoAnalysisReport = {
  /** Numeric estimates found under recognisable keys (hook, attention, retention, virality, engagement, overall). */
  figures: VideoAnalysisFigure[];
  scenes: VideoAnalysisScene[];
  sceneCount: number;
  summary: string;
  /** The redacted provider envelope, kept only while it fits the manifest bound. */
  raw?: Record<string, unknown>;
  truncated?: boolean;
};
const FIGURE = /hook|attention|retention|viral|engagement|overall|score/i;
const clean = (value: unknown, max: number) =>
  typeof value === "string" ? value.replace(/\p{Cc}/gu, (c) => (c === "\n" ? c : "")).replace(/https?:\/\/[^\s<>"']+/giu, "[link omitted]").trim().slice(0, max) : "";
const number = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : null);
function reportEvidence(value: unknown, jobId: string): Record<string, unknown> | null {
  if (!object(value)) return null;
  const body = object(value.analysis) ? value.analysis : object(value.result) ? value.result : value;
  const found = consumerVoiceToolAcknowledgement(Object.fromEntries(ACK_ID_KEYS.filter((k) => k in body).map((k) => [k, body[k]])));
  if (found !== null && found !== jobId) return null;
  const top = consumerVoiceToolAcknowledgement(Object.fromEntries(ACK_ID_KEYS.filter((k) => k in value).map((k) => [k, value[k]])));
  if (top !== null && top !== jobId) return null;
  if (found === null && top === null) return null;
  return body;
}
/** A completed analysis for exactly the acknowledged job, reduced to bounded
 * figures, scenes and a summary. Unknown envelopes stay diagnostic. */
export function consumerVideoAnalysisReport(value: unknown, jobId: string): VideoAnalysisReport | null {
  const body = reportEvidence(value, jobId);
  if (!body || body.status !== "completed") return null;
  const figures: VideoAnalysisFigure[] = [];
  const scan = (source: Record<string, unknown>, prefix: string) => {
    for (const [key, entry] of Object.entries(source)) {
      if (figures.length >= ANALYSIS_REPORT_LIMITS.figures) return;
      const label = `${prefix}${key}`;
      const n = number(entry);
      if (n !== null && FIGURE.test(label)) figures.push({ key: label, label: label.replace(/[._]/g, " "), value: n });
      else if (object(entry) && !prefix && /score|metric|summary|overall|prediction|figure/i.test(key)) scan(entry, `${key}.`);
    }
  };
  scan(body, "");
  const list = Array.isArray(body.scenes) ? body.scenes : [];
  const scenes: VideoAnalysisScene[] = list.slice(0, ANALYSIS_REPORT_LIMITS.scenes).map((scene, index) => {
    if (!object(scene)) return { index, text: clean(scene, ANALYSIS_REPORT_LIMITS.text) };
    const start = number(scene.start ?? scene.start_time ?? scene.start_s), end = number(scene.end ?? scene.end_time ?? scene.end_s);
    const text = clean(scene.description ?? scene.summary ?? scene.text ?? scene.analysis ?? scene.title, ANALYSIS_REPORT_LIMITS.text);
    return { index, ...(start === null ? {} : { start }), ...(end === null ? {} : { end }), text };
  });
  const summary = clean(body.summary ?? body.overview ?? body.description, ANALYSIS_REPORT_LIMITS.text);
  const serialized = JSON.stringify(body);
  const report: VideoAnalysisReport = { figures, scenes, sceneCount: list.length, summary };
  if (serialized.length <= ANALYSIS_REPORT_LIMITS.jsonBytes) report.raw = body;
  else report.truncated = true;
  return report;
}
export function consumerVideoAnalysisFailure(value: unknown, jobId: string): string | null {
  const body = reportEvidence(value, jobId);
  if (!body || !FAILED.has(String(body.status))) return null;
  return clean(body.fail_reason, 300) || String(body.status);
}
export function consumerVoiceToolPollAfter(value: unknown): number | undefined {
  if (!object(value)) return undefined;
  const wait = value.poll_after_seconds;
  return typeof wait === "number" && Number.isFinite(wait) && wait >= 0 && wait <= 3600 ? Math.max(1, Math.ceil(wait)) : undefined;
}

/* ── Voices (read-only listing) ──────────────────────────────────────── */
export type ConnectedVoice = { id: string; type: VoiceType; name: string; language?: string; gender?: string };
export type ConnectedVoices = { voices: ConnectedVoice[]; complete: boolean; fetchedAt: number };
export const VOICES_LIMITS = { voices: 500, pageSize: 100, pages: 5, jsonBytes: 524_288 } as const;
export const VOICES_TTL_MS = 3_600_000;
export const NEXT_CURSOR = /^[\x21-\x7e]{1,4096}$/;
/** One `list_voices` page: its entries and the cursor for the next page. Entries
 * without the exact `{voice_id, voice_type}` pair the tools need are dropped;
 * preview links are never surfaced. */
export function parseConnectedVoicesPage(raw: unknown): { items: unknown[]; next: string | null } {
  const items = Array.isArray(raw) ? raw : object(raw) ? (Array.isArray(raw.voices) ? raw.voices : Array.isArray(raw.items) ? raw.items : null) : null;
  if (!items) throw new VoiceToolError("invalid_voices", "The connected account returned an unusable voice list.");
  const next = object(raw) ? (raw.next_cursor ?? raw.cursor ?? null) : null;
  if (next !== null && next !== undefined && next !== "" && (typeof next !== "string" || !NEXT_CURSOR.test(next)))
    throw new VoiceToolError("invalid_voices", "The connected account returned an unusable voice list.");
  return { items, next: typeof next === "string" && next ? next : null };
}
export function parseConnectedVoices(raw: unknown, fetchedAt = Date.now()): ConnectedVoices {
  if (!object(raw) || !Array.isArray(raw.items) || raw.items.length > VOICES_LIMITS.voices) throw new VoiceToolError("invalid_voices", "The connected account returned an unusable voice list.");
  const seen = new Set<string>();
  const voices: ConnectedVoice[] = [];
  for (const item of raw.items) {
    if (!object(item)) continue;
    const id = item.voice_id ?? item.id, type = item.voice_type ?? item.type;
    if (typeof id !== "string" || !voiceId.safeParse(id).success || (type !== "preset" && type !== "element") || seen.has(`${type}:${id}`)) continue;
    seen.add(`${type}:${id}`);
    const name = clean(item.name ?? item.title ?? item.display_name, 160) || id;
    const language = clean(item.language ?? item.locale ?? item.accent, 60), gender = clean(item.gender, 30);
    voices.push({ id, type, name, ...(language ? { language } : {}), ...(gender ? { gender } : {}) });
  }
  return { voices, complete: raw.complete !== false, fetchedAt };
}

/** "<source name without extension> · voice changed" / "· dubbed (French)" / "· analysed". */
export function voiceToolResultName(tool: VoiceTool, sourceName: string, input?: Pick<ConsumerVoiceToolInput, "targetLanguage">) {
  const base = sourceName.replace(/\.[A-Za-z0-9]{1,5}$/, "").trim().slice(0, 100) || "Source";
  return tool.name === "dubbing" && input?.targetLanguage ? `${base} · ${tool.suffix} (${dubbingLanguageName(input.targetLanguage)})` : `${base} · ${tool.suffix}`;
}
