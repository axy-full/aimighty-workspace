import { withTenant } from "@/lib/auth";
import { NO_STORE, crewCaller, crewFailure } from "@/lib/crew/http";
import { verifyXai, xaiConnected, xaiModel, xaiRate } from "@/lib/crew/xai";

export const dynamic = "force-dynamic";

/** GET: is a key connected, which model, can a round be priced. POST: Verify — lists models, spends nothing. */
export const GET = withTenant(async (req: Request) => {
  const caller = await crewCaller(req);
  if (caller.response) return caller.response;
  try {
    const connected = xaiConnected();
    return Response.json({ connected, model: xaiModel(), priced: connected ? Boolean(await xaiRate()) : false }, { headers: NO_STORE });
  } catch (error) { return crewFailure(error); }
});

export const POST = withTenant(async (req: Request) => {
  const caller = await crewCaller(req);
  if (caller.response) return caller.response;
  try {
    const result = await verifyXai();
    return Response.json({ ...result, model: xaiModel(), listed: result.models.includes(xaiModel()) }, { status: result.ok ? 200 : 502, headers: NO_STORE });
  } catch (error) { return crewFailure(error); }
});
