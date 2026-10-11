import { requireUser, withTenant } from "@/lib/auth";
import { typicalTimes } from "@/lib/v12/typicalTimes.server";

export const dynamic = "force-dynamic";

/**
 * GET /api/v12/typical-times: how long each engine's takes usually take, as
 * the middle half of recent history in milliseconds (lib/v12/typicalTimes).
 * Read-only, signed in, for the workspace in scope (the same check as the
 * workbench's engine list). The reply is durations only: `{ models: { [engine
 * id]: { lowMs, highMs, source } } }`. An engine left out has too little
 * history; the browser falls back to lib/v12/typicalTimeDefaults.ts.
 */
export const GET = withTenant(async () => {
  const got = await requireUser();
  if (got.response) return got.response;
  const reply = await typicalTimes();
  return Response.json(reply, { headers: { "Cache-Control": "private, max-age=300" } });
});
