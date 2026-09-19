import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import ts from "typescript";
import * as zod from "zod";
import * as tenant from "../../lib/tenant";
import { MediaSourceError } from "../../lib/mediaBindings";
import { workbenchScopeFor } from "../../lib/workbench/request-scope";
import { AccountError } from "../../lib/accountDb";
import * as requestBody from "../../lib/requestBody";
import { ConsumerOAuthError } from "../../lib/higgsfield-consumer/oauth";
import { ConsumerDiscoveryError } from "../../lib/higgsfield-consumer/mcp";
import { ConsumerJobError } from "../../lib/higgsfield-consumer/jobs";
import { ConsumerVideoError } from "../../lib/higgsfield-consumer/video-contract";
import { ConsumerVideoServiceError } from "../../lib/higgsfield-consumer/video-service";
import { ConsumerOriginalError } from "../../lib/higgsfield-consumer/video-original";
import { ConsumerGenjutsuError } from "../../lib/higgsfield-consumer/genjutsu-sources";
import * as catalogue from "../../lib/higgsfield-consumer/catalogue";
import * as tools from "../../lib/higgsfield-consumer/voice-tools";

const key = "11111111-1111-4111-8111-111111111111";
const wallet = "22222222-2222-4222-8222-222222222222";
const input = { tool: "voice_change", source: { uploadId: "clip-original" }, voice: { id: "voice-nova", type: "preset", name: "Nova" } };
const quote = { action: "quote", draftId: "draft-1", input, idempotencyKey: key };
const submit = { action: "submit", draftId: "draft-1", id: key, workspaceId: wallet, credits: 12 };
const status = { action: "status", draftId: "draft-1", id: key };
const voices = { action: "voices" };
const scope = workbenchScopeFor("workspace", "owner");

/** Exercise the real tenant wrapper, owner/render guards, body reader and route
 * schema. Isolate session resolution, rate storage and the provider service. */
async function fixture(options: { analysis?: boolean } = {}) {
  const auth = await import("../../lib/auth");
  let store = { workspace: { id: "workspace", deletedAt: null, suspendedAt: null }, user: { id: "owner", role: "admin", owner: true } } as tenant.TenantStore;
  const ast = ts.createSourceFile("auth.ts", readFileSync("lib/auth.ts", "utf8"), ts.ScriptTarget.Latest, true);
  const declaration = ast.statements.find((statement) => ts.isFunctionDeclaration(statement) && statement.name?.text === "withTenant")!;
  const compile = (source: string) => ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const wrapped = {} as Pick<typeof auth, "withTenant">;
  new Function("exports", "resolveStore", "runWithStore", "NoTenantError", "MediaSourceError", "workbenchScopeFor", "recoveryRoute", compile(declaration.getText(ast)))(wrapped, async () => store, tenant.runWithStore, tenant.NoTenantError, MediaSourceError, workbenchScopeFor, (handler: unknown) => handler);
  const calls: { name: string; args: unknown[]; workspace: string }[] = [], limits: unknown[][] = [], connections: unknown[] = [];
  let failure: unknown, limited = false;
  const connection = { status: "connected", connected: true };
  const job = { id: key, draftId: "draft-1", workflow: "voice-tool", status: "quoted", quoteCredits: 12, creditUnit: "higgsfield_credits", tool: { name: "voice_change", label: "Change voice", suffix: "voice changed", output: "video" }, priceSource: "get_cost" };
  const listing = { voices: [{ id: "voice-nova", type: "preset", name: "Nova" }], complete: true, fetchedAt: 1 };
  const service = (name: string, result: unknown) => async (...args: unknown[]) => {
    calls.push({ name, args, workspace: tenant.requireTenant().id });
    if (failure) throw failure;
    return result;
  };
  const deps: Record<string, unknown> = {
    zod,
    "@/lib/auth": { ...auth, withTenant: wrapped.withTenant },
    "@/lib/tenant": tenant,
    "@/lib/accountDb": { AccountError, takeAccountLimit: async (...args: unknown[]) => { limits.push(args); if (limited) throw new AccountError("PRIVATE_RATE_STATE", 429); } },
    "@/lib/requestBody": requestBody,
    "@/lib/higgsfield-consumer/oauth": { ConsumerOAuthError, getConsumerConnection: async (identity: unknown) => { connections.push(identity); return connection; } },
    "@/lib/higgsfield-consumer/mcp": { ConsumerDiscoveryError },
    "@/lib/higgsfield-consumer/jobs": { ConsumerJobError },
    "@/lib/higgsfield-consumer/video-contract": { ConsumerVideoError },
    "@/lib/higgsfield-consumer/video-service": { ConsumerVideoServiceError },
    "@/lib/higgsfield-consumer/video-original": { ConsumerOriginalError },
    "@/lib/higgsfield-consumer/catalogue": catalogue,
    "@/lib/higgsfield-consumer/voice-tools": tools,
    "@/lib/higgsfield-consumer/genjutsu-sources": { ConsumerGenjutsuError },
    "@/lib/higgsfield-consumer/generation-sources": { GENERATION_SOURCE_BYTES: 52428800 },
    "@/lib/higgsfield-consumer/voice-tool-service": {
      VIDEO_ANALYSIS_ENABLED: options.analysis === true,
      consumerVoiceToolJobs: service("list", [job]),
      connectedVoices: service("voices", listing),
      quoteConsumerVoiceTool: service("quote", job),
      submitConsumerVoiceToolJob: service("submit", { ...job, status: "accepted" }),
      pollConsumerVoiceTool: service("status", { job: { ...job, status: "accepted" } }),
    },
  };
  const output = { exports: {} as Record<"GET" | "POST", (request: Request) => Promise<Response>> };
  new Function("require", "module", "exports", compile(readFileSync("app/api/higgsfield/consumer/audio-tools/route.ts", "utf8")))((name: string) => {
    if (!(name in deps)) throw new Error(`Unexpected route dependency ${name}`);
    return deps[name];
  }, output, output.exports);
  return {
    calls, limits, connections, connection, job, listing, store: () => store, setStore: (value: tenant.TenantStore) => { store = value; },
    fail: (value: unknown) => { failure = value; }, limit: () => { limited = true; },
    request: async (method: "GET" | "POST", body: unknown = quote, options: { scope?: string | null; origin?: string; query?: string; raw?: string | Uint8Array; contentLength?: string; empty?: boolean } = {}) => {
      const captured = options.scope === undefined ? scope : options.scope;
      const request = new Request(`https://particl.example/api/higgsfield/consumer/audio-tools${options.query ?? ""}`, {
        method, headers: { ...(captured === null ? {} : { "X-Workbench-Scope": captured }), ...(options.origin ? { Origin: options.origin } : {}), ...(options.contentLength ? { "Content-Length": options.contentLength } : {}) },
        ...(method === "POST" && !options.empty ? { body: (options.raw ?? JSON.stringify(body)) as BodyInit } : {}),
      });
      const fetchBefore = globalThis.fetch;
      globalThis.fetch = async () => { throw new Error("NO_NETWORK_IN_ROUTE_TEST"); };
      try { return await output.exports[method](request); } finally { globalThis.fetch = fetchBefore; }
    },
  };
}

