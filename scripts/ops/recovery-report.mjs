import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createClient } from "@libsql/client";

const parse = (value) => {
  try {
    return JSON.parse(value ?? "{}");
  } catch {
    return {};
  }
};
const quote = (name) => '"' + name.replaceAll('"', '""') + '"';

/** Read only, against restored files. Never imports app workers, touches a
 * provider, expires credits, releases held jobs or clears an idempotency key. */
export async function recoveryReport(directory) {
  await readFile(join(directory, "OFFLINE-RESTORE.txt"));
  const inventory = JSON.parse(
    await readFile(join(directory, "inventory.json"), "utf8"),
  );
  const report = {
    backupCreatedAt: inventory.createdAt,
    generatedAt: new Date().toISOString(),
    actions: [],
    tombstones: [],
    meters: [],
  };
  for (const source of inventory.databases) {
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(source.id))
      throw new Error("Unsafe database ID.");
    const db = createClient({
      url: pathToFileURL(resolve(directory, "databases", source.id + ".db"))
        .href,
      intMode: "bigint",
    });
    try {
      const names = new Set(
        (
          await db.execute("SELECT name FROM sqlite_schema WHERE type='table'")
        ).rows.map((r) => r.name),
      );
      const action = (table, row, disposition, handle = null) =>
        report.actions.push({
          database: source.id,
          workspaceIds: source.workspaceIds,
          table,
          id: row.id ?? row.request_id,
          status: row.status ?? row.state,
          disposition,
          handle,
          reservedUsd:
            row.cost_usd == null ? (row.estimate_usd ?? null) : row.cost_usd,
        });
      if (names.has("generations"))
        for (const row of (
          await db.execute(
            "SELECT * FROM generations WHERE status<>'succeeded'",
          )
        ).rows) {
          const params = parse(row.params);
          const handle =
            row.ark_task_id ||
            params.falRequestId ||
            (params.producedOutcome?.kind === "video"
              ? params.producedOutcome.taskId
              : null);
          if (handle)
            action("generations", row, "poll-existing-handle-only", handle);
          else if (params.producedOutcome)
            action("generations", row, "recover-persisted-outcome-no-submit");
          else if (params.paidClaim)
            action(
              "generations",
              row,
              "uncertain-provider-outcome-never-resubmit",
            );
          else if (row.status === "held")
            action("generations", row, "held-review-before-release");
          else if (["queued", "running", "processing"].includes(row.status))
            action(
              "generations",
              row,
              "verify-no-provider-acceptance-before-new-action",
            );
        }
      for (const table of [
        "workbench_atomik_jobs",
        "paid_text_jobs",
        "identity_training_runs",
      ]) {
        if (!names.has(table)) continue;
        for (const row of (
          await db.execute(
            `SELECT * FROM ${quote(table)} WHERE status NOT IN ('succeeded','done','complete')`,
          )
        ).rows) {
          if (row.request_id && table === "identity_training_runs")
            action(
              table,
              row,
              "poll-existing-training-handle-only",
              row.request_id,
            );
          else if (row.provider_response || row.response_json)
            action(table, row, "recover-persisted-response-no-submit");
          else if (
            ["running", "queued", "submitting", "failed", "uncertain"].includes(
              row.status,
            )
          )
            action(table, row, "uncertain-provider-outcome-never-resubmit");
        }
      }
      if (names.has("workbench_development_jobs")) {
        for (const row of (await db.execute("SELECT * FROM workbench_development_jobs WHERE status<>'succeeded' OR settled=0")).rows) {
          const steps = names.has("workbench_development_steps")
            ? (await db.execute({ sql: "SELECT step_index,status,response FROM workbench_development_steps WHERE job_id=? ORDER BY step_index", args: [row.id] })).rows
            : [];
          const attempted = steps.find(step => ["running", "uncertain"].includes(step.status));
          const next = steps.find(step => step.status !== "succeeded");
          const disposition = row.status === "queued" ? "reconcile-admission-reservation-no-submit"
            : row.status === "uncertain" || attempted ? "uncertain-provider-phase-never-resubmit"
            : ["succeeded", "failed"].includes(row.status) ? (Number(row.settled) ? "terminal-no-provider-work" : "settle-persisted-development-cost-no-submit")
            : row.status === "running" && next?.status === "queued" ? "resume-only-never-started-development-phase"
            : "reconcile-saved-development-result-no-submit";
          action("workbench_development_jobs", row, disposition);
        }
      }
      if (names.has("workbench_development_steps")) {
        for (const row of (await db.execute("SELECT job_id,step_index,status,response,cost_usd,estimate_usd FROM workbench_development_steps WHERE status IN ('running','uncertain')")).rows) {
          action("workbench_development_steps", { ...row, id: `${row.job_id}:phase:${row.step_index}` },
            row.response ? "recover-persisted-development-response-no-submit" : "uncertain-provider-phase-never-resubmit");
        }
      }
      if (names.has("identities")) {
        const tracked = names.has("identity_training_runs")
          ? new Set(
              (
                await db.execute("SELECT id FROM identity_training_runs")
              ).rows.map((r) => r.id),
            )
          : new Set();
        for (const row of (
          await db.execute("SELECT * FROM identities WHERE status='training'")
        ).rows) {
          if (row.training_run_id && tracked.has(row.training_run_id)) continue;
          action(
            "identities",
            row,
            row.request_id
              ? "poll-existing-training-handle-only"
              : "uncertain-provider-outcome-never-resubmit",
            row.request_id || null,
          );
        }
      }
      if (names.has("workspaces"))
        for (const row of (await db.execute("SELECT * FROM workspaces")).rows) {
          if (row.deleted_at != null || row.purged_at != null)
            report.tombstones.push({
              workspaceId: row.id,
              deletedAt: Number(row.deleted_at),
              purgedAt: row.purged_at == null ? null : Number(row.purged_at),
            });
        }
      if (names.has("workspace_provisioning"))
        for (const row of (
          await db.execute(
            "SELECT * FROM workspace_provisioning WHERE state<>'ready'",
          )
        ).rows)
          action(
            "workspace_provisioning",
            row,
            "check-existing-database-before-provisioning-retry",
          );
      if (names.has("meter_events"))
        for (const row of (
          await db.execute(
            "SELECT * FROM meter_events WHERE status<>'succeeded'",
          )
        ).rows) {
          report.meters.push({
            workspaceId: row.workspace_id,
            id: row.id,
            kind: row.kind,
            status: row.status,
            billedCredits: row.billed_credits,
          });
        }
    } finally {
      db.close();
    }
  }
  await writeFile(
    join(directory, "reconciliation-report.json"),
    JSON.stringify(
      report,
      (_, v) => (typeof v === "bigint" ? Number(v) : v),
      2,
    ),
    { flag: "wx", mode: 0o600 },
  );
  return {
    actions: report.actions.length,
    tombstones: report.tombstones.length,
    meters: report.meters.length,
  };
}
