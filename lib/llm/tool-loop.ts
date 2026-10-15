import { z } from "zod";
import type {
  JSONObject, JSONValue, LanguageModelV4, LanguageModelV4CallOptions, LanguageModelV4Content, LanguageModelV4FinishReason, LanguageModelV4FunctionTool, LanguageModelV4GenerateResult,
  LanguageModelV4Message, LanguageModelV4ToolChoice, LanguageModelV4Usage, SharedV4ProviderMetadata, SharedV4ProviderOptions, SharedV4Warning,
} from "@ai-sdk/provider";

/**
 * Our own small tool loop (docs/plans/vercel-out.md, section 2.3, step B1). It calls a provider SDK model's `doGenerate` directly, so a bounded agent turn does not need
 * the `ai` package's `ToolLoopAgent`. Nothing imports this yet; B2 puts the Atomik planner on it, B3-B6 the other three loops. Until `ai` is removed (B7) the differential
 * test (tests/unit/toolLoopDifferential.spec.ts) runs `ToolLoopAgent` and this loop on the same scripted models and asserts the same requests, the same results and the
 * same per-step usage.
 *
 * What it does, step by step (the same as `ToolLoopAgent` with `maxRetries: 0`, `generate`, never `stream`):
 *  1. Build the provider prompt: the instructions as a system message, then the history (text and file parts as `ai` does).
 *  2. Per step, call `prepareStep` (it may choose a `toolChoice` and the `activeTools`, or throw), send the active tools as JSON Schema, the output schema as
 *     `responseFormat`, the call settings, `providerOptions` and the abort signal. No retry: one call per step.
 *  3. Read the reply's tool calls. Each input is parsed against its zod schema; an unknown tool or a bad input becomes an error result sent back to the model. The valid calls
 *     run together, started in call order. A tool that throws becomes an error result too.
 *  4. Append the assistant message (text, reasoning and tool calls, with the provider's metadata kept as the next step's provider options, which Anthropic's signed thinking
 *     needs) and one tool message with the results in call order. Go on while every client tool call has a result, there was one, and fewer than `maxSteps` steps ran.
 *  5. Keep each step's usage, converted exactly as `ai` converts it, with the provider's own raw counts passed through untouched: the money paths price from those.
 *  6. When the last step ended with text and an output schema was given, parse it as JSON and validate it.
 *
 * Differences from `ai`, on purpose: no `user-agent: ai/<version>` header is added (the caller's `headers` go as given); an image given as a URL is refused (the callers
 * send data URLs or base64 only, so nothing is downloaded); JSON from the model is refused exactly where `ai`'s secure parse refuses it.
 */

/* ── Types the callers use (structurally the same as `ai`'s, so a swap needs no change at the call site) ── */

export type LoopUsage = {
  inputTokens: number | undefined;
  inputTokenDetails: { noCacheTokens: number | undefined; cacheReadTokens: number | undefined; cacheWriteTokens: number | undefined };
  outputTokens: number | undefined;
  outputTokenDetails: { textTokens: number | undefined; reasoningTokens: number | undefined };
  totalTokens: number | undefined;
  /** The provider's own counts, untouched. */
  raw?: JSONObject;
};

export type LoopUserPart =
  | { type: "text"; text: string; providerOptions?: SharedV4ProviderOptions }
  | { type: "image"; image: string; mediaType?: string; providerOptions?: SharedV4ProviderOptions }
  | { type: "file"; data: string; mediaType: string; filename?: string; providerOptions?: SharedV4ProviderOptions };

export type LoopAssistantPart =
  | { type: "text"; text: string; providerOptions?: SharedV4ProviderOptions }
  | { type: "reasoning"; text: string; providerOptions?: SharedV4ProviderOptions }
  | { type: "custom"; kind: `${string}.${string}`; providerOptions?: SharedV4ProviderOptions }
  | { type: "file"; data: string; mediaType: string; providerOptions?: SharedV4ProviderOptions }
  | { type: "reasoning-file"; data: string; mediaType: string; providerOptions?: SharedV4ProviderOptions }
  | { type: "tool-call"; toolCallId: string; toolName: string; input: unknown; providerExecuted?: boolean; providerOptions?: SharedV4ProviderOptions };

export type LoopToolResultOutput =
  | { type: "text"; value: string }
  | { type: "json"; value: JSONValue }
  | { type: "error-text"; value: string }
  | { type: "error-json"; value: JSONValue };

