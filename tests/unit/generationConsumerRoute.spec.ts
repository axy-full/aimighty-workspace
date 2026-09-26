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
import { BuildInFlightError } from "../../lib/higgsfield-consumer/build-records";

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
    },
    "@/lib/higgsfield-consumer/characters": {
      connectedCharacters: service("characters", { connected: true, available: true, characters: [{ soulId: "soul_9f2a", name: "Mira", type: "soul_2", status: "ready", previewUrl: null }] }),
      connectedPlan: service("plan", { connected: true, available: true, plan: "Pro", paid: true }),
      buildConnectedCharacter: service("build", { state: "training", character: { soulId: "soul_new", name: "Mira", type: "soul_2", status: "training", previewUrl: null } }),
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

test("owner catalogue, quote, exact approval and status receive server-derived identity and the captured project", async () => {
  const f = await fixture();
  const catalogueResponse = await f.request("POST", listing, { origin: "https://particl.example" });
  expect(catalogueResponse.status).toBe(200);
  expect(await catalogueResponse.json()).toEqual({ catalogue: f.models });
  expect((await f.request("POST", { ...listing, refresh: true, type: "video" })).status).toBe(200);
  /* The Gen composer names itself on its quote, so Gen can pick its own takes back up later. */
  const marked = { ...quote, composer: "gen" };
  for (const body of [quote, marked, submit, status]) {
    const response = await f.request("POST", body, { origin: "https://particl.example" });
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(await response.json()).toHaveProperty("job");
  }
  const response = await f.request("GET", undefined, { query: "?draftId=draft-1&userId=other&workspaceId=other" });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ connection: f.connection, jobs: [f.job], capabilities: { types: ["image", "video", "audio", "3d"], tools: tools.CONNECTED_TOOLS.map((tool) => ({ name: tool.name, label: tool.label, outputType: tool.outputType, sourceKind: tool.sourceKind, extraKinds: tool.extraKinds, models: tool.models })), promptLimit: 5000, maxMedias: 30, maxMediaBytes: 52428800, maxOriginalBytes: 104857600, importsMediaForQuote: true, cancel: false } });
  expect(f.connections).toEqual([{ workspaceId: "workspace", userId: "owner" }]);
  expect(f.calls).toEqual([
    { name: "catalogue", args: ["owner", { refresh: false }], workspace: "workspace" },
    { name: "catalogue", args: ["owner", { refresh: true }], workspace: "workspace" },
    { name: "quote", args: ["owner", "draft-1", input, key, { composer: null }], workspace: "workspace" },
    { name: "quote", args: ["owner", "draft-1", input, key, { composer: "gen" }], workspace: "workspace" },
    { name: "submit", args: [{ userId: "owner", draftId: "draft-1", id: key }, submit], workspace: "workspace" },
    { name: "status", args: [{ userId: "owner", draftId: "draft-1", id: key }], workspace: "workspace" },
    { name: "list", args: ["owner", "draft-1"], workspace: "workspace" },
  ]);
  expect(f.limits).toEqual([listing, { ...listing, refresh: true, type: "video" }, quote, marked, submit, status].map((body) => [`hf-consumer-generation:workspace:owner:${body.action}`, body.action === "status" ? 30 : body.action === "catalogue" ? 12 : 6, 60_000]));
});

