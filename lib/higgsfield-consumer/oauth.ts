import { createHash, randomBytes } from "node:crypto";
import {
  claimConsumerAccess,
  completeAuthorization,
  consumeAuthorization,
  consumerConnectionStatus,
  disconnectConsumer,
  finishConsumerRefresh,
  hashConsumerSecret,
  storeAuthorization,
  type ConsumerIdentity,
  type ConsumerTokens,
} from "./store";

export const CONSUMER_ISSUER = "https://clerk.higgsfield.ai";
export const CONSUMER_RESOURCE = "https://mcp.higgsfield.ai/mcp";
export const CONSUMER_SCOPES = "openid email offline_access";
const TOKEN_ENDPOINT = `${CONSUMER_ISSUER}/oauth/token`;
type ErrorCode =
  | "configuration"
  | "invalid_state"
  | "session_changed"
  | "authorization_denied"
  | "authorization_failed"
  | "reconnect_required"
  | "connection_changed"
  | "connection_busy"
  | "unavailable";
const messages: Record<ErrorCode, string> = {
  configuration:
    "The Higgsfield connection is not configured for this deployment.",
  invalid_state:
    "This connection attempt expired or was already used. Start again in workspace settings.",
  session_changed:
    "Your browser session or workspace changed. Start the connection again in the intended workspace.",
  authorization_denied: "Higgsfield authorization was not approved.",
  authorization_failed:
    "Higgsfield could not complete this connection. Start again in workspace settings.",
  reconnect_required:
    "Reconnect Higgsfield in workspace settings before continuing.",
  connection_changed:
    "The Higgsfield connection changed. Request a new quote before starting a new job; existing jobs require their original connection.",
  connection_busy:
    "The Higgsfield connection is refreshing. Try again shortly.",
  unavailable:
    "The Higgsfield connection is temporarily unavailable. Try again shortly.",
};
export class ConsumerOAuthError extends Error {
  constructor(
    public code: ErrorCode,
    public status = code === "connection_busy" || code === "connection_changed"
      ? 409
      : code === "reconnect_required"
        ? 401
        : code === "unavailable" || code === "configuration"
          ? 503
          : 400,
  ) {
    super(messages[code]);
    this.name = "ConsumerOAuthError";
  }
}

/** Only an operator-configured canonical origin is used; never Host/forwarded headers. */
export function consumerConfiguration() {
  try {
    const origin = new URL(process.env.APP_ORIGIN || "https://www.particl.app");
    if (
      origin.protocol !== "https:" ||
      origin.username ||
      origin.password ||
      origin.pathname !== "/" ||
      origin.search ||
      origin.hash
    )
      throw new Error();
    const metadataUrl = `${origin.origin}/api/higgsfield/consumer/client`;
    const clientId = process.env.HF_CONSUMER_CLIENT_ID || metadataUrl;
    if (
      !clientId ||
      clientId.length > 2048 ||
      /[\s\x00-\x1f\x7f]/.test(clientId)
    )
      throw new Error();
    return {
      origin: origin.origin,
      metadataUrl,
      clientId,
      redirectUri: `${origin.origin}/api/higgsfield/consumer/callback`,
    };
  } catch {
    throw new ConsumerOAuthError("configuration");
  }
}
export function consumerClientMetadata() {
  const { metadataUrl, origin, redirectUri } = consumerConfiguration();
  return {
    client_id: metadataUrl,
    client_name: "Particl",
    client_uri: origin,
    redirect_uris: [redirectUri],
    token_endpoint_auth_method: "none",
  };
}
export function consumerCallbackLocation(code: "connected" | ErrorCode) {
  return `${consumerConfiguration().origin}/settings?higgsfield=${encodeURIComponent(code)}#engines`;
}
export const consumerSessionHash = hashConsumerSecret;