export type LoopToolResultPart = { type: "tool-result"; toolCallId: string; toolName: string; output: LoopToolResultOutput; providerOptions?: SharedV4ProviderOptions };

/** The history, in the shape `ai` calls a ModelMessage; `prepareStep` reads it (the callers' input budgets count it). */
export type LoopMessage =
  | { role: "user"; content: string | LoopUserPart[]; providerOptions?: SharedV4ProviderOptions }
  | { role: "assistant"; content: LoopAssistantPart[]; providerOptions?: SharedV4ProviderOptions }
  | { role: "tool"; content: LoopToolResultPart[]; providerOptions?: SharedV4ProviderOptions };

export type LoopToolOptions = { toolCallId: string; messages: LoopMessage[]; abortSignal: AbortSignal | undefined };

export type LoopTool<Input = never> = {
  description?: string;
  inputSchema: z.ZodType<Input, unknown>;
  execute: (input: Input, options: LoopToolOptions) => unknown | Promise<unknown>;
};
/** Keeps the input type of a tool's schema flowing into its `execute`. */
export const loopTool = <Input,>(definition: { description?: string; inputSchema: z.ZodType<Input, unknown>; execute: (input: Input, options: LoopToolOptions) => unknown | Promise<unknown> }): LoopTool<Input> => definition;

export type LoopToolChoice = "auto" | "none" | "required" | { toolName: string };

export type LoopPrepareStep = (event: { stepNumber: number; steps: LoopStep[]; messages: LoopMessage[]; instructions: string | undefined }) =>
  | { toolChoice?: LoopToolChoice; activeTools?: string[] } | void | Promise<{ toolChoice?: LoopToolChoice; activeTools?: string[] } | void>;

export type LoopToolCall = { type: "tool-call"; toolCallId: string; toolName: string; input: unknown; invalid?: boolean; error?: string; providerExecuted?: boolean; providerMetadata?: SharedV4ProviderMetadata };

export type LoopStep = {
  stepNumber: number;
  /** The step's text parts joined. */
  text: string;
  reasoningText: string | undefined;
  toolCalls: LoopToolCall[];
  toolResults: { toolCallId: string; toolName: string; input: unknown; output: unknown }[];
  toolErrors: { toolCallId: string; toolName: string; input: unknown; error: unknown }[];
  finishReason: LanguageModelV4FinishReason["unified"];
  rawFinishReason: string | undefined;
  usage: LoopUsage;
  providerMetadata: SharedV4ProviderMetadata | undefined;
  warnings: SharedV4Warning[] | undefined;
  response: { id: string; modelId: string; timestamp: Date; messages: LoopMessage[] };
};

export type ToolLoopSettings = {
  maxOutputTokens?: number; temperature?: number; topP?: number; topK?: number; presencePenalty?: number; frequencyPenalty?: number; stopSequences?: string[]; seed?: number;
  reasoning?: LanguageModelV4CallOptions["reasoning"];
};

export type ToolLoopInput<Output = never> = ToolLoopSettings & {
  model: LanguageModelV4;
  instructions?: string;
  messages: LoopMessage[];
  tools?: Record<string, LoopTool<never>>;
  /** Stop after this many model calls (at least 1). */
  maxSteps: number;
  /** Sent on every step as the response format, and what the last step's text is parsed and checked against. */
  output?: z.ZodType<Output>;
  providerOptions?: SharedV4ProviderOptions;
  headers?: Record<string, string | undefined>;
  abortSignal?: AbortSignal;
  prepareStep?: LoopPrepareStep;
  /** Awaited after each step; an error it throws is ignored, as in `ai`. */
  onStepFinish?: (step: LoopStep) => void | Promise<void>;
};

export type ToolLoopResult<Output> = {
  steps: LoopStep[];
  totalUsage: LoopUsage;
  /** The last step's text. */
  text: string;
  finishReason: LoopStep["finishReason"];
  rawFinishReason: string | undefined;
  /** The parsed output, when an output schema was given and the last step ended in text. */
  output: Output | undefined;
};

