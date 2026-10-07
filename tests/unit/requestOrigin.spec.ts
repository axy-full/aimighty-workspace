import { test, expect } from "@playwright/test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import ts from "typescript";
import { MediaSourceError } from "../../lib/mediaBindings";
import { NoTenantError, runWithStore, type TenantStore } from "../../lib/tenant";
import { workbenchScopeFor } from "../../lib/workbench/request-scope";
import { crossOriginProblem, expectedOrigin, proxiedPublicOrigin } from "../../lib/requestOrigin";

const dir = mkdtempSync(path.join(tmpdir(), "particl-request-origin-"));
process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";

/* A self-hosted standalone server behind a TLS-ending proxy: Next builds req.url from the listen address. */
const LISTEN = "http://localhost:3000";
const PUBLIC = "https://app.203-0-113-7.sslip.io";
const BEHIND_PROXY = { SELFHOST_BEHIND_PROXY: "1", APP_ORIGIN: PUBLIC };

function post(url: string, origin?: string | null) {
  return new Request(url, {
    method: "POST",
    headers: { "Content-Type": "text/plain", ...(origin == null ? {} : { Origin: origin }) },
    body: JSON.stringify({ email: "nobody@example.test", password: "not-a-password-2026" }),
  });
}

test("without the proxy setting the rule is exactly today's: same origin or no Origin passes, anything else is refused", () => {
  for (const env of [{}, { APP_ORIGIN: "https://particl.test" }, { APP_ORIGIN: "https://elsewhere.test" }]) {
    const url = "https://particl.test/api/auth/login";
    expect(crossOriginProblem(post(url, "https://particl.test"), env)).toBe(false);
    expect(crossOriginProblem(post(url), env)).toBe(false); // non-browser API callers, as before
    expect(crossOriginProblem(post(url, ""), env)).toBe(false); // an empty header reads as absent, as before
    for (const bad of ["https://attacker.test", "null", "http://particl.test", "https://particl.test:8443", "https://particl.test/", "https://evil.particl.test", "https://particl.test.evil.test", "HTTPS://PARTICL.TEST"])
      expect(crossOriginProblem(post(url, bad), env), `${bad} with ${JSON.stringify(env)}`).toBe(true);
  }
  /* APP_ORIGIN alone changes nothing: a page on APP_ORIGIN posting to another host is still refused. */
  expect(crossOriginProblem(post("https://particl-git-x.vercel.app/api/auth/login", "https://particl.test"), { APP_ORIGIN: "https://particl.test" })).toBe(true);
});

test("behind the proxy the expected origin is APP_ORIGIN, and only APP_ORIGIN", () => {
  const url = `${LISTEN}/api/auth/login`;
  expect(expectedOrigin(post(url), BEHIND_PROXY)).toBe(PUBLIC);
  expect(crossOriginProblem(post(url, PUBLIC), BEHIND_PROXY)).toBe(false);
  expect(crossOriginProblem(post(url), BEHIND_PROXY)).toBe(false); // missing Origin: unchanged
  /* The listen address is not a public origin: a page there (another local app on the visitor's machine) is refused. */
  expect(crossOriginProblem(post(url, LISTEN), BEHIND_PROXY)).toBe(true);
  expect(crossOriginProblem(post(`https://localhost:3000/api/auth/login`, "https://localhost:3000"), BEHIND_PROXY)).toBe(true);
  for (const bad of ["null", "https://attacker.test", "http://app.203-0-113-7.sslip.io", "https://app.203-0-113-7.sslip.io:3000", "https://x.app.203-0-113-7.sslip.io", "https://app.203-0-113-7.sslip.io.attacker.test", `${PUBLIC}/`, "HTTPS://APP.203-0-113-7.SSLIP.IO"])
    expect(crossOriginProblem(post(url, bad), BEHIND_PROXY), bad).toBe(true);
});

test("headers the client sends never decide the expected origin", () => {
  const spoofed = new Request(`${LISTEN}/api/auth/login`, {
    method: "POST",
    headers: { Origin: "https://attacker.test", Host: "attacker.test", "X-Forwarded-Host": "attacker.test", "X-Forwarded-Proto": "https", Forwarded: "host=attacker.test;proto=https" },
  });
  for (const env of [{}, BEHIND_PROXY]) {
    expect(crossOriginProblem(spoofed, env)).toBe(true);
    expect(expectedOrigin(spoofed, env)).not.toContain("attacker");
  }
});

test("APP_ORIGIN is normalised to scheme, host and port; an unusable value adds nothing", () => {
  const forms: [string, string][] = [
    ["https://app.example.test", "https://app.example.test"],
    ["https://app.example.test/", "https://app.example.test"],
    ["  https://app.example.test/some/path?x=1#y  ", "https://app.example.test"],
    ["https://APP.Example.TEST", "https://app.example.test"],
    ["https://app.example.test:443", "https://app.example.test"],
    ["https://app.example.test:8443/", "https://app.example.test:8443"],
    ["http://app.example.test:80", "http://app.example.test"],
  ];
  for (const [raw, origin] of forms) {
    expect(proxiedPublicOrigin({ SELFHOST_BEHIND_PROXY: "1", APP_ORIGIN: raw })).toBe(origin);
    expect(crossOriginProblem(post(`${LISTEN}/api/x`, origin), { SELFHOST_BEHIND_PROXY: "1", APP_ORIGIN: raw })).toBe(false);
  }
  /* Opaque-origin schemes serialise to "null", which a sandboxed frame sends: they must never become the expected origin. */
  for (const raw of [undefined, "", "   ", "not a url", "app.example.test", "file:///srv/app", "data:text/html,x", "javascript:alert(1)", "blob:https://app.example.test/x", "ftp://app.example.test"]) {
    const env = { SELFHOST_BEHIND_PROXY: "1", APP_ORIGIN: raw };
    expect(proxiedPublicOrigin(env), String(raw)).toBeNull();
    expect(expectedOrigin(post(`${LISTEN}/api/x`), env)).toBe(LISTEN); // falls back to today's rule, nothing more
    expect(crossOriginProblem(post(`${LISTEN}/api/x`, "null"), env)).toBe(true);
  }
});

