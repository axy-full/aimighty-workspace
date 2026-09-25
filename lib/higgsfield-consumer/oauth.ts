import { createHash, randomBytes } from "node:crypto";
import {
  claimConsumerAccess,
  completeAuthorization,
  consumeAuthorization,
  consumerConnectionStatus,
  disconnectConsumer,
  finishConsumerRefresh,
  hashConsumerSecret,
  recordConsumerSubject,
  releaseConsumerRefresh,
  storeAuthorization,
  type ConsumerIdentity,
  type ConsumerTokens,
} from "./store";

export const CONSUMER_ISSUER = "https://clerk.higgsfield.ai";
export const CONSUMER_RESOURCE = "https://mcp.higgsfield.ai/mcp";
export const CONSUMER_SCOPES = "openid email offline_access";
const TOKEN_ENDPOINT = `${CONSUMER_ISSUER}/oauth/token`;
/** The issuer's OIDC userinfo endpoint, as its discovery document names it
 * (tests/fixtures/clerk-openid-configuration.json). */
export const CONSUMER_USERINFO = `${CONSUMER_ISSUER}/oauth/userinfo`;
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
    "The account connection is not configured for this deployment.",
  invalid_state:
    "This connection attempt expired or was already used. Start again in Workspace › Engines.",
  session_changed:
    "Your browser session or workspace changed. Start the connection again in the intended workspace.",
  authorization_denied: "Account authorization was not approved.",
  authorization_failed:
    "The connected account could not complete this connection. Start again in Workspace › Engines.",
  reconnect_required:
    "Reconnect the account in Workspace › Engines before continuing.",
  connection_changed:
    "The account connection changed. Request a new quote before starting a new job; existing jobs require their original connection.",
  connection_busy:
    "The account connection is refreshing. Try again shortly.",
  unavailable:
    "The connected account is temporarily unavailable. Try again shortly.",
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
/** Back to Suites › Workspace › Engines, where the connection card reads the
 * outcome. It rides in the fragment: the shell rewrites the query to its own
 * params on load but always carries the fragment across. */