test("voice tool routes reject signed-out, nonowner and API-token callers before service access", async () => {
  const f = await fixture(), original = f.store();
  for (const method of ["GET", "POST"] as const) {
    f.setStore({ ...original, user: null });
    expect((await f.request(method, quote, { scope: null })).status).toBe(401);
    for (const role of ["member", "admin"] as const) {
      f.setStore({ ...original, user: { ...original.user!, role, owner: false } });
      expect((await f.request(method)).status).toBe(403);
    }
    for (const tokenScope of ["read", "render"] as const) {
      f.setStore({ ...original, token: { id: "api-token", name: "Fixture", scope: tokenScope, capUsd: null } });
      expect((await f.request(method, quote, { scope: null })).status).toBe(403);
    }
    f.setStore({ ...original, workspace: null });
    expect((await f.request(method, quote, { scope: null })).status).toBe(method === "POST" ? 409 : 401);
    f.setStore({ ...original, workspace: { ...original.workspace!, deletedAt: 1 } });
    expect((await f.request(method)).status).toBe(401);
  }
  expect(f.calls).toEqual([]); expect(f.limits).toEqual([]); expect(f.connections).toEqual([]);
});

test("voice tool requests cannot adopt another workspace, user, origin or incomplete MFA session", async () => {
  const f = await fixture(), original = f.store();
  for (const body of [voices, quote, submit, status]) {
    for (const captured of [null, "", workbenchScopeFor("other", "owner"), workbenchScopeFor("workspace", "other")])
      expect((await f.request("POST", body, { scope: captured })).status).toBe(409);
    expect((await f.request("POST", body, { origin: "https://other.example" })).status).toBe(403);
  }
  for (const captured of ["", workbenchScopeFor("other", "owner"), workbenchScopeFor("workspace", "other")])
    expect((await f.request("GET", undefined, { scope: captured })).status).toBe(409);
  f.setStore({ ...original, mfaRequired: true });
  for (const method of ["GET", "POST"] as const) expect((await f.request(method)).status).toBe(428);
  expect(f.calls).toEqual([]); expect(f.limits).toEqual([]); expect(f.connections).toEqual([]);
});