test("strict generation schemas reject remote URLs, spoofed identities, provider overrides and unknown actions", async () => {
  const f = await fixture();
  const malformed = [null, [], {}, { ...quote, action: "generate" }, { ...quote, action: "cancel" }, { ...quote, userId: "other" }, { ...quote, workspaceId: wallet },
    { ...quote, draftId: "../foreign" }, { ...quote, draftId: "x".repeat(201) }, { ...quote, idempotencyKey: "bad" },
    ...[{ type: "gif" }, { model: "../x" }, { model: "" }, { prompt: "a".repeat(5001) }, { parameters: { get_cost: false, ...input.parameters } , extra: 1 }, { parameters: { "bad key": 1 } }, { parameters: { nested: { a: 1 } } },
      { parameters: null }, { medias: [{ role: "image_references", source: { url: "https://provider.invalid/still.png" } }] },
      { medias: [{ role: "image_references", source: { uploadId: "a", genId: "b" } }] }, { medias: [{ role: "Bad Role", source: { uploadId: "a" } }] },
      { medias: [{ role: "image_references", source: { uploadId: "a" } }, { role: "mask", source: { uploadId: "a" } }] },
      { medias: Array.from({ length: 31 }, (_, i) => ({ role: "image_references", source: { uploadId: `image-${i}` } })) },
      { medias: [{ role: "image_references", source: { uploadId: "../secret" } }] }, { count: 2 }, { use_unlim: true }].map((patch) => ({ ...quote, input: { ...input, ...patch } })),
    { ...quote, composer: "ads" }, { ...quote, composer: true }, { ...status, composer: "gen" },
    { ...submit, credits: -1 }, { ...submit, credits: 100001 }, { ...submit, credits: "9" }, { ...submit, workspaceId: "bad" }, { ...submit, id: "bad" }, { ...submit, input },
    { ...status, tool: "generate_image" }, { ...status, userId: "other" }, { ...listing, type: "gif" }, { ...listing, refresh: "yes" }, { ...listing, model: "x" },
    { action: "explainer-presets", presetId: "56fc6472-33b7-45dc-83ff-80c71d40aec6" }, { action: "explainer-presets", refresh: "yes" }, { action: "resolve-explainer-preset" }];
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

test("suspension prevents generation dispatch, while catalogue and status remain readable and limits block all service calls", async () => {
  const f = await fixture(), original = f.store();
  f.setStore({ ...original, workspace: { ...original.workspace!, suspendedAt: 1, suspendedReason: "Paused" } });
  expect((await f.request("POST", submit)).status).toBe(423); expect(f.calls).toEqual([]);
  expect((await f.request("POST", status)).status).toBe(200);
  expect((await f.request("POST", listing)).status).toBe(200);
  expect(f.calls.map((call) => call.name)).toEqual(["status", "catalogue"]);
  f.setStore(original); f.limit();
  for (const body of [listing, quote, submit, status]) {
    const response = await f.request("POST", body);
    expect(response.status).toBe(429); expect(await response.text()).not.toContain("PRIVATE_RATE_STATE");
  }
  expect(f.calls.map((call) => call.name)).toEqual(["status", "catalogue"]);
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

test("the explainer style listing is an owner read with its own limit; it carries no generation or resolve action", async () => {
  const f = await fixture();
  const response = await f.request("POST", { action: "explainer-presets" });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ explainer: { presets: [{ id: "56fc6472-33b7-45dc-83ff-80c71d40aec6", title: "Editorial Motion Graphics", aspect: "9:16" }], fetchedAt: 1, runnable: false, catalogueModels: [] } });
  expect((await f.request("POST", { action: "explainer-presets", refresh: true })).status).toBe(200);
  expect(f.calls.map((call) => [call.name, call.args])).toEqual([["explainer", ["owner", { refresh: false }]], ["explainer", ["owner", { refresh: true }]]]);
  expect(f.limits.map((args) => [args[0], args[1]])).toEqual([["hf-consumer-generation:workspace:owner:explainer-presets", 12], ["hf-consumer-generation:workspace:owner:explainer-presets", 12]]);
});

test("the characters listing is an owner read with the catalogue's limit; it carries nothing but the action", async () => {
  const f = await fixture();
  const response = await f.request("POST", { action: "characters" });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ connected: true, available: true, characters: [{ soulId: "soul_9f2a", name: "Mira", type: "soul_2", status: "ready", previewUrl: null }] });
  expect((await f.request("POST", { action: "characters", refresh: true })).status).toBe(400);
  expect(f.calls.map((call) => [call.name, call.args])).toEqual([["characters", ["owner"]]]);
  expect(f.limits.map((args) => [args[0], args[1]])).toEqual([["hf-consumer-generation:workspace:owner:characters", 12]]);
});

