import { withTenant } from "@/lib/auth";
import { NO_STORE, crewCaller, crewFailure } from "@/lib/crew/http";
import { verifyXai, xaiConnected, xaiModel, xaiRate } from "@/lib/crew/xai";

export const dynamic = "force-dynamic";

/**
 * GET: is a key connected, can a round be priced. POST: Verify — proves the key by listing the vendor's models, spends nothing, and says
 * whether the crew's engine is among them. Neither names the engine, its vendor or the list (Amendment (iii) §E, Crew included; owner,
 * 24 Oct 2026): the model stays on the server.
 */
export const GET = withTenant(async (req: Request) => {
  const caller = await crewCaller(req);
  if (caller.response) return caller.response;
  try {
    const connected = xaiConnected();
    return Response.json({ connected, priced: connected ? Boolean(await xaiRate()) : false }, { headers: NO_STORE });
  } catch (error) { return crewFailure(error); }
});

export const POST = withTenant(async (req: Request) => {
  const caller = await crewCaller(req);
  if (caller.response) return caller.response;
  try {
    const result = await verifyXai();
    return Response.json({ ok: result.ok, listed: result.models.includes(xaiModel()), ...(result.reason ? { reason: result.reason } : {}) }, { status: result.ok ? 200 : 502, headers: NO_STORE });
  } catch (error) { return crewFailure(error); }
});
