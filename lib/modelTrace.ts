import type { AsyncLocalStorage } from "node:async_hooks";
import type { Telemetry, TelemetryOptions } from "ai";
import { currentTenant } from "./tenant";

/**
 * One span per model call, for Langfuse (the owner's decision of 21 Oct 2026).
 *
 * A model call SITE is where the product asks a model something: an Atomik chat turn, the board
 * planner, Enhance, a development step, and so on (the closed list: tests/helpers/modelCallSites.ts).
 * The site opens the span (`traceModelCall`, or `openModelCall` where the cost is worked out after the
 * answer) with ids and settings only. A DOOR is where the bytes leave (lib/textDirect.ts textPost,
 * lib/gateway.ts gatewayPost, lib/openai-direct.ts, an AI SDK agent's generate, Crew's xAI request):
 * `modelDoor` marks the call sent and reads the usage the provider reported. The AI SDK's telemetry hook
 * (`modelTelemetry`) adds one child span per model step inside an agent loop.
 *
 * What a span carries: workspace, run or chat id, step, mode, band, model, effort, tokens in, out and
 * cached, vendor cost, latency, outcome and environment. NEVER prompt text, messages, instructions,
 * tool arguments or results, outputs, reasoning, images, file names, people, user ids, URLs, headers,
 * keys or error text: nothing here reads any of them, and the SDK hook is given recordInputs and
 * recordOutputs false and an integration that reads usage only.
 *
 * Off unless a tracer is installed (lib/modelTraceExport.ts, from instrumentation.ts when
 * LANGFUSE_ENABLED is exactly "1"). Off, every wrapper just runs its function. Tracing never changes
 * what a call returns or throws, and a tracer that fails is ignored.
 */

/** Every model call site, by the id its span carries. tests/unit/model-call-sites.spec.ts holds this to the closed list. */
export const MODEL_SITES = {
  "atomik.turn": "Atomik chat turn",
  "atomik.memory_read": "Atomik reads a text into Memory",
  "atomik.enhance": "Enhance (the prompt enhancer)",
  "atomik.ideas": "Atomik drafts ideas",
  "atomik.shots": "Atomik drafts a shot list",
  "atomik.treatment_scene": "Atomik writes a treatment scene",
  "atomik.board_planner": "the board planner (a Rig run's planning turn)",
  "atomik.development": "a development step: write, idea, screenplay, ad film, frames, sketch, cast, environment, beat sheet, condense, rig, Verify",
  "atomik.workbench": "a Studio Atomik job: plan, suite agent, 3D blocking agent, reference-ad review",
  "enhance.inline": "the prompt writer before a render (generation admission)",
  "crew.round": "one Crew member's request in a round",
} as const;
export type ModelSiteId = keyof typeof MODEL_SITES;
/** A door reached with no site around it: still traced, under this id. The coverage spec fails if a listed site produces one. */
export const UNATTRIBUTED = "unattributed";

export type ModelCallMode = "agent" | "director";
export type ModelCallOutcome = "answered" | "refused" | "failed" | "timed_out";
export type ModelCallMeta = {
  /** The run, job or request the call belongs to. */
  runId?: string | null;
  chatId?: string | null;
  /** What the call does within its site (a development kind and stage, a job's variant, a Crew phase). */
  step?: string | null;
  /** The board's mode for the person who asked, Agent or Director, where the site knows it. */
  mode?: ModelCallMode | null;
  /** The hold band the call's reservation uses (lib/runLimit.ts), where it has one. */
  band?: number | null;
  model?: string | null;
  effort?: string | null;
};
/** What a door or a site learns while the call runs. Numbers only; never text from the call. */
export type ModelCallNote = {
  tokensIn?: number | null; tokensOut?: number | null; tokensCached?: number | null;
  /** The vendor's cost in USD as the code already works it out for this call (never a typed price). */
  costUsd?: number | null;
  model?: string | null;
  /** The provider's HTTP status, when a door saw one. */
  status?: number | null;
  /** The provider's or model's own refusal (a content filter, a refusal stop). */
  refused?: boolean;
  runId?: string | null;
};

