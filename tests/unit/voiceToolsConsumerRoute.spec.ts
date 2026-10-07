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
import * as retired from "../../lib/higgsfield-consumer/retired";
import { crossOriginProblem } from "../../lib/requestOrigin";

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
  new Function("exports", "resolveStore", "runWithStore", "NoTenantError", "MediaSourceError", "workbenchScopeFor", "recoveryRoute", "crossOriginProblem", compile(declaration.getText(ast)))(wrapped, async () => store, tenant.runWithStore, tenant.NoTenantError, MediaSourceError, workbenchScopeFor, (handler: unknown) => handler, crossOriginProblem);
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
    "@/lib/higgsfield-consumer/retired": retired,
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

async function expectRetired(response: Response) {
  expect(response.status).toBe(410);
  expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  expect(await response.json()).toEqual({ code: "retired", error: retired.SIGN_IN_RETIRED_MESSAGE });
}
const dubbing = { ...quote, input: { tool: "dubbing", source: { genId: "take" }, targetLanguage: "fra" } };

test("voices, quote and submit answer 410 before any limit or service; status and the saved jobs still reach the service, and the capability list keeps analysis off", async () => {
  const f = await fixture();
  for (const body of [voices, { ...voices, refresh: true }, quote, dubbing, submit])
    await expectRetired(await f.request("POST", body, { origin: "https://particl.example" }));
  expect(f.calls).toEqual([]); expect(f.limits).toEqual([]);
  const polled = await f.request("POST", status, { origin: "https://particl.example" });
  expect(polled.status).toBe(200);
  expect(polled.headers.get("Cache-Control")).toBe("private, no-store");
  expect(polled.headers.get("X-Content-Type-Options")).toBe("nosniff");
  expect(await polled.json()).toHaveProperty("job");
  const response = await f.request("GET", undefined, { query: "?draftId=draft-1&userId=other&workspaceId=other" });
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body).toEqual({ connection: f.connection, jobs: [f.job], capabilities: {
    voice: true, dubbing: true, analysis: false,
    reframe: true, reframeAspectRatios: ["16:9", "9:16", "4:3", "3:4", "1:1", "21:9"], reframeResolutions: ["480p", "720p", "1080p"], maxReframeSeconds: 60,
    tools: [{ name: "voice_change", label: "Change voice", output: "video", suffix: "voice changed" }, { name: "dubbing", label: "Dub", output: "video", suffix: "dubbed" }, { name: "reframe", label: "Reframe", output: "video", suffix: "reframed" }],
    languages: tools.DUBBING_LANGUAGES, sourceKind: "video", maxSourceBytes: 52428800, maxOriginalBytes: 104857600, importsMediaForQuote: true, priceSources: ["get_cost"], cancel: false,
  } });
  // Capability copy never names the provider (the ledger's credit-unit key is an internal identifier shared by every consumer route).
  expect(JSON.stringify(body.capabilities).toLowerCase()).not.toContain("higgsfield");
  expect(f.connections).toEqual([{ workspaceId: "workspace", userId: "owner" }]);
  expect(f.calls).toEqual([
    { name: "status", args: [{ userId: "owner", draftId: "draft-1", id: key }], workspace: "workspace" },
    { name: "list", args: ["owner", "draft-1"], workspace: "workspace" },
  ]);
  expect(f.limits).toEqual([["hf-consumer-audio-tools:workspace:owner:status", 30, 60_000]]);
});

test("an analysis quote is retired whether or not the platform flag is on", async () => {
  const analysis = { ...quote, input: { tool: "video_analysis", source: { uploadId: "clip-original" } } };
  for (const f of [await fixture(), await fixture({ analysis: true })]) {
    await expectRetired(await f.request("POST", analysis));
    expect(f.calls).toEqual([]); expect(f.limits).toEqual([]);
  }
  const capabilities = (await (await (await fixture({ analysis: true })).request("GET", undefined, { query: "?draftId=draft-1" })).json()).capabilities;
  expect(capabilities.analysis).toBe(true);
});

test("a stale tab's retired request gets the plain answer whatever its body; the status schema stays strict", async () => {
  const f = await fixture();
  const staleRetired = [{ ...quote, userId: "other" }, { ...quote, idempotencyKey: "bad" }, { ...quote, input: { ...input, source: { url: "https://provider.invalid/clip.mp4" } } },
    { ...quote, input: { tool: "dubbing", source: { uploadId: "a" } } }, { ...submit, credits: -1 }, { ...submit, input }, { ...voices, cursor: "x" }, { ...voices, refresh: "yes" }];
  for (const body of staleRetired) await expectRetired(await f.request("POST", body));
  const malformed = [null, [], {}, { ...quote, action: "generate" }, { ...quote, action: "cancel" },
    { ...status, tool: "voice_change" }, { ...status, userId: "other" }, { ...status, id: "bad" }, { ...status, draftId: "../foreign" }];
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

test("a paused workspace can still read a running job; limits block status, and a retired action never reaches the limits", async () => {
  const f = await fixture(), original = f.store();
  f.setStore({ ...original, workspace: { ...original.workspace!, suspendedAt: 1, suspendedReason: "Paused" } });
  await expectRetired(await f.request("POST", submit)); expect(f.calls).toEqual([]);
  expect((await f.request("POST", status)).status).toBe(200);
  await expectRetired(await f.request("POST", voices));
  expect(f.calls.map((call) => call.name)).toEqual(["status"]);
  f.setStore(original); f.limit();
  const limited = await f.request("POST", status);
  expect(limited.status).toBe(429); expect(await limited.text()).not.toContain("PRIVATE_RATE_STATE");
  for (const body of [voices, quote, submit]) await expectRetired(await f.request("POST", body));
  expect(f.calls.map((call) => call.name)).toEqual(["status"]);
  expect(f.limits.map((args) => args[0])).toEqual(["hf-consumer-audio-tools:workspace:owner:status", "hf-consumer-audio-tools:workspace:owner:status"]);
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
