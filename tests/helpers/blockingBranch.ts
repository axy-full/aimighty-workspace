/**
 * The guard for the 3D blocking branch-copy check (tests/unit/blocking-branch-copy.spec.ts): it may only ever run against a copy the
 * owner made for it, never against the production database. Pure, so its own rules are tested (tests/unit/blocking-schema.spec.ts).
 *
 *  - the URL must carry the owner's branch marker, `3d-blocking-test`: in its HOST for a remote database (a marker only in the path of a
 *    production host does not count), or in its file name for a local file: copy;
 *  - it must not be any database the environment names as the live one (TURSO_DATABASE_URL, DATABASE_URL,
 *    PLATFORM_DATABASE_URL, WORKSPACE_DATABASE_URL, or a comma-separated BLOCKING_PRODUCTION_NAMES the owner adds);
 *  - it must not look like a production name (a host or path with "prod" in it);
 *  - writes are refused where the process says it is a deployment: VERCEL_ENV set, or NODE_ENV=production.
 */
export const BRANCH_MARKER = "3d-blocking-test";

type Env = Record<string, string | undefined>;
const LIVE_URL_VARS = ["TURSO_DATABASE_URL", "DATABASE_URL", "PLATFORM_DATABASE_URL", "WORKSPACE_DATABASE_URL"] as const;

function hostAndPath(url: string): string {
  try { const u = new URL(url); return `${u.host}${u.pathname}`.toLowerCase(); } catch { return url.toLowerCase(); }
}
/** Where the marker must be: the host of a remote URL; the path of a local file: copy (it has no host). An address that cannot be read counts as a whole. */
function markerPlace(url: string): string {
  try {
    const u = new URL(url);
    return (u.protocol === "file:" ? u.pathname : u.host).toLowerCase();
  } catch { return url.toLowerCase(); }
}

/** Why this URL may not be used, in words, or null when it is a branch copy the check may read. */
export function branchCopyProblem(url: string | undefined, env: Env = process.env): string | null {
  if (!url) return "Set BLOCKING_BRANCH_DB_URL to the branch copy.";
  const where = hostAndPath(url);
  if (!markerPlace(url).includes(BRANCH_MARKER)) return `This is not a branch copy: ${/^file:/i.test(url.trim()) ? "its file name" : "its host"} does not contain "${BRANCH_MARKER}". Nothing was read.`;
  const live = [...LIVE_URL_VARS.map((name) => env[name]), ...(env.BLOCKING_PRODUCTION_NAMES ?? "").split(",")]
    .map((value) => (value ?? "").trim()).filter(Boolean);
  for (const name of live) if (url.trim() === name || hostAndPath(name) === where) return "This URL is the live database. Nothing was read.";
  if (/prod/i.test(where)) return 'This URL looks like a production database ("prod" is in its name). Nothing was read.';
  return null;
}

/** Why a write may not run here, or null. The check's write step is a throwaway row on the branch copy only. */
export function branchWriteProblem(env: Env = process.env): string | null {
  if (env.VERCEL_ENV) return "VERCEL_ENV is set: this looks like a deployment, so nothing is written.";
  if (env.NODE_ENV === "production") return "NODE_ENV is production, so nothing is written.";
  return null;
}
