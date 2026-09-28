import { readFileSync } from "node:fs";
import ts from "typescript";

/**
 * The REAL route guard, read budget and availability answer
 * (lib/higgsfield-consumer/route-access.ts) for a consumer route loaded with
 * injected dependencies: wired to the test's auth, tenant and rate-limit
 * recorder, with the funding decision answered by the test (whether the
 * platform's website tools can take this work now). Plus the one neutral
 * refusal mapping every consumer route shares.
 */
export async function websiteRouteModules(deps: { auth: unknown; tenant: unknown; accountDb: unknown; available?: () => boolean }): Promise<Record<string, unknown>> {
  // As the real decision: a workspace on its own account always reads with its own connection.
  const managed = () => (deps.tenant as { requireTenant(): { usesPlatformKeys?: boolean } }).requireTenant().usesPlatformKeys === true;
  const funding = {
    readFunding: async () => (managed() && deps.available?.() ? { kind: "platform_account", tool: null } : { kind: "own_account" }),
  };
  const map: Record<string, unknown> = {
    "@/lib/auth": deps.auth,
    "@/lib/tenant": deps.tenant,
    "@/lib/accountDb": deps.accountDb,
    "./platform-jobs": { websiteAccountReadsPerMinute: () => 120 },
    "./funding": funding,
  };
  const routeAccess = { exports: {} as Record<string, unknown> };
  const source = ts.transpileModule(readFileSync("lib/higgsfield-consumer/route-access.ts", "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  new Function("require", "module", "exports", source)((name: string) => {
    if (!(name in map)) throw new Error(`Unexpected dependency: ${name}`);
    return map[name];
  }, routeAccess, routeAccess.exports);
  return {
    "@/lib/higgsfield-consumer/route-access": routeAccess.exports,
    "@/lib/higgsfield-consumer/funding": funding,
    "@/lib/higgsfield-consumer/website-problems": await import("../../lib/higgsfield-consumer/website-problems"),
  };
}