export async function beginConsumerAuthorization(
  identity: ConsumerIdentity,
  session: string,
) {
  if (!session) throw new ConsumerOAuthError("session_changed");
  const { clientId, redirectUri } = consumerConfiguration();
  const state = randomBytes(32).toString("base64url"),
    verifier = randomBytes(32).toString("base64url");
  await storeAuthorization({
    ...identity,
    state,
    verifier,
    sessionHash: consumerSessionHash(session),
    clientId,
    redirectUri,
  });
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: CONSUMER_SCOPES,
    resource: CONSUMER_RESOURCE,
    state,
    code_challenge_method: "S256",
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
  });
  return { url: `${CONSUMER_ISSUER}/oauth/authorize?${params}` };
}

async function tokenResponse(
  params: URLSearchParams,
  fetcher: typeof fetch,
): Promise<Record<string, unknown>> {
  const abort = new AbortController(),
    timer = setTimeout(() => abort.abort(), 12_000);
  try {
    const response = await fetcher(TOKEN_ENDPOINT, {
      method: "POST",
      redirect: "error",
      cache: "no-store",
      signal: abort.signal,
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: params.toString(),
    });
    if (
      !response.ok ||
      !response.headers
        .get("content-type")
        ?.toLowerCase()
        .includes("application/json") ||
      Number(response.headers.get("content-length") || 0) > 32_768 ||
      !response.body
    ) {
      void response.body?.cancel().catch(() => {});
      throw new Error();
    }
    const reader = response.body.getReader(),
      decoder = new TextDecoder("utf-8", { fatal: true });
    let bytes = 0,
      text = "";
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > 32_768) throw new Error();
        text += decoder.decode(chunk.value, { stream: true });
      }
      const data: unknown = JSON.parse(text + decoder.decode());
      if (!data || typeof data !== "object" || Array.isArray(data))
        throw new Error();
      return data as Record<string, unknown>;
    } catch {
      void reader.cancel().catch(() => {});
      throw new Error();
    } finally {
      reader.releaseLock();
    }
  } catch {
    throw new ConsumerOAuthError("authorization_failed");
  } finally {
    clearTimeout(timer);
  }
}
function parseTokens(
  data: Record<string, unknown>,
  clientId: string,
  redirectUri: string,
  previous?: ConsumerTokens,
): ConsumerTokens {
  const validToken = (value: unknown) =>
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 16_384 &&
    !/[\x00-\x20\x7f]/.test(value);
  if (
    !validToken(data.access_token) ||
    typeof data.token_type !== "string" ||
    data.token_type.toLowerCase() !== "bearer" ||
    !Number.isSafeInteger(data.expires_in) ||
    Number(data.expires_in) <= 0 ||
    Number(data.expires_in) > 31_536_000 ||
    (data.refresh_token !== undefined && !validToken(data.refresh_token)) ||
    (data.scope !== undefined &&
      (typeof data.scope !== "string" || data.scope.length > 1024))
  )
    throw new ConsumerOAuthError("authorization_failed");
  return {
    accessToken: data.access_token as string,
    ...(data.refresh_token || previous?.refreshToken
      ? {
          refreshToken: (data.refresh_token ||
            previous?.refreshToken) as string,
        }
      : {}),
    expiresAt: Date.now() + Number(data.expires_in) * 1000,
    scope:
      typeof data.scope === "string"
        ? data.scope
        : previous?.scope || CONSUMER_SCOPES,
    clientId,
    redirectUri,
  };
}

/** The claim is consumed before exchanging. An ambiguous exchange cannot be replayed. */
export async function finishConsumerAuthorization(
  identity: ConsumerIdentity,
  session: string,
  params: URLSearchParams,
  fetcher: typeof fetch = fetch,
) {
  if (!session) throw new ConsumerOAuthError("session_changed");
  for (const key of ["state", "code", "iss", "error"])
    if (params.getAll(key).length > 1)
      throw new ConsumerOAuthError("invalid_state");
  const state = params.get("state") || "";
  const authorization = await consumeAuthorization(state, {
    ...identity,
    sessionHash: consumerSessionHash(session),
  });
  if (!authorization) throw new ConsumerOAuthError("invalid_state");
  if (params.has("error")) throw new ConsumerOAuthError("authorization_denied");
  const code = params.get("code") || "";
  if (
    params.get("iss") !== CONSUMER_ISSUER ||
    !code ||
    code.length > 4096 ||
    /[\x00-\x20\x7f]/.test(code)
  )
    throw new ConsumerOAuthError("authorization_failed");
  const data = await tokenResponse(
    new URLSearchParams({
      grant_type: "authorization_code",
      client_id: authorization.clientId,
      code,
      redirect_uri: authorization.redirectUri,
      code_verifier: authorization.verifier,
      resource: CONSUMER_RESOURCE,
    }),
    fetcher,
  );
  const tokens = parseTokens(
    data,
    authorization.clientId,
    authorization.redirectUri,
  );
  if (!(await completeAuthorization(authorization, tokens)))
    throw new ConsumerOAuthError("session_changed");
}

