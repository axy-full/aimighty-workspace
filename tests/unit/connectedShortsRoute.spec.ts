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
import * as studio from "../../lib/higgsfield-consumer/shorts-studio";

const key = "11111111-1111-4111-8111-111111111111";
const wallet = "22222222-2222-4222-8222-222222222222";
const input = { source: { uploadId: "clip-original" }, preset: { id: "7fa32a45-2f1e-45ed-8cc7-03296ddcf07f", source: "cms", name: "Bold Urban" }, aspectRatio: "9:16" };
const quote = { action: "quote", draftId: "draft-1", input, idempotencyKey: key };
const submit = { action: "submit", draftId: "draft-1", id: key, workspaceId: wallet, credits: 40 };
const status = { action: "status", draftId: "draft-1", id: key };
const presets = { action: "presets" };
const scope = workbenchScopeFor("workspace", "owner");

/** The real tenant wrapper, owner/render guards, body reader and route schema;
 * session resolution, rate storage and the Shorts service are isolated. */
async function fixture() {
  const auth = await import("../../lib/auth");
  let store = { workspace: { id: "workspace", deletedAt: null, suspendedAt: null }, user: { id: "owner", role: "admin", owner: true } } as tenant.TenantStore;
  const ast = ts.createSourceFile("auth.ts", readFileSync("lib/auth.ts", "utf8"), ts.ScriptTarget.Latest, true);
  const declaration = ast.statements.find((statement) => ts.isFunctionDeclaration(statement) && statement.name?.text === "withTenant")!;
  const compile = (source: string) => ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const wrapped = {} as Pick<typeof auth, "withTenant">;
  new Function("exports", "resolveStore", "runWithStore", "NoTenantError", "MediaSourceError", "workbenchScopeFor", "recoveryRoute", compile(declaration.getText(ast)))(wrapped, async () => store, tenant.runWithStore, tenant.NoTenantError, MediaSourceError, workbenchScopeFor, (handler: unknown) => handler);
  const calls: { name: string; args: unknown[] }[] = [], limits: unknown[][] = [];
  let failure: unknown;
  const job = { id: key, draftId: "draft-1", status: "quoted", quoteCredits: 40, creditUnit: "higgsfield_credits", clips: [] };
  const service = (name: string, result: unknown) => async (...args: unknown[]) => { calls.push({ name, args }); if (failure) throw failure; return result; };
  const deps: Record<string, unknown> = {
    zod,
    "@/lib/auth": { ...auth, withTenant: wrapped.withTenant },
    "@/lib/tenant": tenant,
    "@/lib/accountDb": { AccountError, takeAccountLimit: async (...args: unknown[]) => { limits.push(args); } },
    "@/lib/requestBody": requestBody,
    "@/lib/higgsfield-consumer/oauth": { ConsumerOAuthError, getConsumerConnection: async () => ({ connected: true }) },
    "@/lib/higgsfield-consumer/mcp": { ConsumerDiscoveryError },
    "@/lib/higgsfield-consumer/jobs": { ConsumerJobError },
    "@/lib/higgsfield-consumer/video-contract": { ConsumerVideoError },
    "@/lib/higgsfield-consumer/video-service": { ConsumerVideoServiceError },
    "@/lib/higgsfield-consumer/video-original": { ConsumerOriginalError },
    "@/lib/higgsfield-consumer/genjutsu-sources": { ConsumerGenjutsuError },
    "@/lib/higgsfield-consumer/generation-sources": { GENERATION_SOURCE_BYTES: 52428800 },
    "@/lib/higgsfield-consumer/shorts-studio": studio,
    "@/lib/higgsfield-consumer/shorts-service": {
      consumerShortsJobs: service("list", [job]),
      connectedShortsPresets: service("presets", { presets: [], complete: true, fetchedAt: 1 }),
      quoteConsumerShorts: service("quote", job),
      submitConsumerShortsJob: service("submit", { ...job, status: "accepted" }),
      pollConsumerShorts: service("status", { job: { ...job, status: "accepted" } }),
    },
  };
  const output = { exports: {} as Record<"GET" | "POST", (request: Request) => Promise<Response>> };
  new Function("require", "module", "exports", compile(readFileSync("app/api/higgsfield/consumer/shorts/route.ts", "utf8")))((name: string) => {
    if (!(name in deps)) throw new Error(`Unexpected route dependency ${name}`);
    return deps[name];
  }, output, output.exports);
  return {
    calls, limits, store: () => store, setStore: (value: tenant.TenantStore) => { store = value; }, fail: (value: unknown) => { failure = value; },
    request: async (method: "GET" | "POST", body: unknown = quote, options: { scope?: string | null; query?: string } = {}) => {
      const captured = options.scope === undefined ? scope : options.scope;
      const request = new Request(`https://particl.example/api/higgsfield/consumer/shorts${options.query ?? ""}`, {
        method, headers: captured === null ? {} : { "X-Workbench-Scope": captured }, ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
      });
      const fetchBefore = globalThis.fetch;
      globalThis.fetch = async () => { throw new Error("NO_NETWORK_IN_ROUTE_TEST"); };
      try { return await output.exports[method](request); } finally { globalThis.fetch = fetchBefore; }
    },
  };
}

