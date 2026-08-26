import { NextResponse } from "next/server";
import { db, ready } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * Deployment sanity check. Reports only whether things are configured and
 * reachable — never a key, a URL or a token value.
 */
export async function GET() {
  let database = "unreachable";
  try {
    await ready();
    await db().execute("SELECT 1");
    database = process.env.TURSO_DATABASE_URL ? "turso" : "local-file";
  } catch { /* leave as unreachable */ }

  return NextResponse.json({
    ok: database !== "unreachable",
    database,
    storage: process.env.BLOB_READ_WRITE_TOKEN ? "blob-private" : "local-disk",
    arkKeyConfigured: Boolean(process.env.ARK_API_KEY),
    region: process.env.VERCEL_REGION ?? "local",
    commit: (process.env.VERCEL_GIT_COMMIT_SHA ?? "local").slice(0, 7),
  });
}
