import { test, expect } from "@playwright/test";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import ts from "typescript";
import * as zod from "zod";
import * as tenant from "../../lib/tenant";
import { MediaSourceError } from "../../lib/mediaBindings";
import { workbenchScopeFor } from "../../lib/workbench/request-scope";
import { AccountError } from "../../lib/accountDb";
import * as retired from "../../lib/higgsfield-consumer/retired";
import { PLANS } from "../../lib/workspace/plans";

/**
 * The guard for the retired Higgsfield sign-in (lib/higgsfield-consumer/retired.ts):
 * no feature may need a sign-in to a Higgsfield account. Every account route
 * that could price, start or build work, or read the account's catalogue,
 * presets, voices or diagnostics answers 410 before any rate allowance or
 * service is touched. What jobs already running need to finish
 * (status reads, saved-job lists, a lost batch's check, set-aside), the
 * credit history and Disconnect still reach their code.
 *
 * Each route runs for real — the tenant wrapper, the owner and render
 * guards, the body reader, the route's own schemas — and every function any
 * account module exports is replaced by a recorder that throws: a 410 with
 * nothing recorded means the refusal came first.
 */

const ACCOUNT_ROUTES = "app/api/higgsfield/consumer";
/** Routes off entirely: every handler answers the retirement, for anyone. */
const OFF: Record<string, { file: string; method: "GET" | "POST" }> = {
  connect: { file: `${ACCOUNT_ROUTES}/connect/route.ts`, method: "POST" },
  client: { file: `${ACCOUNT_ROUTES}/client/route.ts`, method: "GET" },
  capabilities: { file: `${ACCOUNT_ROUTES}/capabilities/route.ts`, method: "POST" },
  qualification: { file: `${ACCOUNT_ROUTES}/qualification/route.ts`, method: "POST" },
  "analysis-qualification": { file: `${ACCOUNT_ROUTES}/analysis-qualification/route.ts`, method: "POST" },
};
/** Routes that keep their reads: each retired action, and what stays with a request that reaches its service. */
const MIXED: Record<string, { file: string; retired: string[]; stays: Record<string, Record<string, unknown>> }> = {
  generation: {
    file: `${ACCOUNT_ROUTES}/generation/route.ts`,
    retired: ["catalogue", "quote", "submit", "quote-batch", "submit-batch", "explainer-presets", "characters", "characters-plan", "characters-create", "elements", "elements-create"],
    stays: {
      status: { action: "status", draftId: "draft-1", id: "11111111-1111-4111-8111-111111111111" },
      "check-batch": { action: "check-batch", draftId: "draft-1", ids: ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"] },
    },
  },
  genjutsu: {
    file: `${ACCOUNT_ROUTES}/genjutsu/route.ts`,
    retired: ["quote", "submit"],
    stays: { status: { action: "status", draftId: "draft-1", id: "11111111-1111-4111-8111-111111111111" } },
  },
  video: {
    file: `${ACCOUNT_ROUTES}/video/route.ts`,
    retired: ["quote", "quote-rehearsal", "submit", "setup"],
    stays: { status: { action: "status", draftId: "draft-1", id: "11111111-1111-4111-8111-111111111111" } },
  },
  "marketing-templates": {
    file: `${ACCOUNT_ROUTES}/marketing-templates/route.ts`,
    retired: ["catalogue", "costs", "quote", "submit"],
    stays: { status: { action: "status", draftId: "draft-1", id: "11111111-1111-4111-8111-111111111111" } },
  },
  shorts: {
    file: `${ACCOUNT_ROUTES}/shorts/route.ts`,
    retired: ["presets", "quote", "submit"],
    stays: { status: { action: "status", draftId: "draft-1", id: "11111111-1111-4111-8111-111111111111" } },
  },
  "audio-tools": {
    file: `${ACCOUNT_ROUTES}/audio-tools/route.ts`,
    retired: ["voices", "quote", "submit"],
    stays: { status: { action: "status", draftId: "draft-1", id: "11111111-1111-4111-8111-111111111111" } },
  },
  connection: {
    file: `${ACCOUNT_ROUTES}/connection/route.ts`,
    retired: ["developer-probe"],
    stays: { "set-aside": { action: "set-aside", id: "11111111-1111-4111-8111-111111111111" } },
  },
};
/** Every route under /api/higgsfield/consumer is classified here; a new one fails this guard until it is. */
const CLASSIFIED = ["activity", "callback", ...Object.keys(OFF), ...Object.keys(MIXED)];
/** Modules a route may use as they are: nothing in them reaches the account. */
const AS_IS: Record<string, unknown> = {
  zod,
  "@/lib/tenant": tenant,
  "@/lib/higgsfield-consumer/retired": retired,
};
const scope = workbenchScopeFor("workspace", "owner");

async function withTenantFor(store: () => tenant.TenantStore) {
  const auth = await import("../../lib/auth");
  const ast = ts.createSourceFile("auth.ts", readFileSync("lib/auth.ts", "utf8"), ts.ScriptTarget.Latest, true);
  const declaration = ast.statements.find((statement) => ts.isFunctionDeclaration(statement) && statement.name?.text === "withTenant")!;
  const wrapped = {} as Pick<typeof auth, "withTenant">;
  new Function("exports", "resolveStore", "runWithStore", "NoTenantError", "MediaSourceError", "workbenchScopeFor", "recoveryRoute", compile(declaration.getText(ast)))(
    wrapped, async () => store(), tenant.runWithStore, tenant.NoTenantError, MediaSourceError, workbenchScopeFor, (handler: unknown) => handler,
  );
  return { ...auth, withTenant: wrapped.withTenant };
}
function compile(source: string) {
  return ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
}
/** A module whose functions all record and throw; its constants, schemas and error classes are the real ones. */
function recorder(id: string, loaded: Record<string, unknown>, touched: string[]) {
  /* A CommonJS-compiled module's re-exports sit on its default export (the exports object). */
  const inner = loaded.default && typeof loaded.default === "object" ? loaded.default as Record<string, unknown> : {};
  const copy: Record<string, unknown> = { ...inner, ...loaded };
  return new Proxy(copy, {
    get(target, prop) {
      const value = target[prop as string];
      if (typeof prop === "string" && typeof value === "function" && /^[a-z]/.test(prop))
        return (...args: unknown[]) => { void args; touched.push(`${id}#${prop}`); throw new Error(`ROUTE_REACHED:${prop}`); };
      return value;
    },
  });
}
function importSpecifiers(source: string) {
  return [...new Set([...source.matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1]))];
}

