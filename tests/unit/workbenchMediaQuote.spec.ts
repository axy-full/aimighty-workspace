import { test, expect } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { MODELS, type ModelDef } from '../../lib/models';
import { estimateCostUsd } from '../../lib/vendorPricing';
import { billCredits } from '../../lib/creditTerms';
import { generatedReferenceSeconds, videoReferenceSeconds } from '../../lib/referenceDuration';
import { quoteWorkbenchMedia, referencePrices, workbenchGenerationModels } from '../../lib/workbench/media-quote';
import { mediaQuoteReferences } from '../../lib/workbench/media-reference-input';
import { seedProject } from '../../lib/workbench/studio';
import { runInTenant, type TenantWorkspace } from '../../lib/tenant';
import { db, ready } from '../../lib/db';

const dir = mkdtempSync(path.join(tmpdir(), 'particl-media-quote-'));
function workspace(): TenantWorkspace {
  const id = randomUUID();
  return { id, slug: 'quote', name: 'Quote', legacy: false, dbUrl: 'file:' + path.join(dir, id + '.db'), dbToken: null,
    keys: {}, usesPlatformKeys: false, allowanceUsd: null, gatewayKeyId: null, ownerId: 'owner', createdAt: 0,
    suspendedAt: null, suspendedReason: null, flaggedAt: null, flagNote: null, concurrency: 3, rendersPerHour: 30, storageQuotaBytes: null, deletedAt: null };
}
const model = MODELS.find(item => item.id === 'dreamina-seedance-2-5-260628')!;
async function fixtures() {
  await ready();
  await db().execute(`INSERT INTO uploads(id,filename,mime,ext,bytes,sha256,stored_url,created_at,kind,duration_s)
    VALUES('video_upload','clip.mp4','video/mp4','mp4',1000,'hash','/api/uploads/video_upload',0,'video',4)`);
  await db().execute(`INSERT INTO uploads(id,filename,mime,ext,bytes,sha256,stored_url,created_at,kind)
    VALUES('image_upload','frame.png','image/png','png',1000,'hash2','/api/uploads/image_upload',0,'image')`);
  await db().execute({ sql: `INSERT INTO generations(id,kind,model,prompt,params,status,stored_url,created_at,updated_at)
    VALUES('video_generation','video',?,'test',?,'succeeded','/api/media/video_generation',0,0)`, args: [model.id, JSON.stringify({ duration: 5 })] });
}

test('new-take engines exclude editing tools and put the economy still first', () => {
  const engines = workbenchGenerationModels();
  expect(engines.some(item => item.id.includes('topaz'))).toBe(false);
  expect(engines.some(item => item.id.includes('reframe'))).toBe(false);
  expect(engines.some(item => item.stillTask)).toBe(false);
  expect(engines.find(item => item.marketing)?.hidden).toBe(true);
  expect(engines.filter(item => item.kind === 'image')[0].id).toBe('gemini-3.1-flash-image');
});

test('reference-video quotes include upload and generated duration at the input-video rate', async () => {
  await runInTenant(workspace(), async () => {
    await fixtures();
    const refs = await referencePrices([{ uploadId: 'video_upload' }, { genId: 'video_generation' }, { uploadId: 'image_upload' }], 2);
    expect(refs).toEqual({ images: 3, videos: 2, inputSeconds: 9, hasVideoInput: true });
    const quote = quoteWorkbenchMedia(model, { resolution: '720p', ratio: '16:9', duration: 5 }, refs);
    expect(quote.credits).toBe(billCredits(estimateCostUsd(model.id, '720p', '16:9', 5, 9, true)!.net, model.id));
    expect(quote.credits).not.toBe(billCredits(estimateCostUsd(model.id, '720p', '16:9', 5)!.net, model.id));
  });
});

test('unknown video duration cannot become a zero-cost input', async () => {
  await runInTenant(workspace(), async () => {
    await fixtures();
    await db().execute("UPDATE uploads SET duration_s=NULL WHERE id='video_upload'");
    await expect(referencePrices([{ uploadId: 'video_upload' }])).rejects.toThrow('no verified duration');
    await db().execute("UPDATE generations SET params='{}' WHERE id='video_generation'");
    await expect(referencePrices([{ genId: 'video_generation' }])).rejects.toThrow('no verified duration');
  });
});

test('reference IDs resolve within the tenant and must identify available output', async () => {
  const first = workspace();
  await runInTenant(first, fixtures);
  await runInTenant(workspace(), async () => {
    await ready();
    await expect(referencePrices([{ uploadId: 'video_upload' }])).rejects.toThrow('unavailable');
  });
  await runInTenant(first, async () => {
    await db().execute("UPDATE generations SET status='running' WHERE id='video_generation'");
    await expect(referencePrices([{ genId: 'video_generation' }])).rejects.toThrow('not completed');
  });
});

test('a still engine rejects video references and video engines enforce their combined ceiling', () => {
  const image = MODELS.find(item => item.kind === 'image' && !item.hidden)!;
  expect(() => quoteWorkbenchMedia(image, { resolution: image.resolutions[0], ratio: '16:9', duration: 5 }, { images: 0, videos: 1, inputSeconds: 4, hasVideoInput: true })).toThrow('reference videos');
  expect(() => quoteWorkbenchMedia(model, { resolution: '720p', ratio: '16:9', duration: 5 }, { images: 0, videos: 2, inputSeconds: model.maxVideoSecondsTotal + 1, hasVideoInput: true })).toThrow('combined');
  expect(() => quoteWorkbenchMedia({ ...model, maxReferenceImages: 1 } as ModelDef, { resolution: '720p', ratio: '16:9', duration: 5 }, { images: 2, videos: 0, inputSeconds: 0, hasVideoInput: false })).toThrow('reference images');
});

test('the browser quote carries saved IDs and counts only unregistered images', () => {
  const base = seedProject().assets[0];
  const q = new URLSearchParams(mediaQuoteReferences([
    { ...base, kind: 'video', generationId: 'video_generation' },
    { ...base, kind: 'video', url: '/api/uploads/video_upload' },
    { ...base, uploadId: 'image_upload' },
    base,
    { ...base, kind: 'video', url: '/api/workbench/media/legacy_clip' },
  ]));
  expect(q.getAll('genId')).toEqual(['video_generation']);
  expect(q.getAll('uploadId')).toEqual(['video_upload', 'image_upload']);
  expect(q.get('imageRefs')).toBe('1');
  expect(q.get('unresolvedVideoRefs')).toBe('1');
});

test('the shared duration reader used by submit preserves generated and uploaded seconds', () => {
  expect(generatedReferenceSeconds('{"duration":5.5}')).toBe(5.5);
  expect(generatedReferenceSeconds('{"duration":-1}')).toBeNull();
  expect(generatedReferenceSeconds('broken')).toBeNull();
  expect(videoReferenceSeconds([{ kind: 'video', durationS: 4 }, { kind: 'video', durationS: generatedReferenceSeconds('{"duration":5}') }, { kind: 'image', durationS: null }])).toBe(9);
  expect(videoReferenceSeconds([{ kind: 'video', durationS: null }])).toBeNull();
});
