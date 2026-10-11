import { NextResponse } from "next/server";
import { requireSession, withTenant } from "@/lib/auth";
import { readApprovals } from "@/lib/control-room/approvals.server";

export const dynamic = "force-dynamic";

/**
 * What waits for a person in this workspace, as one queue, and the last
 * decisions (lib/control-room/approvals.server.ts). The control room's
 * Approvals, Home's "Waiting for you", ⌘K and the phone's "Needs you" read it.
 *
 * GET only, and for a signed-in person only: an API token is refused
 * (requireSession), because this is the list a person approves from. It reads
 * this workspace alone, in credits only, and changes nothing; every approval
 * goes through the item's own existing route.
 */
export const GET = withTenant(async function GET() {
  const got = await requireSession();
  if (got.response) return got.response;
  try {
    const reply = await readApprovals({ id: got.user.id, role: got.user.role, owner: got.user.owner });
    return NextResponse.json(reply, { headers: { "Cache-Control": "private, no-store" } });
  } catch {
    console.error(JSON.stringify({ event: "control_room.approvals_read_failed" }));
    return NextResponse.json({ error: "Approvals could not be read. Try again." }, { status: 500, headers: { "Cache-Control": "no-store" } });
  }
});