/** The model's answer was not the object asked for. Carries the text and the usage so a caller can still settle what the attempt used. */
export class ToolLoopOutputError extends Error {
  readonly text: string; readonly usage: LoopUsage; readonly finishReason: LoopStep["finishReason"]; readonly stepUsage: LoopUsage[];
  constructor(message: string, detail: { cause?: unknown; text: string; usage: LoopUsage; finishReason: LoopStep["finishReason"]; stepUsage: LoopUsage[] }) {
    super(message, detail.cause === undefined ? undefined : { cause: detail.cause });
    this.name = "ToolLoopOutputError"; this.text = detail.text; this.usage = detail.usage; this.finishReason = detail.finishReason; this.stepUsage = detail.stepUsage;
  }
}

/** A model object that is not a provider-spec v4 language model (a string id, or an older spec) cannot be called here. */
export function v4Model(model: unknown): LanguageModelV4 {
  if (model && typeof model === "object" && (model as { specificationVersion?: unknown }).specificationVersion === "v4" && typeof (model as { doGenerate?: unknown }).doGenerate === "function") return model as LanguageModelV4;
  throw new Error("The language model is not a provider-spec v4 model.");
}

/* ── Usage: the provider's counts to ours, exactly as `ai` converts them ── */

export function toLoopUsage(usage: LanguageModelV4Usage): LoopUsage {
  return {
    inputTokens: usage.inputTokens.total,
    inputTokenDetails: { noCacheTokens: usage.inputTokens.noCache, cacheReadTokens: usage.inputTokens.cacheRead, cacheWriteTokens: usage.inputTokens.cacheWrite },
    outputTokens: usage.outputTokens.total,
    outputTokenDetails: { textTokens: usage.outputTokens.text, reasoningTokens: usage.outputTokens.reasoning },
    totalTokens: addCounts(usage.inputTokens.total, usage.outputTokens.total),
    raw: usage.raw,
  };
}
/** Unknown stays unknown: two unknown counts add to unknown, never to zero. */
const addCounts = (a: number | undefined, b: number | undefined): number | undefined => (a == null && b == null ? undefined : (a ?? 0) + (b ?? 0));
export function addLoopUsage(a: LoopUsage, b: LoopUsage): LoopUsage {
  return {
    inputTokens: addCounts(a.inputTokens, b.inputTokens),
    inputTokenDetails: {
      noCacheTokens: addCounts(a.inputTokenDetails?.noCacheTokens, b.inputTokenDetails?.noCacheTokens),
      cacheReadTokens: addCounts(a.inputTokenDetails?.cacheReadTokens, b.inputTokenDetails?.cacheReadTokens),
      cacheWriteTokens: addCounts(a.inputTokenDetails?.cacheWriteTokens, b.inputTokenDetails?.cacheWriteTokens),
    },
    outputTokens: addCounts(a.outputTokens, b.outputTokens),
    outputTokenDetails: { textTokens: addCounts(a.outputTokenDetails?.textTokens, b.outputTokenDetails?.textTokens), reasoningTokens: addCounts(a.outputTokenDetails?.reasoningTokens, b.outputTokenDetails?.reasoningTokens) },
    totalTokens: addCounts(a.totalTokens, b.totalTokens),
  };
}
const NO_USAGE: LoopUsage = {
  inputTokens: undefined, inputTokenDetails: { noCacheTokens: undefined, cacheReadTokens: undefined, cacheWriteTokens: undefined },
  outputTokens: undefined, outputTokenDetails: { textTokens: undefined, reasoningTokens: undefined }, totalTokens: undefined,
};

/* ── Schemas ── */

/** Every object closed unless the schema says otherwise: what `ai` sends for a zod schema (draft 7, inputs, nothing by reference). */
function closeObjects(schema: Record<string, unknown>): Record<string, unknown> {
  const visit = (def: unknown): unknown => (typeof def === "boolean" ? def : closeObjects(def as Record<string, unknown>));
  const type = schema.type;
  if (type === "object" || (Array.isArray(type) && type.includes("object"))) {
    const extra = schema.additionalProperties;
    schema.additionalProperties = extra != null && typeof extra !== "boolean" ? visit(extra) : false;
    const properties = schema.properties as Record<string, unknown> | undefined;
    if (properties) for (const key of Object.keys(properties)) properties[key] = visit(properties[key]);
  }
  if (schema.items != null) schema.items = Array.isArray(schema.items) ? schema.items.map(visit) : visit(schema.items);
  for (const key of ["anyOf", "allOf", "oneOf"] as const) if (schema[key] != null) schema[key] = (schema[key] as unknown[]).map(visit);
  const definitions = schema.definitions as Record<string, unknown> | undefined;
  if (definitions) for (const key of Object.keys(definitions)) definitions[key] = visit(definitions[key]);
  return schema;
}
export const toolJsonSchema = (schema: z.ZodType<unknown, unknown>) =>
  closeObjects(z.toJSONSchema(schema, { target: "draft-7", io: "input", reused: "inline" }) as Record<string, unknown>) as LanguageModelV4FunctionTool["inputSchema"];