async function loadRoute(file: string) {
  let store = { workspace: { id: "workspace", deletedAt: null, suspendedAt: null }, user: { id: "owner", role: "admin", owner: true } } as tenant.TenantStore;
  const touched: string[] = [], limits: unknown[][] = [];
  const auth = await withTenantFor(() => store);
  const scopeModule = await import("../../lib/workbench/request-scope");
  const requestBody = await import("../../lib/requestBody");
  const source = readFileSync(file, "utf8");
  const deps: Record<string, unknown> = {};
  for (const id of importSpecifiers(source)) {
    if (id === "@/lib/auth") deps[id] = auth;
    else if (id === "@/lib/accountDb") deps[id] = { AccountError, takeAccountLimit: async (...args: unknown[]) => { limits.push(args); } };
    else if (id === "@/lib/requestBody") deps[id] = requestBody;
    else if (id === "@/lib/workbench/request-scope") deps[id] = scopeModule;
    else if (id in AS_IS) deps[id] = AS_IS[id];
    else if (id.startsWith("@/lib/")) deps[id] = recorder(id, await import(`../../${id.slice(2)}`) as Record<string, unknown>, touched);
    else throw new Error(`Unclassified route dependency ${id} in ${file}`);
  }
  const output = { exports: {} as Record<string, (request: Request) => Promise<Response>> };
  new Function("require", "module", "exports", compile(source))((name: string) => {
    if (!(name in deps)) throw new Error(`Unexpected route dependency ${name}`);
    return deps[name];
  }, output, output.exports);
  return {
    touched, limits, handlers: output.exports,
    setStore: (value: tenant.TenantStore) => { store = value; },
    call: async (method: string, body?: unknown) => {
      const request = new Request(`https://particl.example/${file}`, {
        method, headers: { "X-Workbench-Scope": scope, "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const fetchBefore = globalThis.fetch;
      let network = 0;
      globalThis.fetch = async () => { network++; throw new Error("NO_NETWORK_IN_GUARD"); };
      try {
        /* A recorder thrown out of a route's own error handler still means the request reached the account code. */
        const response = await output.exports[method](request).catch((error: unknown) => {
          if (error instanceof Error && error.message.startsWith("ROUTE_REACHED:")) return new Response(null, { status: 599 });
          throw error;
        });
        return { response, network };
      } finally {
        globalThis.fetch = fetchBefore;
      }
    },
  };
}

async function expectRetired(response: Response) {
  expect(response.status).toBe(410);
  expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  expect(await response.json()).toEqual({ code: "retired", error: retired.SIGN_IN_RETIRED_MESSAGE });
}

test("every route under /api/higgsfield/consumer is classified: off, mixed, the callback or the credit history", () => {
  const found = readdirSync(ACCOUNT_ROUTES, { withFileTypes: true }).filter((entry) => entry.isDirectory() && existsSync(`${ACCOUNT_ROUTES}/${entry.name}/route.ts`)).map((entry) => entry.name).sort();
  expect(found).toEqual(CLASSIFIED.filter((name) => existsSync(`${ACCOUNT_ROUTES}/${name}/route.ts`)).sort());
  expect(found).toHaveLength(14);
});

test("the sign-in, discovery and qualification routes answer 410 to anyone, and import nothing but the retirement", async () => {
  for (const [name, route] of Object.entries(OFF)) {
    expect(importSpecifiers(readFileSync(route.file, "utf8")), name).toEqual(["@/lib/higgsfield-consumer/retired"]);
    const loaded = await loadRoute(route.file);
    const { response, network } = await loaded.call(route.method, route.method === "POST" ? { view: "reach", workspaceId: "other" } : undefined);
    await expectRetired(response);
    expect(network, name).toBe(0);
    expect(loaded.touched, name).toEqual([]);
    expect(loaded.limits, name).toEqual([]);
  }
});

test("a sign-in started before the retirement is never finished: its callback uses nothing of the sign-in but the way back", async () => {
  const file = `${ACCOUNT_ROUTES}/callback/route.ts`;
  expect(importSpecifiers(readFileSync(file, "utf8"))).toEqual(["@/lib/higgsfield-consumer/oauth", "@/lib/higgsfield-consumer/retired"]);
  const loaded = await loadRoute(file);
  const { response, network } = await loaded.call("GET");
  /* The way back is recorded like every account function (so here it throws, and the route falls back to the plain refusal);
     nothing else of the sign-in is touched. The redirect itself: tests/unit/higgsfieldConsumerOAuth.spec.ts. */
  expect(loaded.touched).toEqual(["@/lib/higgsfield-consumer/oauth#consumerCallbackLocation"]);
  await expectRetired(response);
  expect(network).toBe(0);
});

test("every retired action on the mixed routes answers 410 before the rate allowance or any service, for any body", async () => {
  for (const [name, route] of Object.entries(MIXED)) {
    const loaded = await loadRoute(route.file);
    for (const action of route.retired) {
      /* A stale tab's body need not match the schema any more: the action alone decides. */
      for (const body of [{ action }, { action, draftId: "../foreign", credits: -1, input: { url: "https://provider.invalid/x" } }]) {
        const { response, network } = await loaded.call("POST", body);
        await expectRetired(response);
        expect(network, `${name} ${action}`).toBe(0);
      }
    }
    expect(loaded.touched, name).toEqual([]);
    expect(loaded.limits, name).toEqual([]);
  }
});

test("what running jobs need still reaches its code: status, a lost batch's check, set-aside, the saved lists and Disconnect", async () => {
  for (const [name, route] of Object.entries(MIXED)) {
    const loaded = await loadRoute(route.file);
    for (const [action, body] of Object.entries(route.stays)) {
      const before = loaded.touched.length;
      const { response } = await loaded.call("POST", body);
      expect(response.status, `${name} ${action}`).not.toBe(410);
      expect(loaded.touched.length, `${name} ${action} reaches its service`).toBeGreaterThan(before);
    }
    expect(loaded.limits.length, name).toBe(Object.keys(route.stays).length);
  }
  /* The saved-job lists and the connection read are GET; Disconnect is DELETE. None is retired. */
  for (const file of ["generation", "genjutsu", "video", "marketing-templates", "shorts", "audio-tools", "connection"].map((name) => `${ACCOUNT_ROUTES}/${name}/route.ts`)) {
    const loaded = await loadRoute(file);
    const query = file.includes("/connection/") ? "" : "?draftId=draft-1";
    const request = new Request(`https://particl.example/${file}${query}`, { headers: { "X-Workbench-Scope": scope } });
    const response = await loaded.handlers.GET(request);
    expect(response.status, file).not.toBe(410);
    expect(loaded.touched.length, `${file} GET reaches its read`).toBeGreaterThan(0);
  }
  const connection = await loadRoute(`${ACCOUNT_ROUTES}/connection/route.ts`);
  const disconnect = await connection.handlers.DELETE(new Request(`https://particl.example/${ACCOUNT_ROUTES}/connection`, { method: "DELETE", headers: { "X-Workbench-Scope": scope } }));
  expect(disconnect.status).not.toBe(410);
  expect(connection.touched).toEqual(["@/lib/higgsfield-consumer/oauth#removeConsumerConnection"]);
  /* The credit history reads the ledger only; it is not an account call and not retired. */
  expect(importSpecifiers(readFileSync(`${ACCOUNT_ROUTES}/activity/route.ts`, "utf8"))).not.toContain("@/lib/higgsfield-consumer/retired");
});

test("each mixed route retires exactly its new-work actions, and checks before its allowance, render gate or service", () => {
  for (const [name, route] of Object.entries(MIXED)) {
    const source = readFileSync(route.file, "utf8");
    if (name === "connection") {
      /* No schema here: set-aside is handled, developer-probe is retired, anything else is refused as malformed. */
      expect(source).toContain('if (body?.action === "developer-probe") return retiredResponse();');
      expect(source).not.toContain("probeDeveloperApi");
      continue;
    }
    const actions = [...new Set([...source.matchAll(/action:\s*z\.literal\("([^"]+)"\)/g)].map((match) => match[1]))].sort();
    /* Every action the schema accepts is either retired or one of the reads that stay. */
    expect(actions, name).toEqual([...route.retired, ...Object.keys(route.stays)].sort());
    const declared = source.match(/const RETIRED = new Set\(\[([^\]]*)\]\)/);
    expect(declared, name).not.toBeNull();
    expect([...declared![1].matchAll(/"([^"]+)"/g)].map((match) => match[1]).sort(), name).toEqual([...route.retired].sort());
    const post = source.slice(source.indexOf("export const POST"));
    const check = post.indexOf("if (asksRetired(raw, RETIRED)) return retiredResponse();");
    expect(check, name).toBeGreaterThan(0);
    for (const later of ["takeAccountLimit(", "requireRender(", ".safeParse("]) {
      const at = post.indexOf(later);
      if (at >= 0) expect(check, `${name}: the retirement is checked before ${later}`).toBeLessThan(at);
    }
  }
});

test("Atomik reads nothing of the account, and the shell's capability answers member for everyone", () => {
  expect(retired.SIGN_IN_RETIRED).toBe(true);
  /* Atomik's account planner, recipes and connected step are gone (tests/unit/atomikNoAccount.spec.ts guards what replaced them). */
  for (const gone of ["app/api/atomik/recipes/route.ts", "app/api/atomik/steps/[id]/connected/route.ts", "lib/higgsfield-consumer/planner-service.ts", "lib/higgsfield-consumer/recipes-service.ts"])
    expect(existsSync(gone), gone).toBe(false);
  const hook = readFileSync("lib/shell/use-connected-capability.ts", "utf8");
  expect(hook).toContain('owner: false, status: "member" as const');
  expect(hook).not.toMatch(/fetch\(|CONNECTION_ENDPOINT|session\.owner/);
  /* No workspace plan calls an account route, not even to read: Compare reads the project's Library (GET /api/workbench/library). */
  for (const [page, plan] of Object.entries(PLANS))
    for (const step of plan.steps) expect(step.executor.backend.path, `${page}: ${step.label}`).not.toMatch(/^\/api\/higgsfield\/consumer\//);
  expect(readFileSync("lib/workspace/plans.ts", "utf8")).not.toContain("/api/higgsfield/consumer");
});

test("no page mounts a surface that starts account work: the sign-in card, the developer check, the account's composers and forms", () => {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(path);
      else if (/\.tsx?$/.test(entry.name)) files.push(path);
    }
  };
  for (const root of ["app", "components", "lib"]) walk(root);
  const retiredSurfaces = ["HiggsfieldConsumerConnection", "ConsumerVideoVerification", "DeveloperApiRow", "AtomikGenerate", "ConsumerGenjutsu", "ConsumerShorts", "ConsumerMarketingVideo", "ShortsPage", "FormPage", "WorkflowHosts", "WorkflowHost", "AtomikVoiceTools"];
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    for (const surface of retiredSurfaces) expect(source, `${file} mounts ${surface}`).not.toMatch(new RegExp(`import[^;]*\\b${surface}\\b[^;]*from`));
    /* Nothing starts a sign-in: the connect route is called from nowhere, and no page builds the account's sign-in address
       (the server's own sign-in code goes in its own step). */
    expect(source, file).not.toContain("/api/higgsfield/consumer/connect\"");
    if (!file.startsWith("lib/higgsfield-consumer/") && !file.startsWith("app/api/")) expect(source, file).not.toContain("clerk.higgsfield.ai");
  }
});

/* ── What R3 took out: the account's UI and the shell's wiring to it (the server code goes in its own step) ── */

const uiFiles = () => {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(path);
      else if (/\.tsx?$/.test(entry.name)) files.push(path);
    }
  };
  for (const root of ["components", "lib/shell", "lib/workspace"]) walk(root);
  for (const entry of readdirSync("app", { withFileTypes: true, recursive: true })) {
    const path = `${entry.parentPath}/${entry.name}`;
    if (entry.isFile() && /(page|layout)\.tsx$/.test(entry.name) && !path.startsWith("app/api")) files.push(path);
  }
  return files;
};

test("the account's screens are deleted: its composers, forms, workflows, collector, diagnostics and connection card", () => {
  for (const gone of [
    "components/graphite/DeveloperApiRow.tsx", "components/graphite/tools/WorkflowHost.tsx",
    "components/suites/ConsumerGenjutsu.tsx", "components/suites/ConsumerMarketingVideo.tsx", "components/suites/consumer-marketing-video.module.css",
    "components/suites/ConsumerShorts.tsx", "components/suites/AtomikVoiceTools.tsx", "components/suites/atomik-generate.module.css",
    "components/management/HiggsfieldConsumerConnection.tsx", "components/management/ConsumerVideoVerification.tsx",
    "components/workspace/pages/ShortsPage.tsx", "components/workspace/mobile/pages/FormPage.tsx",
    "lib/shell/workflows.ts", "lib/shell/use-connected-collector.ts", "lib/workspace/mobile-form.ts",
  ]) expect(existsSync(gone), gone).toBe(false);
});

test("nothing a page renders reads the account's client: only the retired card pages kept for their replacements, and the history readers", () => {
  /* The pages still on the retired card until their API-key or Particl versions land, the modules only they use,
     and Workspace › Engines' retired row (the running jobs to set aside, and Disconnect). Nothing else. */
  const KEPT = new Set([
    "components/graphite/business/BusinessView.tsx", "components/graphite/viral/ViralView.tsx", "components/graphite/production/CastStage.tsx",
    "components/graphite/tools/SoulIdHost.tsx", "components/graphite/OwnerRunCard.tsx", "components/graphite/ResumedJobs.tsx",
    "components/suites/MarketingTemplates.tsx", "components/graphite/ConnectedAccountRow.tsx",
    "lib/shell/business.ts", "lib/shell/use-business.ts", "lib/shell/viral.ts", "lib/shell/use-viral.ts",
    "lib/shell/use-connected-job.ts", "lib/shell/use-resumed-jobs.ts", "lib/shell/connected-collector.ts",
  ]);
  /* History: a take the account made, read from Particl's own records (the Usage and /usage tabs, the tray's words). */
  const HISTORY = /higgsfield-consumer\/(activity-types|job-state|resume|retired)"/;
  for (const file of uiFiles()) {
    if (KEPT.has(file)) continue;
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(/from "[^"]*higgsfield-consumer\/[^"]+"/g)) expect(match[0], `${file} imports ${match[0]}`).toMatch(HISTORY);
    expect(source, file).not.toMatch(/\/api\/higgsfield\/consumer\/(generation|genjutsu|video|shorts|audio-tools|marketing-templates|capabilities|qualification|analysis-qualification|client)\b/);
  }
});

test("Gen, its composers and the shell's chrome carry no account source, catalogue, identity, resumed take, Analysis or owner gate", () => {
  for (const file of [
    "components/graphite/GenView.tsx", "components/graphite/ModelSheet.tsx", "components/workspace/GenerateComposer.tsx", "components/workspace/mobile/MakeComposer.tsx",
    "lib/workspace/composer.ts", "lib/workspace/use-composer.ts", "lib/workspace/take-batch.ts", "lib/workspace/model-picker.ts",
    "components/graphite/StageStrip.tsx", "components/graphite/PageHead.tsx", "components/graphite/AtomikSheet.tsx", "components/workspace/AtomikPanel.tsx",
    "components/workspace/mobile/sheets/AtomikSheet.tsx", "components/workspace/spec/SpecInspector.tsx", "lib/workspace/atomik-host.tsx", "lib/shell/state.tsx",
  ]) {
    const source = readFileSync(file, "utf8");
    expect(source, file).not.toMatch(/useConnectedCapability|useConnectedCollector|useResumedConnectedJobs|runsOnOwnerAccount|ownerAccountPlans|connected-collector|ResumedJobs|WorkflowHost/);
    /* A take made on the account is still named as one when it is recreated (its recipe's `billing`), but the composer holds no such source. */
    expect(source, file).not.toMatch(/state\.billing|type: "billing"|connected cr|gen-tab-analysis|gen-resumed|gen-identity|action: "characters"|action: "catalogue"/);
  }
});
