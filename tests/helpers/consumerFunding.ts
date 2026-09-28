import { readFileSync } from "node:fs";
import ts from "typescript";

/**
 * The REAL funding decision, grant resolver, own-object guard, client view
 * and website-account billing (lib/higgsfield-consumer/funding.ts, access.ts,
 * account-objects.ts, client-view.ts, account-billing.ts) for a consumer
 * service loaded with injected dependencies. They are wired to the same
 * tenant, job ledger and oauth modules the test injects into the service, so
 * an own-account job resolves through the test's own fixture grant exactly as
 * the service did before the resolver existed, and a managed workspace
 * refuses through the real rules.
 */
export async function consumerFundingModules(deps: { tenant: unknown; jobs: unknown; oauth: unknown }): Promise<Record<string, unknown>> {
  const load = (file: string, map: Record<string, unknown>) => {
    const loaded = { exports: {} as Record<string, unknown> };
    const source = ts.transpileModule(readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    new Function("require", "module", "exports", source)((name: string) => {
      if (!(name in map)) throw new Error(`Unexpected dependency: ${name}`);
      return map[name];
    }, loaded, loaded.exports);
    return loaded.exports;
  };
  const common: Record<string, unknown> = {
    "@/lib/tenant": deps.tenant,
    "@/lib/vendorRates": await import("../../lib/vendorRates"),
    "./jobs": deps.jobs,
    "./oauth": deps.oauth,
    "./platform-account": await import("../../lib/higgsfield-consumer/platform-account"),
    "./platform-jobs": await import("../../lib/higgsfield-consumer/platform-jobs"),
    "./website-tools": await import("../../lib/higgsfield-consumer/website-tools"),
  };
  const funding = load("lib/higgsfield-consumer/funding.ts", common);
  const access = load("lib/higgsfield-consumer/access.ts", { ...common, "./funding": funding });
  // The workspace's own-object guard, over the same tenant (its records and the platform registry are real).
  const objects = load("lib/higgsfield-consumer/account-objects.ts", {
    "@/lib/tenant": deps.tenant,
    "./character-records": await import("../../lib/higgsfield-consumer/character-records"),
    "./element-records": await import("../../lib/higgsfield-consumer/element-records"),
    "./platform-jobs": await import("../../lib/higgsfield-consumer/platform-jobs"),
  });
  return {
    "./funding": funding, "./access": access, "./account-objects": objects,
    "./client-view": await import("../../lib/higgsfield-consumer/client-view"),
    // The platform account's money path: every call returns at once for a job on its owner's own account.
    "./account-billing": await import("../../lib/higgsfield-consumer/account-billing"),
  };
}