/* ── Messages ── */

const errorText = (error: unknown): string => (error == null ? "unknown error" : typeof error === "string" ? error : error instanceof Error ? error.toString() : JSON.stringify(error));
const jsonValue = (value: unknown): JSONValue => { if (value === undefined) return null; const text = JSON.stringify(value); return text === undefined ? null : (JSON.parse(text) as JSONValue); };

/**
 * Raw text that must be JSON, parsed as `ai` parses it (the `secureJsonParse` filter in @ai-sdk/provider-utils): parse first, then walk every object and refuse an own
 * `__proto__` key, or an own `constructor` object that has an own `prototype`. A string that merely mentions `__proto__` is fine. The failure's words are the ones `ai` used,
 * because the model is shown them (the differential test pins them).
 */
function forbiddenPrototypeKey(root: object): boolean {
  let next: object[] = [root];
  while (next.length) {
    const nodes = next;
    next = [];
    for (const node of nodes) {
      if (Object.prototype.hasOwnProperty.call(node, "__proto__")) return true;
      const ctor = (node as { constructor?: unknown }).constructor;
      if (Object.prototype.hasOwnProperty.call(node, "constructor") && ctor !== null && typeof ctor === "object" && Object.prototype.hasOwnProperty.call(ctor, "prototype")) return true;
      for (const key in node) { const value = (node as Record<string, unknown>)[key]; if (value && typeof value === "object") next.push(value as object); }
    }
  }
  return false;
}
function parseJson(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    const value: unknown = JSON.parse(text);
    if (value !== null && typeof value === "object" && forbiddenPrototypeKey(value)) throw new SyntaxError("Object contains forbidden prototype property");
    return { ok: true, value };
  } catch (cause) { return { ok: false, error: `AI_JSONParseError: JSON parsing failed: Text: ${text}.\nError message: ${errorText(cause)}` }; }
}

/** What the signature of a few image types looks like in their first bytes; `ai` trusts these over a stated type. */
function sniffImage(base64: string): string | undefined {
  let bytes: Buffer;
  try { bytes = Buffer.from(base64.slice(0, 24), "base64"); } catch { return undefined; }
  if (bytes.length >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 12 && bytes.toString("latin1", 0, 4) === "RIFF" && bytes.toString("latin1", 8, 12) === "WEBP") return "image/webp";
  if (bytes.length >= 4 && bytes.toString("latin1", 0, 4) === "GIF8") return "image/gif";
  return undefined;
}

type ProviderFilePart = { type: "file"; mediaType: string; filename?: string; data: { type: "data"; data: string } | { type: "url"; url: URL }; providerOptions?: SharedV4ProviderOptions };
function fileData(data: string, mediaType: string | undefined, userImage: boolean): { data: ProviderFilePart["data"]; mediaType: string } {
  let url: URL | null = null;
  try { url = new URL(data); } catch { /* base64 */ }
  let content = data, type = mediaType;
  if (url && url.protocol === "data:") {
    const [header, base64] = data.split(",");
    const stated = header?.split(";")[0]?.split(":")[1];
    if (!stated || base64 == null) throw new Error(`Invalid data URL format in content ${data.slice(0, 64)}`);
    content = base64; type = stated;
  } else if (url) {
    if (userImage) throw new Error("An image must be sent as a data URL or base64, not a link.");
    return { data: { type: "url", url }, mediaType: type ?? "application/octet-stream" };
  }
  const sniffed = sniffImage(content);
  if (sniffed) type = sniffed;
  if (!type) throw new Error("Media type is missing for file part");
  return { data: { type: "data", data: content }, mediaType: type };
}

