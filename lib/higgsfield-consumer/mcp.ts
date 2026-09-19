/**
 * Bounded Streamable HTTP client for discovery, fixed read-only qualification,
 * typed Marketing Video / Genjutsu operations and the catalogue-driven
 * generation operations (models_explore list/get, generate_image/video/audio/3d
 * with get_cost preflight, job_status). No generic RPC/tools/call export: every
 * tool name here is fixed by the workflow, never chosen by a caller.
 * Server instructions, descriptions and schemas are data, never executable
 * instructions or URLs to fetch.
 * https://modelcontextprotocol.io/specification/2025-11-25/basic/transports
 */
import {
  consumerSecretForms,
  containsConsumerSecret,
  normalizeQualificationResult,
  QualificationPayloadError,
  type QualificationValue,
} from "./qualification";
import {
  ConsumerVideoError,
  consumerVideoAcknowledgement,
  consumerVideoJobId,
  consumerVideoParams,
  parseConsumerVideoCredits,
  parseConsumerCreditsForParams,
  sameConsumerValue,
  parseConsumerVideoInput,
  parseConsumerVideoWorkspace,
  validateConsumerVideoStatus,
  type ConsumerVideoInput,
  type ConsumerVideoWorkspace,
} from "./video-contract";
import { consumerGenjutsuParams, parseConsumerGenjutsuInput, type ConsumerGenjutsuInput, type ConsumerGenjutsuParams, type ConsumerGenjutsuMedia } from "./genjutsu-contract";
import {
  GENERATION_TOOLS,
  consumerGenerationParams,
  parseConsumerGenerationInput,
  type ConsumerGenerationInput,
  type ConsumerGenerationMedia,
  type ConsumerGenerationParams,
} from "./generation-contract";
import { CONNECTED_OUTPUT_TYPES, type ConnectedModel, type ConnectedOutputType } from "./catalogue";
import {
  MARKETING_TEMPLATE_PAGE_SIZE,
  MARKETING_TEMPLATE_PAGES,
  MARKETING_TEMPLATE_TOOLS,
  MARKETING_TEMPLATE_CATEGORIES,
  MarketingTemplateError,
  consumerMarketingTemplateParams,
  consumerMarketingTemplateAcknowledgement,
  parseConsumerMarketingTemplateInput,
  consumerMarketingTemplatePollAfter,
  marketingTemplateArgumentShape,
  parseMarketingTemplatePage,
  priceForTemplate,
  type ConsumerMarketingTemplateInput,
  type ConsumerMarketingTemplateParams,
  type MarketingTemplate,
  type MarketingTemplateCategory,
  type MarketingTemplateCosts,
} from "./marketing-templates";
import {
  VOICES_LIMITS,
  VOICE_TOOL_STATUS_ARGUMENT,
  VoiceToolError,
  consumerVoiceToolAcknowledgement,
  consumerVoiceToolParams,
  consumerVoiceToolPollAfter,
  parseConnectedVoicesPage,
  parseConsumerVoiceToolInput,
  requireVoiceTool,
  voiceToolArgumentShape,
  voiceToolArguments,
  type ConsumerVoiceToolInput,
  type ConsumerVoiceToolParams,
  type VoiceToolName,
  type VoiceToolShape,
} from "./voice-tools";
export const CATALOGUE_PAGE_LIMIT = 100;
export const CATALOGUE_PAGES = 5;
export const CONSUMER_MCP_URL = "https://mcp.higgsfield.ai/mcp";
const PROTOCOLS = ["2025-11-25", "2025-06-18", "2025-03-26"] as const;
export const DISCOVERY_LIMITS = {
  timeoutMs: 25_000,
  pageBytes: 1_048_576,
  totalBytes: 2_097_152,
  pages: 8,
  tools: 200,
  messages: 256,
} as const;
export const QUALIFICATION_LIMITS = {
  timeoutMs: 45_000,
  callTimeoutMs: 10_000,
} as const;

// These exact tools/arguments were advertised by the authorized consumer MCP
// catalogue and reviewed as non-generating reads. Never accept a caller's tool
// name or arguments here; selecting a workspace also mutates remote state.
const QUALIFICATION_READS = Object.freeze([
  Object.freeze({ tool: "list_workspaces", arguments: Object.freeze({}) }),
  Object.freeze({
    tool: "models_explore",
    arguments: Object.freeze({
      action: "get",
      model_id: "marketing_studio_video",
    }),
  }),
  Object.freeze({
    tool: "models_explore",
    arguments: Object.freeze({
      action: "get",
      model_id: "hf_mult_replace_object",
    }),
  }),
  Object.freeze({
    tool: "models_explore",
    arguments: Object.freeze({
      action: "get",
      model_id: "hf_mult_motion_control",
    }),
  }),
  Object.freeze({
    tool: "models_explore",
    arguments: Object.freeze({ action: "search", query: "virality", limit: 3 }),
  }),
  Object.freeze({
    tool: "marketing_studio_v2_presets",
    arguments: Object.freeze({ category: "all", size: 2 }),
  }),
  Object.freeze({
    tool: "marketing_studio_v2_costs",
    arguments: Object.freeze({}),
  }),
  Object.freeze({
    tool: "get_workflow_instructions",
    arguments: Object.freeze({ workflow: "ad-multiplier" }),
  }),
  Object.freeze({
    tool: "generate_video",
    arguments: Object.freeze({
      params: Object.freeze({
        model: "marketing_studio_video",
        prompt:
          "A plain reusable bottle on a clean studio background. A short product demo with no people, logos or text.",
        duration: 15,
        resolution: "720p",
        aspect_ratio: "16:9",
        count: 1,
        get_cost: true,
        use_unlim: false,
      }),
    }),
  }),
]);
const ANALYSIS_QUALIFICATION_READS = Object.freeze([
  Object.freeze({
    tool: "models_explore",
    arguments: Object.freeze({ action: "get", model_id: "brain_activity" }),
  }),
  Object.freeze({
    tool: "models_explore",
    arguments: Object.freeze({ action: "get", model_id: "virality_predictor" }),
  }),
]);

export type ConsumerDiscoveryCode =
  | "reconnect_required"
  | "rate_limited"
  | "provider_unavailable"
  | "provider_error"
  | "redirect_refused"
  | "timeout"
  | "protocol_error"
  | "unsupported_protocol"
  | "catalog_limit";

const ERRORS: Record<ConsumerDiscoveryCode, string> = {
  reconnect_required:
    "Reconnect your Higgsfield account before discovering tools.",
  rate_limited: "Higgsfield is limiting discovery requests. Try again later.",
  provider_unavailable: "Higgsfield tool discovery is temporarily unavailable.",
  provider_error: "Higgsfield could not complete tool discovery.",
  redirect_refused: "Higgsfield discovery attempted an unsupported redirect.",
  timeout: "Higgsfield tool discovery did not finish within the time limit.",
  protocol_error: "Higgsfield returned an unusable discovery response.",
  unsupported_protocol:
    "Higgsfield requested an unsupported discovery protocol.",
  catalog_limit: "The Higgsfield tool catalogue exceeds the discovery limit.",
};

export class ConsumerDiscoveryError extends Error {
  readonly status: number;
  constructor(readonly code: ConsumerDiscoveryCode) {
    super(ERRORS[code]);
    this.name = "ConsumerDiscoveryError";
    this.status =
      code === "reconnect_required"
        ? 409
        : code === "rate_limited"
          ? 429
          : code === "timeout"
            ? 504
            : 502;
  }
}

export type DiscoveredConsumerTool = {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
};
export type ConsumerToolCatalogue = {
  protocolVersion: string;
  tools: DiscoveredConsumerTool[];
};
type Options = {
  fetch?: typeof fetch;
  signal?: AbortSignal;
  /** Tests may shorten, but cannot increase, the production deadline. */
  timeoutMs?: number;
  callTimeoutMs?: number;
};
type ConsumerSession = {
  protocolVersion: string;
  supportsTools: boolean;
  secrets: string[];
  active: () => boolean;
  list: (cursor?: string) => Promise<Record<string, unknown>>;
  qualificationRead: (index: number) => Promise<Record<string, unknown>>;
  analysisQualificationRead: (
    index: number,
  ) => Promise<Record<string, unknown>>;
  videoWorkspaces: () => Promise<Record<string, unknown>>;
  videoQuote: (input: ConsumerVideoInput) => Promise<Record<string, unknown>>;
  videoSubmit: (
    input: ConsumerVideoInput,
    sending: () => void,
  ) => Promise<Record<string, unknown>>;
  genjutsuStatus: (jobId:string)=>Promise<Record<string,unknown>>;
  genjutsuImport: (url: string, type: "image"|"video"|"audio") => Promise<Record<string,unknown>>;
  genjutsuQuote: (params: ConsumerGenjutsuParams) => Promise<Record<string,unknown>>;
  genjutsuSubmit: (params: ConsumerGenjutsuParams, sending:()=>void) => Promise<Record<string,unknown>>;
  videoStatus: (jobId: string) => Promise<Record<string, unknown>>;
  catalogueList: (after?: string) => Promise<Record<string, unknown>>;
  catalogueGet: (modelId: string) => Promise<Record<string, unknown>>;
  generationQuote: (type: ConnectedOutputType, params: ConsumerGenerationParams) => Promise<Record<string, unknown>>;
  generationSubmit: (type: ConnectedOutputType, params: ConsumerGenerationParams, sending: () => void) => Promise<Record<string, unknown>>;
  generationStatus: (jobId: string) => Promise<Record<string, unknown>>;
  templatePresets: (category: MarketingTemplateCategory, cursor?: string | number) => Promise<Record<string, unknown>>;
  templateCosts: () => Promise<Record<string, unknown>>;
  templateCreate: (args: Record<string, unknown>, sending?: () => void) => Promise<Record<string, unknown>>;
  templateStatus: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
  voicesList: (cursor?: string) => Promise<Record<string, unknown>>;
  /** Only the fixed voice/dubbing/analysis create tools; the name is resolved from the workflow, never a caller. */
  voiceToolCreate: (tool: VoiceToolName, args: Record<string, unknown>, sending?: () => void) => Promise<Record<string, unknown>>;
  voiceToolStatus: (tool: VoiceToolName, args: Record<string, unknown>) => Promise<Record<string, unknown>>;
};
// A caller's durable admission error must reach that caller unchanged. It is
// never exposed by a transport response or interpreted as an attempted POST.
class ConsumerAdmissionStopped extends Error {
  constructor(readonly original: unknown) {
    super("Consumer admission stopped");
  }
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function fail(code: ConsumerDiscoveryCode = "protocol_error"): never {
  throw new ConsumerDiscoveryError(code);
}
function parse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return fail();
  }
}

