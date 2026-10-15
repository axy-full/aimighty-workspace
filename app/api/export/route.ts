import { now } from "@/lib/db";
import { requireOwner, withTenant } from "@/lib/auth";
import { NextResponse } from "next/server";
import { exportRows, takesCsv } from "@/lib/exportRows";
import { requireTenant } from "@/lib/tenant";
import { workspaceExport } from "@/lib/workspaceExport";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Full workspace export — the "your data is yours" escape hatch.
 *
 * The workspace's records and the owner's own drafts, and another member's
 * private board's records and takes too, counted in its maker's history
 * (lib/draftProject.ts › exportableBoards); their drafts and soul identities
 * stay theirs. Media bytes use a separate authorized manifest. Credentials
 * are excluded.
 */
export const GET = withTenant(async function GET(req: Request) {
  const url = new URL(req.url);
  const format = url.searchParams.get("format");
  if (format === "csv" || format === "manifest") {
    const got = await requireOwner();
    if (got.response) return got.response;
    const { rows, unit } = await exportRows({ id: got.user.id, role: got.user.role, owner: got.user.owner });
    if (format === "csv") {
      return new Response(takesCsv(rows, unit), {
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="takes-${requireTenant().slug}.csv"`,
          "Cache-Control": "no-store",
        },
      });
    }
    const masters = rows
      .filter((r) => r.url)
      .map((r) => ({
        id: r.id,
        filename: r.filename,
        bytes: r.bytes,
        url: r.url,
        kind: r.kind,
      }));
    return NextResponse.json({
      exportedAt: new Date(now()).toISOString(),
      workspace: requireTenant().slug,
      count: masters.length,
      expiresInHours: 24,
      masters,
    });
  }
  // Owner-scoped export with shared data and customer billing records.
  const got = await requireOwner();
  if (got.response) return got.response;
  const payload = await workspaceExport(got.user.id, got.user.email, { id: got.user.id, role: got.user.role, owner: got.user.owner });

  const stamp = new Date(now()).toISOString().slice(0, 10);
  return new Response(JSON.stringify(payload, null, 2), {
    headers: {
      "Content-Type": "application/json",
      "Content-Disposition": `attachment; filename="${requireTenant().slug}-${stamp}.json"`,
      "Cache-Control": "no-store",
    },
  });
});