test("owner voices, quote, exact approval and status receive server-derived identity, and the capability list keeps analysis off", async () => {
  const f = await fixture();
  const listing = await f.request("POST", voices, { origin: "https://particl.example" });
  expect(listing.status).toBe(200);
  expect(await listing.json()).toEqual({ voices: f.listing });
  expect((await f.request("POST", { ...voices, refresh: true })).status).toBe(200);
  for (const body of [quote, submit, status]) {
    const response = await f.request("POST", body, { origin: "https://particl.example" });
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(await response.json()).toHaveProperty("job");
  }
  const dubbing = { ...quote, input: { tool: "dubbing", source: { genId: "take" }, targetLanguage: "fra" } };
  expect((await f.request("POST", dubbing)).status).toBe(200);
  const response = await f.request("GET", undefined, { query: "?draftId=draft-1&userId=other&workspaceId=other" });
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body).toEqual({ connection: f.connection, jobs: [f.job], capabilities: {
    voice: true, dubbing: true, analysis: false,
    tools: [{ name: "voice_change", label: "Change voice", output: "video", suffix: "voice changed" }, { name: "dubbing", label: "Dub", output: "video", suffix: "dubbed" }],
    languages: tools.DUBBING_LANGUAGES, sourceKind: "video", maxSourceBytes: 52428800, maxOriginalBytes: 104857600, importsMediaForQuote: true, priceSources: ["get_cost"], cancel: false,
  } });
  // Capability copy never names the provider (the ledger's credit-unit key is an internal identifier shared by every consumer route).
  expect(JSON.stringify(body.capabilities).toLowerCase()).not.toContain("higgsfield");
  expect(f.connections).toEqual([{ workspaceId: "workspace", userId: "owner" }]);
  expect(f.calls).toEqual([
    { name: "voices", args: ["owner", { refresh: false }], workspace: "workspace" },
    { name: "voices", args: ["owner", { refresh: true }], workspace: "workspace" },
    { name: "quote", args: ["owner", "draft-1", input, key], workspace: "workspace" },
    { name: "submit", args: [{ userId: "owner", draftId: "draft-1", id: key }, submit], workspace: "workspace" },
    { name: "status", args: [{ userId: "owner", draftId: "draft-1", id: key }], workspace: "workspace" },
    { name: "quote", args: ["owner", "draft-1", dubbing.input, key], workspace: "workspace" },
    { name: "list", args: ["owner", "draft-1"], workspace: "workspace" },
  ]);
  expect(f.limits).toEqual([voices, { ...voices, refresh: true }, quote, submit, status, dubbing].map((body) => [`hf-consumer-audio-tools:workspace:owner:${body.action}`, body.action === "status" ? 30 : body.action === "voices" ? 12 : 6, 60_000]));
});

test("an analysis quote is refused while the flag is off and admitted only when it is on", async () => {
  const analysis = { ...quote, input: { tool: "video_analysis", source: { uploadId: "clip-original" } } };
  const off = await fixture();
  const refused = await off.request("POST", analysis);
  expect(refused.status).toBe(403);
  expect(await refused.json()).toMatchObject({ code: "analysis_disabled" });
  expect(off.calls).toEqual([]); expect(off.limits).toEqual([]);
  const on = await fixture({ analysis: true });
  expect((await on.request("POST", analysis)).status).toBe(200);
  expect(on.calls.map((call) => call.name)).toEqual(["quote"]);
  const capabilities = (await (await on.request("GET", undefined, { query: "?draftId=draft-1" })).json()).capabilities;
  expect(capabilities.analysis).toBe(true);
  expect(capabilities.tools.map((tool: { name: string }) => tool.name)).toEqual(["voice_change", "dubbing", "video_analysis"]);
});

