import { db, ready } from '../db';
import { MODELS, displayModelName, type ModelDef } from '../models';
import { modelConfigured } from '../providers';
import { resolveShotSettings, defaultShotRatio } from '../workspace/engines';
import type { PlanDef } from '../plans';
import type { PlatformModels } from '../platformLayer';
import { reachFor, sortOptions, takesWithin, type PricedTake, type RateGroup, type ReachKind, type ReferenceTakes, type TakeReach, type WorkspaceReach, type WorkspaceTake } from '../mediaReach';
import { quoteWorkbenchMedia, workbenchGenerationModels, type ReferencePrices } from './media-quote';

/**
 * Credits translated into takes, priced by the composer's own quote.
 *
 * Every figure here comes out of quoteWorkbenchMedia — the function behind the
 * price on the Generate button — at named settings with no references, so a
 * plan card, the rate card and the Workspace balance can never disagree with
 * what a take is actually charged. Only credits leave this module: no vendor
 * dollar and no margin reaches a response.
 *
 * Engines are the ones Particl renders through its own APIs and prices from
 * its catalogue. Live-quoted connected-account engines (marketing images,
 * identity renders, transforms) have no fixed price and are left out rather
 * than guessed at.
 */

const NO_REFERENCES: ReferencePrices = { images: 0, videos: 0, inputSeconds: 0, hasVideoInput: false };
/** The length every video cell on the rate card is priced at. */
export const RATE_CARD_SECONDS = 5;
/** How far back "usual" looks: the workspace's most recent finished takes of each kind. */
export const USUAL_WINDOW = 60;

type Configured = (model: ModelDef) => boolean;

/** Generation engines with a catalogue price that this deployment can run now. */
export function reachEngines(configured: Configured = modelConfigured): ModelDef[] {
  const order = new Map(MODELS.map((m, i) => [m.id, i]));
  return workbenchGenerationModels()
    .filter((m) => !m.marketing && !m.soulIdentity && !m.genjutsu && configured(m))
    .sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
}

type TakeSettings = { resolution: string; ratio: string; durationS?: number | null; audio?: boolean };

/** Sound is a price dimension only where the engine bills it by the second (Kling); elsewhere it is ignored. */
const billedSound = (model: ModelDef, audio: boolean | undefined) => Boolean(audio && model.kind === 'video' && model.supportsAudio && model.billing === 'second');

/** One take priced in credits, or null when the engine cannot price those settings. */
export function priceTake(model: ModelDef, settings: TakeSettings): PricedTake | null {
  const video = model.kind === 'video';
  const durationS = video ? settings.durationS ?? null : null;
  if (video && !(typeof durationS === 'number' && durationS > 0)) return null;
  const audio = billedSound(model, settings.audio);
  try {
    const { credits } = quoteWorkbenchMedia(model, { resolution: settings.resolution, ratio: settings.ratio, duration: durationS ?? 0, audio }, NO_REFERENCES);
    if (typeof credits !== 'number' || !(credits > 0)) return null;
    return { kind: model.kind, engine: model.id, label: displayModelName(model.id), resolution: settings.resolution, ratio: settings.ratio, durationS, audio, credits };
  } catch {
    return null;
  }
}

/** An engine at the platform's default settings: 5 s, 720p where offered, 16:9 where offered. */
export function defaultTake(engineId: string, kind: ReachKind, configured: Configured = modelConfigured): PricedTake | null {
  const model = reachEngines(configured).find((m) => m.id === engineId && m.kind === kind);
  const settings = model ? resolveShotSettings({ engine: model.id }) : null;
  return model && settings ? priceTake(model, { resolution: settings.resolution, ratio: settings.ratio, durationS: settings.durationS }) : null;
}

/** The two takes plans are translated into: the platform's default video and image engines at their default settings. */
export function referenceTakes(models: Pick<PlatformModels, 'video' | 'image'>, configured: Configured = modelConfigured): ReferenceTakes {
  return { video: defaultTake(models.video, 'video', configured), image: defaultTake(models.image, 'image', configured) };
}

/** Each plan with what its monthly credits come to at the reference settings. */
export function plansWithReach<P extends PlanDef>(plans: P[], reference: ReferenceTakes): (P & { reach: TakeReach })[] {
  return plans.map((plan) => ({ ...plan, reach: reachFor(plan.includedCredits, reference) }));
}