/** Iterative validation prevents deeply nested provider schemas from escaping bounds. */
function validateSchema(
  value: unknown,
  secrets: string[],
): asserts value is Record<string, unknown> {
  if (!object(value) || value.type !== "object") fail();
  const stack: { value: unknown; depth: number }[] = [{ value, depth: 0 }];
  let nodes = 0;
  while (stack.length) {
    const item = stack.pop()!;
    if (++nodes > 20_000 || item.depth > 40) fail("catalog_limit");
    if (typeof item.value === "string") {
      const text = item.value;
      if (containsConsumerSecret(text, secrets)) fail();
    } else if (item.value !== null && typeof item.value === "object") {
      for (const [key, child] of Object.entries(item.value)) {
        if (containsConsumerSecret(key, secrets)) fail();
        stack.push({ value: child, depth: item.depth + 1 });
      }
    }
  }
}

async function withConsumerSession<T>(
  accessToken: string,
  options: Options,
  maximumMs: number,
  run: (session: ConsumerSession) => Promise<T>,
): Promise<T> {
  if (
    !accessToken ||
    accessToken.length > 16_384 ||
    !/^[\x21-\x7e]+$/.test(accessToken)
  )
    fail("reconnect_required");
  const fetcher = options.fetch ?? fetch;
  const controller = new AbortController();
  const timeoutMs = Math.min(
    maximumMs,
    Math.max(1, options.timeoutMs ?? maximumMs),
  );
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const deadline = performance.now() + timeoutMs;
  function assertDeadline(signal: AbortSignal, requestDeadline = deadline) {
    if (signal.aborted || performance.now() >= requestDeadline) fail("timeout");
  }
  const cancel = () => controller.abort();
  options.signal?.addEventListener("abort", cancel, { once: true });
  if (options.signal?.aborted) controller.abort();
  let sessionId: string | undefined;
  let protocolVersion: string | undefined;
  let sequence = 0;
  let totalBytes = 0;

  // A fetch implementation or stalled body must not be able to extend the
  // overall deadline, even if it ignores AbortSignal.
  async function withinDeadline<T>(
    promise: Promise<T>,
    signal = controller.signal,
    requestDeadline = deadline,
  ): Promise<T> {
    assertDeadline(signal, requestDeadline);
    let onAbort: () => void = () => {};
    try {
      const result = await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          onAbort = () => reject(new ConsumerDiscoveryError("timeout"));
          signal.addEventListener("abort", onAbort, { once: true });
        }),
      ]);
      assertDeadline(signal, requestDeadline);
      return result;
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }

  function rpcResult(
    value: unknown,
    id: string,
    allowNotification: boolean,
  ): Record<string, unknown> | undefined {
    if (!object(value) || value.jsonrpc !== "2.0") fail();
    if ("method" in value) {
      if (
        allowNotification &&
        !("id" in value) &&
        typeof value.method === "string" &&
        value.method.startsWith("notifications/") &&
        !("result" in value) &&
        !("error" in value) &&
        (value.params === undefined || object(value.params))
      )
        return undefined;
      // No sampling, elicitation, callback, or other server request is executed.
      fail("unsupported_protocol");
    }
    if (value.id !== id || "result" in value === "error" in value) fail();
    if ("error" in value) {
      if (
        !object(value.error) ||
        !Number.isSafeInteger(value.error.code) ||
        typeof value.error.message !== "string"
      )
        fail();
      fail("provider_error");
    }
    if (!object(value.result)) fail();
    return value.result;
  }

  async function readReply(
    response: Response,
    id: string,
    signal: AbortSignal,
    requestDeadline: number,
  ): Promise<Record<string, unknown>> {
    const mime = response.headers
      .get("content-type")
      ?.split(";")[0]
      .trim()
      .toLowerCase();
    if (mime !== "application/json" && mime !== "text/event-stream") fail();
    const claimed = response.headers.get("content-length");
    if (
      claimed !== null &&
      (!/^\d+$/.test(claimed) || Number(claimed) > DISCOVERY_LIMITS.pageBytes)
    )
      fail("catalog_limit");
    if (!response.body) fail();
    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let bytes = 0,
      text = "",
      data: string[] = [],
      event = "",
      messages = 0;
    function eventResult() {
      const payload = data.join("\n");
      data = [];
      const eventName = event;
      event = "";
      if (!payload) return undefined; // Heartbeat / resumability primer.
      if (++messages > DISCOVERY_LIMITS.messages) fail("catalog_limit");
      if (eventName && eventName !== "message") fail();
      return rpcResult(parse(payload), id, true);
    }
    function consumeLines(final: boolean): Record<string, unknown> | undefined {
      while (true) {
        const match = /[\r\n]/.exec(text);
        if (!match) return undefined;
        const at = match.index;
        if (!final && text[at] === "\r" && at === text.length - 1)
          return undefined;
        const line = text.slice(0, at);
        text = text.slice(
          at + (text[at] === "\r" && text[at + 1] === "\n" ? 2 : 1),
        );
        if (!line) {
          const result = eventResult();
          if (result) return result;
          continue;
        }
        if (line.startsWith(":")) continue;
        const colon = line.indexOf(":");
        const field = colon < 0 ? line : line.slice(0, colon);
        let value = colon < 0 ? "" : line.slice(colon + 1);
        if (value.startsWith(" ")) value = value.slice(1);
        if (field === "data") data.push(value);
        else if (field === "event") event = value;
        // id/retry fields are inert: this bounded discovery never reconnects
        // or follows an SSE endpoint supplied by the server.
      }
    }
    try {
      while (true) {
        const chunk = await withinDeadline(
          reader.read(),
          signal,
          requestDeadline,
        );
        if (chunk.done) {
          text += decoder.decode();
          if (mime === "application/json")
            return rpcResult(parse(text), id, false)!;
          const result = consumeLines(true);
          if (result) return result;
          // An incomplete SSE event or missing matching response is not success.
          fail();
        }
        bytes += chunk.value.byteLength;
        totalBytes += chunk.value.byteLength;
        if (
          bytes > DISCOVERY_LIMITS.pageBytes ||
          totalBytes > DISCOVERY_LIMITS.totalBytes
        )
          fail("catalog_limit");
        text += decoder.decode(chunk.value, { stream: true });
        if (mime === "text/event-stream") {
          const result = consumeLines(false);
          if (result) return result;
        }
      }
    } finally {
      // Do not wait for an untrusted stream's cancellation acknowledgement.
      void reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }

  async function post(
    method:
      "initialize" | "notifications/initialized" | "tools/list" | "tools/call",
    params?: Record<string, unknown>,
    sending?: () => void,
  ) {
    assertDeadline(controller.signal);
    const id =
      method === "notifications/initialized"
        ? undefined
        : `particl-discovery-${++sequence}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
    };
    if (sessionId) headers["Mcp-Session-Id"] = sessionId;
    if (protocolVersion) headers["MCP-Protocol-Version"] = protocolVersion;
    const requestController = new AbortController();
    const abortRequest = () => requestController.abort();
    controller.signal.addEventListener("abort", abortRequest, { once: true });
    const requestMs = Math.min(
      QUALIFICATION_LIMITS.callTimeoutMs,
      Math.max(1, options.callTimeoutMs ?? QUALIFICATION_LIMITS.callTimeoutMs),
    );
    const requestDeadline =
      method === "tools/call"
        ? Math.min(deadline, performance.now() + requestMs)
        : deadline;
    const requestTimer =
      method === "tools/call" ? setTimeout(abortRequest, requestMs) : undefined;
    let pendingResponse: Response | undefined;
    try {
      assertDeadline(requestController.signal, requestDeadline);
      sending?.();
      const response = await withinDeadline(
        fetcher(CONSUMER_MCP_URL, {
          method: "POST",
          headers,
          body: JSON.stringify({
            jsonrpc: "2.0",
            ...(id ? { id } : {}),
            method,
            ...(params ? { params } : {}),
          }),
          redirect: "error",
          cache: "no-store",
          signal: requestController.signal,
        }).then((received) => {
          pendingResponse = received;
          if (requestController.signal.aborted)
            void received.body?.cancel().catch(() => {});
          return received;
        }),
        requestController.signal,
        requestDeadline,
      );
      if (
        response.redirected ||
        (response.status >= 300 && response.status < 400) ||
        (response.url && response.url !== CONSUMER_MCP_URL)
      )
        fail("redirect_refused");
      if (response.status === 401 || response.status === 403)
        fail("reconnect_required");
      if (response.status === 429) fail("rate_limited");
      if (!response.ok) fail("provider_unavailable");
      if (!id) {
        if (response.status !== 202) fail();
        if (response.body) {
          const reader = response.body.getReader();
          try {
            if (
              !(
                await withinDeadline(
                  reader.read(),
                  requestController.signal,
                  requestDeadline,
                )
              ).done
            )
              fail();
          } finally {
            void reader.cancel().catch(() => {});
            reader.releaseLock();
          }
        }
        return undefined;
      }
      const result = await readReply(
        response,
        id,
        requestController.signal,
        requestDeadline,
      );
      assertDeadline(requestController.signal, requestDeadline);
      if (method === "initialize") {
        const session = response.headers.get("Mcp-Session-Id");
        if (session !== null) {
          if (!/^[\x21-\x7e]{1,1024}$/.test(session)) fail();
          sessionId = session;
        }
      }
      return result;
    } catch (error) {
      if (error instanceof ConsumerDiscoveryError) throw error;
      return fail(
        requestController.signal.aborted ? "timeout" : "provider_unavailable",
      );
    } finally {
      clearTimeout(requestTimer);
      controller.signal.removeEventListener("abort", abortRequest);
      requestController.abort();
      if (pendingResponse?.body && !pendingResponse.body.locked)
        void pendingResponse.body.cancel().catch(() => {});
    }
  }

  try {
    const initialized = (await post("initialize", {
      protocolVersion: PROTOCOLS[0],
      capabilities: {},
      clientInfo: { name: "particl-discovery", version: "1.0.0" },
    }))!;
    if (!PROTOCOLS.some((version) => version === initialized.protocolVersion))
      fail("unsupported_protocol");
    if (
      !object(initialized.capabilities) ||
      !object(initialized.serverInfo) ||
      typeof initialized.serverInfo.name !== "string" ||
      typeof initialized.serverInfo.version !== "string"
    )
      fail();
    protocolVersion = initialized.protocolVersion as string;
    await post("notifications/initialized");
    if (
      initialized.capabilities.tools !== undefined &&
      !object(initialized.capabilities.tools)
    )
      fail();
    return await run({
      protocolVersion,
      supportsTools: initialized.capabilities.tools !== undefined,
      secrets: consumerSecretForms([
        accessToken,
        ...(sessionId ? [sessionId] : []),
      ]),
      active: () => !controller.signal.aborted && performance.now() < deadline,
      list: async (cursor) =>
        (await post("tools/list", cursor === undefined ? {} : { cursor }))!,
      qualificationRead: async (index) => {
        const read = QUALIFICATION_READS[index];
        if (!Number.isInteger(index) || !read) fail("unsupported_protocol");
        return (await post("tools/call", {
          name: read.tool,
          arguments: read.arguments,
        }))!;
      },
      analysisQualificationRead: async (index) => {
        const read = ANALYSIS_QUALIFICATION_READS[index];
        if (!Number.isInteger(index) || !read) fail("unsupported_protocol");
        return (await post("tools/call", {
          name: read.tool,
          arguments: read.arguments,
        }))!;
      },
      videoWorkspaces: async () =>
        (await post("tools/call", { name: "list_workspaces", arguments: {} }))!,
      videoQuote: async (input) =>
        (await post("tools/call", {
          name: "generate_video",
          arguments: { params: consumerVideoParams(input, true) },
        }))!,
      videoSubmit: async (input, sending) =>
        (await post(
          "tools/call",
          {
            name: "generate_video",
            arguments: { params: consumerVideoParams(input, false) },
          },
          sending,
        ))!,
      genjutsuStatus: async jobId=>(await post("tools/call",{name:"job_status",arguments:{jobId,sync:false,raw_data:false}}))!,
      genjutsuImport: async (url,type) => (await post("tools/call", {name:"media_import_url",arguments:{url,type}}))!,
      genjutsuQuote: async params => (await post("tools/call", {name:"generate_video",arguments:{params:{...params,get_cost:true}}}))!,
      genjutsuSubmit: async (params,sending) => (await post("tools/call", {name:"generate_video",arguments:{params:{...params,get_cost:false}}},sending))!,
      videoStatus: async (jobId) =>
        (await post("tools/call", {
          name: "job_status",
          arguments: { jobId, sync: false, raw_data: true },
        }))!,
      catalogueList: async (after) =>
        (await post("tools/call", {
          name: "models_explore",
          arguments: { action: "list", limit: CATALOGUE_PAGE_LIMIT, ...(after === undefined ? {} : { after }) },
        }))!,
      catalogueGet: async (modelId) =>
        (await post("tools/call", { name: "models_explore", arguments: { action: "get", model_id: modelId } }))!,
      generationQuote: async (type, params) =>
        (await post("tools/call", { name: generationTool(type), arguments: { params: { ...params, get_cost: true } } }))!,
      generationSubmit: async (type, params, sending) =>
        (await post("tools/call", { name: generationTool(type), arguments: { params: { ...params, get_cost: false } } }, sending))!,
      generationStatus: async (jobId) =>
        (await post("tools/call", { name: "job_status", arguments: { jobId, sync: false, raw_data: false } }))!,
      templatePresets: async (category, cursor) =>
        (await post("tools/call", {
          name: MARKETING_TEMPLATE_TOOLS.presets,
          arguments: { category, size: MARKETING_TEMPLATE_PAGE_SIZE, ...(cursor === undefined ? {} : { cursor }) },
        }))!,
      templateCosts: async () => (await post("tools/call", { name: MARKETING_TEMPLATE_TOOLS.costs, arguments: {} }))!,
      templateCreate: async (args, sending) => (await post("tools/call", { name: MARKETING_TEMPLATE_TOOLS.create, arguments: args }, sending))!,
      templateStatus: async (args) => (await post("tools/call", { name: MARKETING_TEMPLATE_TOOLS.status, arguments: args }))!,
      voicesList: async (cursor) =>
        (await post("tools/call", { name: "list_voices", arguments: { size: VOICES_LIMITS.pageSize, ...(cursor === undefined ? {} : { cursor }) } }))!,
      voiceToolCreate: async (tool, args, sending) => (await post("tools/call", { name: requireVoiceTool(tool).create, arguments: args }, sending))!,
      voiceToolStatus: async (tool, args) => (await post("tools/call", { name: requireVoiceTool(tool).status, arguments: args }))!,
    });
  } catch (error) {
    if (
      error instanceof ConsumerDiscoveryError ||
      error instanceof ConsumerVideoError ||
      error instanceof ConsumerAdmissionStopped
    )
      throw error;
    // Never propagate a fetch/JSON/provider error that might contain headers,
    // tokens, session identifiers, account data, or server instructions.
    return fail(controller.signal.aborted ? "timeout" : "provider_unavailable");
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", cancel);
    controller.abort();
  }
}

export async function discoverConsumerTools(
  accessToken: string,
  options: Options = {},
): Promise<ConsumerToolCatalogue> {
  return withConsumerSession(
    accessToken,
    options,
    DISCOVERY_LIMITS.timeoutMs,
    async (session) => {
      const { protocolVersion } = session;
      if (!session.supportsTools) return { protocolVersion, tools: [] };
      const tools: DiscoveredConsumerTool[] = [];
      const cursors = new Set<string>();
      const names = new Set<string>();
      let cursor: string | undefined;
      for (let page = 0; page < DISCOVERY_LIMITS.pages; page++) {
        const result = await session.list(cursor);
        if (!Array.isArray(result.tools)) fail();
        if (tools.length + result.tools.length > DISCOVERY_LIMITS.tools)
          fail("catalog_limit");
        for (const entry of result.tools) {
          if (
            !object(entry) ||
            typeof entry.name !== "string" ||
            !/^[\x21-\x7e]{1,128}$/.test(entry.name) ||
            names.has(entry.name) ||
            (entry.description !== undefined &&
              (typeof entry.description !== "string" ||
                entry.description.length > 16_000))
          )
            fail();
          const name = entry.name;
          const secrets = session.secrets;
          if (
            containsConsumerSecret(name, secrets) ||
            (typeof entry.description === "string" &&
              containsConsumerSecret(entry.description, secrets))
          )
            fail();
          validateSchema(entry.inputSchema, secrets);
          if (entry.outputSchema !== undefined)
            validateSchema(entry.outputSchema, secrets);
          names.add(entry.name);
          tools.push({
            name: entry.name,
            ...(entry.description === undefined
              ? {}
              : { description: entry.description as string }),
            inputSchema: entry.inputSchema,
            ...(entry.outputSchema === undefined
              ? {}
              : { outputSchema: entry.outputSchema }),
          });
        }
        if (result.nextCursor === undefined) return { protocolVersion, tools };
        if (
          typeof result.nextCursor !== "string" ||
          result.nextCursor.length < 1 ||
          result.nextCursor.length > 4096 ||
          cursors.has(result.nextCursor)
        )
          fail();
        cursors.add(result.nextCursor);
        cursor = result.nextCursor;
      }
      return fail("catalog_limit");
    },
  );
}

export type ConsumerQualification = {
  readOnly: true;
  results: {
    tool: string;
    arguments: Record<string, unknown>;
    result?: QualificationValue;
    error?: { code: string; message: string };
  }[];
};

/** Only the fixed reviewed reads above can be called. No caller-selected tool,
 * workspace selection, generation, upload or analysis submission is accepted. */
export async function readConsumerQualification(
  accessToken: string,
  options: Options = {},
): Promise<ConsumerQualification> {
  return withConsumerSession(
    accessToken,
    options,
    QUALIFICATION_LIMITS.timeoutMs,
    (session) =>
      qualificationObservations(
        session,
        QUALIFICATION_READS,
        session.qualificationRead,
      ),
  );
}

/** Separate short diagnostic: exact model metadata only. It never requests a
 * price, uploads media, predicts a score or invokes an analysis creation tool. */
export async function readConsumerAnalysisQualification(
  accessToken: string,
  options: Options = {},
): Promise<ConsumerQualification & { scope: "analysis-models" }> {
  return withConsumerSession(
    accessToken,
    options,
    DISCOVERY_LIMITS.timeoutMs,
    async (session) => ({
      ...(await qualificationObservations(
        session,
        ANALYSIS_QUALIFICATION_READS,
        session.analysisQualificationRead,
      )),
      scope: "analysis-models",
    }),
  );
}

async function qualificationObservations(
  session: ConsumerSession,
  reads: readonly { tool: string; arguments: Record<string, unknown> }[],
  readAtIndex: (index: number) => Promise<Record<string, unknown>>,
): Promise<ConsumerQualification> {
  const results: ConsumerQualification["results"] = [];
  let stopped = !session.supportsTools;
  for (const [index, read] of reads.entries()) {
    const observation = {
      tool: read.tool,
      arguments: { ...read.arguments },
    };
    if (stopped || !session.active()) {
      results.push({
        ...observation,
        error: {
          code: "not_run",
          message:
            "This read was not run because the MCP session was unavailable or its diagnostic limit was reached.",
        },
      });
      continue;
    }
    try {
      const raw = await readAtIndex(index);
      const { result, isError } = normalizeQualificationResult(
        raw,
        session.secrets,
      );
      results.push({
        ...observation,
        result,
        ...(isError
          ? {
              error: {
                code: "tool_error",
                message:
                  "Higgsfield could not complete this read-only check. Its redacted response is included for inspection.",
              },
            }
          : {}),
      });
    } catch (error) {
      if (error instanceof QualificationPayloadError) {
        results.push({
          ...observation,
          error: { code: error.code, message: error.message },
        });
        continue;
      }
      const safe =
        error instanceof ConsumerDiscoveryError
          ? error
          : new ConsumerDiscoveryError("provider_unavailable");
      results.push({
        ...observation,
        error: { code: safe.code, message: safe.message },
      });
      // A per-call timeout or ordinary RPC error need not discard other
      // independent reads. No failed request is retried, and exhausted byte
      // limits, auth failures or malformed protocol stop further admission.
      stopped =
        safe.code !== "provider_error" &&
        !(safe.code === "timeout" && session.active());
    }
  }
  return { readOnly: true, results };
}

export type ConsumerVideoQuote = {
  input: Readonly<ConsumerVideoInput>;
  workspace: ConsumerVideoWorkspace;
  credits: number;
};
export type ConsumerVideoSubmission =
  | { state: "accepted"; providerJobId: string; raw: QualificationValue }
  | {
      state: "uncertain";
      raw?: QualificationValue;
      error: { code: "submission_uncertain"; message: string };
    };
const uncertainSubmission = (
  raw?: QualificationValue,
): ConsumerVideoSubmission => ({
  state: "uncertain",
  ...(raw === undefined ? {} : { raw }),
  error: {
    code: "submission_uncertain",
    message:
      "Higgsfield may have accepted this video. Keep its reservation and do not submit it again.",
  },
});
function videoReadResult(
  session: ConsumerSession,
  raw: Record<string, unknown>,
) {
  const result = normalizeQualificationResult(raw, session.secrets);
  if (result.isError) throw new ConsumerVideoError("provider_error");
  return result.result;
}
function videoPreflightError(error: unknown): never {
  if (error instanceof ConsumerVideoError) throw error;
  throw new ConsumerVideoError("preflight_unavailable");
}
function videoWorkspaceId(id: string) {
  try {
    return consumerVideoJobId(id);
  } catch {
    throw new ConsumerVideoError("invalid_workspace");
  }
}
function matchingWorkspace(
  workspace: ConsumerVideoWorkspace,
  expected: string,
) {
  if (workspace.id !== expected)
    throw new ConsumerVideoError("workspace_changed");
}

/** Cost-only. The returned billing workspace is an observation, not a provider
 * transaction lock; no tool here selects or switches the remote workspace. */
export async function getConsumerVideoQuote(
  accessToken: string,
  value: ConsumerVideoInput,
  options: Options = {},
): Promise<ConsumerVideoQuote> {
  const input = parseConsumerVideoInput(value);
  try {
    return await withConsumerSession(
      accessToken,
      options,
      QUALIFICATION_LIMITS.timeoutMs,
      async (session) => {
        if (!session.supportsTools)
          throw new ConsumerVideoError("provider_error");
        const workspace = parseConsumerVideoWorkspace(
          videoReadResult(session, await session.videoWorkspaces()),
        );
        const credits = parseConsumerVideoCredits(
          videoReadResult(session, await session.videoQuote(input)),
          input,
        );
        const current = parseConsumerVideoWorkspace(
          videoReadResult(session, await session.videoWorkspaces()),
        );
        matchingWorkspace(current, workspace.id);
        return { input, workspace: current, credits };
      },
    );
  } catch (error) {
    return videoPreflightError(error);
  }
}

/**
 * Fresh workspace/price checks precede durable admission, which precedes exactly
 * one paid POST. Never retries, selects a workspace, or runs provider instructions.
 * Other Higgsfield clients can still switch the global workspace after the read;
 * this transport cannot promise atomic billing-workspace binding.
 */
export async function submitConsumerVideo(
  accessToken: string,
  value: ConsumerVideoInput,
  expectedWorkspaceId: string,
  expectedCredits: number,
  options: Options & { admit: () => Promise<void> },
): Promise<ConsumerVideoSubmission> {
  const input = parseConsumerVideoInput(value),
    expected = videoWorkspaceId(expectedWorkspaceId);
  if (
    !Number.isFinite(expectedCredits) ||
    expectedCredits <= 0 ||
    expectedCredits > Number.MAX_SAFE_INTEGER ||
    typeof options?.admit !== "function"
  )
    throw new ConsumerVideoError("invalid_input");
  let paidAttempted = false;
  try {
    return await withConsumerSession(
      accessToken,
      options,
      QUALIFICATION_LIMITS.timeoutMs,
      async (session) => {
        if (!session.supportsTools)
          throw new ConsumerVideoError("provider_error");
        const workspace = parseConsumerVideoWorkspace(
          videoReadResult(session, await session.videoWorkspaces()),
        );
        matchingWorkspace(workspace, expected);
        const credits = parseConsumerVideoCredits(
          videoReadResult(session, await session.videoQuote(input)),
          input,
        );
        if (credits !== expectedCredits)
          throw new ConsumerVideoError("quote_changed");
        const current = parseConsumerVideoWorkspace(
          videoReadResult(session, await session.videoWorkspaces()),
        );
        matchingWorkspace(current, expected);
        if (current.credits < credits)
          throw new ConsumerVideoError("insufficient_credits");
        try {
          await options.admit();
        } catch (error) {
          throw new ConsumerAdmissionStopped(error);
        }
        if (!session.active())
          throw new ConsumerVideoError("preflight_unavailable");
        const reply = await session.videoSubmit(input, () => {
          paidAttempted = true;
        });
        const raw = normalizeQualificationResult(reply, session.secrets).result;
        const providerJobId = consumerVideoAcknowledgement(raw);
        // Even an isError envelope with an exact accepted ID retains that receipt.
        return providerJobId
          ? { state: "accepted", providerJobId, raw }
          : uncertainSubmission(raw);
      },
    );
  } catch (error) {
    if (error instanceof ConsumerAdmissionStopped) throw error.original;
    if (paidAttempted) return uncertainSubmission();
    return videoPreflightError(error);
  }
}

/** Read-only polling of one already acknowledged UUID. Results stay diagnostic
 * until an explicit collector validates the provider's artifact/status contract. */
export async function readConsumerVideoJob(
  accessToken: string,
  value: string,
  expectedWorkspaceId: string,
  options: Options = {},
): Promise<{
  jobId: string;
  raw: QualificationValue;
  pollAfterSeconds?: number;
}> {
  const jobId = consumerVideoJobId(value),
    expected = videoWorkspaceId(expectedWorkspaceId);
  try {
    return await withConsumerSession(
      accessToken,
      options,
      QUALIFICATION_LIMITS.timeoutMs,
      async (session) => {
        if (!session.supportsTools)
          throw new ConsumerVideoError("provider_error");
        const workspace = parseConsumerVideoWorkspace(
          videoReadResult(session, await session.videoWorkspaces()),
        );
        matchingWorkspace(workspace, expected);
        const raw = videoReadResult(session, await session.videoStatus(jobId));
        return { jobId, raw, ...validateConsumerVideoStatus(raw, jobId) };
      },
    );
  } catch (error) {
    return videoPreflightError(error);
  }
}

/** Imports only application-authorized originals. The resolve hook persists its
 * permanent import claim/receipt; this transport never retries a mutation. */
export async function getConsumerGenjutsuQuote(
  accessToken: string,
  value: ConsumerGenjutsuInput,
  sources: { url: string; type: "image" | "video" }[],
  options: Options & {
    resolveMedia: (
      index: number,
      workspaceId: string,
      perform: () => Promise<string>,
    ) => Promise<string>;
  },
) {
  const input = parseConsumerGenjutsuInput(value);
  if (
    sources.length !== input.references.length + 1 ||
    sources.some(
      (s, i) =>
        s.type !== (i === 0 ? "video" : "image") || !safeImportUrl(s.url),
    )
  )
    throw new ConsumerVideoError("invalid_input");
  try {
    return await withConsumerSession(
      accessToken,
      options,
      150_000,
      async (session) => {
        if (!session.supportsTools)
          throw new ConsumerVideoError("provider_error");
        const workspace = parseConsumerVideoWorkspace(
          videoReadResult(session, await session.videoWorkspaces()),
        );
        const medias: ConsumerGenjutsuMedia[] = [];
        // Sequential bounded imports keep one remote mutation in flight and its
        // outcome recorded before the next one is admitted.
        for (let i = 0; i < sources.length; i++) {
          if (!session.active())
            throw new ConsumerVideoError("preflight_unavailable");
          const source = sources[i];
          let mediaId: string;
          try {
            mediaId = await options.resolveMedia(i, workspace.id, async () => {
              const raw = videoReadResult(
                session,
                await session.genjutsuImport(source.url, source.type),
              );
              if (
                !object(raw) ||
                typeof raw.media_id !== "string" ||
                (raw.type !== undefined && raw.type !== source.type) ||
                (raw.error != null && raw.error !== "") ||
                (raw.warning != null && raw.warning !== "")
              )
                throw new ConsumerVideoError("provider_error");
              return consumerVideoJobId(raw.media_id);
            });
          } catch (error) {
            throw new ConsumerAdmissionStopped(error);
          }
          medias.push({ value: mediaId, role: i === 0 ? "video" : "image" });
        }
        const params = consumerGenjutsuParams(input, medias);
        const credits = parseConsumerCreditsForParams(
          videoReadResult(session, await session.genjutsuQuote(params)),
          { ...params, get_cost: true },
        );
        const current = parseConsumerVideoWorkspace(
          videoReadResult(session, await session.videoWorkspaces()),
        );
        matchingWorkspace(current, workspace.id);
        return { input, params, workspace: current, credits };
      },
    );
  } catch (error) {
    if (error instanceof ConsumerAdmissionStopped) throw error.original;
    return videoPreflightError(error);
  }
}
function safeImportUrl(value: string) {
  try {
    const u = new URL(value);
    return (
      u.protocol === "https:" &&
      !u.username &&
      !u.password &&
      !u.port &&
      !u.hash
    );
  } catch {
    return false;
  }
}
function checkedGenjutsuParams(
  input: ConsumerGenjutsuInput,
  params: ConsumerGenjutsuParams,
) {
  const checked = consumerGenjutsuParams(input, params.medias);
  if (!sameConsumerValue(checked, params))
    throw new ConsumerVideoError("invalid_input");
  return checked;
}
export async function submitConsumerGenjutsu(
  accessToken: string,
  input: ConsumerGenjutsuInput,
  value: ConsumerGenjutsuParams,
  expectedWorkspaceId: string,
  expectedCredits: number,
  options: Options & { admit: () => Promise<void> },
): Promise<ConsumerVideoSubmission> {
  const params = checkedGenjutsuParams(input, value),
    expected = videoWorkspaceId(expectedWorkspaceId);
  if (
    !Number.isFinite(expectedCredits) ||
    expectedCredits <= 0 ||
    typeof options.admit !== "function"
  )
    throw new ConsumerVideoError("invalid_input");
  let attempted = false;
  try {
    return await withConsumerSession(
      accessToken,
      options,
      QUALIFICATION_LIMITS.timeoutMs,
      async (session) => {
        const workspace = parseConsumerVideoWorkspace(
          videoReadResult(session, await session.videoWorkspaces()),
        );
        matchingWorkspace(workspace, expected);
        const credits = parseConsumerCreditsForParams(
          videoReadResult(session, await session.genjutsuQuote(params)),
          { ...params, get_cost: true },
        );
        if (credits !== expectedCredits)
          throw new ConsumerVideoError("quote_changed");
        const current = parseConsumerVideoWorkspace(
          videoReadResult(session, await session.videoWorkspaces()),
        );
        matchingWorkspace(current, expected);
        if (current.credits < credits)
          throw new ConsumerVideoError("insufficient_credits");
        try {
          await options.admit();
        } catch (error) {
          throw new ConsumerAdmissionStopped(error);
        }
        if (!session.active())
          throw new ConsumerVideoError("preflight_unavailable");
        const reply = await session.genjutsuSubmit(params, () => {
          attempted = true;
        });
        const raw = normalizeQualificationResult(reply, session.secrets).result;
        const providerJobId = consumerVideoAcknowledgement(raw, params.model);
        return providerJobId
          ? { state: "accepted", providerJobId, raw }
          : uncertainSubmission(raw);
      },
    );
  } catch (error) {
    if (error instanceof ConsumerAdmissionStopped) throw error.original;
    if (attempted) return uncertainSubmission();
    return videoPreflightError(error);
  }
}
export async function readConsumerGenjutsuJob(
  accessToken: string,
  jobId: string,
  expectedWorkspaceId: string,
  model: ConsumerGenjutsuParams["model"],
  options: Options = {},
) {
  consumerVideoJobId(jobId);
  const expected = videoWorkspaceId(expectedWorkspaceId);
  if (!["hf_mult_motion_control", "hf_mult_replace_object"].includes(model))
    throw new ConsumerVideoError("invalid_input");
  try {
    return await withConsumerSession(
      accessToken,
      options,
      QUALIFICATION_LIMITS.timeoutMs,
      async (session) => {
        matchingWorkspace(
          parseConsumerVideoWorkspace(
            videoReadResult(session, await session.videoWorkspaces()),
          ),
          expected,
        );
        const raw = videoReadResult(
          session,
          await session.genjutsuStatus(jobId),
        );
        if (object(raw) && object(raw.generation)) {
          const generation = raw.generation;
          if (("id" in generation && consumerVideoJobId(generation.id) !== jobId) ||
              ("model" in generation && generation.model !== model) ||
              ("type" in generation && generation.type !== "video"))
            throw new ConsumerVideoError("invalid_job");
        }
        return {
          jobId,
          raw,
          ...validateConsumerVideoStatus(raw, jobId, model),
        };
      },
    );
  } catch (error) {
    return videoPreflightError(error);
  }
}

/* ── Catalogue-driven generation (Atomik "Generate" workflows) ─────────── */
function generationTool(type: ConnectedOutputType) {
  if (!CONNECTED_OUTPUT_TYPES.includes(type)) throw new ConsumerVideoError("invalid_input");
  return GENERATION_TOOLS[type];
}
const CURSOR = /^[\x21-\x7e]{1,4096}$/;
/** Read-only: the whole `models_explore list` catalogue, following the
 * provider's page token up to a fixed page count. The merged raw envelope is
 * returned for catalogue.ts to parse; nothing here is executed or priced. */
export async function readConnectedCatalogue(
  accessToken: string,
  options: Options = {},
): Promise<{ items: unknown[]; has_more: boolean; unlim: unknown }> {
  try {
    return await withConsumerSession(accessToken, options, QUALIFICATION_LIMITS.timeoutMs, async (session) => {
      if (!session.supportsTools) throw new ConsumerVideoError("provider_error");
      const items: unknown[] = [];
      const seen = new Set<string>();
      let after: string | undefined, unlim: unknown, hasMore = false;
      for (let page = 0; page < CATALOGUE_PAGES; page++) {
        if (!session.active()) throw new ConsumerVideoError("preflight_unavailable");
        const raw = videoReadResult(session, await session.catalogueList(after));
        if (!object(raw) || !Array.isArray(raw.items) || items.length + raw.items.length > 400)
          throw new ConsumerVideoError("provider_error");
        items.push(...raw.items);
        if (page === 0) unlim = raw.unlim;
        hasMore = raw.has_more === true;
        const next = raw.next_page_token;
        if (!hasMore || next === undefined || next === null) break;
        if (typeof next !== "string" || !CURSOR.test(next) || seen.has(next)) throw new ConsumerVideoError("provider_error");
        seen.add(next);
        after = next;
      }
      return { items, has_more: hasMore, unlim };
    });
  } catch (error) {
    return videoPreflightError(error);
  }
}
/** Read-only `models_explore get` for one model id; returns the raw entry. */
export async function readConnectedModel(accessToken: string, modelId: string, options: Options = {}): Promise<unknown> {
  if (!/^[A-Za-z0-9_.-]{1,80}$/.test(modelId)) throw new ConsumerVideoError("invalid_input");
  try {
    return await withConsumerSession(accessToken, options, QUALIFICATION_LIMITS.timeoutMs, async (session) => {
      if (!session.supportsTools) throw new ConsumerVideoError("provider_error");
      const raw = videoReadResult(session, await session.catalogueGet(modelId));
      if (!object(raw)) throw new ConsumerVideoError("provider_error");
      return object(raw.model) ? raw.model : raw;
    });
  } catch (error) {
    return videoPreflightError(error);
  }
}
export type ConsumerGenerationQuote = {
  input: ConsumerGenerationInput;
  params: ConsumerGenerationParams;
  workspace: ConsumerVideoWorkspace;
  credits: number;
};
/** Imports each application-authorized reference once (the resolve hook owns
 * the durable claim), then prices the validated request with get_cost:true.
 * Nothing here submits a generation. */
export async function getConsumerGenerationQuote(
  accessToken: string,
  model: ConnectedModel,
  value: ConsumerGenerationInput,
  sources: { url: string; type: "image" | "video" | "audio"; role: string }[],
  options: Options & {
    resolveMedia: (index: number, workspaceId: string, perform: () => Promise<string>) => Promise<string>;
  },
): Promise<ConsumerGenerationQuote> {
  const input = parseConsumerGenerationInput(value);
  if (
    sources.length !== input.medias.length ||
    sources.some((s, i) => s.role !== input.medias[i].role || !safeImportUrl(s.url) || !["image", "video", "audio"].includes(s.type))
  )
    throw new ConsumerVideoError("invalid_input");
  // Validate against the catalogue before any provider call, paid or not.
  consumerGenerationParams(model, input, input.medias.map((media) => ({ value: "00000000-0000-4000-8000-000000000000", role: media.role })));
  try {
    return await withConsumerSession(accessToken, options, 150_000, async (session) => {
      if (!session.supportsTools) throw new ConsumerVideoError("provider_error");
      const workspace = parseConsumerVideoWorkspace(videoReadResult(session, await session.videoWorkspaces()));
      const medias: ConsumerGenerationMedia[] = [];
      for (let i = 0; i < sources.length; i++) {
        if (!session.active()) throw new ConsumerVideoError("preflight_unavailable");
        const source = sources[i];
        let mediaId: string;
        try {
          mediaId = await options.resolveMedia(i, workspace.id, async () => {
            const raw = videoReadResult(session, await session.genjutsuImport(source.url, source.type));
            if (
              !object(raw) ||
              typeof raw.media_id !== "string" ||
              (raw.type !== undefined && raw.type !== source.type) ||
              (raw.error != null && raw.error !== "") ||
              (raw.warning != null && raw.warning !== "")
            )
              throw new ConsumerVideoError("provider_error");
            return consumerVideoJobId(raw.media_id);
          });
        } catch (error) {
          throw new ConsumerAdmissionStopped(error);
        }
        medias.push({ value: mediaId, role: source.role });
      }
      const params = consumerGenerationParams(model, input, medias);
      const credits = parseConsumerCreditsForParams(
        videoReadResult(session, await session.generationQuote(input.type, params)),
        { ...params, get_cost: true },
      );
      const current = parseConsumerVideoWorkspace(videoReadResult(session, await session.videoWorkspaces()));
      matchingWorkspace(current, workspace.id);
      return { input, params, workspace: current, credits };
    });
  } catch (error) {
    if (error instanceof ConsumerAdmissionStopped) throw error.original;
    return videoPreflightError(error);
  }
}
/** Fresh wallet/price checks, durable admission, then exactly one paid call. */
export async function submitConsumerGeneration(
  accessToken: string,
  model: ConnectedModel,
  input: ConsumerGenerationInput,
  value: ConsumerGenerationParams,
  expectedWorkspaceId: string,
  expectedCredits: number,
  options: Options & { admit: () => Promise<void> },
): Promise<ConsumerVideoSubmission> {
  const checked = consumerGenerationParams(model, input, value.medias);
  if (!sameConsumerValue(checked, value)) throw new ConsumerVideoError("invalid_input");
  const params = checked, expected = videoWorkspaceId(expectedWorkspaceId);
  if (!Number.isFinite(expectedCredits) || expectedCredits <= 0 || typeof options.admit !== "function")
    throw new ConsumerVideoError("invalid_input");
  let attempted = false;
  try {
    return await withConsumerSession(accessToken, options, QUALIFICATION_LIMITS.timeoutMs, async (session) => {
      const workspace = parseConsumerVideoWorkspace(videoReadResult(session, await session.videoWorkspaces()));
      matchingWorkspace(workspace, expected);
      const credits = parseConsumerCreditsForParams(
        videoReadResult(session, await session.generationQuote(input.type, params)),
        { ...params, get_cost: true },
      );
      if (credits !== expectedCredits) throw new ConsumerVideoError("quote_changed");
      const current = parseConsumerVideoWorkspace(videoReadResult(session, await session.videoWorkspaces()));
      matchingWorkspace(current, expected);
      if (current.credits < credits) throw new ConsumerVideoError("insufficient_credits");
      try {
        await options.admit();
      } catch (error) {
        throw new ConsumerAdmissionStopped(error);
      }
      if (!session.active()) throw new ConsumerVideoError("preflight_unavailable");
      const reply = await session.generationSubmit(input.type, params, () => {
        attempted = true;
      });
      const raw = normalizeQualificationResult(reply, session.secrets).result;
      const providerJobId = consumerVideoAcknowledgement(raw, params.model, input.type);
      return providerJobId ? { state: "accepted", providerJobId, raw } : uncertainSubmission(raw);
    });
  } catch (error) {
    if (error instanceof ConsumerAdmissionStopped) throw error.original;
    if (attempted) return uncertainSubmission();
    return videoPreflightError(error);
  }
}
/** Read-only status of one acknowledged generation job (normalized envelope). */
export async function readConsumerGenerationJob(
  accessToken: string,
  jobId: string,
  expectedWorkspaceId: string,
  model: string,
  type: ConnectedOutputType,
  options: Options = {},
) {
  consumerVideoJobId(jobId);
  const expected = videoWorkspaceId(expectedWorkspaceId);
  if (!/^[A-Za-z0-9_.-]{1,80}$/.test(model) || !CONNECTED_OUTPUT_TYPES.includes(type)) throw new ConsumerVideoError("invalid_input");
  try {
    return await withConsumerSession(accessToken, options, QUALIFICATION_LIMITS.timeoutMs, async (session) => {
      matchingWorkspace(parseConsumerVideoWorkspace(videoReadResult(session, await session.videoWorkspaces())), expected);
      const raw = videoReadResult(session, await session.generationStatus(jobId));
      if (object(raw) && object(raw.generation)) {
        const generation = raw.generation;
        if (("id" in generation && consumerVideoJobId(generation.id) !== jobId) ||
            ("model" in generation && generation.model !== model) ||
            ("type" in generation && generation.type !== type))
          throw new ConsumerVideoError("invalid_job");
      }
      return { jobId, raw, ...validateConsumerVideoStatus(raw, jobId, model, type) };
    });
  } catch (error) {
    return videoPreflightError(error);
  }
}

/* ── Marketing Studio v2 templates (Moleculr "Create with template") ──── */
/** The advertised input schemas of the named tools, read from this session's
 * bounded tools/list. Schemas are data used only to verify our argument names. */
async function sessionToolSchemas(session: ConsumerSession, names: readonly string[]) {
  const found = new Map<string, Record<string, unknown>>();
  const cursors = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < DISCOVERY_LIMITS.pages && found.size < names.length; page++) {
    if (!session.active()) throw new ConsumerVideoError("preflight_unavailable");
    const result = await session.list(cursor);
    if (!Array.isArray(result.tools) || result.tools.length > DISCOVERY_LIMITS.tools) throw new ConsumerVideoError("provider_error");
    for (const entry of result.tools) {
      if (!object(entry) || typeof entry.name !== "string") throw new ConsumerVideoError("provider_error");
      if (!names.includes(entry.name) || found.has(entry.name)) continue;
      try {
        validateSchema(entry.inputSchema, session.secrets);
      } catch {
        throw new ConsumerVideoError("provider_error");
      }
      found.set(entry.name, entry.inputSchema);
    }
    const next = result.nextCursor;
    if (next === undefined) break;
    if (typeof next !== "string" || !CURSOR.test(next) || cursors.has(next)) throw new ConsumerVideoError("provider_error");
    cursors.add(next);
    cursor = next;
  }
  return found;
}
const unverified = (what: string) =>
  new MarketingTemplateError("contract_unverified", `The connected account's ${what} tool does not advertise the arguments this workflow sends. Nothing was submitted.`);
/** Read-only: the whole presets feed for one category, following the
 * provider's cursor up to a fixed page count. The merged items are returned
 * for marketing-templates.ts to parse; nothing here is executed or priced. */
export async function readMarketingTemplateCatalogue(
  accessToken: string,
  category: MarketingTemplateCategory = "all",
  options: Options = {},
): Promise<{ items: unknown[]; total: number | null; complete: boolean }> {
  if (!MARKETING_TEMPLATE_CATEGORIES.includes(category)) throw new ConsumerVideoError("invalid_input");
  try {
    return await withConsumerSession(accessToken, options, QUALIFICATION_LIMITS.timeoutMs, async (session) => {
      if (!session.supportsTools) throw new ConsumerVideoError("provider_error");
      const items: unknown[] = [];
      const seen = new Set<string>();
      let cursor: string | number | undefined, total: number | null = null, more = false;
      for (let page = 0; page < MARKETING_TEMPLATE_PAGES; page++) {
        if (!session.active()) throw new ConsumerVideoError("preflight_unavailable");
        const raw = videoReadResult(session, await session.templatePresets(category, cursor));
        let parsed: ReturnType<typeof parseMarketingTemplatePage>;
        try {
          parsed = parseMarketingTemplatePage(raw);
        } catch {
          throw new ConsumerVideoError("provider_error");
        }
        if (items.length + parsed.items.length > 1200) throw new ConsumerVideoError("provider_error");
        items.push(...parsed.items);
        if (page === 0) total = parsed.total;
        more = !(parsed.hasMore === false || parsed.next === null || parsed.items.length === 0 || (total !== null && items.length >= total));
        if (!more) break;
        const key = String(parsed.next);
        if (seen.has(key)) throw new ConsumerVideoError("provider_error");
        seen.add(key);
        cursor = parsed.next!;
      }
      return { items, total, complete: !more };
    });
  } catch (error) {
    return videoPreflightError(error);
  }
}
/** Read-only: the versioned pricing document, raw, for marketing-templates.ts. */
export async function readMarketingTemplateCosts(accessToken: string, options: Options = {}): Promise<unknown> {
  try {
    return await withConsumerSession(accessToken, options, QUALIFICATION_LIMITS.timeoutMs, async (session) => {
      if (!session.supportsTools) throw new ConsumerVideoError("provider_error");
      const raw = videoReadResult(session, await session.templateCosts());
      if (!object(raw)) throw new ConsumerVideoError("provider_error");
      return raw;
    });
  } catch (error) {
    return videoPreflightError(error);
  }
}
export type ConsumerMarketingTemplateShape = { nested: boolean; getCost: boolean };
export type ConsumerMarketingTemplateQuote = {
  input: ConsumerMarketingTemplateInput;
  params: ConsumerMarketingTemplateParams;
  shape: ConsumerMarketingTemplateShape;
  workspace: ConsumerVideoWorkspace;
  credits: number;
  /** Where the approved price came from: the tool's own get_cost preflight or the catalogue's cost table. */
  priceSource: "get_cost" | "cost_table" | "catalogue";
};
const templateArguments = (params: ConsumerMarketingTemplateParams, shape: ConsumerMarketingTemplateShape, getCost: boolean | null) => {
  const body: Record<string, unknown> = { ...params, ...(getCost === null ? {} : { get_cost: getCost }) };
  return shape.nested ? { params: body } : body;
};
async function verifiedTemplateShape(session: ConsumerSession, params: ConsumerMarketingTemplateParams) {
  const schemas = await sessionToolSchemas(session, [MARKETING_TEMPLATE_TOOLS.create]);
  const shape = marketingTemplateArgumentShape(schemas.get(MARKETING_TEMPLATE_TOOLS.create), Object.keys(params));
  if (!shape) throw new ConsumerAdmissionStopped(unverified("create"));
  return shape;
}
async function templatePrice(
  session: ConsumerSession,
  template: MarketingTemplate,
  costs: MarketingTemplateCosts | null,
  params: ConsumerMarketingTemplateParams,
  shape: ConsumerMarketingTemplateShape,
): Promise<{ credits: number; priceSource: ConsumerMarketingTemplateQuote["priceSource"] }> {
  if (shape.getCost) {
    const sent = templateArguments(params, shape, true);
    const raw = videoReadResult(session, await session.templateCreate(sent));
    return { credits: parseConsumerCreditsForParams(raw, shape.nested ? (sent.params as Record<string, unknown>) : sent), priceSource: "get_cost" };
  }
  const priced = priceForTemplate(costs, template);
  if (!priced) throw new ConsumerAdmissionStopped(new MarketingTemplateError("price_unknown", "The catalogue's cost table has no price for this template. Nothing was submitted."));
  return { credits: priced.credits, priceSource: priced.source };
}
/** Imports the product original once (the resolve hook owns the durable
 * claim), verifies the create tool's advertised arguments, then prices the
 * request without submitting: get_cost when the tool declares it, otherwise
 * the catalogue's versioned cost table. */
export async function getConsumerMarketingTemplateQuote(
  accessToken: string,
  template: MarketingTemplate,
  costs: MarketingTemplateCosts | null,
  value: ConsumerMarketingTemplateInput,
  source: { url: string; type: "image" } | null,
  options: Options & { resolveMedia: (workspaceId: string, perform: () => Promise<string>) => Promise<string> },
): Promise<ConsumerMarketingTemplateQuote> {
  const input = parseConsumerMarketingTemplateInput(value);
  if (input.presetId !== template.id || Boolean(input.productImage) !== (source !== null) || (source && (!safeImportUrl(source.url) || source.type !== "image")))
    throw new ConsumerVideoError("invalid_input");
  consumerMarketingTemplateParams(input, source ? "00000000-0000-4000-8000-000000000000" : null);
  try {
    return await withConsumerSession(accessToken, options, 150_000, async (session) => {
      if (!session.supportsTools) throw new ConsumerVideoError("provider_error");
      const workspace = parseConsumerVideoWorkspace(videoReadResult(session, await session.videoWorkspaces()));
      let mediaId: string | null = null;
      if (source) {
        try {
          mediaId = await options.resolveMedia(workspace.id, async () => {
            const raw = videoReadResult(session, await session.genjutsuImport(source.url, "image"));
            if (!object(raw) || typeof raw.media_id !== "string" || (raw.type !== undefined && raw.type !== "image") ||
                (raw.error != null && raw.error !== "") || (raw.warning != null && raw.warning !== ""))
              throw new ConsumerVideoError("provider_error");
            return consumerVideoJobId(raw.media_id);
          });
        } catch (error) {
          throw new ConsumerAdmissionStopped(error);
        }
      }
      const params = consumerMarketingTemplateParams(input, mediaId);
      const shape = await verifiedTemplateShape(session, params);
      const { credits, priceSource } = await templatePrice(session, template, costs, params, shape);
      const current = parseConsumerVideoWorkspace(videoReadResult(session, await session.videoWorkspaces()));
      matchingWorkspace(current, workspace.id);
      return { input, params, shape, workspace: current, credits, priceSource };
    });
  } catch (error) {
    if (error instanceof ConsumerAdmissionStopped) throw error.original;
    return videoPreflightError(error);
  }
}
/** Fresh wallet, contract and price checks, durable admission, then exactly one paid call. */
export async function submitConsumerMarketingTemplate(
  accessToken: string,
  template: MarketingTemplate,
  costs: MarketingTemplateCosts | null,
  input: ConsumerMarketingTemplateInput,
  value: ConsumerMarketingTemplateParams,
  expectedShape: ConsumerMarketingTemplateShape,
  expectedWorkspaceId: string,
  expectedCredits: number,
  options: Options & { admit: () => Promise<void> },
): Promise<ConsumerVideoSubmission> {
  const params = consumerMarketingTemplateParams(input, value.product_image ?? null);
  if (!sameConsumerValue(params, value) || template.id !== params.preset_id) throw new ConsumerVideoError("invalid_input");
  const expected = videoWorkspaceId(expectedWorkspaceId);
  if (!Number.isFinite(expectedCredits) || expectedCredits <= 0 || typeof options.admit !== "function") throw new ConsumerVideoError("invalid_input");
  let attempted = false;
  try {
    return await withConsumerSession(accessToken, options, QUALIFICATION_LIMITS.timeoutMs, async (session) => {
      if (!session.supportsTools) throw new ConsumerVideoError("provider_error");
      const workspace = parseConsumerVideoWorkspace(videoReadResult(session, await session.videoWorkspaces()));
      matchingWorkspace(workspace, expected);
      const shape = await verifiedTemplateShape(session, params);
      if (shape.nested !== expectedShape.nested || shape.getCost !== expectedShape.getCost) throw new ConsumerAdmissionStopped(unverified("create"));
      const { credits } = await templatePrice(session, template, costs, params, shape);
      if (credits !== expectedCredits) throw new ConsumerVideoError("quote_changed");
      const current = parseConsumerVideoWorkspace(videoReadResult(session, await session.videoWorkspaces()));
      matchingWorkspace(current, expected);
      if (current.credits < credits) throw new ConsumerVideoError("insufficient_credits");
      try {
        await options.admit();
      } catch (error) {
        throw new ConsumerAdmissionStopped(error);
      }
      if (!session.active()) throw new ConsumerVideoError("preflight_unavailable");
      const reply = await session.templateCreate(templateArguments(params, shape, shape.getCost ? false : null), () => {
        attempted = true;
      });
      const normalized = normalizeQualificationResult(reply, session.secrets), raw = normalized.result;
      const providerJobId = normalized.isError ? null : consumerMarketingTemplateAcknowledgement(raw);
      return providerJobId ? { state: "accepted", providerJobId, raw } : uncertainSubmission(raw);
    });
  } catch (error) {
    if (error instanceof ConsumerAdmissionStopped) throw error.original;
    if (attempted) return uncertainSubmission();
    return videoPreflightError(error);
  }
}
const STATUS_ARGUMENTS = ["job_id", "id", "jobId"] as const;
/** Read-only status of one acknowledged template job; the identifier argument
 * name is taken from the status tool's advertised schema. */
export async function readConsumerMarketingTemplateJob(
  accessToken: string,
  jobId: string,
  expectedWorkspaceId: string,
  options: Options = {},
): Promise<{ jobId: string; raw: QualificationValue; pollAfterSeconds?: number }> {
  consumerVideoJobId(jobId);
  const expected = videoWorkspaceId(expectedWorkspaceId);
  try {
    return await withConsumerSession(accessToken, options, QUALIFICATION_LIMITS.timeoutMs, async (session) => {
      matchingWorkspace(parseConsumerVideoWorkspace(videoReadResult(session, await session.videoWorkspaces())), expected);
      const schema = (await sessionToolSchemas(session, [MARKETING_TEMPLATE_TOOLS.status])).get(MARKETING_TEMPLATE_TOOLS.status);
      let args: Record<string, unknown> | null = null;
      for (const name of STATUS_ARGUMENTS) {
        const shape = marketingTemplateArgumentShape(schema, [name]);
        if (shape) { args = shape.nested ? { params: { [name]: jobId } } : { [name]: jobId }; break; }
      }
      if (!args) throw new ConsumerAdmissionStopped(unverified("status"));
      const raw = videoReadResult(session, await session.templateStatus(args));
      const wait = consumerMarketingTemplatePollAfter(raw);
      return { jobId, raw, ...(wait === undefined ? {} : { pollAfterSeconds: wait }) };
    });
  } catch (error) {
    if (error instanceof ConsumerAdmissionStopped) throw error.original;
    return videoPreflightError(error);
  }
}

/* ── Voice, dubbing and analysis tools (Atomik Generate, slice I3) ────── */
/** Read-only: the whole `list_voices` listing, following the provider's
 * cursor up to a fixed page count. Items are returned raw for voice-tools.ts
 * to parse; nothing here is executed or priced. */
export async function readConnectedVoices(accessToken: string, options: Options = {}): Promise<{ items: unknown[]; complete: boolean }> {
  try {
    return await withConsumerSession(accessToken, options, QUALIFICATION_LIMITS.timeoutMs, async (session) => {
      if (!session.supportsTools) throw new ConsumerVideoError("provider_error");
      const items: unknown[] = [];
      const seen = new Set<string>();
      let cursor: string | undefined, more = false;
      for (let page = 0; page < VOICES_LIMITS.pages; page++) {
        if (!session.active()) throw new ConsumerVideoError("preflight_unavailable");
        let parsed: ReturnType<typeof parseConnectedVoicesPage>;
        try {
          parsed = parseConnectedVoicesPage(videoReadResult(session, await session.voicesList(cursor)));
        } catch {
          throw new ConsumerVideoError("provider_error");
        }
        if (items.length + parsed.items.length > VOICES_LIMITS.voices) throw new ConsumerVideoError("provider_error");
        items.push(...parsed.items);
        more = parsed.next !== null && parsed.items.length > 0;
        if (!more) break;
        if (seen.has(parsed.next!)) throw new ConsumerVideoError("provider_error");
        seen.add(parsed.next!);
        cursor = parsed.next!;
      }
      return { items, complete: !more };
    });
  } catch (error) {
    return videoPreflightError(error);
  }
}
export type ConsumerVoiceToolQuote = {
  input: ConsumerVoiceToolInput;
  params: ConsumerVoiceToolParams;
  shape: VoiceToolShape;
  workspace: ConsumerVideoWorkspace;
  credits: number;
  /** The only price source these tools can have: their own advertised get_cost form. */
  priceSource: "get_cost";
};
const voiceUnverified = (tool: VoiceToolName, what: "create" | "status") =>
  new VoiceToolError("contract_unverified", `The connected account's ${requireVoiceTool(tool).label} ${what} tool does not advertise the arguments this workflow sends. Nothing was submitted.`);
async function verifiedVoiceToolShape(session: ConsumerSession, tool: VoiceToolName, params: ConsumerVoiceToolParams) {
  const definition = requireVoiceTool(tool);
  const shape = voiceToolArgumentShape((await sessionToolSchemas(session, [definition.create])).get(definition.create), params);
  if (!shape) throw new ConsumerAdmissionStopped(voiceUnverified(tool, "create"));
  return shape;
}
async function voiceToolPrice(session: ConsumerSession, tool: VoiceToolName, params: ConsumerVoiceToolParams, shape: VoiceToolShape) {
  if (!shape.getCost)
    throw new ConsumerAdmissionStopped(new VoiceToolError("price_unknown", `The connected account advertises no price preflight for ${requireVoiceTool(tool).label}, and no catalogue entry prices it. Nothing was sent.`));
  const sent = voiceToolArguments(params, shape, true);
  const raw = videoReadResult(session, await session.voiceToolCreate(tool, sent));
  return parseConsumerCreditsForParams(raw, shape.nested ? (sent.params as Record<string, unknown>) : sent);
}
/** Verifies the create tool's advertised arguments and that it declares a
 * get_cost preflight BEFORE the source is imported (a tool with no price
 * makes no remote mutation at all), imports the project video once (the
 * resolve hook owns the durable claim), then prices without submitting. */
export async function getConsumerVoiceToolQuote(
  accessToken: string,
  value: ConsumerVoiceToolInput,
  source: { url: string; type: "video" },
  options: Options & { resolveMedia: (workspaceId: string, perform: () => Promise<string>) => Promise<string> },
): Promise<ConsumerVoiceToolQuote> {
  const input = parseConsumerVoiceToolInput(value);
  if (!safeImportUrl(source.url) || source.type !== "video") throw new ConsumerVideoError("invalid_input");
  const placeholder = consumerVoiceToolParams(input, "00000000-0000-4000-8000-000000000000");
  try {
    return await withConsumerSession(accessToken, options, 150_000, async (session) => {
      if (!session.supportsTools) throw new ConsumerVideoError("provider_error");
      const workspace = parseConsumerVideoWorkspace(videoReadResult(session, await session.videoWorkspaces()));
      const shape = await verifiedVoiceToolShape(session, input.tool, placeholder);
      if (!shape.getCost) await voiceToolPrice(session, input.tool, placeholder, shape);
      let mediaId: string;
      try {
        mediaId = await options.resolveMedia(workspace.id, async () => {
          const raw = videoReadResult(session, await session.genjutsuImport(source.url, "video"));
          if (!object(raw) || typeof raw.media_id !== "string" || (raw.type !== undefined && raw.type !== "video") ||
              (raw.error != null && raw.error !== "") || (raw.warning != null && raw.warning !== ""))
            throw new ConsumerVideoError("provider_error");
          return consumerVideoJobId(raw.media_id);
        });
      } catch (error) {
        throw new ConsumerAdmissionStopped(error);
      }
      const params = consumerVoiceToolParams(input, mediaId);
      const credits = await voiceToolPrice(session, input.tool, params, shape);
      const current = parseConsumerVideoWorkspace(videoReadResult(session, await session.videoWorkspaces()));
      matchingWorkspace(current, workspace.id);
      return { input, params, shape, workspace: current, credits, priceSource: "get_cost" };
    });
  } catch (error) {
    if (error instanceof ConsumerAdmissionStopped) throw error.original;
    return videoPreflightError(error);
  }
}
/** Fresh wallet, contract and price checks, durable admission, then exactly one paid call. */
export async function submitConsumerVoiceTool(
  accessToken: string,
  input: ConsumerVoiceToolInput,
  value: ConsumerVoiceToolParams,
  expectedShape: VoiceToolShape,
  expectedWorkspaceId: string,
  expectedCredits: number,
  options: Options & { admit: () => Promise<void> },
): Promise<ConsumerVideoSubmission> {
  const mediaId = value.video_id ?? value.video_input_id;
  const params = consumerVoiceToolParams(input, typeof mediaId === "string" ? mediaId : "");
  if (!sameConsumerValue(params, value)) throw new ConsumerVideoError("invalid_input");
  const expected = videoWorkspaceId(expectedWorkspaceId);
  if (!Number.isFinite(expectedCredits) || expectedCredits <= 0 || typeof options.admit !== "function") throw new ConsumerVideoError("invalid_input");
  let attempted = false;
  try {
    return await withConsumerSession(accessToken, options, QUALIFICATION_LIMITS.timeoutMs, async (session) => {
      if (!session.supportsTools) throw new ConsumerVideoError("provider_error");
      const workspace = parseConsumerVideoWorkspace(videoReadResult(session, await session.videoWorkspaces()));
      matchingWorkspace(workspace, expected);
      const shape = await verifiedVoiceToolShape(session, input.tool, params);
      if (shape.nested !== expectedShape.nested || shape.getCost !== expectedShape.getCost) throw new ConsumerAdmissionStopped(voiceUnverified(input.tool, "create"));
      const credits = await voiceToolPrice(session, input.tool, params, shape);
      if (credits !== expectedCredits) throw new ConsumerVideoError("quote_changed");
      const current = parseConsumerVideoWorkspace(videoReadResult(session, await session.videoWorkspaces()));
      matchingWorkspace(current, expected);
      if (current.credits < credits) throw new ConsumerVideoError("insufficient_credits");
      try {
        await options.admit();
      } catch (error) {
        throw new ConsumerAdmissionStopped(error);
      }
      if (!session.active()) throw new ConsumerVideoError("preflight_unavailable");
      const reply = await session.voiceToolCreate(input.tool, voiceToolArguments(params, shape, false), () => {
        attempted = true;
      });
      const normalized = normalizeQualificationResult(reply, session.secrets), raw = normalized.result;
      const providerJobId = normalized.isError ? null : consumerVoiceToolAcknowledgement(raw);
      return providerJobId ? { state: "accepted", providerJobId, raw } : uncertainSubmission(raw);
    });
  } catch (error) {
    if (error instanceof ConsumerAdmissionStopped) throw error.original;
    if (attempted) return uncertainSubmission();
    return videoPreflightError(error);
  }
}
/** Read-only status of one acknowledged voice-tool job: `job_status`
 * (normalized envelope) for revoiced/dubbed videos, `video_analysis_status`
 * (its advertised identifier argument verified first) for analyses. */
export async function readConsumerVoiceToolJob(
  accessToken: string,
  jobId: string,
  expectedWorkspaceId: string,
  tool: VoiceToolName,
  options: Options = {},
): Promise<{ jobId: string; raw: QualificationValue; pollAfterSeconds?: number }> {
  consumerVideoJobId(jobId);
  const expected = videoWorkspaceId(expectedWorkspaceId);
  const definition = requireVoiceTool(tool);
  try {
    return await withConsumerSession(accessToken, options, QUALIFICATION_LIMITS.timeoutMs, async (session) => {
      matchingWorkspace(parseConsumerVideoWorkspace(videoReadResult(session, await session.videoWorkspaces())), expected);
      let raw: QualificationValue;
      if (definition.status === "job_status") {
        raw = videoReadResult(session, await session.generationStatus(jobId));
        if (object(raw) && object(raw.generation)) {
          const generation = raw.generation;
          if (("id" in generation && consumerVideoJobId(generation.id) !== jobId) || ("type" in generation && generation.type !== "video"))
            throw new ConsumerVideoError("invalid_job");
        }
      } else {
        const schema = (await sessionToolSchemas(session, [definition.status])).get(definition.status);
        if (!voiceToolArgumentShape(schema, { [VOICE_TOOL_STATUS_ARGUMENT]: jobId })) throw new ConsumerAdmissionStopped(voiceUnverified(tool, "status"));
        raw = videoReadResult(session, await session.voiceToolStatus(tool, { [VOICE_TOOL_STATUS_ARGUMENT]: jobId }));
      }
      const wait = consumerVoiceToolPollAfter(raw);
      return { jobId, raw, ...(wait === undefined ? {} : { pollAfterSeconds: wait }) };
    });
  } catch (error) {
    if (error instanceof ConsumerAdmissionStopped) throw error.original;
    return videoPreflightError(error);
  }
}
