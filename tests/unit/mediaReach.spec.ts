import { test, expect } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { MODELS } from '../../lib/models';
import { DEFAULT_PLANS } from '../../lib/plans';
import { DEFAULT_MODELS } from '../../lib/platformLayer';
import { quoteWorkbenchMedia } from '../../lib/workbench/media-quote';
import { optionLabel, reachFor, sortOptions, takeSettings, takesWithin } from '../../lib/mediaReach';
import { plansWithReach, rateCard, referenceTakes, reachEngines, usualTakes, workspaceReach, RATE_CARD_SECONDS } from '../../lib/workbench/media-reach';
import { runInTenant, type TenantWorkspace } from '../../lib/tenant';
import { db, ready } from '../../lib/db';

/**
 * Credits said as takes (idea: plans as media). Every figure must be the
 * composer's own quote at named settings — never a second price list — and
 * only credits may leave the server.
 */

const everywhere = () => true;
const NO_REFS = { images: 0, videos: 0, inputSeconds: 0, hasVideoInput: false };
const model = (id: string) => MODELS.find((m) => m.id === id)!;
const SEEDANCE = 'dreamina-seedance-2-5-260628';
const KLING = 'fal-ai/kling-video/v3/standard';
const NB_PRO = 'gemini-3-pro-image';
const quote = (id: string, resolution: string, ratio: string, duration: number, audio = false) =>
  quoteWorkbenchMedia(model(id), { resolution, ratio, duration, audio }, NO_REFS).credits!;