test("the Soul ID build: the plan gate is an owner read; the create needs render, carries exactly name · type · 5–20 sources, and is rate-limited hardest", async () => {
  const f = await fixture();
  const plan = await f.request("POST", { action: "characters-plan" });
  expect(plan.status).toBe(200);
  expect(await plan.json()).toEqual({ plan: { connected: true, available: true, plan: "Pro", paid: true } });
  const sources = [{ uploadId: "up_1" }, { uploadId: "up_2" }, { genId: "gen_3" }, { genId: "gen_4" }, { uploadId: "up_5" }];
  const create = await f.request("POST", { action: "characters-create", name: "Mira", type: "soul_cinematic", sources });
  expect(create.status).toBe(200);
  expect(await create.json()).toEqual({ build: { state: "training", character: { soulId: "soul_new", name: "Mira", type: "soul_2", status: "training", previewUrl: null } } });
  expect(f.calls.map((call) => [call.name, call.args])).toEqual([["plan", ["owner"]], ["build", ["owner", { name: "Mira", type: "soul_cinematic", sources, projectId: null }]]]);
  expect(f.limits.map((args) => [args[0], args[1]])).toEqual([["hf-consumer-generation:workspace:owner:characters-plan", 12], ["hf-consumer-generation:workspace:owner:characters-create", 3]]);
  /* Four stills, a blank name, an unknown type or a stray field are refused before anything is read. */
  expect((await f.request("POST", { action: "characters-create", name: "Mira", type: "soul_2", sources: sources.slice(0, 4) })).status).toBe(400);
  expect((await f.request("POST", { action: "characters-create", name: "  ", type: "soul_2", sources })).status).toBe(400);
  expect((await f.request("POST", { action: "characters-create", name: "Mira", type: "soul", sources })).status).toBe(400);
  expect((await f.request("POST", { action: "characters-create", name: "Mira", type: "soul_2", sources, images: [] })).status).toBe(400);
  expect(f.calls).toHaveLength(2);
  /* The same build already sent (it may be on the account): a plain 409 the card shows, never a second send. */
  f.fail(new BuildInFlightError());
  const again = await f.request("POST", { action: "characters-create", name: "Mira", type: "soul_cinematic", sources });
  expect(again.status).toBe(409);
  expect(await again.json()).toEqual({ code: "build_in_flight", error: "This build was already sent and may have been accepted, so it is not sent again." });
});

test("reference elements: the list is an owner read; the create needs render, carries name · category · 1–8 sources, and is rate-limited hardest", async () => {
  const f = await fixture();
  const list = await f.request("POST", { action: "elements" });
  expect(list.status).toBe(200);
  expect(await list.json()).toEqual({ connected: true, available: true, elements: [{ elementId: "el_1", name: "Fox", category: "character", previewUrl: null }] });
  const create = await f.request("POST", { action: "elements-create", name: "Harbour", category: "environment", description: "The frozen harbour", sources: [{ genId: "gen_1" }], projectId: "ws-1" });
  expect(create.status).toBe(200);
  expect(await create.json()).toEqual({ build: { state: "created", element: { elementId: "el_2", name: "Harbour", category: "environment", previewUrl: null } } });
  expect(f.calls.map((call) => [call.name, call.args])).toEqual([["elements", ["owner"]], ["element-build", ["owner", { name: "Harbour", category: "environment", description: "The frozen harbour", sources: [{ genId: "gen_1" }], projectId: "ws-1" }]]]);
  expect(f.limits.map((args) => [args[0], args[1]])).toEqual([["hf-consumer-generation:workspace:owner:elements", 12], ["hf-consumer-generation:workspace:owner:elements-create", 3]]);
  /* A name over the account's 32 characters, an unknown category, no source or a remote URL are refused before anything is read. */
  expect((await f.request("POST", { action: "elements-create", name: "x".repeat(33), category: "prop", sources: [{ genId: "g" }] })).status).toBe(400);
  expect((await f.request("POST", { action: "elements-create", name: "Lamp", category: "vehicle", sources: [{ genId: "g" }] })).status).toBe(400);
  expect((await f.request("POST", { action: "elements-create", name: "Lamp", category: "prop", sources: [] })).status).toBe(400);
  expect((await f.request("POST", { action: "elements-create", name: "Lamp", category: "prop", sources: [{ url: "https://x.example/a.png" }] })).status).toBe(400);
  expect(f.calls).toHaveLength(2);
});

test("the quote service's standalone refusal answers 409 setup_not_particl with its own safe words", async () => {
  const f = await fixture();
  const input_ = { ...input, parameters: { ...input.parameters, product_ids: ["acct_p1"] } };
  f.fail(Object.assign(new records.ConsumerSetupError(), { cause: new Error("PRIVATE_ACCOUNT_DETAIL") }));
  const response = await f.request("POST", { ...quote, input: input_ }, { origin: "https://particl.example" });
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ code: "setup_not_particl", error: new records.ConsumerSetupError().message });
  /* The route hands the whole input to the service, which runs the guard before anything is priced. */
  expect(f.calls.map((call) => call.name)).toEqual(["quote"]);
  expect(JSON.stringify(f.calls[0].args)).toContain("acct_p1");
});