function providerPrompt(instructions: string | undefined, history: LoopMessage[]): LanguageModelV4Message[] {
  const out: LanguageModelV4Message[] = instructions != null ? [{ role: "system", content: instructions }] : [];
  for (const message of history) {
    if (message.role === "user") {
      if (typeof message.content === "string") { out.push({ role: "user", content: [{ type: "text", text: message.content }], providerOptions: message.providerOptions }); continue; }
      const content = message.content.map((part) => {
        if (part.type === "text") return { type: "text" as const, text: part.text, providerOptions: part.providerOptions };
        const isImage = part.type === "image";
        const found = fileData(isImage ? part.image : part.data, part.mediaType ?? (isImage ? "image" : undefined), isImage);
        return { type: "file" as const, mediaType: found.mediaType, filename: part.type === "file" ? part.filename : undefined, data: found.data, providerOptions: part.providerOptions };
      }).filter((part) => part.type !== "text" || part.text !== "");
      out.push({ role: "user", content: content as never, providerOptions: message.providerOptions });
    } else if (message.role === "assistant") {
      const content = message.content.filter((part) => part.type !== "text" || part.text !== "" || part.providerOptions != null).map((part) => {
        const providerOptions = part.providerOptions;
        switch (part.type) {
          case "text": return { type: "text" as const, text: part.text, providerOptions };
          case "reasoning": return { type: "reasoning" as const, text: part.text, providerOptions };
          case "custom": return { type: "custom" as const, kind: part.kind, providerOptions };
          case "file": { const found = fileData(part.data, part.mediaType, false); return { type: "file" as const, data: found.data, filename: undefined, mediaType: found.mediaType, providerOptions }; }
          case "reasoning-file": { const found = fileData(part.data, part.mediaType, false); return { type: "reasoning-file" as const, data: found.data, mediaType: found.mediaType, providerOptions }; }
          case "tool-call": return { type: "tool-call" as const, toolCallId: part.toolCallId, toolName: part.toolName, input: part.input, providerExecuted: part.providerExecuted, providerOptions };
        }
      });
      out.push({ role: "assistant", content: content as never, providerOptions: message.providerOptions });
    } else {
      out.push({ role: "tool", content: message.content.map((part) => ({ type: "tool-result" as const, toolCallId: part.toolCallId, toolName: part.toolName, output: part.output, providerOptions: part.providerOptions })) as never, providerOptions: message.providerOptions });
    }
  }
  return out;
}

/* ── Settings ── */

function checkSettings(s: ToolLoopSettings) {
  const bad = (parameter: string, message: string) => new Error(`Invalid argument for parameter ${parameter}: ${message}`);
  if (s.maxOutputTokens != null && (!Number.isInteger(s.maxOutputTokens) || s.maxOutputTokens < 1)) throw bad("maxOutputTokens", "maxOutputTokens must be an integer >= 1");
  for (const key of ["temperature", "topP", "topK", "presencePenalty", "frequencyPenalty"] as const) if (s[key] != null && typeof s[key] !== "number") throw bad(key, `${key} must be a number`);
  if (s.seed != null && !Number.isInteger(s.seed)) throw bad("seed", "seed must be an integer");
  return {
    maxOutputTokens: s.maxOutputTokens, temperature: s.temperature, topP: s.topP, topK: s.topK, presencePenalty: s.presencePenalty, frequencyPenalty: s.frequencyPenalty,
    stopSequences: s.stopSequences, seed: s.seed, reasoning: s.reasoning,
  };
}

const toolChoiceOf = (choice: LoopToolChoice | undefined): LanguageModelV4ToolChoice =>
  choice == null ? { type: "auto" } : typeof choice === "string" ? { type: choice } : { type: "tool", toolName: choice.toolName };

/* ── The loop ── */