/** The span attributes this module writes (Langfuse's OpenTelemetry conventions). The required metadata keys are below. */
export const MODEL_SPAN = {
  scope: "particl.model",
  name: "model.call",
  stepName: "model.step",
  traceName: "langfuse.trace.name",
  traceTags: "langfuse.trace.tags",
  traceMetadata: "langfuse.trace.metadata",
  sessionId: "session.id",
  observationType: "langfuse.observation.type",
  observationMetadata: "langfuse.observation.metadata",
  model: "langfuse.observation.model.name",
  usage: "langfuse.observation.usage_details",
  cost: "langfuse.observation.cost_details",
  level: "langfuse.observation.level",
  statusMessage: "langfuse.observation.status_message",
} as const;
/** Every model-call span's metadata has each of these keys; an unknown value is null. */
export const MODEL_CALL_KEYS = [
  "site", "kind", "workspace_id", "run_id", "chat_id", "step", "mode", "band", "model", "effort",
  "tokens_in", "tokens_out", "tokens_cached", "vendor_cost_usd", "latency_ms", "outcome", "environment", "sent", "attempts",
] as const;

type AttrValue = string | number | boolean | string[];
/** The small part of a span this module needs; lib/modelTraceExport.ts adapts an OpenTelemetry tracer to it. */
export interface ModelSpan {
  setAttributes(attributes: Record<string, AttrValue>): void;
  setError(message: string): void;
  child(name: string, attributes: Record<string, AttrValue>): ModelSpan;
  end(): void;
}
export interface ModelTracer { start(name: string, attributes: Record<string, AttrValue>): ModelSpan }

const TRACER = Symbol.for("particl.modelTracer");
type Holder = { [TRACER]?: ModelTracer | null };
/** Installed once at boot (or by a test). Null: tracing off. Kept on globalThis so every bundle of this module shares it. */
export function installModelTracer(tracer: ModelTracer | null): void { (globalThis as Holder)[TRACER] = tracer; }
const tracer = (): ModelTracer | null => (globalThis as Holder)[TRACER] ?? null;
export const modelTracingOn = (): boolean => tracer() !== null;

type CallState = {
  site: string; meta: ModelCallMeta; span: ModelSpan | null; startedAt: number;
  note: ModelCallNote; sent: boolean; attempts: number; doorMs: number; runMs: number;
  doorError: ModelCallOutcome | null; errorName: string | null; failure: unknown; failed: boolean;
  steps: Map<string, ModelSpan>; ended: boolean;
};
type Scope = { call: CallState; inDoor: boolean };
/* Reached through process.getBuiltinModule, as lib/tenant.ts does, so a client chunk that reaches this module through shared code
   does not pull a Node builtin into the browser; there, every wrapper simply runs its function. */
let als: AsyncLocalStorage<Scope> | null | undefined;
function storage(): AsyncLocalStorage<Scope> | null {
  if (als !== undefined) return als;
  const proc = (globalThis as { process?: { getBuiltinModule?: (id: string) => { AsyncLocalStorage: new () => AsyncLocalStorage<Scope> } } }).process;
  const mod = proc?.getBuiltinModule?.("node:async_hooks");
  als = mod ? new mod.AsyncLocalStorage() : null;
  return als;
}
const scope = {
  getStore: (): Scope | undefined => storage()?.getStore(),
  run: <T>(value: Scope, fn: () => Promise<T>): Promise<T> => { const s = storage(); return s ? s.run(value, fn) : fn(); },
};

const safe = (fn: () => void) => { try { fn(); } catch { /* a tracer that fails changes nothing */ } };
const count = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
const add = (a: number | null | undefined, b: number | null | undefined): number | null => a == null ? b ?? null : b == null ? a : a + b;
/** An error's class name, never its message (a provider error carries the request body). */
const errorName = (error: unknown): string | null => {
  const name = error && typeof error === "object" ? (error as { name?: unknown }).name : null;
  return typeof name === "string" && /^[A-Za-z_]{1,40}$/.test(name) ? name : null;
};
const statusOf = (error: unknown): number | null => {
  const value = error && typeof error === "object" ? (error as { statusCode?: unknown; status?: unknown }) : {};
  const status = typeof value.statusCode === "number" ? value.statusCode : typeof value.status === "number" ? value.status : null;
  return status != null && Number.isInteger(status) && status >= 100 && status < 600 ? status : null;
};
const timedOut = (error: unknown): boolean => {
  for (let e = error, depth = 0; e && typeof e === "object" && depth < 4; e = (e as { cause?: unknown }).cause, depth++)
    if (errorName(e) === "TimeoutError") return true;
  return false;
};
const fromStatus = (status: number): ModelCallOutcome => status === 408 || status === 504 ? "timed_out" : status >= 400 && status < 500 ? "refused" : "failed";