test("Vercel is untouched: the setting is ignored wherever VERCEL is set, and only the exact value 1 opts in", () => {
  const vercel = { VERCEL: "1", VERCEL_ENV: "preview", ...BEHIND_PROXY };
  expect(proxiedPublicOrigin(vercel)).toBeNull();
  const url = "https://particl-git-branch.vercel.app/api/auth/login";
  expect(crossOriginProblem(post(url, "https://particl-git-branch.vercel.app"), vercel)).toBe(false);
  expect(crossOriginProblem(post(url, PUBLIC), vercel)).toBe(true);
  for (const flag of ["true", "yes", "0", "", " 1", "1 "]) {
    const env = { SELFHOST_BEHIND_PROXY: flag, APP_ORIGIN: PUBLIC };
    expect(proxiedPublicOrigin(env), JSON.stringify(flag)).toBeNull();
    expect(crossOriginProblem(post(`${LISTEN}/api/auth/login`, PUBLIC), env)).toBe(true);
  }
});

function setEnv(env: Record<string, string | undefined>) {
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

async function withEnv<T>(env: Record<string, string | undefined>, run: () => Promise<T>): Promise<T> {
  const saved = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  setEnv(env);
  try {
    return await run();
  } finally {
    setEnv(saved);
  }
}

test("the sign-in route behind the proxy: APP_ORIGIN reaches the password check, any other origin is 403 with no cookie", async () => {
  const login = (await import("../../app/api/auth/login/route")).POST;
  const url = `${LISTEN}/api/auth/login`;
  await withEnv({ ...BEHIND_PROXY, VERCEL: undefined }, async () => {
    const allowed = await login(post(url, PUBLIC));
    expect(allowed.status).toBe(401); // the origin passed; the made-up account did not
    for (const origin of ["https://attacker.test", LISTEN, "null"]) {
      const refused = await login(post(url, origin));
      expect(refused.status, origin).toBe(403);
      expect(refused.headers.has("set-cookie")).toBe(false);
    }
  });
  /* The same request without the setting is refused, as it is today. */
  await withEnv({ SELFHOST_BEHIND_PROXY: undefined, APP_ORIGIN: PUBLIC, VERCEL: undefined }, async () => {
    expect((await login(post(url, PUBLIC))).status).toBe(403);
  });
});

/** The real withTenant, with only session resolution controlled (as tests/unit/tenantRequestScope.spec.ts). */
function tenantWrapper(store: TenantStore) {
  const source = ts.createSourceFile("auth.ts", readFileSync("lib/auth.ts", "utf8"), ts.ScriptTarget.Latest, true);
  const fn = source.statements.find((statement) => ts.isFunctionDeclaration(statement) && statement.name?.text === "withTenant")!;
  const compiled = ts.transpileModule(fn.getText(source), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports = {} as Pick<typeof import("../../lib/auth"), "withTenant">;
  new Function("exports", "resolveStore", "runWithStore", "NoTenantError", "MediaSourceError", "workbenchScopeFor", "recoveryRoute", "crossOriginProblem", compiled)(
    exports, async () => store, runWithStore, NoTenantError, MediaSourceError, workbenchScopeFor, (handler: unknown) => handler, crossOriginProblem,
  );
  return exports.withTenant;
}

test("every state-changing data route (withTenant) follows the same rule behind the proxy; tokens are unchanged", async () => {
  const session = { workspace: { id: "workspace" }, user: { id: "owner" } } as TenantStore;
  const token = { ...session, token: { id: "t", name: "t", scope: "render", capUsd: null, capCredits: null } } as TenantStore;
  const reached: string[] = [];
  const route = (store: TenantStore) => tenantWrapper(store)(async (req: Request) => { reached.push(req.headers.get("origin") ?? "none"); return Response.json({ ok: true }); });
  const url = `${LISTEN}/api/projects`;
  await withEnv({ ...BEHIND_PROXY, VERCEL: undefined }, async () => {
    expect((await route(session)(post(url, PUBLIC), undefined)).status).toBe(200);
    expect((await route(session)(post(url), undefined)).status).toBe(200);
    for (const origin of ["https://attacker.test", LISTEN, "null"]) expect((await route(session)(post(url, origin), undefined)).status, origin).toBe(403);
    /* A GET is never origin-checked, and a token caller is not (no cookie rides on it): both as before. */
    expect((await route(session)(new Request(url, { headers: { Origin: "https://attacker.test" } }), undefined)).status).toBe(200);
    expect((await route(token)(post(url, "https://attacker.test"), undefined)).status).toBe(200);
  });
  await withEnv({ SELFHOST_BEHIND_PROXY: undefined, APP_ORIGIN: PUBLIC, VERCEL: undefined }, async () => {
    expect((await route(session)(post("https://particl.test/api/projects", "https://particl.test"), undefined)).status).toBe(200);
    expect((await route(session)(post(url, PUBLIC), undefined)).status).toBe(403);
  });
  expect(reached).toEqual([PUBLIC, "none", "https://attacker.test", "https://attacker.test", "https://particl.test"]);
});