const dir = mkdtempSync(path.join(tmpdir(), 'particl-media-reach-'));
function workspace(): TenantWorkspace {
  const id = randomUUID();
  return { id, slug: 'reach', name: 'Reach', legacy: false, dbUrl: 'file:' + path.join(dir, id + '.db'), dbToken: null,
    keys: {}, usesPlatformKeys: true, allowanceUsd: null, gatewayKeyId: null, ownerId: 'owner', createdAt: 0,
    suspendedAt: null, suspendedReason: null, flaggedAt: null, flagNote: null, concurrency: 3, rendersPerHour: 30, storageQuotaBytes: null, deletedAt: null };
}
let n = 0;
async function take(kind: 'video' | 'image', modelId: string, params: Record<string, unknown>, extra: { status?: string; deleted?: number; task?: string } = {}) {
  n += 1;
  await db().execute({
    sql: `INSERT INTO generations(id,kind,model,prompt,params,status,stored_url,created_at,updated_at,deleted,task)
          VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
    args: [`gen_${n}`, kind, modelId, 'a take', JSON.stringify(params), extra.status ?? 'succeeded', `/api/media/gen_${n}`, 1_000 + n, 1_000 + n, extra.deleted ?? 0, extra.task ?? 'generate'],
  });
}

test('the arithmetic: whole takes, rounded down, unknowns stay unknown', () => {
  expect(takesWithin(400, 18)).toBe(22);
  expect(takesWithin(18, 18)).toBe(1);
  expect(takesWithin(17, 18)).toBe(0);
  expect(takesWithin(-5, 18)).toBe(0);
  expect(takesWithin(400, 0)).toBeNull();
  expect(takesWithin(null, 18)).toBeNull();
  expect(takesWithin(400, null)).toBeNull();
  expect(reachFor(400, { video: null, image: null })).toEqual({ videos: null, images: null });
  expect(sortOptions(['1080p', '4k', '480p', '720p'])).toEqual(['480p', '720p', '1080p', '4k']);
  expect(sortOptions(['Medium', 'High', 'Low'])).toEqual(['Low', 'Medium', 'High']);
  expect(sortOptions(['4K', '512', '2K', '1K'])).toEqual(['512', '1K', '2K', '4K']);
  expect(optionLabel('4k')).toBe('4K');
  expect(optionLabel('512')).toBe('512 px');
  expect(optionLabel('720p')).toBe('720p');
  expect(takeSettings({ label: 'Kling 3.0', resolution: '1080p', durationS: 5, audio: true })).toBe('Kling 3.0 · 1080p · 5\u00a0s · sound');
  expect(takeSettings({ label: 'Nano Banana Pro', resolution: '1K', durationS: null, audio: false })).toBe('Nano Banana Pro · 1K');
});

test("plans are counted at the platform's default engines, 5 s 720p 16:9, by the composer's own quote", () => {
  const reference = referenceTakes(DEFAULT_MODELS, everywhere);
  expect(reference.video).toMatchObject({ engine: DEFAULT_MODELS.video, resolution: '720p', ratio: '16:9', durationS: 5, audio: false });
  expect(reference.video!.credits).toBe(quote(DEFAULT_MODELS.video, '720p', '16:9', 5));
  expect(reference.image).toMatchObject({ engine: DEFAULT_MODELS.image, durationS: null });
  expect(reference.image!.credits).toBe(quote(DEFAULT_MODELS.image, reference.image!.resolution, reference.image!.ratio, 0));

  const plans = plansWithReach(DEFAULT_PLANS, reference);
  for (const plan of plans) {
    expect(plan.reach.videos).toBe(Math.floor(plan.includedCredits / reference.video!.credits));
    expect(plan.reach.images).toBe(Math.floor(plan.includedCredits / reference.image!.credits));
  }
  /* §7A's own card: Seedance 2.5 5 s 720p sells at 18 cr, so Studio's 400 cr is 22 of them. */
  expect(plans.find((p) => p.id === 'studio')!.reach.videos).toBe(Math.floor(400 / quote(SEEDANCE, '720p', '16:9', 5)));

  /* An engine the deployment cannot run is not a figure anyone can buy. */
  expect(referenceTakes(DEFAULT_MODELS, () => false)).toEqual({ video: null, image: null });
});

test('the rate card is every priced generation engine, per 5 s or per image, and carries credits only', () => {
  const groups = rateCard(everywhere);
  const video = groups.find((g) => g.kind === 'video')!;
  const image = groups.find((g) => g.kind === 'image')!;
  expect(video.seconds).toBe(RATE_CARD_SECONDS);
  expect(image.seconds).toBeNull();
  for (const row of video.rows) {
    const m = model(row.engine);
    for (const cell of row.cells) expect(cell.credits).toBe(quote(m.id, cell.option, m.ratios.includes('16:9') ? '16:9' : m.ratios[0], RATE_CARD_SECONDS));
    expect(row.cells.map((c) => c.option)).toEqual(sortOptions(row.cells.map((c) => c.option)));
  }
  const seedance = video.rows.find((r) => r.engine === SEEDANCE)!;
  expect(seedance.label).toBe('Seedance 2.5');
  expect(seedance.cells.map((c) => c.option)).toEqual(['480p', '720p', '1080p']);
  expect(image.rows.some((r) => r.engine === NB_PRO)).toBe(true);
  /* Live-quoted connected engines and post tools have no fixed price here. */
  const engines = [...video.rows, ...image.rows].map((r) => model(r.engine));
  expect(engines.some((m) => m.marketing || m.soulIdentity || m.genjutsu || m.stillTask || m.hidden)).toBe(false);
  expect(reachEngines(everywhere).every((m) => !(m.supportsTasks ?? ['generate']).includes('upscale'))).toBe(true);
  /* Nothing but credits: no vendor dollars, no margin. */
  const wire = JSON.stringify({ groups, reference: referenceTakes(DEFAULT_MODELS, everywhere) });
  expect(wire).not.toMatch(/usd|margin|cost|rate/i);
  expect(rateCard(() => false).every((g) => g.rows.length === 0)).toBe(true);
});

test('sound is priced where the engine bills it, and ignored where it does not', () => {
  expect(quote(KLING, '1080p', '16:9', 5, true)).toBeGreaterThan(quote(KLING, '1080p', '16:9', 5, false));
  expect(quote(SEEDANCE, '720p', '16:9', 5, true)).toBe(quote(SEEDANCE, '720p', '16:9', 5, false));
});

test("a balance is counted at the workspace's usual settings: most-made first, demos, archives and edits ignored", async () => {
  await runInTenant(workspace(), async () => {
    await ready();
    /* The starter production's demo takes are Seedance and would win on count. */
    for (let i = 0; i < 6; i++) await take('video', SEEDANCE, { resolution: '1080p', ratio: '16:9', duration: 8, demo: true });
    /* Archived and non-generate takes are not anyone's usual new take. */
    for (let i = 0; i < 4; i++) await take('video', SEEDANCE, { resolution: '480p', ratio: '16:9', duration: 5 }, { deleted: 1 });
    for (let i = 0; i < 4; i++) await take('video', SEEDANCE, { resolution: '480p', ratio: '16:9', duration: 5 }, { task: 'extend' });
    for (let i = 0; i < 4; i++) await take('video', SEEDANCE, { resolution: '480p', ratio: '16:9', duration: 5 }, { status: 'failed' });
    /* What this workspace really makes: Kling with sound, three times; one Seedance. */
    for (let i = 0; i < 3; i++) await take('video', KLING, { resolution: '1080p', ratio: '9:16', duration: 5, generateAudio: true });
    await take('video', SEEDANCE, { resolution: '720p', ratio: '16:9', duration: 5 });
    /* A take whose settings can no longer be priced is skipped, not guessed. */
    for (let i = 0; i < 5; i++) await take('image', NB_PRO, { resolution: '8K', ratio: '16:9' });

    const usual = await usualTakes(everywhere);
    expect(usual.video).toMatchObject({ engine: KLING, resolution: '1080p', ratio: '9:16', durationS: 5, audio: true, label: 'Kling 3.0' });
    expect(usual.video!.credits).toBe(quote(KLING, '1080p', '9:16', 5, true));
    expect(usual.image).toBeNull();

    const reach = await workspaceReach(1_300, DEFAULT_MODELS, everywhere);
    expect(reach.video).toMatchObject({ basis: 'usual', engine: KLING, left: Math.floor(1_300 / usual.video!.credits) });
    /* No priceable still of its own: the workspace's default image engine at the defaults. */
    const fallback = referenceTakes(DEFAULT_MODELS, everywhere).image!;
    expect(reach.image).toMatchObject({ basis: 'default', engine: fallback.engine, credits: fallback.credits, left: Math.floor(1_300 / fallback.credits) });
    /* A balance under one take is zero takes, not a negative or a fraction. */
    expect((await workspaceReach(1, DEFAULT_MODELS, everywhere)).video!.left).toBe(0);
  });
});

test("another workspace's takes never set this workspace's usual settings", async () => {
  const busy = workspace();
  await runInTenant(busy, async () => {
    await ready();
    for (let i = 0; i < 5; i++) await take('video', KLING, { resolution: '1080p', ratio: '16:9', duration: 10 });
  });
  await runInTenant(workspace(), async () => {
    await ready();
    const reach = await workspaceReach(400, DEFAULT_MODELS, everywhere);
    expect(reach.video).toMatchObject({ basis: 'default', engine: DEFAULT_MODELS.video, resolution: '720p', durationS: 5 });
  });
  await runInTenant(busy, async () => {
    const reach = await workspaceReach(400, DEFAULT_MODELS, everywhere);
    expect(reach.video).toMatchObject({ basis: 'usual', engine: KLING, durationS: 10 });
  });
});