/** Credits per take for every engine: videos per RATE_CARD_SECONDS at each resolution, stills per image at each size. */
export function rateCard(configured: Configured = modelConfigured): RateGroup[] {
  const engines = reachEngines(configured);
  return (['video', 'image'] as const).map((kind) => ({
    kind,
    seconds: kind === 'video' ? RATE_CARD_SECONDS : null,
    rows: engines.filter((m) => m.kind === kind).flatMap((model) => {
      const ratio = defaultShotRatio(model);
      const cells = sortOptions(model.resolutions).flatMap((option) => {
        const take = priceTake(model, { resolution: option, ratio, durationS: RATE_CARD_SECONDS });
        return take ? [{ option, credits: take.credits }] : [];
      });
      return cells.length ? [{ engine: model.id, label: displayModelName(model.id), cells }] : [];
    }),
  }));
}

type Stored = { resolution?: unknown; ratio?: unknown; duration?: unknown; generateAudio?: unknown; demo?: unknown };
const parse = (raw: unknown): Stored => {
  try { const v = typeof raw === 'string' ? JSON.parse(raw) : raw; return v && typeof v === 'object' ? v as Stored : {}; } catch { return {}; }
};

/**
 * The settings this workspace renders most, per kind, among its recent
 * finished takes — ties go to the most recent. Tenant-scoped: db() is the
 * workspace's own database. Archived takes, edits, extends and tools are not
 * a person's usual new take, and the starter production's demo takes were
 * never rendered by anyone; none of them is counted.
 */
export async function usualTakes(configured: Configured = modelConfigured): Promise<ReferenceTakes> {
  await ready();
  const engines = new Map(reachEngines(configured).map((m) => [m.id, m]));
  const { rows } = await db().execute({
    sql: `SELECT kind, model, params FROM generations
          WHERE deleted=0 AND status='succeeded' AND kind IN ('video','image') AND COALESCE(task,'generate')='generate'
          ORDER BY created_at DESC LIMIT ?`,
    args: [USUAL_WINDOW * 2],
  });
  const tallies: Record<ReachKind, Map<string, { n: number; order: number; model: ModelDef; settings: TakeSettings }>> = { video: new Map(), image: new Map() };
  const seen: Record<ReachKind, number> = { video: 0, image: 0 };
  rows.forEach((row, order) => {
    const kind = String(row.kind) as ReachKind;
    const model = engines.get(String(row.model));
    if (!model || model.kind !== kind || seen[kind] >= USUAL_WINDOW) return;
    const p = parse(row.params);
    if (p.demo === true) return;
    seen[kind] += 1;
    const settings: TakeSettings = {
      resolution: String(p.resolution ?? ''), ratio: String(p.ratio ?? ''),
      durationS: kind === 'video' ? Number(p.duration) : null, audio: billedSound(model, p.generateAudio === true),
    };
    const key = [model.id, settings.resolution, settings.ratio, settings.durationS ?? '', settings.audio ? 1 : 0].join('|');
    const tally = tallies[kind].get(key);
    if (tally) tally.n += 1; else tallies[kind].set(key, { n: 1, order, model, settings });
  });
  const pick = (kind: ReachKind): PricedTake | null => {
    for (const t of [...tallies[kind].values()].sort((a, b) => b.n - a.n || a.order - b.order)) {
      const take = priceTake(t.model, t.settings);
      if (take) return take;
    }
    return null;
  };
  return { video: pick('video'), image: pick('image') };
}

/**
 * What a balance buys, per kind: at the workspace's usual settings where it
 * has made takes of that kind, otherwise at its default engine's default
 * settings. `defaults` are the engines its composer opens on.
 */
export async function workspaceReach(balance: number, defaults: Pick<PlatformModels, 'video' | 'image'>, configured: Configured = modelConfigured): Promise<WorkspaceReach> {
  const usual = await usualTakes(configured);
  const settle = (kind: ReachKind): WorkspaceTake | null => {
    const own = usual[kind];
    const take = own ?? defaultTake(defaults[kind], kind, configured);
    if (!take) return null;
    return { ...take, basis: own ? 'usual' : 'default', left: takesWithin(balance, take.credits) ?? 0 };
  };
  return { video: settle('video'), image: settle('image') };
}
