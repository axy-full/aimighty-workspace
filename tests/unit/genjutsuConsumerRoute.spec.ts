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
import * as contract from "../../lib/higgsfield-consumer/genjutsu-contract";
import * as genjutsuTypes from "../../lib/genjutsuTypes";
import * as retired from "../../lib/higgsfield-consumer/retired";

const key = "11111111-1111-4111-8111-111111111111";
const wallet = "22222222-2222-4222-8222-222222222222";
const input = { variant: "motion-transfer", resolution: "1080p", prompt: "Keep the source movement.", source: { uploadId: "original-video" }, references: [{ genId: "original-image" }] };
const quote = { action: "quote", draftId: "draft-1", input, idempotencyKey: key };
const submit = { action: "submit", draftId: "draft-1", id: key, workspaceId: wallet, credits: 25 };
const status = { action: "status", draftId: "draft-1", id: key };
const scope = workbenchScopeFor("workspace", "owner");

/** Exercise the real tenant wrapper, owner/render guards, body reader and route
 * schema. Isolate session resolution, rate storage and the provider service. */
async function fixture() {
  const auth = await import("../../lib/auth");
  let store = { workspace: { id: "workspace", deletedAt: null, suspendedAt: null }, user: { id: "owner", role: "admin", owner: true } } as tenant.TenantStore;
  const ast = ts.createSourceFile("auth.ts", readFileSync("lib/auth.ts", "utf8"), ts.ScriptTarget.Latest, true);
  const declaration = ast.statements.find(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === "withTenant")!;
  const compile = (source: string) => ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const wrapped = {} as Pick<typeof auth, "withTenant">;
  new Function("exports", "resolveStore", "runWithStore", "NoTenantError", "MediaSourceError", "workbenchScopeFor", "recoveryRoute", compile(declaration.getText(ast)))(wrapped, async () => store, tenant.runWithStore, tenant.NoTenantError, MediaSourceError, workbenchScopeFor, (handler: unknown) => handler);
  const calls: { name: string; args: unknown[]; workspace: string }[] = [], limits: unknown[][] = [], connections: unknown[] = [];
  let failure: unknown, limited = false;
  const connection = { status: "connected", connected: true };
  const job = { id: key, draftId: "draft-1", workflow: "genjutsu", status: "quoted", quoteCredits: 25, creditUnit: "higgsfield_credits" };
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
    "@/lib/higgsfield-consumer/genjutsu-contract": contract,
    "@/lib/genjutsuTypes": genjutsuTypes,
    /* The handlers kept behind signInOff, as they ran before Release 1 (the switch itself: tests/unit/signinOffRelease1.spec.ts). */
    "@/lib/higgsfield-consumer/retired": { ...retired, signInOff: (kept: unknown) => kept },
    "@/lib/higgsfield-consumer/genjutsu-sources": { ConsumerGenjutsuError },
    "@/lib/higgsfield-consumer/genjutsu-service": {
      consumerGenjutsuJobs: service("list", [job]),
      consumerGenjutsuRuns: service("runs", { jobs: [{ ...job, status: "completed" }], nextCursor: `1700000000000.${key}` }),
      quoteConsumerGenjutsu: service("quote", job),
      submitConsumerGenjutsuJob: service("submit", { ...job, status: "accepted" }),
      pollConsumerGenjutsu: service("status", { job: { ...job, status: "accepted" } }),
    },
  };
  const output = { exports: {} as Record<"GET" | "POST", (request: Request) => Promise<Response>> };
  new Function("require", "module", "exports", compile(readFileSync("app/api/higgsfield/consumer/genjutsu/route.ts", "utf8")))((name: string) => {
    if (!(name in deps)) throw new Error(`Unexpected route dependency ${name}`);
    return deps[name];
  }, output, output.exports);
  return {
    calls, limits, connections, connection, job, store: () => store, setStore: (value: tenant.TenantStore) => { store = value; },
    fail: (value: unknown) => { failure = value; }, limit: () => { limited = true; },
    request: async (method: "GET" | "POST", body: unknown = quote, options: { scope?: string | null; origin?: string; query?: string; raw?: string | Uint8Array; contentLength?: string; empty?: boolean } = {}) => {
      const captured = options.scope === undefined ? scope : options.scope;
      const request = new Request(`https://particl.example/api/higgsfield/consumer/genjutsu${options.query ?? ""}`, {
        method, headers: { ...(captured === null ? {} : { "X-Workbench-Scope": captured }), ...(options.origin ? { Origin: options.origin } : {}), ...(options.contentLength ? { "Content-Length": options.contentLength } : {}) },
        ...(method === "POST" && !options.empty ? { body: (options.raw ?? JSON.stringify(body)) as BodyInit } : {}),
      });
      const fetchBefore = globalThis.fetch;
      globalThis.fetch = async () => { throw new Error("NO_NETWORK_IN_ROUTE_TEST"); };
      try { return await output.exports[method](request); } finally { globalThis.fetch = fetchBefore; }
    },
  };
}

