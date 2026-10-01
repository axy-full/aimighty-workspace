import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import ts from "typescript";
import * as retired from "../../lib/higgsfield-consumer/retired";
import { workbenchScopeFor } from "../../lib/workbench/request-scope";

/**
 * Reading what the connected account offers — tool discovery, Atomik › Tools
 * & connections' reach check, the read-only contract checks and the analysis
 * model definitions — is retired with the Higgsfield sign-in
 * (lib/higgsfield-consumer/retired.ts). Each route answers 410 to every
 * caller and every body, and imports nothing that could reach the account:
 * no token, no discovery, no rate allowance.
 */
const ROUTES = ["capabilities", "qualification", "analysis-qualification"] as const;

function load(kind: (typeof ROUTES)[number]) {
  const deps: Record<string, unknown> = { "@/lib/higgsfield-consumer/retired": retired };
  const output = { exports: {} as { POST(req?: Request): Promise<Response> } };
  const source = ts.transpileModule(readFileSync(`app/api/higgsfield/consumer/${kind}/route.ts`, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  new Function("require", "module", "exports", source)((name: string) => {
    if (!(name in deps)) throw new Error(`Unexpected dependency ${name}`);
    return deps[name];
  }, output, output.exports);
  return output.exports;
}

test("the discovery, reach and qualification routes answer 410 to any caller and any body, before anything is read", async () => {
  const bodies = [{}, { view: "reach" }, { workspaceId: "other", userId: "other", endpoint: "https://evil.example", method: "tools/call" }];
  const scopes = [workbenchScopeFor("workspace", "owner"), workbenchScopeFor("other", "owner"), null];
  for (const kind of ROUTES) {
    const route = load(kind);
    for (const body of bodies)
      for (const scope of scopes) {
        const fetchBefore = globalThis.fetch;
        let reached = 0;
        globalThis.fetch = async () => { reached++; throw new Error("NO_NETWORK_IN_ROUTE_TEST"); };
        try {
          const response = await route.POST(new Request(`http://localhost/api/higgsfield/consumer/${kind}`, {
            method: "POST",
            headers: { ...(scope === null ? {} : { "X-Workbench-Scope": scope }), origin: "https://other.example" },
            body: JSON.stringify(body),
          }));
          expect(response.status, `${kind} ${JSON.stringify(body)}`).toBe(410);
          expect(response.headers.get("Cache-Control")).toBe("private, no-store");
          expect(await response.json()).toEqual({ code: "retired", error: retired.SIGN_IN_RETIRED_MESSAGE });
        } finally {
          globalThis.fetch = fetchBefore;
        }
        expect(reached).toBe(0);
      }
  }
});

test("the retired routes keep no discovery, token or rate code: only the retirement answers", () => {
  for (const kind of ROUTES) {
    const source = readFileSync(`app/api/higgsfield/consumer/${kind}/route.ts`, "utf8");
    const imports = [...source.matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1]);
    expect(imports, kind).toEqual(["@/lib/higgsfield-consumer/retired"]);
    for (const reader of ["getConsumerAccessToken", "discoverConsumerCapabilities", "discoverAtomikReach", "readConsumerQualification", "readConsumerAnalysisQualification", "takeAccountLimit"])
      expect(source, `${kind} ${reader}`).not.toContain(reader);
  }
});
