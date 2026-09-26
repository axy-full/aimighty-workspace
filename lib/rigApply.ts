/**
 * The phone Rig's "Apply vN" (components/rig/PhoneBoard): one new take per
 * shot that cites the asset. Pure, so what it prices and what it reports are
 * the same shots.
 */

type ShotWords = { title: string; description: string; setup?: Record<string, string | null> | null };

/** What a shot re-renders from: its words and its Setup. Empty when it has neither. */
export function rerenderPrompt(s: ShotWords): string {
  return [s.description || s.title, Object.values(s.setup ?? {}).filter(Boolean).join(" · ")].filter(Boolean).join(". ");
}

/** What an engine offers, as far as a re-render's settings go (a ModelDef, or nothing when it is unknown). */
type EngineShape = { ratios: string[]; resolutions: string[]; durations: number[] };

/**
 * The ratio, resolution and length a re-render is priced and sent at: the
 * shot's own (16:9, 1080p, its planned seconds, 5 when unplanned), snapped
 * to what the engine offers exactly the way admission snaps them
 * (lib/generationAdmission). Priced at anything else, the take would bill a
 * different length than the quote and be refused against its own ceiling.
 */
export function rerenderParams(engine: EngineShape | null, planned: number | null): { ratio: string; resolution: string; duration: number } {
  const want = { ratio: "16:9", resolution: "1080p", duration: planned ?? 5 };
  if (!engine) return want;
  return {
    ratio: engine.ratios.includes(want.ratio) ? want.ratio : engine.ratios[0] ?? want.ratio,
    resolution: engine.resolutions.includes(want.resolution) ? want.resolution : engine.resolutions[0] ?? want.resolution,
    duration: engine.durations.includes(want.duration) ? want.duration : engine.durations[0] ?? 5,
  };
}

/** The shots that can actually re-render; only these are priced and sent. */
export function rerenderable<T extends ShotWords>(list: T[]): T[] {
  return list.filter((s) => rerenderPrompt(s));
}

/** One re-render take's request body: the shot's words, the snapped settings, and, in a credit workspace, its quote as the ceiling. */
export function rerenderBody(
  s: ShotWords & { id: string },
  o: { engine: string; projectId: string | null; params: { ratio: string; resolution: string; duration: number }; maxCredits: number | null },
): Record<string, unknown> {
  return {
    prompt: rerenderPrompt(s), model: o.engine, projectId: o.projectId, shotId: s.id, ...o.params,
    ...(o.maxCredits != null ? { maxCredits: o.maxCredits } : {}),
  };
}

/**
 * Sends one take per shot, in order, and stops at the first that does not
 * start. A request that throws (a dropped connection) stops the run the same
 * way, so the takes that already started are still reported, and still
 * rebind the slot, instead of the error escaping past both.
 */
export async function sendTakes<T extends { code: string }>(
  targets: T[], send: (s: T) => Promise<Response>,
): Promise<{ started: T[]; failure: string | null }> {
  const started: T[] = [];
  for (const s of targets) {
    try {
      const r = await send(s);
      if (r.ok) { started.push(s); continue; }
      const j = await r.json().catch(() => ({}));
      return { started, failure: `${s.code} didn't start: ${String(j.error ?? "try again").replace(/\.$/, "")}` };
    } catch {
      return { started, failure: `${s.code} may not have started: the connection dropped` };
    }
  }
  return { started, failure: null };
}

/**
 * The one toast an Apply leaves (a new toast replaces the last one, so
 * everything has to be said at once): what started and what that costs,
 * what did not start and why, and what had nothing to render.
 */
export function applySummary(o: {
  asset: string; from: string; to: string;
  started: number; sent: number; cost: string;
  failure: string | null; skipped: number;
}): string {
  const takes = (n: number) => `${n} ${n === 1 ? "take" : "takes"}`;
  const parts = o.started
    ? [`${o.asset} → ${o.to} · ${o.started === o.sent ? takes(o.started) : `${o.started} of ${takes(o.sent)}`} rendering · ${o.cost}`]
    : [`Nothing started · ${o.asset} stays on ${o.from}`];
  if (o.failure) parts.push(o.failure);
  if (o.skipped) parts.push(`${o.skipped} ${o.skipped === 1 ? "shot has" : "shots have"} no words to render`);
  return parts.join(" · ");
}
