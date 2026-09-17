import {
  higgsfieldConfigured,
  higgsfieldCredentials,
  higgsfieldHeaders,
} from "./higgsfield";
import { withRecoveryActivity } from "./recovery";

const LIST =
  "https://dev-api.higgsfield.com/v1/custom-references/list?page=1&page_size=1";
const ESTIMATE =
  "https://api.higgsfield.ai/estimate/higgsfield-ai/soul/character";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATUSES = new Set([
  "not_ready",
  "queued",
  "in_progress",
  "completed",
  "failed",
]);
type Failure =
  | "authentication_rejected"
  | "rate_limited"
  | "provider_unavailable"
  | "invalid_response"
  | "model_unavailable";
export type HiggsfieldVerificationQuote = {
  status: "quoted" | "skipped" | "unavailable";
  usd?: number;
  error?: Failure | "no_ready_identity" | "mock_mode";
};
export type HiggsfieldVerification = {
  configured: boolean;
  auth: "verified" | "rejected" | "unavailable" | "not_configured" | "mock";
  readyIdentityAvailable: boolean;
  error:
    | Exclude<Failure, "model_unavailable">
    | "missing_configuration"
    | "mock_mode"
    | null;
  estimates: Record<"720p" | "1080p", HiggsfieldVerificationQuote>;
};
class VerificationFailure extends Error {
  constructor(readonly category: Failure) {
    super(category);
  }
}
function failure(error: unknown): Failure {
  return error instanceof VerificationFailure
    ? error.category
    : "provider_unavailable";
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
/** Count bytes before decoding; never retain or expose provider error bodies. */
async function boundedJson(response: Response): Promise<unknown> {
  const limit = 64 * 1024;
  if (
    !response.body ||
    Number(response.headers.get("content-length")) > limit
  ) {
    void response.body?.cancel().catch(() => {});
    throw new VerificationFailure("invalid_response");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let text = "",
    bytes = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > limit) throw new VerificationFailure("invalid_response");
      text += decoder.decode(part.value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } catch (error) {
    void reader.cancel().catch(() => {});
    if (error instanceof VerificationFailure) throw error;
    throw new VerificationFailure("invalid_response");
  } finally {
    reader.releaseLock();
  }
}
async function readOnlyCall(
  url: typeof LIST | typeof ESTIMATE,
  init: RequestInit,
): Promise<unknown> {
  // The documented estimate POST is a read, not a generation or remote mutation.
  // Track the whole bounded read without leaving an uncertain paid-operation fence.
  return withRecoveryActivity("higgsfield-verification-read", async () => {
    const response = await fetch(url, {
      ...init,
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(12_000),
    });
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      throw new VerificationFailure(
        [401, 403].includes(response.status)
          ? "authentication_rejected"
          : response.status === 429
            ? "rate_limited"
            : url === ESTIMATE && [404, 422, 423].includes(response.status)
              ? "model_unavailable"
              : "provider_unavailable",
      );
    }
    return boundedJson(response);
  });
}
function skipped(
  error?: HiggsfieldVerificationQuote["error"],
): HiggsfieldVerification["estimates"] {
  return {
    "720p": { status: "skipped", ...(error ? { error } : {}) },
    "1080p": { status: "skipped", ...(error ? { error } : {}) },
  };
}
async function estimate(
  size: "720p" | "1080p",
  referenceId: string,
): Promise<HiggsfieldVerificationQuote> {
  try {
    const { keyId, keySecret } = higgsfieldCredentials();
    const response = await readOnlyCall(ESTIMATE, {
      method: "POST",
      headers: {
        Authorization: `Key ${keyId}:${keySecret}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        prompt: "Editorial portrait in soft daylight",
        custom_reference_id: referenceId,
        custom_reference_strength: 1,
        batch_size: 1,
        resolution: size,
        aspect_ratio: "3:4",
        enhance_prompt: false,
      }),
    });
    if (
      !object(response) ||
      !(
        typeof response.usd === "number" ||
        (typeof response.usd === "string" &&
          /^\d+(?:\.\d+)?$/.test(response.usd))
      )
    )
      throw new VerificationFailure("invalid_response");
    const usd = Number(response.usd);
    if (!Number.isFinite(usd) || usd <= 0)
      throw new VerificationFailure("invalid_response");
    return { status: "quoted", usd };
  } catch (error) {
    return { status: "unavailable", error: failure(error) };
  }
}
/** Owner-only route applies account/source policy. This helper never trains,
 * generates, stores provider identities, meters spend or enables a model. */
export async function verifyHiggsfieldConnection(): Promise<HiggsfieldVerification> {
  if (process.env.ENGINE_MOCK === "1")
    return {
      configured: higgsfieldConfigured(),
      auth: "mock",
      readyIdentityAvailable: false,
      error: "mock_mode",
      estimates: skipped("mock_mode"),
    };
  if (!higgsfieldConfigured())
    return {
      configured: false,
      auth: "not_configured",
      readyIdentityAvailable: false,
      error: "missing_configuration",
      estimates: skipped(),
    };
  let referenceId: string | undefined;
  try {
    const response = await readOnlyCall(LIST, {
      method: "GET",
      headers: higgsfieldHeaders(),
    });
    if (
      !object(response) ||
      !Array.isArray(response.items) ||
      response.items.length > 1
    )
      throw new VerificationFailure("invalid_response");
    for (const item of response.items) {
      if (
        !object(item) ||
        typeof item.id !== "string" ||
        !UUID.test(item.id) ||
        !STATUSES.has(String(item.status))
      )
        throw new VerificationFailure("invalid_response");
      if (item.status === "completed") referenceId = item.id;
    }
  } catch (error) {
    const category = failure(error);
    const safe =
      category === "model_unavailable" ? "provider_unavailable" : category;
    return {
      configured: true,
      auth: safe === "authentication_rejected" ? "rejected" : "unavailable",
      readyIdentityAvailable: false,
      error: safe,
      estimates: skipped(safe),
    };
  }
  if (!referenceId)
    return {
      configured: true,
      auth: "verified",
      readyIdentityAvailable: false,
      error: null,
      estimates: skipped("no_ready_identity"),
    };
  const [small, large] = await Promise.all([
    estimate("720p", referenceId),
    estimate("1080p", referenceId),
  ]);
  return {
    configured: true,
    auth: "verified",
    readyIdentityAvailable: true,
    error: null,
    estimates: { "720p": small, "1080p": large },
  };
}
