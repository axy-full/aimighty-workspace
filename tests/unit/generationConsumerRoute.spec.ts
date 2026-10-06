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
import * as contract from "../../lib/higgsfield-consumer/generation-contract";
import * as tools from "../../lib/higgsfield-consumer/tools";
import * as records from "../../lib/higgsfield-consumer/marketing-records";
import * as retired from "../../lib/higgsfield-consumer/retired";

const key = "11111111-1111-4111-8111-111111111111";
const wallet = "22222222-2222-4222-8222-222222222222";
const input = { type: "image", model: "nano_banana_2", prompt: "A plain bottle.", parameters: { resolution: "2k" }, medias: [{ role: "image_references", source: { uploadId: "original-still" } }] };
const quote = { action: "quote", draftId: "draft-1", input, idempotencyKey: key };
const submit = { action: "submit", draftId: "draft-1", id: key, workspaceId: wallet, credits: 9 };
const status = { action: "status", draftId: "draft-1", id: key };
const listing = { action: "catalogue" };
const scope = workbenchScopeFor("workspace", "owner");

/** Exercise the real tenant wrapper, owner/render guards, body reader and route
 * schema. Isolate session resolution, rate storage and the provider service. */
async function fixture() {
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
  const job = { id: key, draftId: "draft-1", workflow: "generation", status: "quoted", quoteCredits: 9, creditUnit: "higgsfield_credits", model: { id: "nano_banana_2", name: "Nano Banana 2", outputType: "image" } };
  const models = { models: [{ id: "nano_banana_2", name: "Nano Banana 2", outputType: "image" }], unlim: { available: false, remaining: null, expiresAt: null }, complete: true, fetchedAt: 1 };
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
    /* The standalone guard runs inside the quote service (tests/unit/generationConsumerService.spec.ts); the route maps its refusal. */
    "@/lib/higgsfield-consumer/marketing-records": { ConsumerSetupError: records.ConsumerSetupError },
    /* The handlers kept behind signInOff, as they ran before Release 1 (the switch itself: tests/unit/signinOffRelease1.spec.ts). */
    "@/lib/higgsfield-consumer/retired": { ...retired, signInOff: (kept: unknown) => kept },
    "@/lib/higgsfield-consumer/video-contract": { ConsumerVideoError },
    "@/lib/higgsfield-consumer/video-service": { ConsumerVideoServiceError },
    "@/lib/higgsfield-consumer/video-original": { ConsumerOriginalError },
    "@/lib/higgsfield-consumer/generation-contract": contract,
    "@/lib/higgsfield-consumer/catalogue": catalogue,
    "@/lib/higgsfield-consumer/tools": tools,
    "@/lib/higgsfield-consumer/genjutsu-sources": { ConsumerGenjutsuError },
    "@/lib/higgsfield-consumer/generation-sources": { GENERATION_SOURCE_BYTES: 52428800 },
    "@/lib/higgsfield-consumer/generation-service": {
      consumerGenerationJobs: service("list", [job]),
      connectedGenerationCatalogue: service("catalogue", models),
      presentCatalogue: (value: unknown) => value,
      quoteConsumerGeneration: service("quote", job),
      submitConsumerGenerationJob: service("submit", { ...job, status: "accepted" }),
      pollConsumerGeneration: service("status", { job: { ...job, status: "accepted" } }),
      quoteConsumerGenerationBatch: service("quote-batch", [job, job]),
      submitConsumerGenerationBatchJobs: service("submit-batch", [{ ...job, status: "accepted" }, { ...job, status: "accepted" }]),
      checkConsumerGenerationBatch: service("check-batch", { state: "absent", jobs: [job, job] }),
    },
    "@/lib/higgsfield-consumer/characters": {
      connectedCharacters: service("characters", { connected: true, available: true, characters: [{ soulId: "soul_9f2a", name: "Wren", type: "soul_2", status: "ready", previewUrl: null }] }),
      connectedPlan: service("plan", { connected: true, available: true, plan: "Pro", paid: true }),
      buildConnectedCharacter: service("build", { state: "training", character: { soulId: "soul_new", name: "Wren", type: "soul_2", status: "training", previewUrl: null } }),
      SOUL_BUILD_STILLS: { min: 5, max: 20 },
      SOUL_BUILD_TYPES: ["soul_2", "soul_cinematic"],
    },
    "@/lib/higgsfield-consumer/elements": {
      connectedElements: service("elements", { connected: true, available: true, elements: [{ elementId: "el_1", name: "Fox", category: "character", previewUrl: null }] }),
      buildConnectedElement: service("element-build", { state: "created", element: { elementId: "el_2", name: "Harbour", category: "environment", previewUrl: null } }),
    },
    "@/lib/higgsfield-consumer/explainer-service": {
      connectedExplainerPresets: service("explainer", { presets: [{ id: "56fc6472-33b7-45dc-83ff-80c71d40aec6", title: "Editorial Motion Graphics", aspect: "9:16" }], fetchedAt: 1, runnable: false, catalogueModels: [] }),
    },
  };
  const output = { exports: {} as Record<"GET" | "POST", (request: Request) => Promise<Response>> };
  new Function("require", "module", "exports", compile(readFileSync("app/api/higgsfield/consumer/generation/route.ts", "utf8")))((name: string) => {
    if (!(name in deps)) throw new Error(`Unexpected route dependency ${name}`);
    return deps[name];
  }, output, output.exports);
  return {
    calls, limits, connections, connection, job, models, store: () => store, setStore: (value: tenant.TenantStore) => { store = value; },
    fail: (value: unknown) => { failure = value; }, limit: () => { limited = true; },
    request: async (method: "GET" | "POST", body: unknown = quote, options: { scope?: string | null; origin?: string; query?: string; raw?: string | Uint8Array; contentLength?: string; empty?: boolean } = {}) => {
      const captured = options.scope === undefined ? scope : options.scope;
      const request = new Request(`https://particl.example/api/higgsfield/consumer/generation${options.query ?? ""}`, {
        method, headers: { ...(captured === null ? {} : { "X-Workbench-Scope": captured }), ...(options.origin ? { Origin: options.origin } : {}), ...(options.contentLength ? { "Content-Length": options.contentLength } : {}) },
        ...(method === "POST" && !options.empty ? { body: (options.raw ?? JSON.stringify(body)) as BodyInit } : {}),
      });
      const fetchBefore = globalThis.fetch;
      globalThis.fetch = async () => { throw new Error("NO_NETWORK_IN_ROUTE_TEST"); };
      try { return await output.exports[method](request); } finally { globalThis.fetch = fetchBefore; }
    },
  };
}