test("Genjutsu consumer routes reject signed-out, nonowner and API-token callers before service access", async () => {
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

test("Genjutsu consumer requests cannot adopt another workspace, user, origin or incomplete MFA session", async () => {
  const f = await fixture(), original = f.store();
  for (const body of [quote, submit, status]) {
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

test("quote and submit answer 410 before any limit or service; status and the saved jobs still reach the service with server-derived identity", async () => {
  const f = await fixture();
  for (const body of [quote, submit]) await expectRetired(await f.request("POST", body, { origin: "https://particl.example" }));
  expect(f.calls).toEqual([]); expect(f.limits).toEqual([]);
  const polled = await f.request("POST", status, { origin: "https://particl.example" });
  expect(polled.status).toBe(200);
  expect(polled.headers.get("Cache-Control")).toBe("private, no-store");
  expect(polled.headers.get("X-Content-Type-Options")).toBe("nosniff");
  expect(await polled.json()).toHaveProperty("job");
  const response = await f.request("GET", undefined, { query: "?draftId=draft-1&userId=other&workspaceId=other" });
  expect(response.status).toBe(200); expect(await response.json()).toEqual({ connection: f.connection, jobs: [f.job], capabilities: { resolutions: ["480p", "720p", "1080p"], minSeconds: 4, maxSeconds: 30, maxImages: 30, maxMediaBytes: 52428800, presetsAvailable: false, importsMediaForQuote: true } });
  expect(f.connections).toEqual([{ workspaceId: "workspace", userId: "owner" }]);
  expect(f.calls).toEqual([
    { name: "status", args: [{ userId: "owner", draftId: "draft-1", id: key }], workspace: "workspace" },
    { name: "list", args: ["owner", "draft-1"], workspace: "workspace" },
  ]);
  expect(f.limits).toEqual([["hf-consumer-genjutsu:workspace:owner:status", 30, 60_000]]);
});

test("a stale tab's quote or submit gets the plain answer whatever its body; the status schema and the GET views stay strict", async () => {
  const f = await fixture();
  const references = Array.from({ length: 30 }, (_, i) => i % 2 ? { genId: `generation-${i}` } : { uploadId: `upload-${i}` });
  const staleRetired = [{ ...quote, userId: "other" }, { ...quote, idempotencyKey: "bad" }, { ...quote, input: { ...input, source: { url: "https://provider.invalid/source.mp4" } } },
    { ...quote, input: { ...input, variant: "object-swap", resolution: "720p", prompt: "", references } }, { ...submit, credits: -1 }, { ...submit, input }];
  for (const body of staleRetired) await expectRetired(await f.request("POST", body));
  const malformed = [null, [], {}, { ...quote, action: "generate" }, { ...status, tool: "generate_video" }, { ...status, userId: "other" }, { ...status, id: "bad" }, { ...status, draftId: "../foreign" }];
  for (const body of malformed) expect((await f.request("POST", body)).status, JSON.stringify(body).slice(0, 150)).toBe(400);
  for (const draftId of ["", "../other", "a".repeat(201)])
    expect((await f.request("GET", undefined, { query: `?draftId=${encodeURIComponent(draftId)}` })).status).toBe(400);
  for (const cursor of ["", "abc", "12", "12.", ".abc", "12.a b", "12.../x", "1e3.abc", "99999999999999999.abc", `12.${"a".repeat(201)}`])
    expect((await f.request("GET", undefined, { query: `?draftId=draft-1&view=runs&cursor=${encodeURIComponent(cursor)}` })).status, cursor).toBe(400);
  /* A cursor pages runs only, and there is one other view: none. */
  for (const query of [`?draftId=draft-1&cursor=1700000000000.${key}`, "?draftId=draft-1&view=all", "?draftId=draft-1&view=",
    "?draftId=draft-1&variant=motion-transfer", "?draftId=draft-1&view=runs&variant=", "?draftId=draft-1&view=runs&variant=lip-sync", "?draftId=draft-1&view=runs&variant=Motion-Transfer"])
    expect((await f.request("GET", undefined, { query })).status, query).toBe(400);
  expect(f.calls).toEqual([]); expect(f.limits).toEqual([]);
});

test("Viral's runs view lists runs only and pages by the cursor the last page ended on, for the signed-in owner only", async () => {
  const f = await fixture();
  const first = await f.request("GET", undefined, { query: "?draftId=draft-1&view=runs&userId=other" });
  expect(first.status).toBe(200);
  const page = await first.json();
  expect(page).toMatchObject({ connection: f.connection, jobs: [{ id: key, status: "completed" }], nextCursor: `1700000000000.${key}` });
  const cursor = page.nextCursor as string;
  expect((await f.request("GET", undefined, { query: `?draftId=draft-1&view=runs&cursor=${encodeURIComponent(cursor)}` })).status).toBe(200);
  /* Recent beside one page lists that page's variant only. */
  expect((await f.request("GET", undefined, { query: "?draftId=draft-1&view=runs&variant=object-swap" })).status).toBe(200);
  expect(f.calls).toEqual([
    { name: "runs", args: ["owner", "draft-1", null, null], workspace: "workspace" },
    { name: "runs", args: ["owner", "draft-1", cursor, null], workspace: "workspace" },
    { name: "runs", args: ["owner", "draft-1", null, "object-swap"], workspace: "workspace" },
  ]);
  expect(f.connections).toEqual(Array.from({ length: 3 }, () => ({ workspaceId: "workspace", userId: "owner" })));
});

test("Genjutsu body validation bounds actual UTF8 bytes and reports malformed JSON without leaking content", async () => {
  const f = await fixture();
  for (const raw of ["{broken", "", '{"input":"PRIVATE_MARKER"', new Uint8Array([0xc3, 0x28])]) {
    const response = await f.request("POST", undefined, { raw });
    expect(response.status).toBe(400); expect(await response.text()).not.toContain("PRIVATE_MARKER");
  }
  expect((await f.request("POST", undefined, { empty: true })).status).toBe(400);
  for (const options of [{ contentLength: "24001" }, { raw: " ".repeat(24001), contentLength: "1" }, { raw: `"${"😀".repeat(6000)}"` }])
    expect((await f.request("POST", quote, options)).status).toBe(413);
  expect(f.calls).toEqual([]); expect(f.limits).toEqual([]);
});

test("a paused workspace can still read a running job; limits block status, and quote or submit never reaches the limits", async () => {
  const f = await fixture(), original = f.store();
  f.setStore({ ...original, workspace: { ...original.workspace!, suspendedAt: 1, suspendedReason: "Paused" } });
  await expectRetired(await f.request("POST", submit)); expect(f.calls).toEqual([]);
  expect((await f.request("POST", status)).status).toBe(200);
  expect(f.calls.map(call => call.name)).toEqual(["status"]);
  f.setStore(original); f.limit();
  const limited = await f.request("POST", status);
  expect(limited.status).toBe(429); expect(await limited.text()).not.toContain("PRIVATE_RATE_STATE");
  for (const body of [quote, submit]) await expectRetired(await f.request("POST", body));
  expect(f.calls.map(call => call.name)).toEqual(["status"]);
  expect(f.limits.map(args => args[0])).toEqual(["hf-consumer-genjutsu:workspace:owner:status", "hf-consumer-genjutsu:workspace:owner:status"]);
});

test("Genjutsu recoverable errors preserve bounded categories and never expose provider or storage details", async () => {
  const f = await fixture();
  for (const [error, expected] of [[new ConsumerOAuthError("reconnect_required"), 401], [new ConsumerDiscoveryError("timeout"), 504],
    [new ConsumerJobError("quote_expired"), 409], [new ConsumerJobError("capacity"), 409], [new ConsumerJobError("not_found", 404), 404],
    [new ConsumerVideoServiceError("not_found", "This Genjutsu job is not available.", 404), 404],
    [new ConsumerVideoServiceError("approval_changed", "Review this job’s wallet and exact credit quote again."), 409],
    [new ConsumerVideoError("quote_changed"), 409], [new ConsumerGenjutsuError("source_limits", 400), 400],
    [new ConsumerGenjutsuError("import_uncertain"), 409], [new ConsumerOriginalError("quota"), 507],
    [new ConsumerOriginalError("deleted"), 409], [new ConsumerOriginalError("invalid_video"), 422],
    [new Error("PRIVATE_PROVIDER_TOKEN_AND_URL"), 503]] as const) {
    f.fail(error); Object.assign(error, { cause: new Error("PRIVATE_PROVIDER_TOKEN_AND_URL") });
    const response = await f.request("POST", status);
    expect(response.status, error.message).toBe(expected);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await response.text()).not.toContain("PRIVATE_PROVIDER_TOKEN_AND_URL");
  }
});

test("the Viral pages ask for submitted jobs only; every other reader keeps the full list", async () => {
  const f = await fixture();
  expect((await f.request("GET", undefined, { query: "?draftId=draft-1&results=submitted" })).status).toBe(200);
  expect((await f.request("GET", undefined, { query: "?draftId=draft-1&results=everything" })).status).toBe(200);
  expect(f.calls).toEqual([
    { name: "list", args: ["owner", "draft-1", { submittedOnly: true }], workspace: "workspace" },
    { name: "list", args: ["owner", "draft-1"], workspace: "workspace" },
  ]);
});
