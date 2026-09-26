import { db, ready } from '../db';
import { MODELS, displayModelName, type ModelDef } from '../models';
import { modelConfigured } from '../providers';
import { paidByPlatform, renderKeyNameFor } from '../platformSpend';
import { resolveShotSettings, defaultShotRatio } from '../workspace/engines';
import type { PlanDef } from '../plans';
import type { PlatformModels } from '../platformLayer';
import { byQuality, reachFor, sortOptions, takesWithin, type PricedTake, type RateGroup, type RateRow, type ReachKind, type ReferenceTakes, type TakeReach, type WorkspaceReach, type WorkspaceTake } from '../mediaReach';
import { NO_REFERENCES, quoteWorkbenchMedia, workbenchGenerationModels } from './media-quote';

/**
 * Credits translated into takes, priced by the composer's own quote.
 *
 * Every figure here comes out of quoteWorkbenchMedia — the function behind the
 * price on the Generate button, and the same arithmetic admission bills with
 * (estimateCostUsd → billCredits at creditUsd()) — at named settings with no
 * references, so a plan card, the rate card and the Workspace balance can
 * never disagree with what a take is charged. Only credits leave this module:
 * no vendor dollar and no margin reaches a response, and nothing here turns
 * credits back into money.
 *
 * Engines are the ones Particl renders through its own APIs and prices from
 * its catalogue. Live-quoted engines (campaign images, identity renders,
 * transforms) and anything run on a connected account — priced in that
 * provider's own credits — are left out rather than converted or guessed at.
 */

/** The length every video cell on the rate card is priced at. */
export const RATE_CARD_SECONDS = 5;
/** How far back "usual" looks: the workspace's most recent finished takes of each kind. */
export const USUAL_WINDOW = 60;

type Configured = (model: ModelDef) => boolean;

/**
 * An engine whose takes draw on THIS workspace's credit balance: configured,
 * and paid by the platform rather than by a key of the workspace's own (the
 * same test the credit wall applies at admission — lib/allowance.ts). Call
 * inside the tenant.
 */
export const paidFromBalance: Configured = (model) => modelConfigured(model) && paidByPlatform(renderKeyNameFor(model.provider));

/** Generation engines with a catalogue price that this deployment can run now. */
export function reachEngines(configured: Configured = modelConfigured): ModelDef[] {
  const order = new Map(MODELS.map((m, i) => [m.id, i]));
  return workbenchGenerationModels()
    .filter((m) => !m.marketing && !m.soulIdentity && !m.genjutsu && configured(m))
    .sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
}

type TakeSettings = { resolution: string; ratio: string; durationS?: number | null; audio?: boolean };

/** Sound is a price dimension only where the engine bills it by the second (Kling); elsewhere it does not move the price. */
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

/** An engine at the platform's shot defaults: 5 s, 720p where offered, 16:9 where offered. */
export function defaultTake(engineId: string, kind: ReachKind, configured: Configured = modelConfigured): PricedTake | null {
  const model = reachEngines(configured).find((m) => m.id === engineId && m.kind === kind);
  const settings = model ? resolveShotSettings({ engine: model.id }) : null;
  return model && settings ? priceTake(model, { resolution: settings.resolution, ratio: settings.ratio, durationS: settings.durationS }) : null;
}

/** The two takes plans are translated into: the platform's default video and image engines at their default settings. */
export function referenceTakes(models: Pick<PlatformModels, 'video' | 'image'>, configured: Configured = modelConfigured): ReferenceTakes {
  return { video: defaultTake(models.video, 'video', configured), image: defaultTake(models.image, 'image', configured) };
}

/**
 * Each plan with what its monthly credits come to at the reference settings.
 * A plan with no monthly credits (Invite's grant is once, not monthly) has no
 * figure rather than "≈ 0 a month".
 */
export function plansWithReach<P extends PlanDef>(plans: P[], reference: ReferenceTakes): (P & { reach: TakeReach })[] {
  return plans.map((plan) => ({ ...plan, reach: plan.includedCredits > 0 ? reachFor(plan.includedCredits, reference) : { videos: null, images: null } }));
}

/**
 * Credits per take for every engine: videos per RATE_CARD_SECONDS at each
 * resolution, stills per image at each size or quality. An engine that bills
 * sound by the second gets a second row with sound, so nobody who turns sound
 * on pays more than the card says.
 */
