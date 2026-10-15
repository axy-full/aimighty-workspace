import { NextResponse } from "next/server";
import { requireUser, withTenant } from "@/lib/auth";
import { db, ready } from "@/lib/db";
import { mayReadTake } from "@/lib/draftProject";
import { SAMPLE_CLIP_CREDIT, SAMPLE_CLIP_URL } from "@/lib/sampleClip";

export const dynamic = "force-dynamic";

/**
 * Which of this workspace's takes are the starter production's sample clip (Big Buck Bunny, CC BY 3.0: lib/sampleClip.ts), so every screen that shows a take can carry
 * its credit without each take view model carrying a flag. Read-only; only takes this person may see; empty for a workspace with no starter or whose starter takes
 * are the platform's neutral previews (those carry no credit).
 */
export const GET = withTenant(async function GET() {
  const got = await requireUser();
  if (got.response) return got.response;
  await ready();
  const rows = (await db().execute({ sql: "SELECT id, project_id FROM generations WHERE stored_url = ? AND deleted = 0 AND status = 'succeeded' ORDER BY created_at LIMIT 500", args: [SAMPLE_CLIP_URL] })).rows;
  const allowed = new Map<string, boolean>();
  const takes: string[] = [];
  for (const row of rows) {
    const project = row.project_id == null ? null : String(row.project_id);
    const key = project ?? "";
    if (!allowed.has(key)) allowed.set(key, await mayReadTake(got.user, project));
    if (allowed.get(key)) takes.push(String(row.id));
  }
  return NextResponse.json({ takes, credit: SAMPLE_CLIP_CREDIT.line }, { headers: { "Cache-Control": "no-store" } });
});