/** One unknown tool or one bad input: what the model is told. */
async function readToolCall(call: Extract<LanguageModelV4Content, { type: "tool-call" }>, tools: Record<string, LoopTool<never>>): Promise<LoopToolCall> {
  const base = { type: "tool-call" as const, toolCallId: call.toolCallId, toolName: call.toolName, providerExecuted: call.providerExecuted, providerMetadata: call.providerMetadata };
  const tool = Object.hasOwn(tools, call.toolName) ? tools[call.toolName] : undefined;
  const invalid = (error: string): LoopToolCall => {
    const parsed = parseJson(call.input);
    return { ...base, input: parsed.ok ? parsed.value : call.input, invalid: true, error };
  };
  if (!tool) return invalid(`AI_NoSuchToolError: Model tried to call unavailable tool '${call.toolName}'. ${Object.keys(tools).length ? `Available tools: ${Object.keys(tools).join(", ")}.` : "No tools are available."}`);
  let value: unknown = {};
  if (call.input.trim() !== "") {
    const parsed = parseJson(call.input);
    if (!parsed.ok) return invalid(`AI_InvalidToolInputError: Invalid input for tool ${call.toolName}: ${parsed.error}`);
    value = parsed.value;
  }
  const checked = await tool.inputSchema.safeParseAsync(value);
  if (!checked.success) return invalid(`AI_InvalidToolInputError: Invalid input for tool ${call.toolName}: AI_TypeValidationError: Type validation failed: Value: ${JSON.stringify(value)}.\nError message: ${errorText(checked.error)}`);
  return { ...base, input: checked.data };
}

