import { NextResponse, type NextRequest } from "next/server";
import { requireUser } from "@/lib/auth";
import { listChats, createChat, engines, type AgentMode } from "@/lib/atomik";
import { menuFor, priceLabel, type CatalogModel } from "@/lib/catalog";

export const dynamic = "force-dynamic";

/**
 * The chat list and the planner menu.
 *
 * Both in one response because the screen needs both to draw its first
 * frame, and the menu is a cached read of the gateway's catalogue rather
 * than a query — asking for it separately would cost a round trip to save
 * nothing.
 */

/** A coarse band, not a price.
 *
 *  Text pricing is per token, so a number here would be a rate nobody can
 *  turn into "what will this conversation cost me". Three bands answer the
 *  question people actually have, which is whether this planner is the
 *  cheap one or the expensive one. */
function band(m: CatalogModel): "Low cost" | "Medium cost" | "High cost" | "" {
  const p = m.pricing as Record<string, unknown> | null;
  const out = Number(p?.output);
  if (!Number.isFinite(out)) return "";
  const perM = out * 1e6;
  return perM <= 2 ? "Low cost" : perM <= 12 ? "Medium cost" : "High cost";
}

const shape = (m: CatalogModel) => ({
  id: m.id, name: m.name, owner: m.owner,
  description: m.description.slice(0, 120),
  band: band(m), price: priceLabel(m),
});

export async function GET() {
  const got = await requireUser();
  if (got.response) return got.response;

  const [chats, menu, eng] = await Promise.all([
    listChats(), menuFor("planner"), engines(),
  ]);
  return NextResponse.json({
    chats,
    engines: eng,
    models: {
      featured: menu.featured.map(shape),
      rest: menu.rest.map(shape),
    },
  });
}

export async function POST(req: NextRequest) {
  const got = await requireUser();
  if (got.response) return got.response;
  const body = await req.json().catch(() => ({}));
  const id = await createChat({
    userId: got.user.id,
    projectId: typeof body.projectId === "string" ? body.projectId : null,
    model: typeof body.model === "string" && body.model ? body.model : "auto",
    agentMode: body.agentMode === "auto" ? "auto" : ("ask" as AgentMode),
  });
  return NextResponse.json({ id });
}
