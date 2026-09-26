import { test, expect } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { MODELS } from '../../lib/models';
import { DEFAULT_PLANS } from '../../lib/plans';
import { DEFAULT_MODELS } from '../../lib/platformLayer';
import { quoteWorkbenchMedia } from '../../lib/workbench/media-quote';
import { byQuality, eachLine, isTakeCell, leftFrom, optionLabel, reachFor, sortOptions, takeSettings, takesWithin } from '../../lib/mediaReach';
import { paidFromBalance, plansWithReach, rateCard, referenceTakes, reachEngines, usualTakes, workspaceReach, RATE_CARD_SECONDS, USUAL_WINDOW } from '../../lib/workbench/media-reach';
import { runInTenant, type TenantWorkspace } from '../../lib/tenant';
import { db, ready } from '../../lib/db';

/**
 * Credits said as takes (idea 24: plans and credits as media). Every figure
 * must be the composer's own quote at named settings — never a second price
 * list — only credits may leave the server, and nothing run on a connected
 * account (the provider's own credits) is ever re-priced at Particl's rate.
 */

const everywhere = () => true;
const NO_REFS = { images: 0, videos: 0, inputSeconds: 0, hasVideoInput: false };
const model = (id: string) => MODELS.find((m) => m.id === id)!;
const SEEDANCE = 'dreamina-seedance-2-5-260628';
const KLING = 'fal-ai/kling-video/v3/standard';
const KLING_PRO = 'fal-ai/kling-video/v3/pro';
const GROK_VIDEO = 'grok-imagine-video-1.5';
const NB_PRO = 'gemini-3-pro-image';
const GPT_IMAGE = 'gpt-image-2.5-flare';
const quote = (id: string, resolution: string, ratio: string, duration: number, audio = false) =>
  quoteWorkbenchMedia(model(id), { resolution, ratio, duration, audio }, NO_REFS).credits!;