export function rateCard(configured: Configured = modelConfigured): RateGroup[] {
  const engines = reachEngines(configured);
  const rowsOf = (models: ModelDef[]) => models.flatMap((model) => {
    const ratio = defaultShotRatio(model);
    const cellsAt = (audio: boolean) => sortOptions(model.resolutions).flatMap((option) => {
      const take = priceTake(model, { resolution: option, ratio, durationS: RATE_CARD_SECONDS, audio });
      return take ? [{ option, credits: take.credits }] : [];
    });
    const label = displayModelName(model.id);
    const silent = cellsAt(false);
    const rows: RateRow[] = silent.length ? [{ engine: model.id, label, audio: false, cells: silent }] : [];
    if (billedSound(model, true)) {
      const sound = cellsAt(true);
      if (sound.length && sound.some((cell, i) => cell.credits !== silent[i]?.credits)) rows.push({ engine: model.id, label, audio: true, cells: sound });
    }
    return rows;
  });
  const stills = engines.filter((m) => m.kind === 'image');
  return [
    { kind: 'video', axis: 'resolution', seconds: RATE_CARD_SECONDS, rows: rowsOf(engines.filter((m) => m.kind === 'video')) },
    { kind: 'image', axis: 'size', seconds: null, rows: rowsOf(stills.filter((m) => !byQuality(m.resolutions))) },
    { kind: 'image', axis: 'quality', seconds: null, rows: rowsOf(stills.filter((m) => byQuality(m.resolutions))) },
  ];
}

type Stored = { resolution?: unknown; ratio?: unknown; duration?: unknown; generateAudio?: unknown };
const parse = (raw: unknown): Stored => {
  try { const v = typeof raw === 'string' ? JSON.parse(raw) : raw; return v && typeof v === 'object' ? v as Stored : {}; } catch { return {}; }
};

/**
 * The settings this workspace renders most, per kind, among its last
 * USUAL_WINDOW finished takes of that kind on an engine priced here — ties go
 * to the most recent. Tenant-scoped: db() is the workspace's own database.
 *
 * Not counted: archived takes; edits, extends and tools (not a new take);
 * the starter production's demo takes (nobody rendered them); and anything
 * made through a connected account, which that provider bills in its own
 * credits — never re-priced at Particl's rate.
 */
export async function usualTakes(configured: Configured = modelConfigured): Promise<ReferenceTakes> {
  await ready();
  const engines = new Map(reachEngines(configured).map((m) => [m.id, m]));
  const usualOf = async (kind: ReachKind): Promise<PricedTake | null> => {
    const ids = [...engines.values()].filter((m) => m.kind === kind).map((m) => m.id);
    if (!ids.length) return null;
    const { rows } = await db().execute({
      sql: `SELECT model, params FROM generations
            WHERE kind=? AND deleted=0 AND status='succeeded' AND COALESCE(task,'generate')='generate'
              AND model IN (${ids.map(() => '?').join(',')})
              AND provider <> 'higgsfield' AND COALESCE(billed_to,'') <> 'higgsfield'
              AND COALESCE(CASE WHEN json_valid(params) THEN json_extract(params,'$.demo') END, 0) = 0
              AND COALESCE(CASE WHEN json_valid(params) THEN json_extract(params,'$.consumerCreditUnit') END, '') = ''
            ORDER BY created_at DESC, id DESC LIMIT ?`,
      args: [kind, ...ids, USUAL_WINDOW],
    });
    const tallies = new Map<string, { n: number; order: number; model: ModelDef; settings: TakeSettings }>();
    rows.forEach((row, order) => {
      const model = engines.get(String(row.model));
      if (!model) return;
      const p = parse(row.params);
      const settings: TakeSettings = {
        resolution: String(p.resolution ?? ''), ratio: String(p.ratio ?? ''),
        durationS: kind === 'video' ? Number(p.duration) : null, audio: billedSound(model, p.generateAudio === true),
      };
      const key = [model.id, settings.resolution, settings.ratio, settings.durationS ?? '', settings.audio ? 1 : 0].join('|');
      const tally = tallies.get(key);
      if (tally) tally.n += 1; else tallies.set(key, { n: 1, order, model, settings });
    });
    /* Most-made first; a setting that can no longer be priced is skipped, not guessed. */
    for (const t of [...tallies.values()].sort((a, b) => b.n - a.n || a.order - b.order)) {
      const take = priceTake(t.model, t.settings);
      if (take) return take;
    }
    return null;
  };
  const [video, image] = await Promise.all([usualOf('video'), usualOf('image')]);
  return { video, image };
}

/**
 * What a balance buys, per kind: at the workspace's usual settings where it
 * has made takes of that kind, otherwise at its default engine's default
 * settings. `defaults` are the engines its composer opens on; `configured`
 * should be paidFromBalance, so an engine the workspace pays for with its
 * own key never stands for what its credits buy.
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
