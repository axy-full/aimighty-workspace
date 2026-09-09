import { NextResponse } from "next/server";
import { requireRender, withTenant } from "@/lib/auth";
import { now } from "@/lib/db";
import { impactOf } from "@/lib/impact";
import { parsePort } from "@/lib/rig";

/**
 * What a change would cost, before it is made (brief 3).
 *
 * A POST because it is a question about a proposed change rather than a thing
 * that exists, and because the port it asks about is a triple rather than
 * something that reads well in a query string. Nothing is written and nothing
 * is charged: this is the price, and the verdict that says whether the person
 * asking may press it.
 */
export const dynamic = "force-dynamic";

export const POST = withTenant(async function POST(req: Request) {
  /* The same door the press uses, not a weaker one. requireRender turns away
     a suspended workspace and a read-only token, and a quote that answered
     "allowed" to a caller the press refuses outright would be worse than no
     quote at all. */
  const got = await requireRender();
  if (got.response) return got.response;

  const body = await req.json().catch(() => ({}));
  const port = parsePort(body.port);
  if (!port || !port.attributeId || !port.versionId) {
    return NextResponse.json(
      { error: "Ask about one version: a port of elementId:attributeId:versionId." },
      { status: 400 });
  }

  /* The project selector's own sentinels, read the way every other route
     reads them: both mean "not one production" rather than a production
     that happens to be called that. */
  const asked = typeof body.projectId === "string" ? body.projectId : "";
  const projectId = asked && asked !== "all" && asked !== "unfiled" ? asked : null;

  const impact = await impactOf(port.elementId, port.attributeId, port.versionId, {
    projectId, at: now(), isAdmin: got.user.role === "admin",
  });
  return NextResponse.json({ impact });
});