const dir = mkdtempSync(path.join(tmpdir(), 'particl-media-reach-'));
function workspace(keys: Record<string, string> = {}): TenantWorkspace {
  const id = randomUUID();
  return { id, slug: 'reach', name: 'Reach', legacy: false, dbUrl: 'file:' + path.join(dir, id + '.db'), dbToken: null,
    keys, usesPlatformKeys: true, allowanceUsd: null, gatewayKeyId: null, ownerId: 'owner', createdAt: 0,
    suspendedAt: null, suspendedReason: null, flaggedAt: null, flagNote: null, concurrency: 3, rendersPerHour: 30, storageQuotaBytes: null, deletedAt: null };
}
let n = 0;
async function take(kind: 'video' | 'image', modelId: string, params: Record<string, unknown>, extra: { status?: string; deleted?: number; task?: string; provider?: string; billedTo?: string } = {}) {
  n += 1;
  await db().execute({
    sql: `INSERT INTO generations(id,kind,model,prompt,params,status,stored_url,created_at,updated_at,deleted,task,provider,billed_to)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    args: [`gen_${n}`, kind, modelId, 'a take', JSON.stringify(params), extra.status ?? 'succeeded', `/api/media/gen_${n}`, 1_000 + n, 1_000 + n,
      extra.deleted ?? 0, extra.task ?? 'generate', extra.provider ?? model(modelId).provider, extra.billedTo ?? null],
  });
}

test('the arithmetic: whole takes, rounded down, unknowns stay unknown', () => {
  expect(takesWithin(400, 18)).toBe(22);
  expect(takesWithin(18, 18)).toBe(1);
  expect(takesWithin(17, 18)).toBe(0);
  expect(takesWithin(-5, 18)).toBe(0);
  expect(takesWithin(1300.9, 18)).toBe(72);
  expect(takesWithin(400, 0)).toBeNull();
  expect(takesWithin(null, 18)).toBeNull();
  expect(takesWithin(400, null)).toBeNull();
  expect(takesWithin(Number.NaN, 18)).toBeNull();
  expect(reachFor(400, { video: null, image: null })).toEqual({ videos: null, images: null });
  expect(sortOptions(['1080p', '4k', '480p', '720p'])).toEqual(['480p', '720p', '1080p', '4k']);
  expect(sortOptions(['Medium', 'High', 'Low'])).toEqual(['Low', 'Medium', 'High']);
  expect(sortOptions(['4K', '512', '2K', '1K'])).toEqual(['512', '1K', '2K', '4K']);
  expect(byQuality(['Medium', 'High', 'Low'])).toBe(true);
  expect(byQuality(['1K', '2K'])).toBe(false);
  expect(byQuality([])).toBe(false);
  expect(optionLabel('4k')).toBe('4K');
  expect(optionLabel('512')).toBe('512 px');
  expect(optionLabel('720p')).toBe('720p');
  expect(takeSettings({ label: 'Kling 3.0', resolution: '1080p', durationS: 5, audio: true })).toBe('Kling 3.0 · 1080p · 5 s · sound');
  expect(takeSettings({ label: 'Nano Banana Pro', resolution: '1K', durationS: null, audio: false })).toBe('Nano Banana Pro · 1K');
  expect(eachLine({ credits: 1300 })).toBe('1,300 cr each');
  /* The count follows the balance the page shows; the server's count is only the fallback. */
  expect(leftFrom(1257, { credits: 18, left: 72 })).toBe(69);
  expect(leftFrom(null, { credits: 18, left: 72 })).toBe(72);
  expect(leftFrom(10, { credits: 18, left: 72 })).toBe(0);
});

test("plans are counted at the platform's default engines, 5 s 720p 16:9, by the composer's own quote", () => {
  const reference = referenceTakes(DEFAULT_MODELS, everywhere);
  expect(reference.video).toMatchObject({ engine: DEFAULT_MODELS.video, resolution: '720p', ratio: '16:9', durationS: 5, audio: false });
  expect(reference.video!.credits).toBe(quote(DEFAULT_MODELS.video, '720p', '16:9', 5));
  expect(reference.image).toMatchObject({ engine: DEFAULT_MODELS.image, durationS: null });
  expect(reference.image!.credits).toBe(quote(DEFAULT_MODELS.image, reference.image!.resolution, reference.image!.ratio, 0));

  const plans = plansWithReach(DEFAULT_PLANS, reference);
  for (const plan of plans.filter((p) => p.includedCredits > 0)) {
    expect(plan.reach.videos).toBe(Math.floor(plan.includedCredits / reference.video!.credits));
    expect(plan.reach.images).toBe(Math.floor(plan.includedCredits / reference.image!.credits));
  }
  /* Invite's credits are a one-off grant, not a month: no "≈ 0 a month". */
  expect(plans.find((p) => p.id === 'invite')!.reach).toEqual({ videos: null, images: null });
  /* The plan itself is untouched: price and credits come through as the layer holds them. */
  expect(plans.map((plan) => ({ ...plan, reach: undefined }))).toEqual(DEFAULT_PLANS);

  /* An engine the deployment cannot run is not a figure anyone can buy. */
  expect(referenceTakes(DEFAULT_MODELS, () => false)).toEqual({ video: null, image: null });
});

test('the rate card is every priced generation engine, per 5 s or per image, sound where it costs more, credits only', () => {
  const groups = rateCard(everywhere);
  expect(groups.map((g) => [g.kind, g.axis, g.seconds])).toEqual([['video', 'resolution', RATE_CARD_SECONDS], ['image', 'size', null], ['image', 'quality', null]]);
  for (const group of groups) {
    for (const row of group.rows) {
      const m = model(row.engine);
      expect(m.kind).toBe(group.kind);
      expect(byQuality(m.resolutions)).toBe(group.axis === 'quality');
      const ratio = m.ratios.includes('16:9') ? '16:9' : m.ratios[0];
      for (const cell of row.cells) expect(cell.credits).toBe(quote(m.id, cell.option, ratio, group.kind === 'video' ? RATE_CARD_SECONDS : 0, row.audio));
      expect(row.cells.map((c) => c.option)).toEqual(sortOptions(row.cells.map((c) => c.option)));
    }
  }
  const [video] = groups;
  const rowsOf = (id: string) => video.rows.filter((r) => r.engine === id);
  expect(rowsOf(SEEDANCE).map((r) => [r.label, r.audio, r.cells.map((c) => c.option)])).toEqual([['Seedance 2.5', false, ['480p', '720p', '1080p']]]);
  /* Kling bills sound by the second, so it gets a second row; Seedance and Grok price sound the same and do not. */
  expect(rowsOf(KLING).map((r) => r.audio)).toEqual([false, true]);
  expect(rowsOf(KLING_PRO).map((r) => r.audio)).toEqual([false, true]);
  expect(rowsOf(KLING)[1].cells[0].credits).toBeGreaterThan(rowsOf(KLING)[0].cells[0].credits);
  expect(rowsOf(GROK_VIDEO).map((r) => r.audio)).toEqual([false]);
  expect(groups[1].rows.some((r) => r.engine === NB_PRO)).toBe(true);
  expect(groups[2].rows.some((r) => r.engine === GPT_IMAGE)).toBe(true);

  /* Live-quoted engines, connected-account engines and post tools have no fixed price here. */
  const engines = groups.flatMap((g) => g.rows).map((r) => model(r.engine));
  expect(engines.some((m) => m.marketing || m.soulIdentity || m.genjutsu || m.stillTask || m.hidden)).toBe(false);
  expect(reachEngines(everywhere).every((m) => (m.supportsTasks ?? ['generate']).includes('generate'))).toBe(true);
  /* Nothing but credits: no vendor dollars, no margin, no money at all. */
  const wire = JSON.stringify({ groups, reference: referenceTakes(DEFAULT_MODELS, everywhere) });
  expect(wire).not.toMatch(/usd|margin|cost|\$|price/i);
  expect(rateCard(() => false).every((g) => g.rows.length === 0)).toBe(true);
});

test('sound is priced where the engine bills it, and ignored where it does not', () => {
  expect(quote(KLING, '1080p', '16:9', 5, true)).toBeGreaterThan(quote(KLING, '1080p', '16:9', 5, false));
  expect(quote(SEEDANCE, '720p', '16:9', 5, true)).toBe(quote(SEEDANCE, '720p', '16:9', 5, false));
});

test('an outline marks only the exact take a figure used: engine, size, sound, length and price', () => {
  const group = { seconds: 5 };
  const kling = { kind: 'video' as const, engine: KLING, label: 'Kling 3.0', resolution: '1080p', ratio: '16:9', durationS: 5, audio: false, credits: 7 };
  const row = { engine: KLING, audio: false };
  expect(isTakeCell(kling, group, row, { option: '1080p', credits: 7 })).toBe(true);
  expect(isTakeCell(kling, group, { ...row, audio: true }, { option: '1080p', credits: 7 })).toBe(false);
  expect(isTakeCell({ ...kling, durationS: 8 }, group, row, { option: '1080p', credits: 7 })).toBe(false);
  /* Same engine and size, but the take's aspect priced it differently: the cell is not its price. */
  expect(isTakeCell({ ...kling, credits: 6 }, group, row, { option: '1080p', credits: 7 })).toBe(false);
  expect(isTakeCell(null, group, row, { option: '1080p', credits: 7 })).toBe(false);
  const still = { kind: 'image' as const, engine: NB_PRO, label: 'Nano Banana Pro', resolution: '1K', ratio: '16:9', durationS: null, audio: false, credits: 3 };
  expect(isTakeCell(still, { seconds: null }, { engine: NB_PRO, audio: false }, { option: '1K', credits: 3 })).toBe(true);
});

test("a balance is counted at the workspace's usual settings: most-made first; demos, archives, edits, failures ignored", async () => {
  await runInTenant(workspace(), async () => {
    await ready();
    /* The starter production's demo takes are Seedance and would win on count. */
    for (let i = 0; i < 6; i++) await take('video', SEEDANCE, { resolution: '1080p', ratio: '16:9', duration: 8, demo: true });
    /* Archived, non-generate and failed takes are not anyone's usual new take. */
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
    expect((await workspaceReach(-40, DEFAULT_MODELS, everywhere)).video!.left).toBe(0);
  });
});

test('a habit is what a take shows and costs: the same priced setting at two aspects counts once', async () => {
  /* Seedance prices 720p the same whichever way up the frame is. */
  expect(quote(SEEDANCE, '720p', '9:16', 5)).toBe(quote(SEEDANCE, '720p', '16:9', 5));
  await runInTenant(workspace(), async () => {
    await ready();
    for (let i = 0; i < 2; i++) await take('video', SEEDANCE, { resolution: '720p', ratio: '16:9', duration: 5 });
    for (let i = 0; i < 3; i++) await take('video', KLING, { resolution: '1080p', ratio: '16:9', duration: 5 });
    for (let i = 0; i < 2; i++) await take('video', SEEDANCE, { resolution: '720p', ratio: '9:16', duration: 5 });
    const usual = await usualTakes(everywhere);
    /* Four Seedance 720p takes beat three Kling ones; the figure is the most recent of the four. */
    expect(usual.video).toMatchObject({ engine: SEEDANCE, resolution: '720p', ratio: '9:16', durationS: 5, credits: quote(SEEDANCE, '720p', '9:16', 5) });
  });
});

test('each kind looks back over its own takes: a run of stills never hides the usual video', async () => {
  await runInTenant(workspace(), async () => {
    await ready();
    for (let i = 0; i < 3; i++) await take('video', SEEDANCE, { resolution: '1080p', ratio: '16:9', duration: 10 });
    /* More recent stills than both windows together. */
    for (let i = 0; i < USUAL_WINDOW * 2 + 5; i++) await take('image', GPT_IMAGE, { resolution: 'High', ratio: '1:1' });
    const usual = await usualTakes(everywhere);
    expect(usual.video).toMatchObject({ engine: SEEDANCE, resolution: '1080p', durationS: 10 });
    expect(usual.image).toMatchObject({ engine: GPT_IMAGE, resolution: 'High' });
  });
});

test("a connected account's takes are the provider's credits: never counted, never re-priced", async () => {
  await runInTenant(workspace(), async () => {
    await ready();
    /* Many takes through the connected account, some under a catalogue engine's id. */
    for (let i = 0; i < 5; i++) await take('video', SEEDANCE, { resolution: '1080p', ratio: '16:9', duration: 10 }, { provider: 'higgsfield', billedTo: 'higgsfield' });
    for (let i = 0; i < 5; i++) await take('video', SEEDANCE, { resolution: '1080p', ratio: '9:16', duration: 10, consumerCreditUnit: 'higgsfield_credits', consumerCredits: 40 });
    await take('video', SEEDANCE, { resolution: '480p', ratio: '16:9', duration: 5 });
    const usual = await usualTakes(everywhere);
    expect(usual.video).toMatchObject({ engine: SEEDANCE, resolution: '480p', durationS: 5 });
  });
});

test('an engine the workspace pays for with its own key never stands for what its credits buy', async () => {
  const mock = process.env.ENGINE_MOCK;
  process.env.ENGINE_MOCK = '1';
  try {
    /* Its own fal key: Kling is billed to the workspace's fal account, not its balance. */
    await runInTenant(workspace({ fal: 'sealed-in-test' }), async () => {
      await ready();
      for (let i = 0; i < 4; i++) await take('video', KLING, { resolution: '1080p', ratio: '16:9', duration: 5 });
      await take('video', SEEDANCE, { resolution: '720p', ratio: '16:9', duration: 5 });
      expect(paidFromBalance(model(KLING))).toBe(false);
      expect(paidFromBalance(model(SEEDANCE))).toBe(true);
      const reach = await workspaceReach(400, DEFAULT_MODELS, paidFromBalance);
      expect(reach.video).toMatchObject({ basis: 'usual', engine: SEEDANCE, resolution: '720p' });
      expect(rateCard(paidFromBalance)[0].rows.some((r) => r.engine === KLING)).toBe(false);
    });
  } finally {
    if (mock === undefined) delete process.env.ENGINE_MOCK; else process.env.ENGINE_MOCK = mock;
  }
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