function begin(site: string, meta: ModelCallMeta): CallState {
  const state: CallState = { site, meta, span: null, startedAt: Date.now(), note: {}, sent: false, attempts: 0, doorMs: 0, runMs: 0,
    doorError: null, errorName: null, failure: undefined, failed: false, steps: new Map(), ended: false };
  const t = tracer();
  if (t) safe(() => { state.span = t.start(MODEL_SPAN.name, { [MODEL_SPAN.traceName]: site, [MODEL_SPAN.observationType]: "generation" }); });
  return state;
}

function outcomeOf(state: CallState): ModelCallOutcome {
  const status = state.note.status;
  if (state.failed) {
    if (status != null && status >= 400) return fromStatus(status);
    if (state.doorError) return state.doorError;
    if (timedOut(state.failure)) return "timed_out";
    const thrown = statusOf(state.failure);
    if (thrown != null && thrown >= 400 && thrown < 500) return fromStatus(thrown);
    return state.note.refused ? "refused" : "failed";
  }
  if (status != null && status >= 400) return fromStatus(status);
  if (state.note.refused) return "refused";
  return "answered";
}

function finish(state: CallState): void {
  if (state.ended) return;
  state.ended = true;
  const span = state.span;
  if (!span) return;
  safe(() => {
    for (const step of state.steps.values()) step.end();
    const outcome = outcomeOf(state);
    const meta = state.meta, note = state.note;
    const model = note.model ?? meta.model ?? null;
    const environment = process.env.LANGFUSE_ENVIRONMENT?.trim() || null;
    const workspace = currentTenant()?.workspace?.id ?? null;
    const runId = meta.runId ?? note.runId ?? null;
    const values: Record<(typeof MODEL_CALL_KEYS)[number], string | number | boolean | null> = {
      site: state.site, kind: (MODEL_SITES as Record<string, string>)[state.site] ?? null,
      workspace_id: workspace, run_id: runId, chat_id: meta.chatId ?? null, step: meta.step ?? null,
      mode: meta.mode ?? null, band: count(meta.band), model, effort: meta.effort ?? null,
      tokens_in: count(note.tokensIn), tokens_out: count(note.tokensOut), tokens_cached: count(note.tokensCached),
      vendor_cost_usd: count(note.costUsd), latency_ms: Math.round(state.sent ? state.doorMs : state.runMs || Date.now() - state.startedAt),
      outcome, environment, sent: state.sent, attempts: state.attempts,
    };
    const usage: Record<string, number> = {};
    if (values.tokens_in != null) usage.input = values.tokens_in as number;
    if (values.tokens_out != null) usage.output = values.tokens_out as number;
    if (values.tokens_cached != null) usage.input_cached_tokens = values.tokens_cached as number;
    const attributes: Record<string, AttrValue> = {
      [MODEL_SPAN.observationMetadata]: JSON.stringify(values),
      [MODEL_SPAN.traceMetadata]: JSON.stringify({ site: state.site, workspace_id: workspace, run_id: runId, chat_id: meta.chatId ?? null, mode: meta.mode ?? null, outcome, environment }),
      [MODEL_SPAN.traceTags]: [state.site, `outcome:${outcome}`, ...(meta.mode ? [`mode:${meta.mode}`] : [])],
      [MODEL_SPAN.level]: outcome === "answered" ? "DEFAULT" : outcome === "refused" ? "WARNING" : "ERROR",
      [MODEL_SPAN.statusMessage]: [outcome, note.status != null ? `status=${note.status}` : "", state.errorName ? `error=${state.errorName}` : ""].filter(Boolean).join(" "),
    };
    if (model) attributes[MODEL_SPAN.model] = model;
    if (Object.keys(usage).length) attributes[MODEL_SPAN.usage] = JSON.stringify(usage);
    if (values.vendor_cost_usd != null) attributes[MODEL_SPAN.cost] = JSON.stringify({ total: values.vendor_cost_usd });
    const session = meta.chatId ?? runId;
    if (session) attributes[MODEL_SPAN.sessionId] = session;
    span.setAttributes(attributes);
    if (outcome !== "answered") span.setError(attributes[MODEL_SPAN.statusMessage] as string);
    span.end();
  });
}

