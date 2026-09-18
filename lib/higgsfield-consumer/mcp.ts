/**
 * Discovery-only Streamable HTTP client. There is deliberately no generic RPC
 * or tools/call export. Server instructions, descriptions and schemas are data,
 * never executable instructions or URLs to fetch.
 * https://modelcontextprotocol.io/specification/2025-11-25/basic/transports
 */
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
};
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
      if (secrets.some((secret) => text.includes(secret))) fail();
    } else if (item.value !== null && typeof item.value === "object") {
      for (const [key, child] of Object.entries(item.value)) {
        if (secrets.some((secret) => key.includes(secret))) fail();
        stack.push({ value: child, depth: item.depth + 1 });
      }
    }
  }
}

export async function discoverConsumerTools(
  accessToken: string,
  options: Options = {},
): Promise<ConsumerToolCatalogue> {
  if (
    !accessToken ||
    accessToken.length > 16_384 ||
    !/^[\x21-\x7e]+$/.test(accessToken)
  )
    fail("reconnect_required");
  const fetcher = options.fetch ?? fetch;
  const controller = new AbortController();
  const timeoutMs = Math.min(
    DISCOVERY_LIMITS.timeoutMs,
    Math.max(1, options.timeoutMs ?? DISCOVERY_LIMITS.timeoutMs),
  );
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const cancel = () => controller.abort();
  options.signal?.addEventListener("abort", cancel, { once: true });
  if (options.signal?.aborted) controller.abort();
  let sessionId: string | undefined;
  let protocolVersion: string | undefined;
  let sequence = 0;
  let totalBytes = 0;

  // A fetch implementation or stalled body must not be able to extend the
  // overall deadline, even if it ignores AbortSignal.
  async function withinDeadline<T>(promise: Promise<T>): Promise<T> {
    if (controller.signal.aborted) fail("timeout");
    let onAbort: () => void = () => {};
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          onAbort = () => reject(new ConsumerDiscoveryError("timeout"));
          controller.signal.addEventListener("abort", onAbort, { once: true });
        }),
      ]);
    } finally {
      controller.signal.removeEventListener("abort", onAbort);
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
        const chunk = await withinDeadline(reader.read());
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
    method: "initialize" | "notifications/initialized" | "tools/list",
    params?: Record<string, unknown>,
  ) {
    if (controller.signal.aborted) fail("timeout");
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
        signal: controller.signal,
      }),
    );
    try {
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
            if (!(await withinDeadline(reader.read())).done) fail();
          } finally {
            void reader.cancel().catch(() => {});
            reader.releaseLock();
          }
        }
        return undefined;
      }
      const result = await readReply(response, id);
      if (method === "initialize") {
        const session = response.headers.get("Mcp-Session-Id");
        if (session !== null) {
          if (!/^[\x21-\x7e]{1,1024}$/.test(session)) fail();
          sessionId = session;
        }
      }
      return result;
    } finally {
      if (response.body && !response.body.locked)
        void response.body.cancel().catch(() => {});
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
    if (initialized.capabilities.tools === undefined)
      return { protocolVersion, tools: [] };
    if (!object(initialized.capabilities.tools)) fail();
    const tools: DiscoveredConsumerTool[] = [];
    const cursors = new Set<string>();
    const names = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < DISCOVERY_LIMITS.pages; page++) {
      const result = (await post(
        "tools/list",
        cursor === undefined ? {} : { cursor },
      ))!;
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
        const secrets = [accessToken, ...(sessionId ? [sessionId] : [])];
        if (
          secrets.some(
            (secret) =>
              name.includes(secret) ||
              (typeof entry.description === "string" &&
                entry.description.includes(secret)),
          )
        )
          fail();
        validateSchema(entry.inputSchema, secrets);
        names.add(entry.name);
        tools.push({
          name: entry.name,
          ...(entry.description === undefined
            ? {}
            : { description: entry.description as string }),
          inputSchema: entry.inputSchema,
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
  } catch (error) {
    if (error instanceof ConsumerDiscoveryError) throw error;
    // Never propagate a fetch/JSON/provider error that might contain headers,
    // tokens, session identifiers, account data, or server instructions.
    return fail(controller.signal.aborted ? "timeout" : "provider_unavailable");
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", cancel);
    controller.abort();
  }
}
