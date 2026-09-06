import { NextResponse } from "next/server";
import { requireUser, withTenant } from "@/lib/auth";
import { statementFor, statementMonths, statementCsv, monthRange } from "@/lib/statements";

export const dynamic = "force-dynamic";

/**
 * Statements — the owner's and admins' to read. No month lists the months
 * with anything on them; a month returns its statement, as JSON or as a
 * CSV to download.
 */
export const GET = withTenant(async function GET(req: Request) {
  const got = await requireUser();
  if (got.response) return got.response;
  if (got.user.role !== "admin") return NextResponse.json({ error: "Statements are the owner's and admins' to read." }, { status: 403 });
  const url = new URL(req.url);
  const month = url.searchParams.get("month");
  if (!month) return NextResponse.json({ months: await statementMonths() });
  if (!monthRange(month)) return NextResponse.json({ error: "A month looks like 2026-09." }, { status: 400 });
  const projectId = url.searchParams.get("project") || null;
  const statement = await statementFor(month, projectId);
  if (!statement) return NextResponse.json({ error: "No such month." }, { status: 404 });
  if (url.searchParams.get("format") === "csv") {
    const name = `statement-${statement.workspace.slug}-${month}${projectId ? `-${projectId}` : ""}.csv`;
    return new Response(statementCsv(statement), {
      headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${name}"`, "Cache-Control": "no-store" },
    });
  }
  return NextResponse.json(statement);
});