test("generation routes reject signed-out, nonowner and API-token callers before service access", async () => {
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

test("generation requests cannot adopt another workspace, user, origin or incomplete MFA session", async () => {
  const f = await fixture(), original = f.store();
  for (const body of [listing, quote, submit, status]) {
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

/** Every action that prices, starts or builds work on the connected account, or reads its catalogue,
 * characters, elements or styles: retired with the Higgsfield sign-in (lib/higgsfield-consumer/retired.ts). */
const second = "33333333-3333-4333-8333-333333333333";
const retiredBodies = [
  listing, { ...listing, refresh: true, type: "video" }, quote, { ...quote, composer: "gen" }, submit,
  { action: "quote-batch", draftId: "draft-1", input, idempotencyKeys: [key, second], batchId: "b_k1abc2", composer: "gen" },
  { action: "submit-batch", draftId: "draft-1", ids: [key, second], workspaceId: wallet, credits: 18 },
  { action: "explainer-presets" }, { action: "explainer-presets", refresh: true },
  { action: "characters" }, { action: "characters-plan" },
  { action: "characters-create", name: "Wren", type: "soul_cinematic", sources: [{ uploadId: "up_1" }, { uploadId: "up_2" }, { genId: "gen_3" }, { genId: "gen_4" }, { uploadId: "up_5" }] },
  { action: "elements" }, { action: "elements-create", name: "Harbour", category: "environment", description: "The frozen harbour", sources: [{ genId: "gen_1" }], projectId: "ws-1" },
];
async function expectRetired(response: Response) {
  expect(response.status).toBe(410);
  expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  expect(await response.json()).toEqual({ code: "retired", error: retired.SIGN_IN_RETIRED_MESSAGE });
}

test("every new-work action answers 410 before any limit or service; status and the saved jobs still reach the service with server-derived identity", async () => {
  const f = await fixture();
  for (const body of retiredBodies) await expectRetired(await f.request("POST", body, { origin: "https://particl.example" }));
  expect(f.calls).toEqual([]); expect(f.limits).toEqual([]);
  /* What a job already running needs: its status, and the project's saved jobs (the collector's list). */
  const polled = await f.request("POST", status, { origin: "https://particl.example" });
  expect(polled.status).toBe(200);
  expect(polled.headers.get("Cache-Control")).toBe("private, no-store");
  expect(polled.headers.get("X-Content-Type-Options")).toBe("nosniff");
  expect(await polled.json()).toHaveProperty("job");
  const response = await f.request("GET", undefined, { query: "?draftId=draft-1&userId=other&workspaceId=other" });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ connection: f.connection, jobs: [f.job], capabilities: { types: ["image", "video", "audio", "3d"], tools: tools.CONNECTED_TOOLS.map((tool) => ({ name: tool.name, label: tool.label, outputType: tool.outputType, sourceKind: tool.sourceKind, extraKinds: tool.extraKinds, models: tool.models })), promptLimit: 5000, maxMedias: 30, maxMediaBytes: 52428800, maxOriginalBytes: 104857600, importsMediaForQuote: true, cancel: false } });
  expect(f.connections).toEqual([{ workspaceId: "workspace", userId: "owner" }]);
  expect(f.calls).toEqual([
    { name: "status", args: [{ userId: "owner", draftId: "draft-1", id: key }], workspace: "workspace" },
    { name: "list", args: ["owner", "draft-1"], workspace: "workspace" },
  ]);
  expect(f.limits).toEqual([["hf-consumer-generation:workspace:owner:status", 30, 60_000]]);
});

test("a stale tab's retired request gets the plain answer even when its body no longer matches; the status and check schemas stay strict", async () => {
  const f = await fixture();
  /* Retired actions: whatever else the body holds, the answer is the retirement, never "review the request". */
  const staleRetired = [{ ...quote, userId: "other" }, { ...quote, idempotencyKey: "bad" }, { ...quote, input: { ...input, model: "../x" } },
    { ...submit, credits: -1 }, { ...submit, input }, { ...listing, type: "gif" }, { action: "explainer-presets", presetId: "56fc6472-33b7-45dc-83ff-80c71d40aec6" },
    { action: "characters", refresh: true }, { action: "characters-create", name: "Wren", type: "soul_2", sources: [] }, { action: "elements-create", name: "x".repeat(33), category: "prop", sources: [{ genId: "g" }] },
    { action: "quote-batch", draftId: "draft-1", input, idempotencyKeys: [key] }, { action: "submit-batch", draftId: "draft-1", ids: [key], workspaceId: wallet, credits: 0 }];
  for (const body of staleRetired) await expectRetired(await f.request("POST", body));
  const malformed = [null, [], {}, { ...quote, action: "generate" }, { ...quote, action: "cancel" }, { action: "resolve-explainer-preset" },
    { ...status, composer: "gen" }, { ...status, tool: "generate_image" }, { ...status, userId: "other" }, { ...status, id: "bad" }, { ...status, draftId: "../foreign" },
    { action: "check-batch", draftId: "draft-1", ids: [key] }, { action: "check-batch", draftId: "draft-1", ids: ["bad", second] }, { action: "check-batch", draftId: "draft-1", ids: [key, second], credits: 18 }];
  for (const body of malformed) expect((await f.request("POST", body)).status, JSON.stringify(body).slice(0, 150)).toBe(400);
  for (const draftId of ["", "../other", "a".repeat(201)])
    expect((await f.request("GET", undefined, { query: `?draftId=${encodeURIComponent(draftId)}` })).status).toBe(400);
  expect(f.calls).toEqual([]); expect(f.limits).toEqual([]);
});

test("generation body validation bounds actual UTF8 bytes and reports malformed JSON without leaking content", async () => {
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
  await expectRetired(await f.request("POST", submit));
  expect((await f.request("POST", status)).status).toBe(200);
  expect((await f.request("POST", { action: "check-batch", draftId: "draft-1", ids: [key, second] })).status).toBe(200);
  expect(f.calls.map((call) => call.name)).toEqual(["status", "check-batch"]);
  f.setStore(original); f.limit();
  const limited = await f.request("POST", status);
  expect(limited.status).toBe(429); expect(await limited.text()).not.toContain("PRIVATE_RATE_STATE");
  for (const body of [listing, quote, submit]) await expectRetired(await f.request("POST", body));
  expect(f.calls.map((call) => call.name)).toEqual(["status", "check-batch"]);
  expect(f.limits.map((args) => args[0])).toEqual(["hf-consumer-generation:workspace:owner:status", "hf-consumer-generation:workspace:owner:check-batch", "hf-consumer-generation:workspace:owner:status"]);
});

test("generation errors preserve bounded categories and never expose provider or storage details", async () => {
  const f = await fixture();
  for (const [error, expected] of [[new ConsumerOAuthError("reconnect_required"), 401], [new ConsumerDiscoveryError("timeout"), 504],
    [new ConsumerJobError("quote_expired"), 409], [new ConsumerJobError("capacity"), 409], [new ConsumerJobError("not_found", 404), 404],
    [new ConsumerVideoServiceError("not_found", "This generation job is not available.", 404), 404],
    [new ConsumerVideoServiceError("approval_changed", "Review this job’s wallet and exact credit quote again."), 409],
    [new ConsumerVideoError("quote_changed"), 409], [new ConsumerGenjutsuError("source_limits", 400), 400],
    [new ConsumerGenjutsuError("import_uncertain"), 409], [new ConsumerOriginalError("quota"), 507],
    [new ConsumerOriginalError("deleted"), 409], [new ConsumerOriginalError("invalid_video"), 422],
    [new catalogue.CatalogueError("parameter_unknown", "The model does not declare a setting named “seed”."), 400],
    [new catalogue.CatalogueError("invalid_catalogue", "The connected account returned an unusable model catalogue."), 502],
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

test("a batch whose submit reply was lost is still checked (never a paid call); pricing and sending a batch are retired", async () => {
  const f = await fixture();
  const checkBatch = { action: "check-batch", draftId: "draft-1", ids: [key, second] };
  const response = await f.request("POST", checkBatch, { origin: "https://particl.example" });
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  expect(await response.json()).toHaveProperty("state");
  expect(f.calls.map((call) => [call.name, call.args])).toEqual([["check-batch", ["owner", "draft-1", [key, second]]]]);
  expect(f.limits.map((args) => [args[0], args[1]])).toEqual([["hf-consumer-generation:workspace:owner:check-batch", 30]]);
  for (const body of retiredBodies.filter((b) => b.action === "quote-batch" || b.action === "submit-batch")) await expectRetired(await f.request("POST", body));
  expect(f.calls).toHaveLength(1);
});