test("strict voice tool schemas reject remote URLs, spoofed identities, provider overrides and unknown actions", async () => {
  const f = await fixture();
  const malformed = [null, [], {}, { ...quote, action: "generate" }, { ...quote, action: "cancel" }, { ...quote, userId: "other" }, { ...quote, workspaceId: wallet },
    { ...quote, draftId: "../foreign" }, { ...quote, draftId: "x".repeat(201) }, { ...quote, idempotencyKey: "bad" },
    ...[{ tool: "virality_predictor" }, { tool: "dubbing" }, { targetLanguage: "fra" }, { voice: { id: "x", type: "custom" } }, { voice: { id: "", type: "preset" } }, { prompt: "hi" }, { get_cost: true },
      { source: { url: "https://provider.invalid/clip.mp4" } }, { source: { uploadId: "a", genId: "b" } }, { source: { uploadId: "../secret" } }, { video_id: key }, { count: 2 }]
      .map((patch) => ({ ...quote, input: { ...input, ...patch } })),
    { ...quote, input: { tool: "dubbing", source: { uploadId: "a" }, targetLanguage: "fr" } }, { ...quote, input: { tool: "dubbing", source: { uploadId: "a" } } },
    { ...submit, credits: -1 }, { ...submit, credits: 100001 }, { ...submit, credits: "12" }, { ...submit, workspaceId: "bad" }, { ...submit, id: "bad" }, { ...submit, input },
    { ...status, tool: "voice_change" }, { ...status, userId: "other" }, { ...voices, cursor: "x" }, { ...voices, refresh: "yes" }, { ...voices, size: 5 }];
  for (const body of malformed) expect((await f.request("POST", body)).status, JSON.stringify(body).slice(0, 150)).toBe(400);
  for (const draftId of ["", "../other", "a".repeat(201)])
    expect((await f.request("GET", undefined, { query: `?draftId=${encodeURIComponent(draftId)}` })).status).toBe(400);
  expect(f.calls).toEqual([]); expect(f.limits).toEqual([]);
});

test("voice tool body validation bounds actual UTF8 bytes and reports malformed JSON without leaking content", async () => {
  const f = await fixture();
  for (const raw of ["{broken", "", '{"input":"PRIVATE_MARKER"', new Uint8Array([0xc3, 0x28])]) {
    const response = await f.request("POST", undefined, { raw });
    expect(response.status).toBe(400); expect(await response.text()).not.toContain("PRIVATE_MARKER");
  }
  expect((await f.request("POST", undefined, { empty: true })).status).toBe(400);
  for (const options of [{ contentLength: "48001" }, { raw: " ".repeat(48001), contentLength: "1" }, { raw: `"${"😀".repeat(12001)}"` }])
    expect((await f.request("POST", quote, options)).status).toBe(413);
  expect(f.calls).toEqual([]); expect(f.limits).toEqual([]);
});

test("suspension prevents voice tool dispatch, while voices and status remain readable and limits block all service calls", async () => {
  const f = await fixture(), original = f.store();
  f.setStore({ ...original, workspace: { ...original.workspace!, suspendedAt: 1, suspendedReason: "Paused" } });
  expect((await f.request("POST", submit)).status).toBe(423); expect(f.calls).toEqual([]);
  expect((await f.request("POST", status)).status).toBe(200);
  expect((await f.request("POST", voices)).status).toBe(200);
  expect(f.calls.map((call) => call.name)).toEqual(["status", "voices"]);
  f.setStore(original); f.limit();
  for (const body of [voices, quote, submit, status]) {
    const response = await f.request("POST", body);
    expect(response.status).toBe(429); expect(await response.text()).not.toContain("PRIVATE_RATE_STATE");
  }
  expect(f.calls.map((call) => call.name)).toEqual(["status", "voices"]);
});

test("voice tool errors preserve bounded categories and never expose provider or storage details", async () => {
  const f = await fixture();
  for (const [error, expected] of [[new ConsumerOAuthError("reconnect_required"), 401], [new ConsumerDiscoveryError("timeout"), 504],
    [new ConsumerJobError("quote_expired"), 409], [new ConsumerJobError("capacity"), 409], [new ConsumerJobError("not_found", 404), 404],
    [new ConsumerVideoServiceError("not_found", "This voice job is not available.", 404), 404],
    [new ConsumerVideoServiceError("approval_changed", "Review this job’s wallet and exact credit quote again."), 409],
    [new ConsumerVideoError("quote_changed"), 409], [new ConsumerGenjutsuError("source_limits", 400), 400],
    [new ConsumerGenjutsuError("import_uncertain"), 409], [new ConsumerOriginalError("quota"), 507],
    [new ConsumerOriginalError("deleted"), 409], [new ConsumerOriginalError("invalid_video"), 422],
    [new tools.VoiceToolError("price_unknown", "The Higgsfield tool has no price. Nothing was sent."), 409],
    [new tools.VoiceToolError("contract_unverified", "The tool does not advertise these arguments."), 502],
    [new tools.VoiceToolError("invalid_voices", "Unusable voice list."), 502],
    [new Error("PRIVATE_PROVIDER_TOKEN_AND_URL"), 503]] as const) {
    f.fail(error); Object.assign(error, { cause: new Error("PRIVATE_PROVIDER_TOKEN_AND_URL") });
    const response = await f.request("POST", status);
    expect(response.status, error.message).toBe(expected);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    const text = await response.text();
    expect(text).not.toContain("PRIVATE_PROVIDER_TOKEN_AND_URL");
    expect(text.toLowerCase()).not.toContain("higgsfield");
  }
});
