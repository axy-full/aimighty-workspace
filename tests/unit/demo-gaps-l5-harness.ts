import { mkdtempSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import ts from "typescript";
import type { TenantWorkspace, WorkspaceRole } from "../../lib/tenant";

/**
 * Lane 5's route harness: the real lib/auth.ts (withTenant, requireSession, requireRender, the bearer-token lookup
 * against the workspace's own api_tokens table) with only the cookie, the headers and the platform's account lookup
 * stood in. Each spec file gets its own temporary databases. Neutral names only.
 */
export function freshDatabases(tag: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `particl-l5-${tag}-`));
  process.env.PLATFORM_DATABASE_URL = `file:${path.join(dir, "platform.db")}`;
  process.env.TURSO_DATABASE_URL = `file:${path.join(dir, "primary.db")}`;
  process.env.KEYRING_SECRET ??= "unit-test-keyring-secret-unit-test-keyring";
  process.env.ENGINE_MOCK = "1";
  return dir;
}

export function workspace(dir: string, id: string): TenantWorkspace {
  return {
    id, name: id, slug: id, legacy: false,
    dbUrl: `file:${path.join(dir, `${id}.db`)}`, dbToken: null,
    keys: {}, usesPlatformKeys: true, allowanceUsd: null, gatewayKeyId: null,
    ownerId: "owner", createdAt: 0, suspendedAt: null, suspendedReason: null,
    flaggedAt: null, flagNote: null, concurrency: null, rendersPerHour: null,
    storageQuotaBytes: null, deletedAt: null,
  } as TenantWorkspace;
}

/** Transpiles one file and runs it with the given modules standing in for its imports. */
export function load<T>(file: string, dependencies: Record<string, unknown>): T {
  const filename = path.resolve(file), require = createRequire(filename);
  const compiled = ts.transpileModule(readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const mod = { exports: {} };
  new Function("require", "module", "exports", compiled)(
    (name: string) => Object.hasOwn(dependencies, name) ? dependencies[name] : require(name),
    mod, mod.exports,
  );
  return mod.exports as T;
}

export type Who = { mode: "session" | "token" | "none"; ws: TenantWorkspace | null; userId: string; name: string; role: WorkspaceRole; bearer: string };

/** The real lib/auth.ts, answering as `who` says: a browser session, a bearer token or nobody. */
export async function authAs(who: Who) {
  const tenant = await import("../../lib/tenant");
  const database = await import("../../lib/db");
  const scope = await import("../../lib/workbench/request-scope");
  return load<typeof import("../../lib/auth")>("lib/auth.ts", {
    "./recovery": { recoveryRoute: (handler: unknown) => handler },
    "./mediaBindings": { MediaSourceError: class extends Error {} },
    "./workbench/request-scope": scope,
    "./db": database, "./tenant": tenant,
    "next/headers": {
      cookies: async () => ({ get: () => (who.mode === "session" ? { value: "fixture-session" } : undefined) }),
      headers: async () => new Headers(who.mode === "token" ? { authorization: `Bearer ${who.bearer}` } : {}),
    },
    "./platform": {
      sessionLookup: async () => (who.mode === "session" && who.ws ? { account: { id: who.userId, name: who.name, email: `${who.userId}@example.invalid`, mfa_enabled: 1 }, workspaceId: who.ws.id } : null),
      workspacesFor: async () => (who.ws ? [{ workspace: who.ws, role: who.role }] : []),
      getWorkspace: async (id: string) => (who.ws && who.ws.id === id ? who.ws : null),
      legacyWorkspace: async () => null,
      platformReady: async () => {},
      platformDb: () => ({ execute: async () => ({ rows: [{ role: who.role }] }) }),
    },
  });
}

/** A request the way the browser sends one for this person: same origin, with the workspace scope header. */
export function scoped(who: Who, url: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  if (who.mode === "session" && who.ws) headers.set("X-Workbench-Scope", `particl-active-${who.ws.id}-${who.userId}`);
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  return new Request(url, { ...init, headers });
}

/** A user row and, optionally, a token of the given scope, in the workspace's own database. Returns the raw token. */
export async function seedPeople(ws: TenantWorkspace, people: { id: string; name: string }[], tokens: { id: string; userId: string; scope: string; raw: string }[] = []) {
  const { runInTenant } = await import("../../lib/tenant");
  const { db, ready } = await import("../../lib/db");
  const { tokenHash } = await import("../../lib/auth");
  await runInTenant(ws, async () => {
    await ready();
    for (const p of people) await db().execute({ sql: "INSERT OR IGNORE INTO users(id,email,name,password_hash,created_at) VALUES(?,?,?,'x',0)", args: [p.id, `${p.id}@example.invalid`, p.name] });
    for (const t of tokens) {
      /* A prepare token is stored as POST /api/tokens stores it: "read", with its grant apart (review of #558, H1). */
      await db().execute({ sql: "INSERT OR IGNORE INTO api_tokens(id,token_hash,name,user_id,scope,created_at) VALUES(?,?,?,?,?,0)", args: [t.id, tokenHash(t.raw), `token ${t.scope}`, t.userId, t.scope === "prepare" ? "read" : t.scope] });
      if (t.scope === "prepare") await db().execute({ sql: "INSERT OR IGNORE INTO api_token_grants(token_id,kind,created_at) VALUES(?,'prepare',0)", args: [t.id] });
    }
  });
}

/** A raw token in this workspace's format (`pk_<workspace>_<secret>`), made up for the test. */
export const rawToken = (ws: TenantWorkspace, n: string) => `pk_${ws.id.replace(/^ws_/, "")}_${n.repeat(48).slice(0, 48)}`;
