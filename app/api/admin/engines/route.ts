import { NextResponse } from "next/server";
import { requireSuperAdmin } from "@/lib/auth";
import { engineHealth, engineSpansSince, engineMargin, type EngineHealthRow } from "@/lib/meter";
import { engineSwitches, setEngineSwitch } from "@/lib/platform";
import { PROVIDERS, providerConfigured, type ProviderId } from "@/lib/providers";
import { MODELS, getModel } from "@/lib/models";
import { peakByEngine } from "@/lib/concurrency";

export const dynamic = "force-dynamic";

/**
 * Engine health across every workspace: what ran, what failed, how long it
 * took — and, for board 12h, one row per provider with its switch.
 *
 *   curl -b "$COOKIE" http://localhost:4550/api/admin/engines
 *   { day: EngineHealthRow[], week: EngineHealthRow[],          // as before
 *     providers: [{ id, label, short, models: string[], configured,
 *                   on, reason,                                  // the switch (lib/platform engineSwitches)
 *                   jobs7d, failed7d, failRate7d, running,       // keyed by the MODEL's provider
 *                   peak30d, concurrent, room,                   // concurrent: ProviderDef.concurrent — none declared, so room is null
 *                   marginPct7d }] }                             // engineMargin(now − 7d), internal excluded
 *
 *   curl -b "$COOKIE" -X PATCH http://localhost:4550/api/admin/engines \
 *        -H 'content-type: application/json' -d '{"id":"fal","on":false,"reason":"queue backed up"}'
 *   { providers }   — by = the admin's name, at = now, reason trimmed to 160 chars (null when empty)
 */

const isProviderId = (v: unknown): v is ProviderId => PROVIDERS.some((p) => p.id === v);

/* The switch is keyed by the model's provider (who MADE it), never by the
   billed door: a Google still through the gateway is billed to vercel but
   is switched off with google. A model the catalogue does not know (an
   audio or trainer id) falls back to the billed engine, which is its
   provider anyway. */
const providerOfRow = (r: EngineHealthRow): string => {
  try { return getModel(r.model).provider; } catch { return r.engine; }
};

async function providersView() {
  const at = Date.now();
  const [week, switches, margins, spans] = await Promise.all([
    engineHealth(at - 7 * 86_400_000).catch(() => [] as EngineHealthRow[]),
    engineSwitches(),
    engineMargin(at - 7 * 86_400_000).catch(() => null),
    engineSpansSince(at - 30 * 86_400_000).catch(() => []),
  ]);
  const peaks = new Map(peakByEngine(spans, at).map((p) => [p.engine, p.peak]));
  return PROVIDERS.map((p) => {
    const rows: EngineHealthRow[] = week.filter((r: EngineHealthRow) => providerOfRow(r) === p.id);
    const jobs7d = rows.reduce((a, r) => a + r.jobs, 0);
    const failed7d = rows.reduce((a, r) => a + r.failed, 0);
    const sw = switches[p.id];
    /* A per-provider ceiling, when the registry declares one; none does
       today, so room is null and the desk prints an em dash. Never a typed
       vendor number. */
    const concurrent = typeof (p as { concurrent?: unknown }).concurrent === "number" ? Number((p as { concurrent?: number }).concurrent) : null;
    const peak30d = peaks.get(p.id) ?? 0;
    const room = concurrent && concurrent > 0 ? Math.max(0, Math.min(1, 1 - peak30d / concurrent)) : null;
    return {
      id: p.id, label: p.label, short: p.short,
      models: MODELS.filter((m) => m.provider === p.id).map((m) => m.id),
      configured: providerConfigured(p),
      on: sw?.on ?? true, reason: sw?.reason ?? null,
      jobs7d, failed7d, failRate7d: jobs7d ? failed7d / jobs7d : 0,
      running: rows.reduce((a, r) => a + r.running, 0),
      peak30d, concurrent, room,
      marginPct7d: margins?.[p.id]?.marginPct ?? null,
    };
  });
}

export async function GET() {
  const got = await requireSuperAdmin();
  if (got.response) return got.response;
  const now = Date.now();
  const [day, week, providers] = await Promise.all([engineHealth(now - 86_400_000), engineHealth(now - 7 * 86_400_000), providersView()]);
  return NextResponse.json({ day, week, providers });
}

/** One switch, one engine, everywhere: the gate is read where money starts (lib/meter.ts), not here. */
export async function PATCH(req: Request) {
  const got = await requireSuperAdmin();
  if (got.response) return got.response;
  const body = await req.json().catch(() => ({}));
  if (!isProviderId(body.id)) return NextResponse.json({ error: `id must be one of ${PROVIDERS.map((p) => p.id).join(", ")}.` }, { status: 400 });
  if (typeof body.on !== "boolean") return NextResponse.json({ error: "on must be true or false." }, { status: 400 });
  const reason = String(body.reason ?? "").trim().slice(0, 160) || null;
  await setEngineSwitch(body.id, body.on, body.on ? null : reason, got.user.name);
  return NextResponse.json({ providers: await providersView() });
}