export async function runToolLoop<Output = never>(input: ToolLoopInput<Output>): Promise<ToolLoopResult<Output>> {
  const { model, tools = {}, output } = input;
  if (!Number.isSafeInteger(input.maxSteps) || input.maxSteps < 1) throw new Error("maxSteps must be a whole number of at least 1.");
  const settings = checkSettings(input);
  const instructions = input.instructions;
  const initial = input.messages;
  const steps: LoopStep[] = [];
  const stepUsage = (): LoopUsage[] => steps.map((step) => step.usage);
  /* A failure after some steps completed carries what they used, so a caller that settles the attempt does not have to guess; the error itself is the one thrown. */
  const withUsage = <E,>(error: E): E => { if (error && typeof error === "object") { try { Object.defineProperty(error, "toolLoopUsage", { value: stepUsage(), configurable: true }); } catch { /* a frozen error stays as it is */ } } return error; };
  const responseFormat = output ? { type: "json" as const, schema: toolJsonSchema(output as z.ZodType<unknown, unknown>) } : undefined;
  const functionTools = (active: string[] | undefined): LanguageModelV4FunctionTool[] | undefined => {
    const names = Object.keys(tools).filter((name) => !active || active.includes(name));
    return names.length ? names.map((name) => ({ type: "function" as const, name, inputSchema: toolJsonSchema(tools[name].inputSchema as z.ZodType<unknown, unknown>), ...(tools[name].description !== undefined ? { description: tools[name].description } : {}) })) : undefined;
  };
  let history: LoopMessage[] = [...initial];
  let calls: LoopToolCall[] = [], answered = 0;
  try {
    do {
      if (steps.length > 0) input.abortSignal?.throwIfAborted();
      const stepNumber = steps.length;
      const prepared = (await input.prepareStep?.({ stepNumber, steps: [...steps], messages: history, instructions })) ?? {};
      const result: LanguageModelV4GenerateResult = await model.doGenerate({
        ...settings,
        tools: functionTools(prepared.activeTools),
        toolChoice: toolChoiceOf(prepared.toolChoice),
        responseFormat,
        prompt: providerPrompt(instructions, history),
        providerOptions: input.providerOptions,
        abortSignal: input.abortSignal,
        headers: input.headers,
      });
      const usage = toLoopUsage(result.usage);
      calls = await Promise.all(result.content.filter((part): part is Extract<LanguageModelV4Content, { type: "tool-call" }> => part.type === "tool-call").map((call) => readToolCall(call, tools)));
      const clientCalls = calls.filter((call) => !call.providerExecuted);
      const results: LoopStep["toolResults"] = [], errors: LoopStep["toolErrors"] = [];
      const outcome = new Map<string, LoopToolResultOutput>();
      for (const call of clientCalls) if (call.invalid) { errors.push({ toolCallId: call.toolCallId, toolName: call.toolName, input: call.input, error: call.error }); outcome.set(call.toolCallId, { type: "error-text", value: errorText(call.error) }); }
      if (result.finishReason.unified === "stop" || result.finishReason.unified === "tool-calls") {
        const runnable = clientCalls.filter((call) => !call.invalid);
        const ran = await Promise.all(runnable.map(async (call) => {
          try { return { call, ok: true as const, value: await tools[call.toolName].execute(call.input as never, { toolCallId: call.toolCallId, messages: history, abortSignal: input.abortSignal }) }; }
          catch (error) { return { call, ok: false as const, error }; }
        }));
        for (const item of ran) {
          if (item.ok) { results.push({ toolCallId: item.call.toolCallId, toolName: item.call.toolName, input: item.call.input, output: item.value }); outcome.set(item.call.toolCallId, typeof item.value === "string" ? { type: "text", value: item.value } : { type: "json", value: jsonValue(item.value) }); }
          else { errors.push({ toolCallId: item.call.toolCallId, toolName: item.call.toolName, input: item.call.input, error: item.error }); outcome.set(item.call.toolCallId, { type: "error-text", value: errorText(item.error) }); }
        }
      }
      answered = outcome.size;
      /* The assistant message: what the model said, in order, with its metadata as provider options. */
      const said: LoopAssistantPart[] = [];
      for (const part of result.content) {
        const providerOptions = part.type === "source" || part.type === "tool-result" || part.type === "tool-approval-request" ? undefined : (part as { providerMetadata?: SharedV4ProviderMetadata }).providerMetadata;
        if (part.type === "text") { if (part.text.length) said.push({ type: "text", text: part.text, providerOptions }); }
        else if (part.type === "reasoning") said.push({ type: "reasoning", text: part.text, providerOptions });
        else if (part.type === "custom") said.push({ type: "custom", kind: part.kind, providerOptions });
        else if (part.type === "file" || part.type === "reasoning-file") said.push({ type: part.type, data: part.data.type === "data" ? (typeof part.data.data === "string" ? part.data.data : Buffer.from(part.data.data).toString("base64")) : part.data.url.toString(), mediaType: part.mediaType, providerOptions });
        else if (part.type === "tool-call") {
          const read = calls.find((call) => call.toolCallId === part.toolCallId)!;
          said.push({ type: "tool-call", toolCallId: part.toolCallId, toolName: part.toolName, input: read.invalid && typeof read.input !== "object" ? {} : read.input, providerExecuted: part.providerExecuted, providerOptions });
        }
      }
      const made: LoopMessage[] = [];
      if (said.length) made.push({ role: "assistant", content: said });
      const answers: LoopToolResultPart[] = clientCalls.filter((call) => outcome.has(call.toolCallId)).map((call) => ({ type: "tool-result" as const, toolCallId: call.toolCallId, toolName: call.toolName, output: outcome.get(call.toolCallId)!, providerOptions: call.providerMetadata }));
      if (answers.length) made.push({ role: "tool", content: answers });
      const text = result.content.filter((part) => part.type === "text").map((part) => part.text).join("");
      const reasoning = result.content.filter((part) => part.type === "reasoning").map((part) => part.text);
      const step: LoopStep = {
        stepNumber, text, reasoningText: reasoning.length ? reasoning.join("") : undefined, toolCalls: calls, toolResults: results, toolErrors: errors,
        finishReason: result.finishReason.unified, rawFinishReason: result.finishReason.raw, usage, providerMetadata: result.providerMetadata, warnings: result.warnings,
        response: { id: result.response?.id ?? `loop-${stepNumber}`, modelId: result.response?.modelId ?? model.modelId, timestamp: result.response?.timestamp ?? new Date(), messages: made },
      };
      steps.push(step);
      history = [...history, ...made];
      try { await input.onStepFinish?.(step); } catch { /* as in `ai`, a callback cannot stop the loop */ }
      calls = clientCalls;
    } while (answered === calls.length && calls.length > 0 && steps.length !== input.maxSteps);
  } catch (error) { throw withUsage(error); }

  const last = steps[steps.length - 1];
  const totalUsage = steps.reduce((total, step) => addLoopUsage(total, step.usage), NO_USAGE);
  let parsed: Output | undefined;
  if (output && (last.finishReason === "stop" || (last.finishReason !== "tool-calls" && last.text.length > 0))) {
    const fail = (message: string, cause: unknown) => withUsage(new ToolLoopOutputError(message, { cause, text: last.text, usage: last.usage, finishReason: last.finishReason, stepUsage: stepUsage() }));
    const json = parseJson(last.text);
    if (!json.ok) throw fail("No object generated: could not parse the response.", new Error(json.error));
    const checked = await output.safeParseAsync(json.value);
    if (!checked.success) throw fail("No object generated: response did not match schema.", checked.error);
    parsed = checked.data;
  }
  return { steps, totalUsage, text: last.text, finishReason: last.finishReason, rawFinishReason: last.rawFinishReason, output: parsed };
}