export type ConsumerAccess = { accessToken: string; generation: string };

/**
 * Server-only access snapshot; never serialize it in a route response.
 * Capture generation with a quote, then pass it as expectedGeneration immediately
 * before dispatch/poll. Refresh preserves it; reconnect/disconnect invalidate it.
 * This admission snapshot does not lock out a subsequent owner disconnect.
 */
export async function getConsumerAccess(
  workspaceId: string,
  userId: string,
  options: { expectedGeneration?: string; fetch?: typeof fetch } = {},
): Promise<ConsumerAccess | null> {
  try {
    const access = await claimConsumerAccess({
      workspaceId,
      userId,
      expectedGeneration: options.expectedGeneration,
    });
    if (access.kind === "changed")
      throw new ConsumerOAuthError("connection_changed");
    if (access.kind === "missing") return null;
    if (access.kind === "busy") throw new ConsumerOAuthError("connection_busy");
    if (access.kind === "reconnect")
      throw new ConsumerOAuthError("reconnect_required");
    if (access.kind === "ready")
      return { accessToken: access.token, generation: access.generation };
    if (access.kind !== "refresh") throw new ConsumerOAuthError("unavailable");
    const { claim } = access;
    try {
      const data = await tokenResponse(
        new URLSearchParams({
          grant_type: "refresh_token",
          client_id: claim.tokens.clientId,
          refresh_token: claim.tokens.refreshToken!,
          resource: CONSUMER_RESOURCE,
        }),
        options.fetch ?? fetch,
      );
      const tokens = parseTokens(
        data,
        claim.tokens.clientId,
        claim.tokens.redirectUri,
        claim.tokens,
      );
      if (!(await finishConsumerRefresh(claim, tokens)))
        throw new ConsumerOAuthError("reconnect_required");
      return { accessToken: tokens.accessToken, generation: claim.generation };
    } catch {
      await finishConsumerRefresh(claim, null).catch(() => {});
      throw new ConsumerOAuthError("reconnect_required");
    }
  } catch (error) {
    if (error instanceof ConsumerOAuthError) throw error;
    throw new ConsumerOAuthError("unavailable");
  }
}

/** For read-only diagnostics without a saved job. Never use for job dispatch. */
export async function getConsumerAccessToken(
  workspaceId: string,
  userId: string,
  fetcher: typeof fetch = fetch,
): Promise<string | null> {
  const access = await getConsumerAccess(workspaceId, userId, {
    fetch: fetcher,
  });
  return access?.accessToken ?? null;
}
export const getConsumerConnection = consumerConnectionStatus;
export async function removeConsumerConnection(
  identity: ConsumerIdentity,
  fetcher: typeof fetch = fetch,
) {
  const tokens = await disconnectConsumer(identity);
  if (!tokens) return;
  try {
    await fetcher(`${CONSUMER_ISSUER}/oauth/token/revoke`, {
      method: "POST",
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(3_000),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: tokens.clientId,
        token: tokens.refreshToken || tokens.accessToken,
        token_type_hint: tokens.refreshToken ? "refresh_token" : "access_token",
      }).toString(),
    }).then((response) => {
      void response.body?.cancel().catch(() => {});
    });
  } catch {
    /* Local disconnection has already succeeded; no secret-bearing upstream errors. */
  }
}
