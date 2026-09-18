/**
 * Bounded Streamable HTTP client for discovery, fixed read-only qualification,
 * and typed Marketing Video operations. No generic RPC/tools/call export.
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
  parseConsumerVideoInput,
  parseConsumerVideoWorkspace,
  validateConsumerVideoStatus,
  type ConsumerVideoInput,
  type ConsumerVideoWorkspace,
} from "./video-contract";
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
  videoWorkspaces: () => Promise<Record<string, unknown>>;
  videoQuote: (input: ConsumerVideoInput) => Promise<Record<string, unknown>>;
  videoSubmit: (
    input: ConsumerVideoInput,
    sending: () => void,
  ) => Promise<Record<string, unknown>>;
  videoStatus: (jobId: string) => Promise<Record<string, unknown>>;
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
      videoStatus: async (jobId) =>
        (await post("tools/call", {
          name: "job_status",
          arguments: { jobId, sync: false, raw_data: true },
        }))!,
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
    async (session) => {
      const results: ConsumerQualification["results"] = [];
      let stopped = !session.supportsTools;
      for (const [index, read] of QUALIFICATION_READS.entries()) {
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
          const raw = await session.qualificationRead(index);
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
    },
  );
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
