import type { Instrumentation } from "next";
import { deployedCommit, deploymentLabel } from "./lib/deployment";
import { vercelIdentityInProduction } from "./lib/vercelGuard";

/** At boot: a production server carrying a Vercel identity says so, loudly and once, with the names (never the values). /api/health fails for the same reason.
 * Then model-call tracing to Langfuse (lib/modelTrace.ts), only on the Node.js server and only when LANGFUSE_ENABLED is exactly "1";
 * otherwise nothing of Langfuse is loaded. A tracer that cannot start logs the names it lacks and the server starts as usual. */
export async function register() {
  const names = vercelIdentityInProduction();
  if (names.length) console.error(JSON.stringify({ level: "error", event: "deployment.vercel_identity_in_production", names, at: new Date().toISOString() }));
  if (process.env.NEXT_RUNTIME === "nodejs" && process.env.LANGFUSE_ENABLED === "1") {
    try { (await import("./lib/modelTraceExport")).startLangfuseTracing(process.env); }
    catch (error) { console.error(JSON.stringify({ level: "error", event: "langfuse.not_started", error: error instanceof Error ? error.name : "Error", at: new Date().toISOString() })); }
  }
}

/** Emit only framework route templates and deployment metadata. Request
 * URLs, headers and exception text may contain private media or secrets. */
export const onRequestError: Instrumentation.onRequestError = (_error, request, context) => {
  console.error(JSON.stringify({
    level: "error",
    event: "request.unhandled_error",
    route: context.routePath,
    routeType: context.routeType,
    method: request.method,
    environment: deploymentLabel(), // VERCEL_ENV on Vercel, PARTICL_DEPLOYMENT off it
    release: deployedCommit()?.slice(0, 40) ?? "local", // VERCEL_GIT_COMMIT_SHA, else GIT_COMMIT_SHA off Vercel
    at: new Date().toISOString(),
  }));
};
