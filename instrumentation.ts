import type { Instrumentation } from "next";
import { deploymentLabel } from "./lib/deployment";

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
    release: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 40) ?? "local",
    at: new Date().toISOString(),
  }));
};
