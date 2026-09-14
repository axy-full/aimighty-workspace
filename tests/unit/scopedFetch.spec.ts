import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import ts from "typescript";

test("scoped browser actions retain the rendered identity across delayed dialogs and fail closed without it", async () => {
  let session: { signedIn: boolean; requestScope?: string } = {
    signedIn: true,
    requestScope: "particl-active-original-workspace-original-account",
  };
  const calls: { url: string; init: RequestInit }[] = [];
  const fixtureModule = {
    exports: {} as typeof import("../../lib/useScopedFetch"),
  };
  const source = ts.transpileModule(
    readFileSync("lib/useScopedFetch.ts", "utf8"),
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
    },
  ).outputText;
  new Function("module", "exports", "require", "fetch", source)(
    fixtureModule,
    fixtureModule.exports,
    (name: string) => {
      if (name === "react")
        return { useCallback: (callback: unknown) => callback };
      if (name === "./session") return { useSession: () => session };
      throw new Error("Unexpected import " + name);
    },
    async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return Response.json({ ok: true });
    },
  );
  const delayedAction = fixtureModule.exports.useScopedFetch();
  session = {
    signedIn: true,
    requestScope: "particl-active-new-workspace-new-account",
  };
  await delayedAction("/api/settings", {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      "X-Workbench-Scope": session.requestScope!,
    },
    body: JSON.stringify({ namingTemplate: "private-original-draft" }),
  });
  expect(calls).toHaveLength(1);
  const headers = new Headers(calls[0].init.headers);
  expect(headers.get("x-workbench-scope")).toBe(
    "particl-active-original-workspace-original-account",
  );
  expect(headers.get("content-type")).toBe("application/json");
  expect(calls[0].init.body).toBe(
    JSON.stringify({ namingTemplate: "private-original-draft" }),
  );
  for (const unavailable of [{ signedIn: false }, { signedIn: true }]) {
    session = unavailable;
    await expect(
      fixtureModule.exports.useScopedFetch()("/api/tokens", { method: "POST" }),
    ).rejects.toThrow(/Reload this page/);
  }
  expect(calls).toHaveLength(1);
  session = { signedIn: false };
  await fixtureModule.exports.useScopedFetch("particl-account-verified-user")(
    "/api/auth/logout",
    { method: "POST" },
  );
  expect(new Headers(calls[1].init.headers).get("x-workbench-scope")).toBe(
    "particl-account-verified-user",
  );
  session = {
    signedIn: true,
    requestScope: "particl-active-different-account",
  };
  await expect(
    fixtureModule.exports.useScopedFetch(null)("/api/workspaces", {
      method: "POST",
    }),
  ).rejects.toThrow(/Reload this page/);
  expect(calls).toHaveLength(2);
});
