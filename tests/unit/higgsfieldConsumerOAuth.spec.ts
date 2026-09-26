import { test, expect } from "@playwright/test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import ts from "typescript";
import type { TenantStore } from "../../lib/tenant";

const directory = mkdtempSync(path.join(tmpdir(), "particl-consumer-oauth-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(directory, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(directory, "tenant.db")}`;
process.env.KEYRING_SECRET = "unit-test-consumer-keyring-not-a-real-secret";
process.env.APP_ORIGIN = "https://particl.example";
delete process.env.HF_CONSUMER_CLIENT_ID;
const identity = { workspaceId: "workspace", userId: "owner" };
let sequence = 0;
const fresh = () => ({ ...identity, workspaceId: `workspace-${++sequence}` });
const tokenResponse = () =>
  Response.json({
    access_token: "access-private-abc",
    refresh_token: "refresh-private-xyz",
    expires_in: 3600,
    token_type: "Bearer",
    scope: "openid email offline_access",
  });
const asFetch = (fn: (url: unknown, init?: RequestInit) => Promise<Response>) =>
  fn as typeof fetch;
async function modules() {
  return {
    oauth: await import("../../lib/higgsfield-consumer/oauth"),
    store: await import("../../lib/higgsfield-consumer/store"),
    platform: await import("../../lib/platform"),
  };
}
async function start(id = fresh(), session = "browser-session") {
  const { oauth } = await modules();
  const result = await oauth.beginConsumerAuthorization(id, session);
  const url = new URL(result.url),
    params = new URLSearchParams({
      state: url.searchParams.get("state")!,
      code: "authorization-code",
      iss: oauth.CONSUMER_ISSUER,
    });
  return { id, session, url, params };
}
async function connected(expiry = Date.now() + 3600_000) {
  const { store } = await modules(),
    flow = await start();
  const authorization = await store.consumeAuthorization(
    flow.params.get("state")!,
    { ...flow.id, sessionHash: store.hashConsumerSecret(flow.session) },
  );
  expect(authorization).toBeTruthy();
  const tokens = {
    accessToken: "old-access-private",
    refreshToken: "old-refresh-private",
    expiresAt: expiry,
    scope: "openid email offline_access",
    clientId: authorization!.clientId,
    redirectUri: authorization!.redirectUri,
  };
  expect(await store.completeAuthorization(authorization!, tokens)).toBe(true);
  return { ...flow, tokens };
}

test("own HTTPS metadata, minimal scopes and S256 state store no plaintext session or verifier", async () => {
  const { oauth, store, platform } = await modules();
  const flow = await start();
  expect(oauth.consumerClientMetadata()).toEqual({
    client_id: "https://particl.example/api/higgsfield/consumer/client",
    client_name: "Particl",
    client_uri: "https://particl.example",
    redirect_uris: ["https://particl.example/api/higgsfield/consumer/callback"],
    token_endpoint_auth_method: "none",
  });
  expect(flow.url.origin).toBe(oauth.CONSUMER_ISSUER);
  expect(flow.url.searchParams.get("scope")).toBe(
    "openid email offline_access",
  );
  expect(flow.url.searchParams.get("resource")).toBe(oauth.CONSUMER_RESOURCE);
  expect(flow.url.searchParams.get("code_challenge_method")).toBe("S256");
  const row = (
    await platform.platformDb().execute({
      sql: "SELECT * FROM higgsfield_consumer_authorizations WHERE workspace_id=?",
      args: [flow.id.workspaceId],
    })
  ).rows[0];
  expect(JSON.stringify(row)).not.toContain(flow.session);
  expect(row.state_hash).not.toBe(flow.params.get("state"));
  const authorization = await store.consumeAuthorization(
    flow.params.get("state")!,
    { ...flow.id, sessionHash: store.hashConsumerSecret(flow.session) },
  );
  expect(JSON.stringify(row)).not.toContain(authorization!.verifier);
  expect(flow.url.searchParams.get("code_challenge")).toBe(
    createHash("sha256").update(authorization!.verifier).digest("base64url"),
  );
  process.env.HF_CONSUMER_CLIENT_ID = "our-legit-preregistered-client";
  expect(oauth.consumerConfiguration().clientId).toBe(
    "our-legit-preregistered-client",
  );
  delete process.env.HF_CONSUMER_CLIENT_ID;
  process.env.APP_ORIGIN = "http://localhost:4765";
  expect(() => oauth.consumerConfiguration()).toThrow("not configured");
  process.env.APP_ORIGIN = "https://particl.example";
});

test("authorization checks exact account, workspace and browser session before consuming once", async () => {
  const { store } = await modules(),
    flow = await start(),
    state = flow.params.get("state")!;
  const bound = {
    ...flow.id,
    sessionHash: store.hashConsumerSecret(flow.session),
  };
  expect(
    await store.consumeAuthorization(state, { ...bound, userId: "another" }),
  ).toBeNull();
  expect(
    await store.consumeAuthorization(state, {
      ...bound,
      workspaceId: "another",
    }),
  ).toBeNull();
  expect(
    await store.consumeAuthorization(state, {
      ...bound,
      sessionHash: store.hashConsumerSecret("new-session"),
    }),
  ).toBeNull();
  const values = await Promise.all([
    store.consumeAuthorization(state, bound),
    store.consumeAuthorization(state, bound),
  ]);
  expect(values.filter(Boolean)).toHaveLength(1);
  expect(await store.consumeAuthorization(state, bound)).toBeNull();
});

test("expired, superseded and disconnected authorization states cannot exchange", async () => {
  const { store, oauth } = await modules(),
    flow = await start(),
    bound = { ...flow.id, sessionHash: store.hashConsumerSecret(flow.session) };
  expect(
    await store.consumeAuthorization(
      flow.params.get("state")!,
      bound,
      Date.now() + store.AUTHORIZATION_TTL + 1,
    ),
  ).toBeNull();
  const first = await start(flow.id),
    second = await start(flow.id);
  expect(
    await store.consumeAuthorization(first.params.get("state")!, bound),
  ).toBeNull();
  await store.disconnectConsumer(flow.id);
  let calls = 0;
  await expect(
    oauth.finishConsumerAuthorization(
      second.id,
      second.session,
      second.params,
      asFetch(async () => {
        calls++;
        return tokenResponse();
      }),
    ),
  ).rejects.toMatchObject({ code: "invalid_state" });
  expect(calls).toBe(0);
});

test("callback exchanges captured client and redirect exactly once; stores encrypted tokens and safe status", async () => {
  const { oauth, platform } = await modules(),
    flow = await start();
  let calls = 0,
    userinfo = 0;
  const fetcher = asFetch(async (url, init) => {
    // The exchange names no ID token, so the new token's account is read once
    // from the issuer's userinfo (free) to record which account signed in.
    if (url === oauth.CONSUMER_USERINFO) {
      userinfo++;
      expect(init?.headers).toMatchObject({ Authorization: "Bearer access-private-abc" });
      return Response.json({ sub: "user_fixture", email: "private@example.com" });
    }
    calls++;
    expect(url).toBe("https://clerk.higgsfield.ai/oauth/token");
    expect(init?.redirect).toBe("error");
    expect(init?.headers).toMatchObject({
      "Content-Type": "application/x-www-form-urlencoded",
    });
    const form = new URLSearchParams(String(init?.body));
    expect(form.get("client_id")).toBe(flow.url.searchParams.get("client_id"));
    expect(form.get("redirect_uri")).toBe(
      flow.url.searchParams.get("redirect_uri"),
    );
    expect(form.get("resource")).toBe(oauth.CONSUMER_RESOURCE);
    expect(form.has("client_secret")).toBe(false);
    return tokenResponse();
  });
  process.env.HF_CONSUMER_CLIENT_ID = "different-client-after-start";
  await oauth.finishConsumerAuthorization(
    flow.id,
    flow.session,
    flow.params,
    fetcher,
  );
  delete process.env.HF_CONSUMER_CLIENT_ID;
  await expect(
    oauth.finishConsumerAuthorization(
      flow.id,
      flow.session,
      flow.params,
      fetcher,
    ),
  ).rejects.toMatchObject({ code: "invalid_state" });
  expect(calls).toBe(1);
  expect(userinfo).toBe(1);
  const row = (
    await platform.platformDb().execute({
      sql: "SELECT * FROM higgsfield_consumer_connections WHERE workspace_id=?",
      args: [flow.id.workspaceId],
    })
  ).rows[0];
  expect(JSON.stringify(row)).not.toContain("access-private");
  expect(JSON.stringify(row)).not.toContain("refresh-private");
  // Only a hash of the account is kept: never its subject or email.
  expect(JSON.stringify(row)).not.toContain("user_fixture");
  expect(JSON.stringify(row)).not.toContain("private@example.com");
  const status = await oauth.getConsumerConnection(flow.id);
  expect(status).toMatchObject({ connected: true, requiresReconnect: false, subjectKnown: true });
  expect(Object.keys(status).sort()).toEqual([
    "connected",
    "connectedAt",
    "expiresAt",
    "requiresReconnect",
    "subjectKnown",
  ]);
  expect(
    await oauth.getConsumerAccessToken(
      flow.id.workspaceId,
      flow.id.userId,
      fetcher,
    ),
  ).toBe("access-private-abc");
  expect(
    await oauth.getConsumerAccessToken("wrong", flow.id.userId, fetcher),
  ).toBeNull();
  expect(calls).toBe(1);
});

test("wrong issuer and ambiguous token response fail closed, redact upstream errors and never repeat exchange", async () => {
  const { oauth } = await modules(),
    wrong = await start();
  let calls = 0;
  const fetcher = asFetch(async () => {
    calls++;
    throw new Error("secret upstream token leaked");
  });
  wrong.params.set("iss", "https://untrusted.example");
  await expect(
    oauth.finishConsumerAuthorization(
      wrong.id,
      wrong.session,
      wrong.params,
      fetcher,
    ),
  ).rejects.toMatchObject({ code: "authorization_failed" });
  expect(calls).toBe(0);
  const flow = await start();
  const error = await oauth
    .finishConsumerAuthorization(flow.id, flow.session, flow.params, fetcher)
    .catch((error) => error);
  expect(error.message).not.toContain("secret");
  expect(error.cause).toBeUndefined();
  await expect(
    oauth.finishConsumerAuthorization(
      flow.id,
      flow.session,
      flow.params,
      fetcher,
    ),
  ).rejects.toMatchObject({ code: "invalid_state" });
  expect(calls).toBe(1);
  expect(await oauth.getConsumerConnection(flow.id)).toMatchObject({
    connected: false,
  });
});

test("disconnect during code exchange prevents a late callback from restoring the connection", async () => {
  const { oauth, store } = await modules(),
    flow = await start();
  let respond!: (response: Response) => void, called!: () => void;
  const entered = new Promise<void>((resolve) => (called = resolve));
  const pending = oauth.finishConsumerAuthorization(
    flow.id,
    flow.session,
    flow.params,
    asFetch(async (url) => {
      if (url === oauth.CONSUMER_USERINFO) return new Response(null, { status: 401 });
      called();
      return new Promise((resolve) => (respond = resolve));
    }),
  );
  await entered;
  await store.disconnectConsumer(flow.id);
  respond(tokenResponse());
  await expect(pending).rejects.toMatchObject({ code: "session_changed" });
  expect(await oauth.getConsumerConnection(flow.id)).toMatchObject({
    connected: false,
  });
});

test("concurrent refresh claims rotate once; later readers use the committed token without another refresh", async () => {
  const { oauth } = await modules(),
    flow = await connected(Date.now() + 1000);
  let respond!: (response: Response) => void,
    called!: () => void,
    calls = 0;
  const entered = new Promise<void>((resolve) => (called = resolve));
  const fetcher = asFetch(async (_url, init) => {
    calls++;
    const form = new URLSearchParams(String(init?.body));
    expect(form.get("refresh_token")).toBe(flow.tokens.refreshToken);
    called();
    return new Promise((resolve) => (respond = resolve));
  });
  const first = oauth.getConsumerAccessToken(
    flow.id.workspaceId,
    flow.id.userId,
    fetcher,
  );
  await entered;
  await expect(
    oauth.getConsumerAccessToken(flow.id.workspaceId, flow.id.userId, fetcher),
  ).rejects.toMatchObject({ code: "connection_busy" });
  respond(tokenResponse());
  expect(await first).toBe("access-private-abc");
  expect(
    await oauth.getConsumerAccessToken(
      flow.id.workspaceId,
      flow.id.userId,
      fetcher,
    ),
  ).toBe("access-private-abc");
  expect(calls).toBe(1);
});

test("access snapshots bind token and generation to the exact owner and workspace", async () => {
  const { oauth, platform } = await modules(),
    flow = await connected();
  let calls = 0;
  const fetcher = asFetch(async () => {
    calls++;
    throw new Error("Unexpected refresh");
  });
  const access = await oauth.getConsumerAccess(
    flow.id.workspaceId,
    flow.id.userId,
    { fetch: fetcher },
  );
  const row = (
    await platform.platformDb().execute({
      sql: "SELECT generation FROM higgsfield_consumer_connections WHERE workspace_id=? AND user_id=?",
      args: [flow.id.workspaceId, flow.id.userId],
    })
  ).rows[0];
  expect(access).toEqual({
    accessToken: flow.tokens.accessToken,
    generation: row.generation,
  });
  expect(
    await oauth.getConsumerAccess(flow.id.workspaceId, flow.id.userId, {
      expectedGeneration: access!.generation,
      fetch: fetcher,
    }),
  ).toEqual(access);
  for (const id of [
    { ...flow.id, userId: "another-owner" },
    { ...flow.id, workspaceId: "another-workspace" },
  ]) {
    await expect(
      oauth.getConsumerAccess(id.workspaceId, id.userId, {
        expectedGeneration: access!.generation,
        fetch: fetcher,
      }),
    ).rejects.toMatchObject({ code: "connection_changed", status: 409 });
  }
  expect(
    await oauth.getConsumerAccess("unknown", "owner", { fetch: fetcher }),
  ).toBeNull();
  expect(await oauth.getConsumerConnection(flow.id)).not.toHaveProperty(
    "generation",
  );
  expect(calls).toBe(0);
});

test("a completed reconnect invalidates old quote generations before a replacement token can refresh", async () => {
  const { oauth, store, platform } = await modules(),
    flow = await connected();
  const old = await oauth.getConsumerAccess(
    flow.id.workspaceId,
    flow.id.userId,
  );
  const replacement = await start(flow.id);
  // Starting consent does not silently replace a still-valid account.
  expect(
    await oauth.getConsumerAccess(flow.id.workspaceId, flow.id.userId, {
      expectedGeneration: old!.generation,
    }),
  ).toEqual(old);
  const authorization = await store.consumeAuthorization(
    replacement.params.get("state")!,
    {
      ...flow.id,
      sessionHash: store.hashConsumerSecret(replacement.session),
    },
  );
  expect(
    await store.completeAuthorization(authorization!, {
      ...flow.tokens,
      accessToken: "replacement-account-private",
      expiresAt: Date.now() + 1000,
    }),
  ).toBe(true);
  const snapshot = async () =>
    (
      await platform.platformDb().execute({
        sql: "SELECT generation,status,tokens_enc,refresh_lease,updated_at FROM higgsfield_consumer_connections WHERE workspace_id=? AND user_id=?",
        args: [flow.id.workspaceId, flow.id.userId],
      })
    ).rows[0];
  const before = await snapshot();
  expect(before.generation).not.toBe(old!.generation);
  let calls = 0;
  const fetcher = asFetch(async () => {
    calls++;
    return tokenResponse();
  });
  for (const generation of [old!.generation, ""]) {
    const error = await oauth
      .getConsumerAccess(flow.id.workspaceId, flow.id.userId, {
        expectedGeneration: generation,
        fetch: fetcher,
      })
      .catch((error) => error);
    expect(error).toMatchObject({ code: "connection_changed", status: 409 });
    expect(error.message).not.toContain("private");
    expect(error.message).not.toContain(old!.generation);
  }
  expect(calls).toBe(0);
  expect(await snapshot()).toEqual(before);
  expect(
    await oauth.getConsumerAccess(flow.id.workspaceId, flow.id.userId, {
      expectedGeneration: String(before.generation),
      fetch: fetcher,
    }),
  ).toEqual({
    accessToken: "access-private-abc",
    generation: before.generation,
  });
  expect(calls).toBe(1);
});

test("the same account signing in again keeps its jobs' grant; another account, or one whose identity is unknown, does not", async () => {
  const { oauth, store } = await modules(),
    id = fresh(),
    clientId = oauth.consumerConfiguration().clientId;
  const idToken = (sub: string, claims: Record<string, unknown> = {}) =>
    ["e30", Buffer.from(JSON.stringify({ iss: oauth.CONSUMER_ISSUER, sub, aud: clientId, ...claims })).toString("base64url"), "signature"].join(".");
  const signIn = async (token?: string) => {
    const flow = await start(id);
    await oauth.finishConsumerAuthorization(id, flow.session, flow.params, asFetch(async () =>
      Response.json({ access_token: "access-private-abc", refresh_token: "refresh-private-xyz", expires_in: 3600, token_type: "Bearer", ...(token ? { id_token: token } : {}) })));
    return (await oauth.getConsumerAccess(id.workspaceId, id.userId))!.generation;
  };
  const first = await signIn(idToken("user_a"));
  // Reconnect (after a refused refresh, or from the Reconnect button) with the same account.
  expect(await signIn(idToken("user_a"))).toBe(first);
  // Disconnect, then the same account again: its running jobs resume.
  await store.disconnectConsumer(id);
  expect(await oauth.getConsumerAccess(id.workspaceId, id.userId, { expectedGeneration: first })).toBeNull();
  expect(await signIn(idToken("user_a"))).toBe(first);
  // Another account can never read or spend under the first one's jobs.
  const other = await signIn(idToken("user_b"));
  expect(other).not.toBe(first);
  await expect(oauth.getConsumerAccess(id.workspaceId, id.userId, { expectedGeneration: first })).rejects.toMatchObject({ code: "connection_changed" });
  // No usable identity claim: the old behaviour, a new grant every time.
  const unknown = await signIn();
  expect(unknown).not.toBe(other);
  expect(await signIn()).not.toBe(unknown);
  // Only the issuer's own claims about this client identify an account; the hash is all that is kept.
  expect(oauth.consumerSubjectHash({ id_token: idToken("user_a") }, clientId)).toMatch(/^[a-f0-9]{64}$/);
  expect(oauth.consumerSubjectHash({ id_token: idToken("user_a", { aud: [clientId, "other"] }) }, clientId)).toMatch(/^[a-f0-9]{64}$/);
  for (const token of [idToken("user_a", { iss: "https://issuer.example" }), idToken("user_a", { aud: "another-client" }), idToken(""), "not-a-token", 42])
    expect(oauth.consumerSubjectHash({ id_token: token }, clientId)).toBeNull();
});

test("a connection that never recorded its account learns it from its saved grant before a reconnect or disconnect, so the same account keeps its running jobs", async () => {
  const { oauth, store } = await modules(),
    clientId = oauth.consumerConfiguration().clientId;
  const idToken = (sub: string) =>
    ["e30", Buffer.from(JSON.stringify({ iss: oauth.CONSUMER_ISSUER, sub, aud: clientId })).toString("base64url"), "signature"].join(".");
  const reads: string[] = [];
  /** userinfo answers `sub` for the saved token; a refresh answers `refresh`. */
  const account = (sub: string | null, refresh?: Record<string, unknown>) =>
    asFetch(async (url, init) => {
      if (url === oauth.CONSUMER_USERINFO) {
        reads.push(String((init?.headers as Record<string, string>).Authorization));
        return sub ? Response.json({ sub }) : new Response(null, { status: 401 });
      }
      if (url === "https://clerk.higgsfield.ai/oauth/token/revoke") return new Response(null, { status: 200 });
      return Response.json({ access_token: "access-private-abc", refresh_token: "refresh-private-xyz", expires_in: 3600, token_type: "Bearer", ...refresh });
    });
  const generation = async (id: { workspaceId: string; userId: string }) => {
    const access = await store.claimConsumerAccess(id);
    if (access.kind !== "ready") throw new Error(`Fixture access ${access.kind}`);
    return access.generation;
  };
  const signIn = async (id: { workspaceId: string; userId: string }, token: string | null, sub: string | null = null) => {
    const flow = await start(id);
    await oauth.finishConsumerAuthorization(id, flow.session, flow.params, account(sub, token ? { id_token: token } : {}));
    return generation(id);
  };

  // Connected before subjects were kept: unknown, until the free userinfo read with the SAVED token.
  const legacy = await connected();
  const before = await generation(legacy.id);
  expect(await oauth.getConsumerConnection(legacy.id)).toMatchObject({ connected: true, subjectKnown: false });
  expect(await oauth.backfillConsumerSubject(legacy.id, account("user_a"))).toBe(true);
  expect(reads.at(-1)).toBe("Bearer old-access-private");
  expect(await oauth.getConsumerConnection(legacy.id)).toMatchObject({ subjectKnown: true });
  // Known subjects are never re-read or replaced.
  expect(await oauth.backfillConsumerSubject(legacy.id, account("user_b"))).toBe(true);
  expect(reads).toHaveLength(1);
  // Reconnecting with the same account keeps the grant its jobs are pinned to.
  expect(await signIn(legacy.id, idToken("user_a"))).toBe(before);

  // The userinfo read refused: still unknown (the page warns), and nothing is thrown.
  const refused = await connected();
  const refusedBefore = await generation(refused.id);
  expect(await oauth.backfillConsumerSubject(refused.id, account(null))).toBe(false);
  expect(await oauth.getConsumerConnection(refused.id)).toMatchObject({ subjectKnown: false });
  expect(await signIn(refused.id, idToken("user_a"))).not.toBe(refusedBefore);

  // A due refresh whose answer names the account fills it in, and never replaces a known one.
  const refreshing = await connected(Date.now() + 1000);
  const refreshingBefore = (await store.claimConsumerAccess(refreshing.id, Date.now() - 120_000)) as { generation: string };
  expect(await oauth.backfillConsumerSubject(refreshing.id, account(null, { id_token: idToken("user_c") }))).toBe(true);
  expect(reads).toHaveLength(2);
  expect(await signIn(refreshing.id, idToken("user_c"))).toBe(refreshingBefore.generation);

  // Disconnect learns the account while the grant still exists; the same account connecting again resumes.
  const leaving = await connected();
  const leavingBefore = await generation(leaving.id);
  await oauth.removeConsumerConnection(leaving.id, account("user_d"));
  expect(await oauth.getConsumerConnection(leaving.id)).toMatchObject({ connected: false, subjectKnown: true });
  expect(await oauth.backfillConsumerSubject(leaving.id, account("user_x"))).toBe(true);
  // A sign-in whose answer carries no ID token is identified by userinfo for the NEW token.
  expect(await signIn(leaving.id, null, "user_d")).toBe(leavingBefore);
  expect(reads.at(-1)).toBe("Bearer access-private-abc");
  // Another account still never inherits the jobs.
  expect(await signIn(leaving.id, null, "user_e")).not.toBe(leavingBefore);
});

test("the issuer's recorded discovery document pins the identity assumptions: exact issuer, public subjects, userinfo endpoint", async () => {
  const { oauth } = await modules();
  // Recorded 25 September 2026 from https://clerk.higgsfield.ai/.well-known/openid-configuration
  // (an unauthenticated, read-only public GET; no sign-in or token was involved).
  const discovery = JSON.parse(readFileSync("tests/fixtures/clerk-openid-configuration.json", "utf8")) as Record<string, unknown>;
  // OIDC Core §2: an ID token's iss equals the issuer exactly, and its aud contains our client id.
  expect(discovery.issuer).toBe(oauth.CONSUMER_ISSUER);
  expect(discovery.token_endpoint).toBe(`${oauth.CONSUMER_ISSUER}/oauth/token`);
  expect(discovery.userinfo_endpoint).toBe(oauth.CONSUMER_USERINFO);
  expect(discovery.subject_types_supported).toEqual(["public"]);
  expect(discovery.claims_supported).toEqual(expect.arrayContaining(["iss", "sub", "aud"]));
  expect(discovery.scopes_supported).toEqual(expect.arrayContaining(oauth.CONSUMER_SCOPES.split(" ")));
  expect(discovery.authorization_response_iss_parameter_supported).toBe(true);
  const clientId = oauth.consumerConfiguration().clientId;
  const claims = (overrides: Record<string, unknown>) => ({
    id_token: ["e30", Buffer.from(JSON.stringify({ iss: discovery.issuer, sub: "user_2abc", aud: clientId, iat: 1, exp: 2, ...overrides })).toString("base64url"), "sig"].join("."),
  });
  // An ID token shaped as the document describes identifies the account, and
  // hashes to the same value as a userinfo read of the same public subject.
  const fromToken = oauth.consumerSubjectHash(claims({}), clientId);
  const fromUserinfo = await oauth.consumerUserinfoSubject("fixture", asFetch(async () => Response.json({ sub: "user_2abc" })));
  expect(fromToken).toMatch(/^[a-f0-9]{64}$/);
  expect(fromUserinfo).toBe(fromToken);
  expect(oauth.consumerSubjectHash(claims({ iss: `${discovery.issuer}/` }), clientId)).toBeNull();
  // A userinfo reply that is not a small JSON object with a subject names no account.
  for (const reply of [new Response("nope", { status: 200 }), Response.json({ email: "x@example.com" }), Response.json({ sub: "" }), new Response(null, { status: 500 })])
    expect(await oauth.consumerUserinfoSubject("fixture", asFetch(async () => reply))).toBeNull();
});

test("routine refresh preserves the quote generation and excludes competing refresh claims", async () => {
  const { oauth, store } = await modules(),
    flow = await connected(Date.now() + 1000);
  const snapshot = await store.claimConsumerAccess(
    flow.id,
    Date.now() - 120_000,
  );
  expect(snapshot.kind).toBe("ready");
  if (snapshot.kind !== "ready") throw new Error("Fixture access unavailable");
  let respond!: (response: Response) => void,
    entered!: () => void,
    calls = 0;
  const started = new Promise<void>((resolve) => (entered = resolve));
  const fetcher = asFetch(async () => {
    calls++;
    entered();
    return new Promise((resolve) => (respond = resolve));
  });
  const pending = oauth.getConsumerAccess(flow.id.workspaceId, flow.id.userId, {
    expectedGeneration: snapshot.generation,
    fetch: fetcher,
  });
  await started;
  await expect(
    oauth.getConsumerAccess(flow.id.workspaceId, flow.id.userId, {
      expectedGeneration: snapshot.generation,
      fetch: fetcher,
    }),
  ).rejects.toMatchObject({ code: "connection_busy" });
  respond(tokenResponse());
  const refreshed = {
    accessToken: "access-private-abc",
    generation: snapshot.generation,
  };
  expect(await pending).toEqual(refreshed);
  expect(
    await oauth.getConsumerAccess(flow.id.workspaceId, flow.id.userId, {
      expectedGeneration: snapshot.generation,
      fetch: fetcher,
    }),
  ).toEqual(refreshed);
  expect(calls).toBe(1);
});

test("disconnect and reconnect during refresh reject the old result without clearing a replacement grant", async () => {
  const { oauth, store } = await modules();
  for (const reconnect of [false, true]) {
    const flow = await connected(Date.now() + 1000);
    const snapshot = await store.claimConsumerAccess(
      flow.id,
      Date.now() - 120_000,
    );
    if (snapshot.kind !== "ready")
      throw new Error("Fixture access unavailable");
    let respond!: (response: Response) => void,
      entered!: () => void,
      calls = 0;
    const started = new Promise<void>((resolve) => (entered = resolve));
    const fetcher = asFetch(async () => {
      calls++;
      entered();
      return new Promise((resolve) => (respond = resolve));
    });
    const pending = oauth.getConsumerAccess(
      flow.id.workspaceId,
      flow.id.userId,
      {
        expectedGeneration: snapshot.generation,
        fetch: fetcher,
      },
    );
    await started;
    if (reconnect) {
      const replacement = await start(flow.id);
      const authorization = await store.consumeAuthorization(
        replacement.params.get("state")!,
        {
          ...flow.id,
          sessionHash: store.hashConsumerSecret(replacement.session),
        },
      );
      expect(
        await store.completeAuthorization(authorization!, {
          ...flow.tokens,
          accessToken: "new-account-private",
          expiresAt: Date.now() + 3600_000,
        }),
      ).toBe(true);
    } else await store.disconnectConsumer(flow.id);
    respond(tokenResponse());
    await expect(pending).rejects.toMatchObject({ code: "reconnect_required" });
    // Another account's sign-in replaces the grant; a disconnect keeps the
    // generation for the same account to resume, but nothing reads meanwhile.
    if (reconnect)
      await expect(
        oauth.getConsumerAccess(flow.id.workspaceId, flow.id.userId, {
          expectedGeneration: snapshot.generation,
          fetch: fetcher,
        }),
      ).rejects.toMatchObject({ code: "connection_changed" });
    else
      expect(
        await oauth.getConsumerAccess(flow.id.workspaceId, flow.id.userId, {
          expectedGeneration: snapshot.generation,
          fetch: fetcher,
        }),
      ).toBeNull();
    const current = await oauth.getConsumerAccess(
      flow.id.workspaceId,
      flow.id.userId,
      { fetch: fetcher },
    );
    if (reconnect) {
      expect(current?.accessToken).toBe("new-account-private");
      expect(current?.generation).not.toBe(snapshot.generation);
      expect(
        await oauth.getConsumerAccess(flow.id.workspaceId, flow.id.userId, {
          expectedGeneration: current!.generation,
          fetch: fetcher,
        }),
      ).toEqual(current);
    } else expect(current).toBeNull();
    expect(calls).toBe(1);
  }
});

test("an unanswered refresh keeps the grant and retries; a refused or malformed one requires reconnect without replay", async () => {
  const { oauth, store } = await modules();
  // No answer (network failure, 5xx, rate limit): the grant and its jobs'
  // generation are kept, the lease is released, and the next access retries
  // with the saved refresh token.
  for (const unanswered of [
    () => Promise.reject(new Error("secret lost acknowledgement")),
    () => Promise.resolve(new Response("upstream private detail", { status: 503 })),
    () => Promise.resolve(new Response("slow down", { status: 429 })),
  ]) {
    const flow = await connected(Date.now() + 1000);
    const before = await store.claimConsumerAccess(flow.id, Date.now() - 120_000);
    if (before.kind !== "ready") throw new Error("Fixture access unavailable");
    const bodies: string[] = [];
    let calls = 0;
    const fetcher = asFetch(async (_url, init) => {
      bodies.push(String(init?.body));
      return ++calls === 1 ? unanswered() : tokenResponse();
    });
    const error = await oauth
      .getConsumerAccess(flow.id.workspaceId, flow.id.userId, { expectedGeneration: before.generation, fetch: fetcher })
      .catch((caught) => caught);
    expect(error).toMatchObject({ code: "unavailable", status: 503 });
    expect(error.message).not.toContain("private");
    expect(await oauth.getConsumerConnection(flow.id)).toMatchObject({ connected: true, requiresReconnect: false });
    expect(
      await oauth.getConsumerAccess(flow.id.workspaceId, flow.id.userId, { expectedGeneration: before.generation, fetch: fetcher }),
    ).toEqual({ accessToken: "access-private-abc", generation: before.generation });
    expect(calls).toBe(2);
    for (const body of bodies) expect(new URLSearchParams(body).get("refresh_token")).toBe(flow.tokens.refreshToken);
  }
  // An answer that refuses the grant, or one that is malformed, ends it once.
  for (const response of [
    () => Response.json({ error: "invalid_grant" }, { status: 400 }),
    () =>
      Response.json({
        access_token: "new-token",
        expires_in: 3600,
        token_type: "Bearer",
        refresh_token: "",
      }),
  ]) {
    const flow = await connected(Date.now() + 1000);
    let calls = 0;
    const fetcher = asFetch(async () => {
      calls++;
      return response();
    });
    await expect(
      oauth.getConsumerAccessToken(
        flow.id.workspaceId,
        flow.id.userId,
        fetcher,
      ),
    ).rejects.toMatchObject({ code: "reconnect_required" });
    await expect(
      oauth.getConsumerAccessToken(
        flow.id.workspaceId,
        flow.id.userId,
        fetcher,
      ),
    ).rejects.toMatchObject({ code: "reconnect_required" });
    expect(calls).toBe(1);
    expect(await oauth.getConsumerConnection(flow.id)).toMatchObject({
      connected: false,
      requiresReconnect: true,
    });
  }
});

test("a validated refresh may retain an omitted refresh token and its original scope", async () => {
  const { oauth, store } = await modules(),
    flow = await connected(Date.now() + 1000);
  expect(
    await oauth.getConsumerAccessToken(
      flow.id.workspaceId,
      flow.id.userId,
      asFetch(async () =>
        Response.json({
          access_token: "refreshed-access",
          expires_in: 3600,
          token_type: "Bearer",
        }),
      ),
    ),
  ).toBe("refreshed-access");
  const access = await store.claimConsumerAccess(
    flow.id,
    Date.now() + 3600_000,
  );
  expect(access.kind).toBe("refresh");
  if (access.kind === "refresh") {
    expect(access.claim.tokens.refreshToken).toBe(flow.tokens.refreshToken);
    expect(access.claim.tokens.scope).toBe(flow.tokens.scope);
  }
});

test("an expired refresh lease is taken over with the saved grant, its late holder cannot finish, and disconnect cannot be undone by late rotation", async () => {
  const { store, oauth } = await modules(),
    flow = await connected(Date.now() + 1000);
  const access = await store.claimConsumerAccess(flow.id);
  expect(access.kind).toBe("refresh");
  // The holder died mid-refresh: the next access retries with the saved
  // refresh token under a new lease instead of discarding the grant.
  const takeover = await store.claimConsumerAccess(
    flow.id,
    Date.now() + store.REFRESH_LEASE_TTL + 1,
  );
  expect(takeover.kind).toBe("refresh");
  if (takeover.kind === "refresh" && access.kind === "refresh") {
    expect(takeover.claim.lease).not.toBe(access.claim.lease);
    expect(takeover.claim.generation).toBe(access.claim.generation);
    expect(takeover.claim.tokens.refreshToken).toBe(flow.tokens.refreshToken);
  }
  expect(await oauth.getConsumerConnection(flow.id)).toMatchObject({
    connected: true,
    requiresReconnect: false,
  });
  if (access.kind === "refresh")
    expect(
      await store.finishConsumerRefresh(access.claim, {
        ...flow.tokens,
        accessToken: "late",
      }),
    ).toBe(false);
  const another = await connected(Date.now() + 1000);
  let respond!: (response: Response) => void, called!: () => void;
  const entered = new Promise<void>((resolve) => (called = resolve));
  const pending = oauth.getConsumerAccessToken(
    another.id.workspaceId,
    another.id.userId,
    asFetch(async () => {
      called();
      return new Promise((resolve) => (respond = resolve));
    }),
  );
  await entered;
  await store.disconnectConsumer(another.id);
  respond(tokenResponse());
  await expect(pending).rejects.toMatchObject({ code: "reconnect_required" });
  expect(await oauth.getConsumerConnection(another.id)).toMatchObject({
    connected: false,
    requiresReconnect: false,
  });
});

test("oversized token body is cancelled and ciphertext swapped across accounts cannot authorize", async () => {
  const { oauth, platform } = await modules(),
    flow = await start();
  let cancelled = false;
  const oversized = asFetch(
    async () =>
      new Response(
        new ReadableStream({
          pull(controller) {
            controller.enqueue(new Uint8Array(33_000));
          },
          cancel() {
            cancelled = true;
          },
        }),
        { headers: { "Content-Type": "application/json" } },
      ),
  );
  await expect(
    oauth.finishConsumerAuthorization(
      flow.id,
      flow.session,
      flow.params,
      oversized,
    ),
  ).rejects.toMatchObject({ code: "authorization_failed" });
  expect(cancelled).toBe(true);
  const first = await connected(),
    second = await connected();
  const ciphertext = (
    await platform.platformDb().execute({
      sql: "SELECT tokens_enc FROM higgsfield_consumer_connections WHERE workspace_id=?",
      args: [first.id.workspaceId],
    })
  ).rows[0].tokens_enc;
  await platform.platformDb().execute({
    sql: "UPDATE higgsfield_consumer_connections SET tokens_enc=? WHERE workspace_id=?",
    args: [ciphertext, second.id.workspaceId],
  });
  await expect(
    oauth.getConsumerAccessToken(second.id.workspaceId, second.id.userId),
  ).rejects.toMatchObject({ code: "reconnect_required" });
});

test("disconnect succeeds even when upstream revoke fails and exposes no token in its error", async () => {
  const { oauth } = await modules(),
    flow = await connected();
  const urls: string[] = [];
  await oauth.removeConsumerConnection(
    flow.id,
    asFetch(async (url, init) => {
      urls.push(String(url));
      if (url === oauth.CONSUMER_USERINFO) throw new Error("private failed userinfo");
      expect(url).toBe("https://clerk.higgsfield.ai/oauth/token/revoke");
      expect(new URLSearchParams(String(init?.body)).get("token")).toBe(
        flow.tokens.refreshToken,
      );
      throw new Error("private failed revoke");
    }),
  );
  // The account is looked up (while the grant still exists) before revoking;
  // neither failure stops the disconnect.
  expect(urls).toEqual([oauth.CONSUMER_USERINFO, "https://clerk.higgsfield.ai/oauth/token/revoke"]);
  expect(await oauth.getConsumerConnection(flow.id)).toEqual({
    connected: false,
    requiresReconnect: false,
    subjectKnown: false,
  });
});

async function routeFixture() {
  const auth = await import("../../lib/auth"),
    tenant = await import("../../lib/tenant"),
    scope = await import("../../lib/workbench/request-scope");
  const account = await import("../../lib/accountDb"),
    media = await import("../../lib/mediaBindings");
  let store = {
    workspace: { id: "ws", deletedAt: null },
    user: { id: "owner", role: "admin", owner: true },
  } as TenantStore;
  const source = ts.createSourceFile(
    "auth.ts",
    readFileSync("lib/auth.ts", "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const declaration = source.statements.find(
    (statement) =>
      ts.isFunctionDeclaration(statement) &&
      statement.name?.text === "withTenant",
  )!;
  const exports = {} as Pick<typeof auth, "withTenant">;
  new Function(
    "exports",
    "resolveStore",
    "runWithStore",
    "NoTenantError",
    "MediaSourceError",
    "workbenchScopeFor",
    "recoveryRoute",
    ts.transpileModule(declaration.getText(source), {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
    }).outputText,
  )(
    exports,
    async () => store,
    tenant.runWithStore,
    tenant.NoTenantError,
    media.MediaSourceError,
    scope.workbenchScopeFor,
    (handler: unknown) => handler,
  );
  let starts = 0,
    disconnects = 0,
    backfills = 0,
    limit = false,
    connection: Record<string, unknown> = { connected: false, requiresReconnect: false };
  const held = "33333333-3333-4333-8333-333333333333",
    asides: { userId: string; id: string }[] = [],
    limits: string[] = [];
  const dependencies: Record<string, unknown> = {
    "next/headers": {
      cookies: async () => ({ get: () => ({ value: "session" }) }),
    },
    "@/lib/auth": { ...auth, withTenant: exports.withTenant },
    "@/lib/tenant": tenant,
    "@/lib/workbench/request-scope": scope,
    "@/lib/accountDb": {
      AccountError: account.AccountError,
      takeAccountLimit: async (key: string, count: number, window: number) => {
        limits.push(key);
        if (key.startsWith("higgsfield-consumer-connect:")) {
          expect(count).toBe(5);
          expect(window).toBe(300_000);
        }
        if (limit) throw new account.AccountError("Too many requests.", 429);
      },
    },
    "@/lib/higgsfield-consumer/jobs": {
      consumerCapacity: async (userId: string) => ({ limit: 4, active: 1, mine: [{ id: held, userId }] }),
      setAsideConsumerJob: async (input: { userId: string; id: string }) => {
        asides.push(input);
        return input.id === held;
      },
    },
    "@/lib/higgsfield-consumer/developer-api": {
      probeDeveloperApi: async () => ({ reachable: false, status: null, reason: "stub" }),
    },
    "@/lib/higgsfield-consumer/oauth": {
      ...(await modules()).oauth,
      beginConsumerAuthorization: async () => {
        starts++;
        return { url: "https://clerk.higgsfield.ai/oauth/authorize" };
      },
      backfillConsumerSubject: async () => {
        backfills++;
        if (connection.connected) connection = { ...connection, subjectKnown: true };
        return connection.subjectKnown === true;
      },
      getConsumerConnection: async () => connection,
      removeConsumerConnection: async () => {
        disconnects++;
      },
    },
  };
  const routes: Record<
    string,
    Record<string, (request: Request, ctx?: unknown) => Promise<Response>>
  > = {};
  for (const name of ["connect", "connection"]) {
    const loaded = { exports: {} };
    new Function(
      "require",
      "module",
      "exports",
      ts.transpileModule(
        readFileSync(`app/api/higgsfield/consumer/${name}/route.ts`, "utf8"),
        {
          compilerOptions: {
            module: ts.ModuleKind.CommonJS,
            target: ts.ScriptTarget.ES2022,
          },
        },
      ).outputText,
    )(
      (id: string) => {
        if (!(id in dependencies)) throw new Error(id);
        return dependencies[id];
      },
      loaded,
      loaded.exports,
    );
    routes[name] = loaded.exports;
  }
  return {
    set: (value: TenantStore) => (store = value),
    original: () => store,
    counts: () => ({ starts, disconnects }),
    backfills: () => backfills,
    connect: (value: Record<string, unknown>) => {
      connection = value;
    },
    held,
    asides,
    limits,
    limit: () => {
      limit = true;
    },
    request: (
      route: string,
      method: string,
      captured?: string,
      origin?: string,
      body?: unknown,
    ) =>
      routes[route][method](
        new Request(
          `https://particl.example/api/higgsfield/consumer/${route}`,
          {
            method,
            headers: {
              ...(captured ? { "X-Workbench-Scope": captured } : {}),
              ...(origin ? { origin } : {}),
              ...(body === undefined ? {} : { "Content-Type": "application/json" }),
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          },
        ),
      ),
  };
}
test("the connection read carries the owner's slot holders, and set-aside is an owner-only, scoped ledger action", async () => {
  const route = await routeFixture(),
    original = route.original(),
    scope = "particl-active-ws-owner";
  const read = await route.request("connection", "GET", scope);
  expect(read.status).toBe(200);
  expect(await read.json()).toEqual({ connected: false, requiresReconnect: false, capacity: { limit: 4, active: 1, mine: [{ id: route.held, userId: "owner" }] } });
  const aside = (id: unknown, captured = scope) => route.request("connection", "POST", captured, undefined, { action: "set-aside", id });
  expect((await aside("not-a-job")).status).toBe(400);
  expect((await aside("44444444-4444-4444-8444-444444444444")).status).toBe(409);
  const done = await aside(route.held);
  expect(done.status).toBe(200);
  expect(await done.json()).toMatchObject({ capacity: { limit: 4 } });
  expect(route.asides).toEqual([{ userId: "owner", id: "44444444-4444-4444-8444-444444444444" }, { userId: "owner", id: route.held }]);
  expect(route.limits.filter((key) => key.endsWith(":set-aside"))).toHaveLength(2);
  expect((await aside(route.held, "stale")).status).toBe(409);
  route.set({ ...original, user: { ...original.user!, owner: false } });
  expect((await aside(route.held)).status).toBe(403);
  expect(route.asides).toHaveLength(2);
});

test("before the owner can reconnect, the connection read and the reconnect start both learn which account the grant belongs to", async () => {
  const route = await routeFixture(),
    scope = "particl-active-ws-owner";
  // Not connected: nothing to learn.
  await route.request("connection", "GET", scope);
  expect(route.backfills()).toBe(0);
  route.connect({ connected: true, requiresReconnect: false, subjectKnown: false });
  const read = await route.request("connection", "GET", scope);
  expect(await read.json()).toMatchObject({ connected: true, subjectKnown: true });
  expect(route.backfills()).toBe(1);
  expect(route.limits.filter((key) => key.endsWith(":subject"))).toHaveLength(1);
  // Known: no further read.
  await route.request("connection", "GET", scope);
  expect(route.backfills()).toBe(1);
  // The reconnect start makes sure too, just before the sign-in replaces the grant.
  expect((await route.request("connect", "POST", scope)).status).toBe(200);
  expect(route.backfills()).toBe(2);
  // Rate-limited: the read still answers, it just does not look the account up.
  route.connect({ connected: true, requiresReconnect: false, subjectKnown: false });
  route.limit();
  const limited = await route.request("connection", "GET", scope);
  expect(limited.status).toBe(200);
  expect(await limited.json()).toMatchObject({ subjectKnown: false });
  expect(route.backfills()).toBe(2);
});

test("real route guards reject stale scope, cross-origin, bearer tokens and nonowners before starting or disconnecting", async () => {
  const route = await routeFixture(),
    original = route.original(),
    scope = "particl-active-ws-owner";
  expect((await route.request("connect", "POST")).status).toBe(409);
  expect((await route.request("connect", "POST", "stale")).status).toBe(409);
  expect(
    (await route.request("connect", "POST", scope, "https://other.example"))
      .status,
  ).toBe(403);
  expect((await route.request("connection", "GET")).status).toBe(409);
  for (const tokenScope of ["read", "render"] as const) {
    route.set({
      ...original,
      token: { id: "token", name: "Token", scope: tokenScope, capUsd: null },
    });
    expect((await route.request("connect", "POST", scope)).status).toBe(403);
    expect((await route.request("connection", "DELETE", scope)).status).toBe(
      403,
    );
  }
  route.set({ ...original, user: { ...original.user!, owner: false } });
  expect((await route.request("connect", "POST", scope)).status).toBe(403);
  expect(route.counts()).toEqual({ starts: 0, disconnects: 0 });
  route.set(original);
  expect((await route.request("connect", "POST", scope)).status).toBe(200);
  expect((await route.request("connection", "DELETE", scope)).status).toBe(200);
  route.limit();
  expect((await route.request("connect", "POST", scope)).status).toBe(429);
  expect(route.counts()).toEqual({ starts: 1, disconnects: 1 });
});

test("the connection callback returns to Workspace › Engines in the Suites shell, with its outcome", async () => {
  const { oauth } = await modules();
  expect(oauth.consumerCallbackLocation("connected")).toBe("https://particl.example/suites?view=workspace&tab=engines&higgsfield=connected");
  expect(oauth.consumerCallbackLocation("authorization_denied")).toBe("https://particl.example/suites?view=workspace&tab=engines&higgsfield=authorization_denied");
});
