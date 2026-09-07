import { db, ready, now } from "@/lib/db";
import { requireOwner, withTenant } from "@/lib/auth";
import { NextResponse } from "next/server";
import { exportRows, takesCsv } from "@/lib/exportRows";
import { requireTenant } from "@/lib/tenant";

export const dynamic = "force-dynamic";
export const maxDuration = 60;
/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Full workspace export — the "your data is yours" escape hatch.
 *
 * Everything except the video and image bytes themselves, which stay in
 * object storage and are referenced by URL. Password hashes are deliberately
 * excluded: an export is a record, not a credential store.
 */
export const GET = withTenant(async function GET(req: Request) {
  const url = new URL(req.url);
  const format = url.searchParams.get("format");
  if (format === "csv" || format === "manifest") {
    const got = await requireOwner();
    if (got.response) return got.response;
    const { rows, unit } = await exportRows();
    if (format === "csv") {
      return new Response(takesCsv(rows, unit), {
        headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="takes-${requireTenant().slug}.csv"`, "Cache-Control": "no-store" },
      });
    }
    const masters = rows.filter((r) => r.url).map((r) => ({ id: r.id, filename: r.filename, bytes: r.bytes, url: r.url, kind: r.kind }));
    return NextResponse.json({ exportedAt: new Date(now()).toISOString(), workspace: requireTenant().slug, count: masters.length, expiresInHours: 24, masters });
  }
  // Every prompt, cost and account record in one file: the workspace owner's to take, nobody else's.
  const got = await requireOwner();
  if (got.response) return got.response;
  await ready();

  const [users, projects, generations, topups, uploads] = await Promise.all([
    db().execute(`SELECT id, email, name, role, disabled, created_at, last_seen FROM users ORDER BY created_at`),
    db().execute(`SELECT * FROM projects ORDER BY created_at`),
    db().execute(`SELECT * FROM generations ORDER BY created_at`),
    db().execute(`SELECT * FROM topups ORDER BY created_at`),
    db().execute(`SELECT id, filename, mime, ext, bytes, sha256, width, height, stored_url, created_at FROM uploads ORDER BY created_at`),
  ]);

  const rows = (rs: { rows: unknown[] }) => rs.rows.map((r) => ({ ...(r as any) }));

  const payload = {
    workspace: "Particl",
    exportedAt: new Date(now()).toISOString(),
    exportedBy: got.user.email,
    note:
      "Video and image files live in object storage; this export references them by URL. " +
      "Password hashes are intentionally omitted.",
    counts: {
      users: users.rows.length, projects: projects.rows.length,
      generations: generations.rows.length, topups: topups.rows.length,
      uploads: uploads.rows.length,
    },
    users: rows(users),
    projects: rows(projects),
    generations: rows(generations).map((g: any) => ({ ...g, params: JSON.parse(g.params || "{}") })),
    topups: rows(topups),
    uploads: rows(uploads),
  };

  const stamp = new Date(now()).toISOString().slice(0, 10);
  return new Response(JSON.stringify(payload, null, 2), {
    headers: {
      "Content-Type": "application/json",
      "Content-Disposition": `attachment; filename="particl-${stamp}.json"`,
      "Cache-Control": "no-store",
    },
  });
});