export function consumerCallbackLocation(code: "connected" | ErrorCode) {
  return `${consumerConfiguration().origin}/suites?view=workspace&tab=engines#${new URLSearchParams({ higgsfield: code })}`;
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

/** The token endpoint never answered: a network failure, our timeout, or a
 * server error / rate limit. Distinct from an answer that refuses the grant. */
class TokenEndpointUnanswered extends Error {}
async function tokenResponse(
  params: URLSearchParams,
  fetcher: typeof fetch,
): Promise<Record<string, unknown>> {
  const abort = new AbortController(),
    timer = setTimeout(() => abort.abort(), 12_000);
  let answered = false;
  try {
    let response: Response;
    try {
      response = await fetcher(TOKEN_ENDPOINT, {
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
    } catch {
      throw new TokenEndpointUnanswered();
    }
    if (response.status >= 500 || response.status === 429) {
      void response.body?.cancel().catch(() => {});
      throw new TokenEndpointUnanswered();
    }
    answered = true;
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
  } catch (error) {
    // A body cut off by our own timeout was never fully answered either.
    if (error instanceof TokenEndpointUnanswered || (answered && abort.signal.aborted))
      throw new TokenEndpointUnanswered();
    throw new ConsumerOAuthError("authorization_failed");
  } finally {
    clearTimeout(timer);
  }
}
/** Exchange flows keep one answer: anything but a usable token fails the attempt. */
async function exchangeResponse(params: URLSearchParams, fetcher: typeof fetch) {
  try {
    return await tokenResponse(params, fetcher);
  } catch (error) {
    if (error instanceof TokenEndpointUnanswered) throw new ConsumerOAuthError("authorization_failed");
    throw error;
  }
}

/** The stored form of an account's identity: a hash of the issuer and its
 * subject, never the subject itself. */
const subjectHashOf = (sub: unknown): string | null =>
  typeof sub === "string" && sub.length > 0 && sub.length <= 512 ? hashConsumerSecret(`${CONSUMER_ISSUER}\n${sub}`) : null;
/**
 * Which account a token response belongs to: a hash of the ID token's issuer
 * and subject, or null when there is no usable ID token. The token came
 * straight from the issuer's token endpoint over TLS (OIDC Core 3.1.3.7), so
 * the payload is read for its identity claims only; nothing else is trusted
 * and nothing is stored but the hash.
 */
export function consumerSubjectHash(data: Record<string, unknown>, clientId: string): string | null {
  const token = data.id_token;
  if (typeof token !== "string" || token.length > 16_384) return null;
  const parts = token.split(".");
  if (parts.length !== 3 || !/^[A-Za-z0-9_-]+$/.test(parts[1])) return null;
  try {
    const claims: unknown = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    if (!claims || typeof claims !== "object" || Array.isArray(claims)) return null;
    const { iss, sub, aud } = claims as Record<string, unknown>;
    const audiences = Array.isArray(aud) ? aud : [aud];
    if (iss !== CONSUMER_ISSUER || !audiences.includes(clientId)) return null;
    return subjectHashOf(sub);
  } catch {
    return null;
  }
}
/** One small JSON object from a response, or null: bounded, never trusted beyond its fields. */
async function smallJsonObject(response: Response, limit: number): Promise<Record<string, unknown> | null> {
  if (
    !response.ok ||
    !response.headers.get("content-type")?.toLowerCase().includes("application/json") ||
    Number(response.headers.get("content-length") || 0) > limit ||
    !response.body
  ) {
    void response.body?.cancel().catch(() => {});
    return null;
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
      if (bytes > limit) throw new Error();
      text += decoder.decode(chunk.value, { stream: true });
    }
    const data: unknown = JSON.parse(text + decoder.decode());
    return data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : null;
  } catch {
    void reader.cancel().catch(() => {});
    return null;
  } finally {
    reader.releaseLock();
  }
}
/**
 * Which account an access token belongs to, from the issuer's own userinfo
 * endpoint: a free read (OIDC Core 5.3) that returns the same public `sub` as
 * the ID token (the issuer advertises only public subjects). A hash of the
 * issuer and subject, or null when the read fails in any way.
 */
export async function consumerUserinfoSubject(accessToken: string, fetcher: typeof fetch = fetch): Promise<string | null> {
  try {
    const response = await fetcher(CONSUMER_USERINFO, {
      method: "GET",
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(8_000),
      headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
    });
    return subjectHashOf((await smallJsonObject(response, 16_384))?.sub);
  } catch {
    return null;
  }
}
/**
 * Make sure Particl knows which account the current grant belongs to, BEFORE
 * anything can replace it (a reconnect, a disconnect). Connections made before
 * subjects were recorded have none, and without it the same account signing
 * in again would get a new grant generation and strand every running job.
 * Uses the saved grant only: a refresh answer's ID token when a refresh is due,
 * otherwise the free userinfo read. Never throws; true when the subject is known.
 */
export async function backfillConsumerSubject(identity: ConsumerIdentity, fetcher: typeof fetch = fetch): Promise<boolean> {
  try {
    const status = await consumerConnectionStatus(identity);
    if (status.subjectKnown) return true;
    if (!status.connected) return false;
    const access = await getConsumerAccess(identity.workspaceId, identity.userId, { fetch: fetcher });
    if (!access) return false;
    if ((await consumerConnectionStatus(identity)).subjectKnown) return true;
    const subject = await consumerUserinfoSubject(access.accessToken, fetcher);
    if (subject) await recordConsumerSubject(identity, access.generation, subject);
    return (await consumerConnectionStatus(identity)).subjectKnown === true;
  } catch {
    return false;
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
  const data = await exchangeResponse(
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
  // Which account signed in: the ID token's subject, or — when the answer
  // carries no usable ID token — the issuer's userinfo for the new token.
  const subject =
    consumerSubjectHash(data, authorization.clientId) ??
    (await consumerUserinfoSubject(tokens.accessToken, fetcher));
  if (!(await completeAuthorization(authorization, tokens, Date.now(), subject)))
    throw new ConsumerOAuthError("session_changed");
}

export type ConsumerAccess = { accessToken: string; generation: string };

/**
 * Server-only access snapshot; never serialize it in a route response.
 * Capture generation with a quote, then pass it as expectedGeneration immediately
 * before dispatch/poll. Refresh preserves it, and so does the same account
 * signing in again; another account invalidates it.
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
      if (!(await finishConsumerRefresh(claim, tokens, Date.now(), consumerSubjectHash(data, claim.tokens.clientId))))
        throw new ConsumerOAuthError("reconnect_required");
      return { accessToken: tokens.accessToken, generation: claim.generation };
    } catch (error) {
      // No answer from the account is not a refusal: keep the grant, so jobs
      // pinned to it are not stranded, and let the next access try again.
      if (error instanceof TokenEndpointUnanswered) {
        await releaseConsumerRefresh(claim).catch(() => {});
        throw new ConsumerOAuthError("unavailable");
      }
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
  // Learn which account this grant belongs to while its tokens still exist,
  // so the same account connecting again resumes the jobs running on it.
  await backfillConsumerSubject(identity, fetcher);
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