function fail(state: CallState, error: unknown): void {
  state.failed = true;
  state.failure = error;
  state.errorName ??= errorName(error);
}

/** A model call whose cost is worked out after the answer: run the model work in `run`, `note` the cost, `fail` on an error, `end` once. */
export type ModelCall = {
  run<T>(fn: () => Promise<T>): Promise<T>;
  note(note: ModelCallNote): void;
  fail(error: unknown): void;
  end(): void;
};
export function openModelCall(site: ModelSiteId, meta: ModelCallMeta = {}): ModelCall {
  const state = begin(site, meta);
  return {
    run: async (fn) => {
      const started = Date.now();
      try { return await scope.run({ call: state, inDoor: false }, fn); }
      finally { state.runMs += Date.now() - started; }
    },
    note: (note) => noteInto(state, note),
    fail: (error) => fail(state, error),
    end: () => finish(state),
  };
}

/** One model call at a site: its span opens now and closes when `fn` settles. What `fn` returns or throws is unchanged. */
export async function traceModelCall<T>(site: ModelSiteId, meta: ModelCallMeta, fn: () => Promise<T>): Promise<T> {
  const call = openModelCall(site, meta);
  try { return await call.run(fn); }
  catch (error) { call.fail(error); throw error; }
  finally { call.end(); }
}

function noteInto(state: CallState, note: ModelCallNote): void {
  for (const [key, value] of Object.entries(note) as [keyof ModelCallNote, never][]) if (value !== undefined) (state.note as Record<string, unknown>)[key] = value;
}
/** Adds what is known to the model call in scope (nothing when there is none). Numbers and ids only. */
export function noteModelCall(note: ModelCallNote): void {
  const current = scope.getStore()?.call;
  if (current && !current.ended) noteInto(current, note);
}

/** What a door read off a reply it returned. */
export type DoorReading = { tokensIn?: number | null; tokensOut?: number | null; tokensCached?: number | null; costUsd?: number | null; status?: number | null; refused?: boolean; model?: string | null };

/**
 * Where a model call leaves the process. Marks the call sent, times it, and adds the usage `read` finds on the reply
 * (summed over a site's attempts). A door inside another door is the same call. A door with no site around it is
 * traced as `unattributed`, so nothing that reaches a model goes untraced.
 */
export async function modelDoor<T>(fn: () => Promise<T>, read?: (value: NoInfer<T>) => DoorReading | null): Promise<T> {
  const current = scope.getStore();
  if (current?.inDoor) return fn();
  if (!current) {
    const state = begin(UNATTRIBUTED, {});
    try { return await scope.run({ call: state, inDoor: false }, () => modelDoor(fn, read)); }
    catch (error) { fail(state, error); throw error; }
    finally { finish(state); }
  }
  const state = current.call;
  state.sent = true;
  state.attempts++;
  const started = Date.now();
  try {
    const value = await scope.run({ call: state, inDoor: true }, fn);
    if (read && state.span) safe(() => {
      const r = read(value);
      if (!r) return;
      state.note.tokensIn = add(state.note.tokensIn, count(r.tokensIn));
      state.note.tokensOut = add(state.note.tokensOut, count(r.tokensOut));
      state.note.tokensCached = add(state.note.tokensCached, count(r.tokensCached));
      if (count(r.costUsd) != null) state.note.costUsd = add(state.note.costUsd, count(r.costUsd));
      if (r.status != null) state.note.status = r.status;
      if (r.refused) state.note.refused = true;
      if (r.model) state.note.model ??= r.model;
    });
    return value;
  } catch (error) {
    const status = statusOf(error);
    state.doorError = timedOut(error) ? "timed_out" : status != null ? fromStatus(status) : "failed";
    if (status != null) state.note.status = status;
    state.errorName ??= errorName(error);
    throw error;
  } finally {
    state.doorMs += Date.now() - started;
  }
}

