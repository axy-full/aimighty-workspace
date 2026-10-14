-- Deploy #4 migration 4 of 6: PR #700 (remotion/3-app), Remotion exports. OPTIONAL: the app creates this table lazily (lib/exports/jobs.ts exportJobsReady), only in a
-- workspace that first uses an export, and exports are OFF in production unless REMOTION_EXPORTS is 1/on/true/yes. If the switch stays off at deploy #4 the table is never
-- created and this file need not be applied. Database: the TENANT database of the workspace that exports (db(), not the platform database).
-- Exactly the statements the app runs. Idempotent; additive.
CREATE TABLE IF NOT EXISTS export_jobs (
 id TEXT PRIMARY KEY,
 workspace_id TEXT NOT NULL,
 owner TEXT NOT NULL,
 request_id TEXT NOT NULL,
 fingerprint TEXT NOT NULL,
 composition TEXT NOT NULL,
 spec_json TEXT NOT NULL,
 status TEXT NOT NULL,
 runtime_id TEXT,
 cancel_requested INTEGER NOT NULL DEFAULT 0,
 attempts INTEGER NOT NULL DEFAULT 1,
 retry_times TEXT NOT NULL DEFAULT '[]',
 error TEXT,
 outputs_json TEXT NOT NULL DEFAULT '[]',
 created_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL,
 claimed_at INTEGER,
 finished_at INTEGER,
 UNIQUE(workspace_id, owner, request_id)
);
CREATE INDEX IF NOT EXISTS export_jobs_queue ON export_jobs(workspace_id, status, created_at);
