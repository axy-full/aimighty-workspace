import { NextResponse } from "next/server";
import { requireSession, withTenant } from "@/lib/auth";
import { readActivity } from "@/lib/control-room/activity.server";

export const dynamic = "force-dynamic";

/**
 * Atomik's runs on a production, each step priced and settled, and what every
 * project has settled (lib/control-room/activity.server.ts). The control
 * room's Activity and the board's Project record read it.
 *
 *  GET ?production=<id>   that production's runs
 *  GET                    every production's newest runs
 *
 * GET only, for a signed-in person only (an API token is refused). It reads
 * this workspace alone, in credits only, and changes nothing.
 */
export const GET = withTenant(async function GET(req: Request) {
  const got = await requireSession();
  if (got.response) return got.response;
  const raw = new URL(req.url).searchParams.get("production");
  const production = raw && raw.trim() ? raw.trim() : null;
  if (production && (production.length > 120 || !/^[A-Za-z0-9_-]+$/.test(production)))
    return NextResponse.json({ error: "That project is not one of this workspace's." }, { status: 400, headers: { "Cache-Control": "no-store" } });
  try {
    const reply = await readActivity({ id: got.user.id, role: got.user.role, owner: got.user.owner }, production);
    return NextResponse.json(reply, { headers: { "Cache-Control": "private, no-store" } });
  } catch {
    console.error(JSON.stringify({ event: "control_room.activity_read_failed" }));
    return NextResponse.json({ error: "Activity could not be read. Try again." }, { status: 500, headers: { "Cache-Control": "no-store" } });
  }
});
