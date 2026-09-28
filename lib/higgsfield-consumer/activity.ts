import type { Row } from "@libsql/client";
import { db } from "@/lib/db";
import { consumerJobsReady } from "./jobs";
import type {
  ConsumerActivityState,
  ConsumerActivityTotals,
  ConsumerCreditActivity,
} from "./activity-types";

const PROJECT_LIMIT = 100;
const states: ConsumerActivityState[] = [
  "completed",
  "pending",
  "uncertain",
  "failed",
];
const conditions = {
  completed: "j.status='completed'",
  pending: "j.status IN ('dispatching','accepted')",
  uncertain: "j.status='uncertain'",
  failed: "j.status='failed'",
};
const columns = states
  .map(
    (state) =>
      `SUM(CASE WHEN ${conditions[state]} THEN 1 ELSE 0 END) AS ${state}_jobs,
   SUM(CASE WHEN ${conditions[state]} THEN j.quote_credits ELSE 0 END) AS ${state}_credits`,
  )
  .join(",");
// A restore can quarantine a never-submitted quote as uncertain. Only an actual
// durable dispatch claim is an approved commitment; untouched quotes never count.
const admitted =
  "j.user_id=? AND j.dispatch_claim_hash IS NOT NULL AND j.status<>'quoted'";
function totals(row: Row | undefined): ConsumerActivityTotals {
  return Object.fromEntries(
    states.map((state) => [
      state,
      {
        jobs: Number(row?.[`${state}_jobs`] ?? 0),
        quoteCredits: Number(row?.[`${state}_credits`] ?? 0),
      },
    ]),
  ) as ConsumerActivityTotals;
}

/** Reads the current tenant's immutable ledger. Never contacts a provider and
 * never loads payloads, receipts, grant identifiers or another account's rows. */
export async function getConsumerCreditActivity(
  userId: string,
): Promise<ConsumerCreditActivity> {
  if (!userId || userId.length > 200 || /[\s\u0000-\u001f\u007f]/.test(userId))
    throw new Error("Invalid activity account");
  await consumerJobsReady();
  const [summary, projects] = await db().batch(
    [
      {
        sql: `SELECT ${columns}, COUNT(DISTINCT j.draft_id) AS projects FROM higgsfield_consumer_jobs j WHERE ${admitted}`,
        args: [userId],
      },
      {
        sql: `SELECT j.draft_id, SUBSTR(p.name,1,200) AS name, p.project_id AS available, ${columns}
        FROM higgsfield_consumer_jobs j
        LEFT JOIN workbench_projects p ON p.owner=j.user_id AND p.project_id=j.draft_id
        WHERE ${admitted}
        GROUP BY j.draft_id
        ORDER BY MAX(j.created_at) DESC, j.draft_id ASC LIMIT ?`,
        args: [userId, PROJECT_LIMIT],
      },
    ],
    "read",
  );
  return {
    creditUnit: "higgsfield_credits",
    basis: "approved_quotes",
    scope: "own_account",
    totals: totals(summary.rows[0]),
    projects: projects.rows.map((row) => ({
      draftId: String(row.draft_id),
      name: row.name == null ? null : String(row.name),
      available: row.available != null,
      totals: totals(row),
    })),
    projectLimit: PROJECT_LIMIT,
    projectsTruncated: Number(summary.rows[0]?.projects ?? 0) > PROJECT_LIMIT,
  };
}
