import { after } from "next/server";
import { reserveRecoveryContinuation } from "@/lib/recovery";
import { requireRender, withTenant } from "@/lib/auth";
import { generationRequestKey } from "@/lib/generationRequests";
import { admitBatch, cancelBatch } from "@/lib/batchPress";
import { admissionResponse } from "@/lib/admissionSupport";
import { sampleWorkspaceOff } from "@/lib/demo/spend-guard.server";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * A multi-shot press as ONE job (lib/batchPress.ts): `{ members: [<a generation request>, ...] }`. Quote with `quoteOnly` (the server prices every member itself and judges the SUM
 * against the workspace's monthly cap); press with `maxCredits` (the total) and the quote's `fingerprint`, under an Idempotency-Key that names the press: asking again under it starts only
 * what has not started. `{ cancel: true }` under the same key cancels the press: nothing more starts under it, and its takes still waiting are cancelled at no charge.
 * A quote sent under the press's key reads the press first: `toStart` (the shots left), `pressed` (each shot as it stands) and `approval` (the approval it holds).
 */
export const POST = withTenant(async function POST(req: Request) {
  const got = await requireRender();
  if (got.response) return got.response;
  const body = await req.clone().json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) return Response.json({ error: "Provide the shots to make." }, { status: 400 });
  const defer = async (work: () => Promise<unknown>) => {
    after(await reserveRecoveryContinuation("after-response", work));
  };
  if (body.quoteOnly === true) {
    /* Quoted under a press's key, the press is read first: its started shots are shown and not priced again, and Retry's price is only the shots left. */
    if (!req.headers.has("Idempotency-Key")) return admissionResponse(await admitBatch(body, got, { defer }));
    const checked = generationRequestKey(req, got.user.id);
    if ("response" in checked) return checked.response;
    return admissionResponse(await admitBatch(body, got, { defer, ...(checked.key ? { pressKey: checked.key } : {}) }));
  }
  /* A cancel spends nothing: it is answered in the sample workspace too. */
  if (body.cancel === true) {
    const checked = generationRequestKey(req, got.user.id);
    if ("response" in checked) return checked.response;
    return admissionResponse(await cancelBatch(checked.key, got));
  }
  { const off = await sampleWorkspaceOff(); if (off) return off; }
  const checked = generationRequestKey(req, got.user.id);
  if ("response" in checked) return checked.response;
  return admissionResponse(await admitBatch(body, got, { defer, ...(checked.key ? { pressKey: checked.key } : {}) }));
});