test("Shorts routes reject signed-out, non-owner and API-token callers before any service access", async () => {
  const f = await fixture(), original = f.store();
  for (const method of ["GET", "POST"] as const) {
    f.setStore({ ...original, user: null });
    expect((await f.request(method, quote, { scope: null })).status).toBe(401);
    f.setStore({ ...original, user: { ...original.user!, role: "admin", owner: false } });
    expect((await f.request(method)).status).toBe(403);
    f.setStore({ ...original, token: { id: "api-token", name: "Fixture", scope: "render", capUsd: null } });
    expect((await f.request(method, quote, { scope: null })).status).toBe(403);
  }
  expect(f.calls).toEqual([]); expect(f.limits).toEqual([]);
});

test("owner presets, quote, exact approval and status reach the service with server identity; strict schemas refuse overrides", async () => {
  const f = await fixture();
  const listing = await f.request("GET", undefined, { query: "?draftId=draft-1" });
  expect(listing.status).toBe(200);
  const body = await listing.json();
  expect(body.capabilities).toMatchObject({ shorts: true, aspectRatios: ["9:16", "16:9"], resolution: "720p", minSourceSeconds: 4, maxSourceSeconds: 120, maxClips: 20, cancel: false });
  expect(JSON.stringify(body.capabilities).toLowerCase()).not.toContain("higgsfield");
  for (const request of [presets, quote, submit, status]) expect((await f.request("POST", request)).status, JSON.stringify(request)).toBe(200);
  expect(f.calls.map((call) => call.name)).toEqual(["list", "presets", "quote", "submit", "status"]);
  expect(f.calls[2].args).toEqual(["owner", "draft-1", input, key]);
  expect(f.calls[3].args).toEqual([{ userId: "owner", draftId: "draft-1", id: key }, submit]);
  expect(f.limits.map((args) => args[1])).toEqual([12, 6, 6, 30]);
  for (const bad of [
    { ...quote, input: { ...input, resolution: "1080p" } }, { ...quote, input: { ...input, source: { url: "https://example.com/a.mp4" } } },
    { ...quote, userId: "other" }, { ...submit, credits: -1 }, { action: "create_preset" }, { ...quote, input: { ...input, aspectRatio: "1:1" } },
  ]) expect((await f.request("POST", bad)).status, JSON.stringify(bad)).toBe(400);
  f.fail(new studio.ShortsStudioError("contract_unverified", "The connected account's Shorts Studio tools do not advertise the arguments this workflow sends. Nothing was submitted."));
  const refused = await f.request("POST", quote);
  expect(refused.status).toBe(502);
  expect(await refused.json()).toEqual({ code: "contract_unverified", error: "The connected account's Shorts Studio tools do not advertise the arguments this workflow sends. Nothing was submitted." });
});