/* ── Readers for the reply shapes the doors return ────────────────────── */

const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** The OpenAI-compatible reply every text door returns ({ ok, status, text }): its status, usage and finish reason. Parsed only while tracing. */
export function readTextReply(reply: { ok: boolean; status: number; text: string }): DoorReading {
  if (!reply.ok) return { status: reply.status };
  let json: Record<string, unknown> = {};
  try { json = record(JSON.parse(reply.text)); } catch { return { status: reply.status }; }
  const usage = record(json.usage);
  const finish = record(Array.isArray(json.choices) ? json.choices[0] : null).finish_reason;
  return {
    status: reply.status, tokensIn: count(usage.prompt_tokens), tokensOut: count(usage.completion_tokens),
    tokensCached: count(record(usage.prompt_tokens_details).cached_tokens), costUsd: count(usage.cost),
    refused: finish === "content_filter",
  };
}

/** An AI SDK result (generateText, an agent's generate): its total usage and finish reason. */
export function readSdkResult(result: { totalUsage?: { inputTokens?: number; outputTokens?: number; inputTokenDetails?: { cacheReadTokens?: number } }; usage?: { inputTokens?: number; outputTokens?: number; inputTokenDetails?: { cacheReadTokens?: number } }; finishReason?: string }): DoorReading {
  const usage = result.totalUsage ?? result.usage ?? {};
  return { status: 200, tokensIn: count(usage.inputTokens), tokensOut: count(usage.outputTokens), tokensCached: count(usage.inputTokenDetails?.cacheReadTokens), refused: result.finishReason === "content-filter" };
}

/* ── The AI SDK's telemetry hook ──────────────────────────────────────── */

/**
 * One child span per model step inside an AI SDK call, under the model call in scope. It reads the model id, the
 * usage, the finish reason and the response time; never the prompt, the messages, the tools or the content the
 * events also carry.
 */
const stepSpans: Telemetry = {
  onLanguageModelCallStart(event) {
    const state = scope.getStore()?.call;
    if (!state?.span || state.ended) return;
    safe(() => {
      state.steps.set(event.callId, state.span!.child(MODEL_SPAN.stepName, {
        [MODEL_SPAN.observationType]: "span",
        [MODEL_SPAN.observationMetadata]: JSON.stringify({ site: state.site, model: `${event.provider}/${event.modelId}`, function_id: (event as { functionId?: unknown }).functionId ?? null }),
      }));
    });
  },
  onLanguageModelCallEnd(event) {
    const state = scope.getStore()?.call;
    const step = state?.steps.get(event.callId);
    if (!state || !step) return;
    state.steps.delete(event.callId);
    safe(() => {
      step.setAttributes({ [MODEL_SPAN.observationMetadata]: JSON.stringify({
        site: state.site, model: `${event.provider}/${event.modelId}`, finish_reason: event.finishReason,
        tokens_in: count(event.usage.inputTokens), tokens_out: count(event.usage.outputTokens), tokens_cached: count(event.usage.inputTokenDetails?.cacheReadTokens),
        latency_ms: count(event.performance?.responseTimeMs),
      }) });
      step.end();
    });
  },
  onError() {
    const state = scope.getStore()?.call;
    if (!state) return;
    safe(() => { for (const step of state.steps.values()) { step.setError("failed"); step.end(); } state.steps.clear(); });
  },
};

/** The `experimental_telemetry` every AI SDK call passes: off unless a tracer is installed; inputs and outputs never recorded. */
export function modelTelemetry(functionId: string): TelemetryOptions {
  const on = modelTracingOn();
  return { isEnabled: on, recordInputs: false, recordOutputs: false, functionId, ...(on ? { integrations: [stepSpans] } : {}) };
}

/** The board mode a person works a project in (lib/v12/board/board-data.ts), when the project records one. */
export function boardModeOf(project: { boardMode?: Record<string, "agent" | "director"> } | null | undefined, personId: string | null | undefined): ModelCallMode | null {
  if (!project?.boardMode || !personId || !Object.hasOwn(project.boardMode, personId)) return null;
  const mode = project.boardMode[personId];
  return mode === "agent" || mode === "director" ? mode : null;
}
