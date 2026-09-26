import { test, expect } from "@playwright/test";

/**
 * A token may never mint another token (app/api/tokens/route.ts).
 *
 * The route said so in prose and did not enforce it: the guard was
 * `currentUser()`, which answers for a BEARER caller as well, because
 * `callerFromBearer` puts a user in the tenant store. So "is there a user?"
 * was asked while "is this a session?" was meant, and a READ-ONLY token —
 * the credential /connect hands to third parties precisely because it
 * "cannot bill" — could mint a render-scoped one and start spending.
 *
 * Run the actual mutation handlers with the real session-only guard. A
 * bearer caller must be refused before even initializing the tenant DB.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import ts from "typescript";
import type { TenantStore } from "../../lib/tenant";

const read = (p: string) => readFileSync(path.join(process.cwd(), p), "utf8");

test("actual token POST and DELETE refuse read and render bearers before database work", async () => {
  const auth = await import("../../lib/auth");
  const tenant = await import("../../lib/tenant");
  type Handler = (
    request: Request,
    context: { params: Promise<{ id: string }> },
  ) => Promise<Response>;
  let dbCalls = 0;
  const forbiddenDb = () => {
    dbCalls++;
    throw new Error("A bearer must not reach token storage");
  };
  const dependencies: Record<string, unknown> = {
    "next/server": createRequire(path.resolve("package.json"))("next/server"),
    "@/lib/auth": { ...auth, withTenant: (handler: Handler) => handler },
    "@/lib/tenant": tenant,
    "@/lib/db": {
      db: forbiddenDb,
      ready: forbiddenDb,
      now: forbiddenDb,
      id: forbiddenDb,
    },
    "@/lib/securityAudit": { securityAuditStatement: forbiddenDb },
    "@/lib/credits": { creditsApply: forbiddenDb },
    "@/lib/creditSql": { billedCreditsSum: forbiddenDb },
  };
  for (const [file, method] of [
    ["app/api/tokens/route.ts", "POST"],
    ["app/api/tokens/[id]/route.ts", "DELETE"],
  ] as const) {
    const compiled = ts.transpileModule(read(file), {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
    }).outputText;
    const mod = { exports: {} as Record<string, Handler> };
    new Function("require", "module", "exports", compiled)(
      (name: string) => {
        if (!(name in dependencies))
          throw new Error("Unexpected token-route dependency " + name);
        return dependencies[name];
      },
      mod,
      mod.exports,
    );
    for (const scope of ["read", "render"] as const) {
      const store = {
        workspace: { id: "tenant-fixture" },
        user: {
          id: "caller",
          name: "Caller",
          email: "caller@example.test",
          role: "admin",
          owner: true,
        },
        token: { id: "bearer", name: "Fixture", scope, capUsd: null },
      } as TenantStore;
      await tenant.runWithStore(store, async () => {
        const response = await mod.exports[method](
          new Request("http://localhost/api/tokens/target", {
            method,
            headers: {
              Authorization: "Bearer local-fixture",
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ name: "Escalated", scope: "render" }),
          }),
          { params: Promise.resolve({ id: "target" }) },
        );
        expect(response.status, `${method} with ${scope} bearer`).toBe(403);
        expect(await response.json()).toMatchObject({
          error: expect.stringContaining("signed-in browser session"),
        });
      });
    }
  }
  expect(dbCalls).toBe(0);
});

test("requireSession refuses a token caller and requireUser does not", async () => {
  const src = read("lib/auth.ts");
  /* The distinction the whole finding rests on. `requireUser` deliberately
     RETURNS the token — routes like the render path want it, to enforce a
     token's own spend cap — so it cannot be the guard for session-only
     work, and `requireSession` has to be the one that refuses. */
  expect(src).toContain("export async function requireSession");
  const block = src.slice(src.indexOf("export async function requireSession"));
  expect(block.slice(0, 700)).toContain("got.token");
  expect(block.slice(0, 700)).toMatch(/403/);
});

test("the render guard still lets a render token through", () => {
  /* The fix must not overshoot: requireRender exists so a render-scoped
     token CAN spend, which is the entire point of minting one. If this
     started refusing tokens the CLI and MCP client would stop working. */
  const src = read("lib/auth.ts");
  const block = src.slice(src.indexOf("export async function requireRender"), src.indexOf("export async function requireRender") + 1200);
  // It refuses a token whose scope is not "render" — not every token.
  expect(block, "requireRender gates on scope, not on being a token").toContain('scope !== "render"');
  expect(block, "requireRender must not borrow the session-only guard").not.toContain("requireSession()");
});
