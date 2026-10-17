import { requireUser, withTenant } from "@/lib/auth";
import { historyResponse } from "@/lib/history/read";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * GET /api/history: v30 History (PR A9), read-only, for the signed-in workspace. Behind V30_HISTORY and V30_JOBS, both
 * off by default: off, it answers 404 and opens nothing.
 *
 *   ?view=agent       one row per instruction (no engine anywhere), and earlier work marked "before History"
 *   ?view=director    one row per Director job: engine, settings, inputs, prompt
 *   ?view=aggregates  jobs and credits by production, member and month
 *   &production=<id>  one project the viewer may read (else 404)   &month=2026-10 (UTC)   &member=<id>|me
 *   &cursor=          the next page                                &limit= (1–200)        &format=csv
 *
 * Who reads what follows today's Usage ledger: every member reads every job and its amount, a name only on their own
 * work, and only an owner or admin filters by a teammate. No vendor cost, for anyone.
 */
export const GET = withTenant(async function GET(req: Request) {
  const got = await requireUser();
  if (got.response) return got.response;
  return historyResponse(req, { id: got.user.id, admin: got.user.role === "admin" || got.user.owner, role: got.user.role });
});
