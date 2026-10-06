import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import ts from "typescript";
import * as model from "../../lib/site/settings";

/** /api/admin/site: the platform owner only, in a browser session; every field checked before anything is written. */
type Who = "anonymous" | "member" | "token" | "owner";
class SiteSettingsError extends Error { constructor(message: string, readonly status = 400) { super(message); } }

function load(who: Who, writes: unknown[]) {
  const refuse = { anonymous: [401, "Not signed in"], member: [403, "The platform owner only."], token: [403, "Platform administration requires a signed-in browser session."] } as const;
  const mocks: Record<string, unknown> = {
    "next/server": createRequire(path.resolve("package.json"))("next/server"),
    "@/lib/recovery": { recoveryRoute: (handler: unknown) => handler },
    "@/lib/auth": {
      requireSuperAdmin: async () => who === "owner" ? { user: { id: "owner" } } : { response: Response.json({ error: refuse[who][1] }, { status: refuse[who][0] }) },
    },
    "@/lib/site/settings": model,
    "@/lib/site/settings.server": {
      SiteSettingsError,
      readSite: async () => model.DEFAULT_SITE,
      writeSite: async (patch: { guestWorkspace?: string | null }) => {
        if (patch.guestWorkspace === "ws_gone") throw new SiteSettingsError("That workspace is not on this deployment.");
        writes.push(patch);
        return model.cleanSite({ ...model.DEFAULT_SITE, ...patch });
      },
    },
  };
  const compiled = ts.transpileModule(readFileSync("app/api/admin/site/route.ts", "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const mod = { exports: {} as { GET: () => Promise<Response>; PATCH: (req: Request) => Promise<Response> } };
  new Function("require", "module", "exports", compiled)((name: string) => {
    if (!(name in mocks)) throw new Error("Unexpected route dependency " + name);
    return mocks[name];
  }, mod, mod.exports);
  return mod.exports;
}
const patch = (body: unknown) => new Request("http://localhost/api/admin/site", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

test("nobody but the platform owner reads or changes the site switches", async () => {
  for (const who of ["anonymous", "member", "token"] as const) {
    const writes: unknown[] = [];
    const route = load(who, writes);
    expect((await route.GET()).status, who).toBeGreaterThanOrEqual(401);
    expect((await route.PATCH(patch({ openSignup: true }))).status, who).toBeGreaterThanOrEqual(401);
    expect(writes, who).toEqual([]);
  }
  const owner = load("owner", []);
  expect(await (await owner.GET()).json()).toEqual(model.DEFAULT_SITE);
});

test("the owner's change is checked: junk and unknown fields are refused, a gone workspace too", async () => {
  const writes: unknown[] = [];
  const route = load("owner", writes);
  expect((await route.PATCH(patch({ openSignup: "on" }))).status).toBe(400);
  expect((await route.PATCH(patch({ welcomeCredits: 10 }))).status).toBe(400);
  expect((await route.PATCH(patch({ guestWorkspace: "ws_gone" }))).status).toBe(400);
  expect(writes).toEqual([]);
  const ok = await route.PATCH(patch({ guestHome: true, guestWorkspace: "ws_demo" }));
  expect(await ok.json()).toEqual({ ok: true, openSignup: false, guestHome: true, guestWorkspace: "ws_demo" });
  expect(writes).toEqual([{ guestHome: true, guestWorkspace: "ws_demo" }]);
});
