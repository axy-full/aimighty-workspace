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
 * Asserted on the source rather than over HTTP: the defect was a guard that
 * looked right, so what has to be true is that these routes no longer use
 * the guard that cannot tell a token from a session.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

const read = (p: string) => readFileSync(path.join(process.cwd(), p), "utf8");

test("neither token route is guarded by currentUser()", () => {
  for (const f of ["app/api/tokens/route.ts", "app/api/tokens/[id]/route.ts"]) {
    const src = read(f);
    const mutating = src.match(/export const (POST|DELETE|PATCH|PUT) = [\s\S]*?\n\}\);/g) ?? [];
    expect(mutating.length, `${f} has a state-changing handler`).toBeGreaterThan(0);
    for (const handler of mutating) {
      expect(handler, `${f}: a mutating handler still calls currentUser()`).not.toContain("currentUser()");
      expect(handler, `${f}: a mutating handler must use requireSession()`).toContain("requireSession()");
    }
  }
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
